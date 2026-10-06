import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { RelayConfiguration } from "../Config.ts";
import * as Store from "./BrokerStore.ts";
import * as Identity from "./OidcClient.ts";
import {
  issueAccountToken,
  verifyAccountToken,
  ACCOUNT_TOKEN_TTL_SECONDS,
} from "./AccountTokens.ts";

interface Request {
  readonly method: string;
  readonly path: string;
  readonly query: string;
  readonly body: string;
  readonly headers: Readonly<Record<string, string | undefined>>;
  readonly address: string;
}
interface Response {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}
export class AuthBroker extends Context.Service<
  AuthBroker,
  {
    readonly handle: (
      request: Request,
    ) => Effect.Effect<Response, Store.BrokerStoreError | Identity.OidcClientError>;
  }
>()("t3code-relay/auth/AuthBroker") {}
const clients = new Set(["t3-web", "t3-cli"]);
const deviceGrant = "urn:ietf:params:oauth:grant-type:device_code";
const sessionCookie = "__Host-t3-auth";
const loginCookie = "__Host-t3-login";
const escape = (value: string) =>
  value.replace(
    /[&<>"']/gu,
    (character) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!,
  );
const baseHeaders = {
  "cache-control": "no-store",
  pragma: "no-cache",
  "x-content-type-options": "nosniff",
  "referrer-policy": "same-origin",
};
const json = (body: unknown, status = 200): Response => ({
  status,
  headers: { ...baseHeaders, "content-type": "application/json" },
  body: JSON.stringify(body),
});
const error = (name: string, status = 400) => json({ error: name }, status);
const redirect = (url: string, cookie?: string): Response => ({
  status: 303,
  headers: { ...baseHeaders, location: url, ...(cookie ? { "set-cookie": cookie } : {}) },
  body: "",
});
const cookie = (name: string, value: string, maxAge: number) =>
  `${name}=${value}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=${maxAge}`;
const readCookie = (header: string | undefined, name: string) =>
  header
    ?.split(";")
    .map((x) => x.trim())
    .find((x) => x.startsWith(`${name}=`))
    ?.slice(name.length + 1) ?? "";
const page = (content: string, status = 200): Response => ({
  status,
  headers: {
    ...baseHeaders,
    "content-type": "text/html; charset=utf-8",
    "content-security-policy":
      "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
  },
  body: `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>T3 Connect</title><style>body{font:17px system-ui;background:#15171a;color:#f3f4f5;margin:0;padding:3rem 1.5rem}main{max-width:32rem;margin:auto}h1{font-size:2rem}p{line-height:1.6;color:#c9cdd3}input,button{font:inherit;padding:.8rem;border-radius:.4rem;border:1px solid #707781}input{display:block;margin:.7rem 0 1.5rem;width:calc(100% - 1.6rem);background:#252930;color:inherit}button{cursor:pointer;background:#c7e3ff;color:#102536;margin:.4rem .7rem .4rem 0}button[value=deny]{background:#252930;color:#eee}code{font-size:1.4rem}a{color:#c7e3ff}</style><main>${content}</main></html>`,
});
const make = Effect.gen(function* () {
  const config = yield* RelayConfiguration;
  const oidc = config.oidc;
  if (!oidc) return yield* Effect.die("OIDC broker configuration missing.");
  const store = yield* Store.BrokerStore;
  const provider = yield* Identity.OidcClient;
  const handle: AuthBroker["Service"]["handle"] = (request) =>
    Effect.gen(function* () {
      const query = new URLSearchParams(request.query);
      const form = new URLSearchParams(request.body);
      // Reject ambiguous repeated fields, including state and grant credentials.
      if (
        [...form.keys()].some((key) => form.getAll(key).length !== 1) ||
        [...query.keys()].some((key) => query.getAll(key).length !== 1)
      )
        return error("invalid_request");
      if (request.body.length > 8192 || request.query.length > 8192)
        return error("invalid_request");
      const key = Store.hashCredential(request.address);
      if (!(yield* store.allow(`request:${key}`, 120, 60))) return error("slow_down", 429);
      if (
        request.method === "POST" &&
        request.path !== "/auth/device" &&
        !request.headers["content-type"]?.startsWith("application/x-www-form-urlencoded")
      )
        return error("invalid_request");
      if (request.method === "POST" && request.path === "/auth/device" && form.has("client_id")) {
        if (!request.headers["content-type"]?.startsWith("application/x-www-form-urlencoded"))
          return error("invalid_request");
        const clientId = form.get("client_id") ?? "";
        if (!clients.has(clientId)) return error("invalid_client");
        if (
          form.get("scope") &&
          form.get("scope") !== "openid profile email" &&
          form.get("scope") !== "account"
        )
          return error("invalid_scope");
        if (!(yield* store.allow(`device:${key}`, 10, 60))) return error("slow_down", 429);
        const device = yield* store.createDevice(clientId);
        const uri = `${config.relayIssuer}/auth/device`;
        return json({
          ...device,
          verification_uri: uri,
          verification_uri_complete: `${uri}?user_code=${encodeURIComponent(device.user_code)}`,
        });
      }
      if (request.method === "POST" && request.path === "/auth/token") {
        const clientId = form.get("client_id") ?? "";
        if (!clients.has(clientId)) return error("invalid_client");
        const grant = form.get("grant_type");
        const credential =
          grant === deviceGrant ? form.get("device_code") : form.get("refresh_token");
        if (!credential || credential.length > 512) return error("invalid_request");
        if (grant !== deviceGrant && grant !== "refresh_token")
          return error("unsupported_grant_type");
        const result =
          grant === deviceGrant
            ? yield* store.poll(credential, clientId, oidc.refreshLifetimeSeconds)
            : yield* store.refresh(credential, clientId);
        if ("error" in result) return error(result.error);
        const now = Math.floor((yield* DateTime.now).epochMilliseconds / 1000);
        const accessToken = yield* issueAccountToken(config, result.user, now).pipe(
          Effect.mapError(
            (cause) => new Store.BrokerStoreError({ operation: "issue-token", cause }),
          ),
        );
        return json({
          access_token: accessToken,
          refresh_token: result.refreshToken,
          token_type: "Bearer",
          expires_in: ACCOUNT_TOKEN_TTL_SECONDS,
          user: result.user,
        });
      }
      if (request.method === "POST" && request.path === "/auth/revoke") {
        const clientId = form.get("client_id") ?? "";
        const token = form.get("token") ?? "";
        if (!clients.has(clientId) || token.length > 512) return error("invalid_request");
        yield* store.revoke(token, clientId);
        return { status: 204, headers: baseHeaders, body: "" };
      }
      if (request.method === "GET" && request.path === "/auth/me") {
        const authorization = request.headers.authorization;
        if (!authorization?.startsWith("Bearer ")) return error("invalid_token", 401);
        const user = yield* verifyAccountToken(
          config,
          authorization.slice(7),
          Math.floor((yield* DateTime.now).epochMilliseconds / 1000),
        ).pipe(Effect.orElseSucceed(() => undefined));
        return user ? json(user) : error("invalid_token", 401);
      }
      if (request.method === "POST" && request.path === "/auth/logout") {
        const token = readCookie(request.headers.cookie, sessionCookie);
        const session = yield* store.session(token);
        if (
          !session ||
          request.headers.origin !== config.relayIssuer ||
          !form.get("csrf") ||
          Store.hashCredential(form.get("csrf")!) !== Store.hashCredential(session.csrf)
        )
          return error("access_denied", 403);
        yield* store.deleteSession(token);
        const code = form.get("user_code") ?? "";
        return redirect(
          `/auth/device${code ? `?user_code=${encodeURIComponent(code)}` : ""}`,
          cookie(sessionCookie, "", 0),
        );
      }
      if (request.method === "GET" && request.path === "/auth/login") {
        const code = query.get("user_code") ?? "";
        if (code && !(yield* store.deviceView(code)))
          return page("<h1>Code expired</h1><p>Start sign-in again from your device.</p>", 400);
        if (!(yield* store.allow(`login:${key}`, 10, 60))) return error("slow_down", 429);
        const login = yield* store.createLogin(code);
        const url = yield* provider.authorize(login);
        return redirect(url, cookie(loginCookie, login.browser, 600));
      }
      if (request.method === "GET" && request.path === "/auth/callback") {
        const state = query.get("state") ?? "";
        const browser = readCookie(request.headers.cookie, loginCookie);
        if (!state || !browser)
          return page("<h1>Sign-in expired</h1><p>Start sign-in again from your device.</p>", 400);
        const login = yield* store.consumeLogin(state, browser);
        if (!login)
          return page("<h1>Sign-in expired</h1><p>Start sign-in again from your device.</p>", 400);
        const user = yield* provider.callback({ ...login, url: `${oidc.redirectUri}?${query}` });
        const session = yield* store.createSession(user, oidc.refreshLifetimeSeconds);
        // Replacing the short login cookie with an expired value is unnecessary for replay: the transaction is consumed.
        return redirect(
          `/auth/device${login.userCode ? `?user_code=${encodeURIComponent(login.userCode)}` : ""}`,
          cookie(sessionCookie, session, oidc.refreshLifetimeSeconds),
        );
      }
      if (
        (request.method === "GET" || request.method === "POST") &&
        request.path === "/auth/device"
      ) {
        const code = (request.method === "POST" ? form : query).get("user_code") ?? "";
        if (!code)
          return page(
            '<h1>Connect a device</h1><p>Enter the code shown in T3 Code.</p><form action="/auth/device" method="get"><label for="code">Device code</label><input id="code" name="user_code" required autocomplete="off" maxlength="32"><button>Continue</button></form>',
          );
        if (code.length > 32) return error("invalid_request");
        const device = yield* store.deviceView(code);
        if (!device)
          return page("<h1>Code expired</h1><p>Start sign-in again from your device.</p>", 400);
        const session = yield* store.session(readCookie(request.headers.cookie, sessionCookie));
        if (!session) {
          if (request.method === "POST") return error("access_denied", 403);
          return redirect(`/auth/login?user_code=${encodeURIComponent(code)}`);
        }
        if (request.method === "POST") {
          if (
            request.headers.origin !== config.relayIssuer ||
            !form.get("csrf") ||
            Store.hashCredential(form.get("csrf")!) !== Store.hashCredential(session.csrf)
          )
            return error("access_denied", 403);
          const decision = form.get("decision");
          if (decision !== "approve" && decision !== "deny") return error("invalid_request");
          const changed = yield* store.approve(code, session.user, decision === "approve");
          if (!changed)
            return page("<h1>Request already completed</h1><p>Return to your device.</p>", 400);
          return page(
            decision === "approve"
              ? "<h1>Device connected</h1><p>Return to T3 Code. You can close this page.</p>"
              : "<h1>Request denied</h1><p>No account access was granted.</p>",
          );
        }
        if (device.status !== "pending")
          return page("<h1>Request already completed</h1><p>Return to your device.</p>");
        return page(
          `<h1>Connect this device?</h1><p>Signed in as ${escape(session.user.email ?? session.user.name ?? session.user.id)}.</p><p>Approve only if this code matches the device you are signing in.</p><p><code>${escape(device.user_code)}</code></p><p>Application: ${escape(device.client_id)}</p><form action="/auth/device" method="post"><input type="hidden" name="user_code" value="${escape(code)}"><input type="hidden" name="csrf" value="${escape(session.csrf)}"><button name="decision" value="approve">Connect device</button><button name="decision" value="deny">Deny</button></form><form action="/auth/logout" method="post"><input type="hidden" name="csrf" value="${escape(session.csrf)}"><input type="hidden" name="user_code" value="${escape(code)}"><button>Sign out and change account</button></form><p>Account ID: ${escape(session.user.id)}</p>`,
        );
      }
      return error("not_found", 404);
    });
  return AuthBroker.of({ handle });
});
export const layer = Layer.effect(AuthBroker, make);
