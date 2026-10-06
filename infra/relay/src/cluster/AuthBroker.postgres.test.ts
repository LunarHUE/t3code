import * as NodeCrypto from "node:crypto";
import { describe, expect, it } from "@effect/vitest";
import * as PgClient from "@effect/sql-pg/PgClient";
import * as PgDrizzle from "drizzle-orm/effect-postgres";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import { RelayDb } from "../db.ts";
import * as Broker from "../auth/BrokerStore.ts";
import * as AuthBroker from "../auth/AuthBroker.ts";
import * as OidcClient from "../auth/OidcClient.ts";
import { RelayConfiguration } from "../Config.ts";

const decodeDevice = Schema.decodeEffect(
  Schema.fromJsonString(Schema.Struct({ user_code: Schema.String, device_code: Schema.String })),
);
const decodeToken = Schema.decodeEffect(
  Schema.fromJsonString(
    Schema.Struct({
      access_token: Schema.String,
      refresh_token: Schema.String,
      user: Schema.Struct({ id: Schema.String }),
    }),
  ),
);
const decodeJson = Schema.decodeEffect(Schema.fromJsonString(Schema.Unknown));
const url = process.env.RELAY_CLUSTER_TEST_DATABASE_URL;
if (url && new URL(url).pathname !== "/t3_relay_test") {
  throw new Error("Use a disposable t3_relay_test database.");
}
const database = Layer.effect(RelayDb, PgDrizzle.makeWithDefaults()).pipe(
  Layer.provide(
    PgClient.layer({
      url: Redacted.make(url ?? "postgresql://localhost/t3_relay_test"),
      prepare: false,
    }),
  ),
);
const services = Broker.layer.pipe(Layer.provideMerge(database));
const user = { id: "oidc_fixture", name: "Fixture" };
const client = "t3-code-cli";
const fixture = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    yield* Broker.migrate;
    return yield* effect;
  }).pipe(Effect.provide(services));
const approvedGrant = Effect.gen(function* () {
  const store = yield* Broker.BrokerStore;
  const device = yield* store.createDevice(client);
  expect(yield* store.approve(device.user_code, user, true)).toBe(true);
  const result = yield* store.poll(device.device_code, client, 3600);
  if ("error" in result) throw new Error(result.error);
  return result;
});

describe.skipIf(!url)("OIDC broker PostgreSQL lifecycle", () => {
  it.effect("requires approval, enforces polling interval and binds grants to the client", () =>
    fixture(
      Effect.gen(function* () {
        const store = yield* Broker.BrokerStore;
        const device = yield* store.createDevice(client);
        expect(yield* store.poll(device.device_code, "other-client", 3600)).toEqual({
          error: "invalid_grant",
        });
        expect(yield* store.poll(device.device_code, client, 3600)).toEqual({
          error: "authorization_pending",
        });
        expect(yield* store.poll(device.device_code, client, 3600)).toEqual({ error: "slow_down" });
        expect(yield* store.approve(device.user_code, user, false)).toBe(true);
        expect(yield* store.approve(device.user_code, user, true)).toBe(false);
        expect(yield* store.poll(device.device_code, client, 3600)).toEqual({
          error: "access_denied",
        });
      }),
    ),
  );

  it.effect("redeems an approved device only once across concurrent callers", () =>
    fixture(
      Effect.gen(function* () {
        const store = yield* Broker.BrokerStore;
        const device = yield* store.createDevice(client);
        yield* store.approve(device.user_code, user, true);
        const results = yield* Effect.all(
          [
            store.poll(device.device_code, client, 3600),
            store.poll(device.device_code, client, 3600),
          ],
          { concurrency: "unbounded" },
        );
        expect(results.filter((result) => "refreshToken" in result)).toHaveLength(1);
        expect(results.filter((result) => "error" in result)).toEqual([{ error: "invalid_grant" }]);
        const { $client: sql } = yield* RelayDb;
        const [row] = yield* sql<{
          code_hash: string;
        }>`SELECT code_hash FROM relay_auth_devices WHERE user_code=${Broker.normalizeUserCode(device.user_code)}`;
        expect(row?.code_hash).toBe(Broker.hashCredential(device.device_code));
        expect(row?.code_hash).not.toBe(device.device_code);
      }),
    ),
  );

  it.effect("rotates refresh credentials and commits family revocation after reuse", () =>
    fixture(
      Effect.gen(function* () {
        const store = yield* Broker.BrokerStore;
        const first = yield* approvedGrant;
        expect(yield* store.refresh(first.refreshToken, "other-client")).toEqual({
          error: "invalid_grant",
        });
        const second = yield* store.refresh(first.refreshToken, client);
        if ("error" in second) throw new Error(second.error);
        expect(second.refreshToken).not.toBe(first.refreshToken);
        expect(second.user).toEqual(user);
        expect(yield* store.refresh(first.refreshToken, client)).toEqual({
          error: "invalid_grant",
        });
        expect(yield* store.refresh(second.refreshToken, client)).toEqual({
          error: "invalid_grant",
        });
      }),
    ),
  );

  it.effect("serializes concurrent refresh and rejects credentials after explicit revoke", () =>
    fixture(
      Effect.gen(function* () {
        const store = yield* Broker.BrokerStore;
        const first = yield* approvedGrant;
        const results = yield* Effect.all(
          [store.refresh(first.refreshToken, client), store.refresh(first.refreshToken, client)],
          { concurrency: "unbounded" },
        );
        expect(results.filter((result) => "refreshToken" in result)).toHaveLength(1);
        expect(results.filter((result) => "error" in result)).toHaveLength(1);
        const fresh = yield* approvedGrant;
        yield* store.revoke(fresh.refreshToken, "other-client");
        const rotated = yield* store.refresh(fresh.refreshToken, client);
        if ("error" in rotated) throw new Error(rotated.error);
        yield* store.revoke(fresh.refreshToken, client);
        expect(yield* store.refresh(rotated.refreshToken, client)).toEqual({
          error: "invalid_grant",
        });
      }),
    ),
  );

  it.effect("binds callback state to the browser and consumes it once", () =>
    fixture(
      Effect.gen(function* () {
        const store = yield* Broker.BrokerStore;
        const login = yield* store.createLogin("ABCDEF-123456");
        expect(yield* store.consumeLogin(login.state, "different-browser")).toBeUndefined();
        const results = yield* Effect.all(
          [
            store.consumeLogin(login.state, login.browser),
            store.consumeLogin(login.state, login.browser),
          ],
          { concurrency: "unbounded" },
        );
        expect(results.filter(Boolean)).toHaveLength(1);
        expect(results.find(Boolean)?.userCode).toBe("ABCDEF123456");
      }),
    ),
  );

  it.effect("enforces device, session and absolute refresh expiry without waiting", () =>
    fixture(
      Effect.gen(function* () {
        const store = yield* Broker.BrokerStore;
        const { $client: sql } = yield* RelayDb;
        const device = yield* store.createDevice(client);
        yield* sql`UPDATE relay_auth_devices SET expires_at=now()-interval '1 second' WHERE code_hash=${Broker.hashCredential(device.device_code)}`;
        expect(yield* store.approve(device.user_code, user, true)).toBe(false);
        expect(yield* store.poll(device.device_code, client, 3600)).toEqual({
          error: "expired_token",
        });
        const session = yield* store.createSession(user, 3600);
        expect((yield* store.session(session))?.user).toEqual(user);
        yield* sql`UPDATE relay_auth_sessions SET expires_at=now()-interval '1 second' WHERE token_hash=${Broker.hashCredential(session)}`;
        expect(yield* store.session(session)).toBeUndefined();
        const grant = yield* approvedGrant;
        yield* sql`UPDATE relay_auth_families SET expires_at=now()-interval '1 second' WHERE id IN (SELECT family_id FROM relay_auth_refresh WHERE token_hash=${Broker.hashCredential(grant.refreshToken)})`;
        expect(yield* store.refresh(grant.refreshToken, client)).toEqual({
          error: "invalid_grant",
        });
        yield* store.prune;
        const rows =
          yield* sql`SELECT token_hash FROM relay_auth_refresh WHERE token_hash=${Broker.hashCredential(grant.refreshToken)}`;
        expect(rows).toHaveLength(0);
      }),
    ),
  );
});

const keys = NodeCrypto.generateKeyPairSync("ed25519");
const brokerConfiguration = Layer.succeed(RelayConfiguration, {
  relayIssuer: "https://relay.example.test",
  oidc: {
    issuerUrl: "https://issuer.example.test",
    clientId: "fixture",
    clientSecret: Redacted.make("fixture"),
    redirectUri: "https://relay.example.test/auth/callback",
    scopes: "openid profile email",
    refreshLifetimeSeconds: 3600,
  },
  apns: null,
  apnsDeliveryJobSigningSecret: Redacted.make("unused"),
  cloudMintPrivateKey: Redacted.make(
    keys.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
  ),
  cloudMintPublicKey: keys.publicKey.export({ type: "spki", format: "pem" }).toString(),
  managedEndpointBaseDomain: undefined,
  managedEndpointNamespace: undefined,
});
const broker = AuthBroker.layer.pipe(
  Layer.provideMerge(services),
  Layer.provide(brokerConfiguration),
  Layer.provide(
    Layer.succeed(OidcClient.OidcClient, {
      authorize: ({ state }) =>
        Effect.succeed(`https://issuer.example.test/authorize?state=${state}`),
      callback: () => Effect.succeed(user),
    }),
  ),
);
const requestAddress = `fixture-http-${NodeCrypto.randomUUID()}`;
const request = (
  method: string,
  path: string,
  fields: Record<string, string> = {},
  headers: Record<string, string> = {},
) => ({
  method,
  path,
  query: method === "GET" ? new URLSearchParams(fields).toString() : "",
  body: method === "POST" ? new URLSearchParams(fields).toString() : "",
  headers: { "content-type": "application/x-www-form-urlencoded", ...headers },
  address: requestAddress,
});

describe.skipIf(!url)("OIDC browser approval with durable storage", () => {
  it.effect(
    "requires explicit CSRF-protected approval after login and revokes refresh on logout",
    () =>
      Effect.gen(function* () {
        yield* Broker.migrate;
        const service = yield* AuthBroker.AuthBroker;
        const deviceResponse = yield* service.handle(
          request("POST", "/auth/device", { client_id: "t3-cli" }),
        );
        expect(deviceResponse.status).toBe(200);
        const device = yield* decodeDevice(deviceResponse.body);
        const login = yield* service.handle(
          request("GET", "/auth/login", { user_code: device.user_code }),
        );
        expect(login.status).toBe(303);
        const state = new URL(login.headers.location!).searchParams.get("state")!;
        const loginCookie = login.headers["set-cookie"]!.split(";")[0]!;
        const noCookie = yield* service.handle(
          request("GET", "/auth/callback", { state, code: "fixture" }),
        );
        expect(noCookie.status).toBe(400);
        const callback = yield* service.handle(
          request("GET", "/auth/callback", { state, code: "fixture" }, { cookie: loginCookie }),
        );
        expect(callback.status).toBe(303);
        const sessionCookie = callback.headers["set-cookie"]!.split(";")[0]!;
        const replay = yield* service.handle(
          request("GET", "/auth/callback", { state, code: "fixture" }, { cookie: loginCookie }),
        );
        expect(replay.status).toBe(400);
        const store = yield* Broker.BrokerStore;
        expect((yield* store.deviceView(device.user_code))?.status).toBe("pending");
        const approvePage = yield* service.handle(
          request(
            "GET",
            "/auth/device",
            { user_code: device.user_code },
            { cookie: sessionCookie },
          ),
        );
        const csrf = /name="csrf" value="([^"]+)"/u.exec(approvePage.body)?.[1];
        expect(csrf).toBeTruthy();
        const approval = { user_code: device.user_code, decision: "approve", csrf: csrf! };
        expect(
          (yield* service.handle(
            request("POST", "/auth/device", approval, {
              cookie: sessionCookie,
              origin: "https://attacker.example",
            }),
          )).status,
        ).toBe(403);
        expect(
          (yield* service.handle(
            request(
              "POST",
              "/auth/device",
              { ...approval, csrf: "incorrect" },
              { cookie: sessionCookie, origin: "https://relay.example.test" },
            ),
          )).status,
        ).toBe(403);
        expect((yield* store.deviceView(device.user_code))?.status).toBe("pending");
        expect(
          (yield* service.handle(
            request("POST", "/auth/device", approval, {
              cookie: sessionCookie,
              origin: "https://relay.example.test",
            }),
          )).status,
        ).toBe(200);
        const tokenResponse = yield* service.handle(
          request("POST", "/auth/token", {
            client_id: "t3-cli",
            grant_type: "urn:ietf:params:oauth:grant-type:device_code",
            device_code: device.device_code,
          }),
        );
        expect(tokenResponse.status).toBe(200);
        const token = yield* decodeToken(tokenResponse.body);
        expect(token.user.id).toBe(user.id);
        const me = yield* service.handle(
          request("GET", "/auth/me", {}, { authorization: `Bearer ${token.access_token}` }),
        );
        expect(yield* decodeJson(me.body)).toEqual(user);
        expect(
          (yield* service.handle(
            request("POST", "/auth/revoke", { client_id: "t3-cli", token: token.refresh_token }),
          )).status,
        ).toBe(204);
        const revoked = yield* service.handle(
          request("POST", "/auth/token", {
            client_id: "t3-cli",
            grant_type: "refresh_token",
            refresh_token: token.refresh_token,
          }),
        );
        expect(yield* decodeJson(revoked.body)).toEqual({ error: "invalid_grant" });
        const signout = yield* service.handle(
          request(
            "POST",
            "/auth/logout",
            { csrf: csrf! },
            { cookie: sessionCookie, origin: "https://relay.example.test" },
          ),
        );
        expect(signout.status).toBe(303);
        expect(yield* store.session(sessionCookie.split("=")[1]!)).toBeUndefined();
      }).pipe(Effect.provide(broker)),
  );
});
