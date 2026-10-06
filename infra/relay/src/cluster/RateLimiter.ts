import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { RelayDb } from "../db.ts";
import {
  HookRateLimiter,
  RELAY_HOOK_RATE_LIMIT,
  RELAY_HOOK_ENDPOINT_RATE_LIMIT,
} from "../hooks/HookForwarder.ts";

export const migrate = Effect.gen(function* () {
  const { $client: sql } = yield* RelayDb;
  yield* sql`CREATE TABLE IF NOT EXISTS relay_cluster_rate_limits (
    key text PRIMARY KEY, hits integer NOT NULL, reset_at timestamptz NOT NULL
  )`;
});

export const layer = Layer.effect(
  HookRateLimiter,
  Effect.gen(function* () {
    const { $client: sql } = yield* RelayDb;
    const allow = (namespace: string, limit: number, seconds: number) => (key: string) =>
      sql<{ hits: number }>`INSERT INTO relay_cluster_rate_limits (key, hits, reset_at)
      VALUES (${namespace + key}, 1, now() + ${seconds} * interval '1 second')
      ON CONFLICT (key) DO UPDATE SET
        hits = CASE WHEN relay_cluster_rate_limits.reset_at <= now() THEN 1 ELSE relay_cluster_rate_limits.hits + 1 END,
        reset_at = CASE WHEN relay_cluster_rate_limits.reset_at <= now() THEN excluded.reset_at ELSE relay_cluster_rate_limits.reset_at END
      RETURNING hits`.pipe(
        Effect.map((rows) => (rows[0]?.hits ?? limit + 1) <= limit),
        // Match the upstream boundary: a limiter outage does not drop accepted webhooks.
        Effect.catch(() =>
          Effect.logWarning("Cluster hook limiter unavailable").pipe(Effect.as(true)),
        ),
      );
    return HookRateLimiter.of({
      allowHook: allow("hook:", RELAY_HOOK_RATE_LIMIT.limit, RELAY_HOOK_RATE_LIMIT.periodSeconds),
      allowEndpoint: allow(
        "endpoint:",
        RELAY_HOOK_ENDPOINT_RATE_LIMIT.limit,
        RELAY_HOOK_ENDPOINT_RATE_LIMIT.periodSeconds,
      ),
    });
  }),
);
