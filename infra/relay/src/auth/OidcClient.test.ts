import * as NodeCrypto from "node:crypto";
import { describe, expect, it } from "@effect/vitest";
import { afterEach, vi } from "vite-plus/test";
import * as Schema from "effect/Schema";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import { RelayConfiguration } from "../Config.ts";
import * as OidcClient from "./OidcClient.ts";
import { accountUserId } from "./AccountTokens.ts";
const issuer = "https://identity.example.test";
const metadata = {
  issuer,
  authorization_endpoint: `${issuer}/authorize`,
  token_endpoint: `${issuer}/token`,
  jwks_uri: `${issuer}/jwks`,
  response_types_supported: ["code"],
  subject_types_supported: ["public"],
  id_token_signing_alg_values_supported: ["RS256"],
  token_endpoint_auth_methods_supported: ["client_secret_post"],
};
const keys = NodeCrypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
const privatePem = keys.privateKey.export({ format: "pem", type: "pkcs8" }).toString();
const jwk = { ...keys.publicKey.export({ format: "jwk" }), kid: "test", use: "sig", alg: "RS256" };
const signing = NodeCrypto.generateKeyPairSync("ed25519", {
  privateKeyEncoding: { format: "pem", type: "pkcs8" },
  publicKeyEncoding: { format: "pem", type: "spki" },
});
const config = RelayConfiguration.of({
  relayIssuer: "https://relay.test",
  oidc: {
    issuerUrl: issuer,
    clientId: "broker",
    clientSecret: Redacted.make("secret"),
    redirectUri: "https://relay.test/auth/callback",
    scopes: "openid profile email",
    refreshLifetimeSeconds: 604800,
  },
  apns: null,
  apnsDeliveryJobSigningSecret: Redacted.make("disabled"),
  cloudMintPrivateKey: Redacted.make(signing.privateKey),
  cloudMintPublicKey: signing.publicKey,
  managedEndpointBaseDomain: undefined,
  managedEndpointNamespace: undefined,
});
const layer = OidcClient.layer.pipe(Layer.provide(Layer.succeed(RelayConfiguration, config)));
function fixture(
  options: {
    nonce?: string;
    audience?: string;
    discoveredIssuer?: string;
    invalidSignature?: boolean;
    basicOnly?: boolean;
  } = {},
) {
  const fetch = vi.fn(async (input: Request | string | URL, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url.includes(".well-known"))
      return Response.json({
        ...metadata,
        issuer: options.discoveredIssuer ?? issuer,
        token_endpoint_auth_methods_supported: [
          options.basicOnly ? "client_secret_basic" : "client_secret_post",
        ],
      });
    if (url.endsWith("/jwks")) return Response.json({ keys: [jwk] });
    if (url.endsWith("/token")) {
      const headers = new Headers(init?.headers);
      const body = new URLSearchParams(String(init?.body ?? ""));
      if (options.basicOnly) {
        expect(headers.get("authorization")).toBe(
          `Basic ${Buffer.from("broker:secret").toString("base64")}`,
        );
        expect(body.has("client_secret")).toBe(false);
      } else {
        expect(headers.has("authorization")).toBe(false);
        expect(body.get("client_secret")).toBe("secret");
      }
      // @effect-diagnostics-next-line globalDate:off -- The external OAuth library validates against the real clock.
      const now = Math.floor(Date.now() / 1000);
      const encode = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
      const header = Buffer.from(encode({ alg: "RS256", kid: "test" })).toString("base64url");
      const payload = Buffer.from(
        encode({
          nonce: options.nonce ?? "nonce",
          email: "person@example.test",
          iss: issuer,
          sub: "person",
          aud: options.audience ?? "broker",
          iat: now,
          exp: now + 300,
        }),
      ).toString("base64url");
      const unsigned = `${header}.${payload}`;
      const signature = NodeCrypto.sign("RSA-SHA256", Buffer.from(unsigned), privatePem);
      if (options.invalidSignature) signature[0] = signature[0]! ^ 255;
      const id_token = `${unsigned}.${signature.toString("base64url")}`;
      return Response.json({
        access_token: "unused-upstream-token",
        token_type: "Bearer",
        expires_in: 300,
        id_token,
      });
    }
    throw new Error("Unexpected fixture endpoint.");
  });
  vi.stubGlobal("fetch", fetch);
  return fetch;
}
afterEach(() => vi.unstubAllGlobals());
describe("OIDC upstream client", () => {
  it.effect("discovers lazily, binds PKCE/state/nonce and validates the signed account", () =>
    Effect.gen(function* () {
      const fetch = fixture();
      const client = yield* OidcClient.OidcClient;
      expect(fetch).not.toHaveBeenCalled();
      const input = { state: "state", nonce: "nonce", verifier: "a".repeat(43) };
      const url = new URL(yield* client.authorize(input));
      expect(url.searchParams.get("state")).toBe("state");
      expect(url.searchParams.get("nonce")).toBe("nonce");
      expect(url.searchParams.get("code_challenge_method")).toBe("S256");
      expect(url.searchParams.has("client_secret")).toBe(false);
      expect(
        yield* client.callback({
          ...input,
          url: "https://relay.test/auth/callback?code=code&state=state",
        }),
      ).toEqual({ id: accountUserId(issuer, "person"), email: "person@example.test" });
      expect(fetch.mock.calls.some(([url]) => String(url).includes("jwks"))).toBe(true);
    }).pipe(Effect.provide(layer)),
  );
  it.effect("authenticates to a basic-only token endpoint through the Authorization header", () =>
    Effect.gen(function* () {
      fixture({ basicOnly: true });
      const client = yield* OidcClient.OidcClient;
      expect(
        yield* client.callback({
          state: "state",
          nonce: "nonce",
          verifier: "a".repeat(43),
          url: "https://relay.test/auth/callback?code=code&state=state",
        }),
      ).toMatchObject({ id: accountUserId(issuer, "person") });
    }).pipe(
      Effect.provide(
        OidcClient.layer.pipe(
          Layer.provide(
            Layer.succeed(RelayConfiguration, {
              ...config,
              oidc: { ...config.oidc!, tokenEndpointAuthMethod: "client_secret_basic" },
            }),
          ),
        ),
      ),
    ),
  );
  it.effect("rejects wrong callback state before exchanging a code", () =>
    Effect.gen(function* () {
      const fetch = fixture();
      const client = yield* OidcClient.OidcClient;
      expect(
        yield* client
          .callback({
            state: "state",
            nonce: "nonce",
            verifier: "a".repeat(43),
            url: "https://relay.test/auth/callback?code=code&state=wrong",
          })
          .pipe(Effect.isFailure),
      ).toBe(true);
      expect(fetch.mock.calls.some(([url]) => String(url).endsWith("/token"))).toBe(false);
    }).pipe(Effect.provide(layer)),
  );
  it.effect("rejects a mismatched nonce", () =>
    Effect.gen(function* () {
      fixture({ nonce: "wrong" });
      const client = yield* OidcClient.OidcClient;
      expect(
        yield* client
          .callback({
            state: "state",
            nonce: "nonce",
            verifier: "a".repeat(43),
            url: "https://relay.test/auth/callback?code=code&state=state",
          })
          .pipe(Effect.isFailure),
      ).toBe(true);
    }).pipe(Effect.provide(layer)),
  );
  it.effect.each([
    { name: "client audience", audience: "wrong-client" },
    { name: "provider signature", invalidSignature: true },
  ])("rejects invalid $name", (options) =>
    Effect.gen(function* () {
      fixture(options);
      const client = yield* OidcClient.OidcClient;
      expect(
        yield* client
          .callback({
            state: "state",
            nonce: "nonce",
            verifier: "a".repeat(43),
            url: "https://relay.test/auth/callback?code=code&state=state",
          })
          .pipe(Effect.isFailure),
      ).toBe(true);
    }).pipe(Effect.provide(layer)),
  );
  it.effect("rejects discovery from a different issuer", () =>
    Effect.gen(function* () {
      fixture({ discoveredIssuer: "https://wrong.example.test" });
      const client = yield* OidcClient.OidcClient;
      expect(
        yield* client
          .authorize({ state: "state", nonce: "nonce", verifier: "a".repeat(43) })
          .pipe(Effect.isFailure),
      ).toBe(true);
    }).pipe(Effect.provide(layer)),
  );
});
