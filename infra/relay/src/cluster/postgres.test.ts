// @effect-diagnostics-next-line nodeBuiltinImport:off -- Real upstream HTTP fixture exercises durable delivery.
import * as NodeHttp from "node:http";
import { describe, expect, it } from "@effect/vitest";
import * as PgClient from "@effect/sql-pg/PgClient";
import * as PgDrizzle from "drizzle-orm/effect-postgres";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import { RelayConfiguration } from "../Config.ts";
import * as PrivateHeldHooks from "./HeldHooks.ts";
import * as EnvironmentLinks from "../environments/EnvironmentLinks.ts";
import { HeldHooks } from "../hooks/HeldHooks.ts";
import { parsePrivateEndpoints } from "./config.ts";
import { RelayDb } from "../db.ts";
import { HookInbox } from "../hooks/HookInbox.ts";
import { HookRateLimiter, RELAY_HOOK_RATE_LIMIT } from "../hooks/HookForwarder.ts";
import * as Inbox from "./HookInbox.ts";
import * as RateLimiter from "./RateLimiter.ts";

const url = process.env.RELAY_CLUSTER_TEST_DATABASE_URL;
// These tests delete fixture data. Refuse any database except the disposable test DB.
if (url && new URL(url).pathname !== "/t3_relay_test")
  throw new Error("Use a disposable t3_relay_test database.");
const database = Layer.effect(RelayDb, PgDrizzle.makeWithDefaults()).pipe(
  Layer.provide(
    PgClient.layer({
      url: Redacted.make(url ?? "postgresql://localhost/t3_relay_test"),
      prepare: false,
    }),
  ),
);
const services = Layer.merge(Inbox.layer, RateLimiter.layer).pipe(Layer.provideMerge(database));
const hook = (id: string) => ({
  id,
  // @effect-diagnostics-next-line globalDate:off -- Match the real PostgreSQL clock in this integration fixture.
  receivedAt: new Date().toISOString(),
  method: "POST",
  rawHookId: "hook",
  rawToken: "secret",
  hookKey: "hook",
  query: "",
  headers: { "content-type": "application/json" },
  body: new TextEncoder().encode('{"event":true}'),
});

describe.skipIf(!url)("cluster PostgreSQL adapters", () => {
  it.effect("persists, deduplicates, caps, wakes and clears held webhooks", () =>
    Effect.gen(function* () {
      yield* Inbox.migrate;
      const { $client: sql } = yield* RelayDb;
      yield* sql`DELETE FROM relay_cluster_hook_inbox`;
      const inbox = yield* HookInbox;
      const base = { endpointKey: "fixture-endpoint", baseUrl: "https://example.test" };
      expect(yield* inbox.hold({ ...base, hook: hook("first") })).toBe(true);
      expect(yield* inbox.hold({ ...base, hook: hook("first") })).toBe(true);
      const [count] = yield* sql<{
        count: number;
      }>`SELECT count(*)::int AS count FROM relay_cluster_hook_inbox`;
      expect(count?.count).toBe(1);
      // A new adapter instance sees the same durable inbox.
      expect(yield* inbox.wake({ ...base, baseUrl: "https://new.example.test" })).toBe(true);
      const [row] = yield* sql<{
        base_url: string;
        body: Uint8Array;
      }>`SELECT base_url, body FROM relay_cluster_hook_inbox`;
      expect(row?.base_url).toBe("https://new.example.test");
      expect(new TextDecoder().decode(row?.body)).toBe('{"event":true}');
      for (let i = 1; i < 100; i++)
        expect(yield* inbox.hold({ ...base, hook: hook(`hook-${i}`) })).toBe(true);
      expect(yield* inbox.hold({ ...base, hook: hook("over-cap") })).toBe(false);
      expect(
        yield* inbox.hold({ ...base, hook: { ...hook("other-hook"), hookKey: "other" } }),
      ).toBe(true);
      yield* inbox.clear(base);
      expect(yield* inbox.wake(base)).toBe(false);
    }).pipe(Effect.provide(services)),
  );
  it.effect("retains unreachable deliveries and sends the same delivery ID after recovery", () =>
    Effect.gen(function* () {
      let status = 503;
      const ids: Array<string | undefined> = [];
      const server = NodeHttp.createServer((request, response) => {
        ids.push(request.headers["x-t3-relay-delivery-id"] as string | undefined);
        response.writeHead(status);
        response.end();
      });
      yield* Effect.promise(
        () => new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve)),
      );
      try {
        const address = server.address();
        if (!address || typeof address === "string") throw new Error("Missing fixture listener");
        yield* Effect.gen(function* () {
          yield* Inbox.migrate;
          const { $client: sql } = yield* RelayDb;
          yield* sql`DELETE FROM relay_cluster_hook_inbox`;
          const inbox = yield* HookInbox;
          const worker = yield* Inbox.DeliveryWorker;
          yield* inbox.hold({
            endpointKey: "delivery-test",
            baseUrl: `http://127.0.0.1:${address.port}/`,
            hook: hook("retry-me"),
          });
          yield* worker.drain;
          const [retained] = yield* sql<{
            failures: number;
          }>`SELECT failures FROM relay_cluster_hook_inbox WHERE id = 'retry-me'`;
          expect(retained?.failures).toBe(1);
          status = 200;
          yield* inbox.wake({
            endpointKey: "delivery-test",
            baseUrl: `http://127.0.0.1:${address.port}/`,
          });
          yield* worker.drain;
          const rows = yield* sql`SELECT id FROM relay_cluster_hook_inbox`;
          expect(rows).toHaveLength(0);
        }).pipe(Effect.provide(services));
        expect(ids).toEqual(["retry-me", "retry-me"]);
      } finally {
        yield* Effect.promise(
          () =>
            new Promise<void>((resolve, reject) =>
              server.close((error) => (error ? reject(error) : resolve())),
            ),
        );
      }
    }),
  );
  it.effect("resolves private webhook routes only while their owner link remains active", () => {
    const entries = parsePrivateEndpoints(
      '[{"userId":"fixture-user","environmentId":"fixture-env","url":"https://fixture.example.test"}]',
    );
    const config = Layer.succeed(RelayConfiguration, {
      relayIssuer: "https://relay.example.test",
      privateEndpoints: entries,
      apns: null,
      clerkSecretKey: Redacted.make("fixture"),
      clerkPublishableKey: "fixture",
      clerkJwtAudience: "fixture",
      apnsDeliveryJobSigningSecret: Redacted.make("fixture"),
      cloudMintPrivateKey: Redacted.make("fixture"),
      cloudMintPublicKey: "fixture",
      managedEndpointBaseDomain: undefined,
      managedEndpointNamespace: undefined,
    });
    const hooks = PrivateHeldHooks.layer.pipe(
      Layer.provide(EnvironmentLinks.layer),
      Layer.provideMerge(services),
      Layer.provide(config),
    );
    return Effect.gen(function* () {
      const { $client: sql } = yield* RelayDb;
      yield* sql`DELETE FROM relay_environment_links WHERE user_id = 'fixture-user'`;
      yield* sql`INSERT INTO relay_environment_links
        (user_id, environment_id, environment_public_key, endpoint_http_base_url, endpoint_ws_base_url,
         endpoint_provider_kind, managed_tunnels_enabled, hold_webhooks_while_offline, created_at, updated_at)
        VALUES ('fixture-user', 'fixture-env', 'fixture-key', 'https://fixture.example.test/', 'wss://fixture.example.test/ws',
          'manual', true, true, '2026-01-01', '2026-01-01')`;
      const held = yield* HeldHooks;
      const key = entries[0]!.endpointKey;
      expect(yield* held.resolveEndpoint(key)).toEqual({
        httpBaseUrl: "https://fixture.example.test/",
        environmentId: "fixture-env",
        holdWhileOffline: true,
      });
      expect(yield* held.resolveEndpoint("unknown")).toBeNull();
      yield* sql`UPDATE relay_environment_links SET revoked_at = '2026-01-02' WHERE user_id = 'fixture-user'`;
      expect(yield* held.resolveEndpoint(key)).toBeNull();
      yield* sql`DELETE FROM relay_environment_links WHERE user_id = 'fixture-user'`;
    }).pipe(Effect.provide(hooks));
  });
  it.effect("shares rate limits between adapter instances and resets expired windows", () =>
    Effect.gen(function* () {
      const allow = Effect.gen(function* () {
        const limiter = yield* HookRateLimiter;
        return yield* limiter.allowHook("fixture-rate");
      }).pipe(Effect.provide(services));
      yield* Effect.gen(function* () {
        yield* RateLimiter.migrate;
        const { $client: sql } = yield* RelayDb;
        yield* sql`DELETE FROM relay_cluster_rate_limits`;
      }).pipe(Effect.provide(database));
      for (let i = 0; i < RELAY_HOOK_RATE_LIMIT.limit; i++) expect(yield* allow).toBe(true);
      expect(yield* allow).toBe(false);
      yield* Effect.gen(function* () {
        const { $client: sql } = yield* RelayDb;
        yield* sql`UPDATE relay_cluster_rate_limits SET reset_at = now() - interval '1 second'`;
      }).pipe(Effect.provide(database));
      expect(yield* allow).toBe(true);
    }),
  );
});
