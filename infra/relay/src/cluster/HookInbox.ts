import type * as SqlError from "effect/sql/SqlError";
import * as Schema from "effect/Schema";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import { RelayDb } from "../db.ts";
import { HookInbox, HookInboxError } from "../hooks/HookInbox.ts";
import type { HeldHook } from "../hooks/HookInboxStore.ts";
import { sendUpstream, TUNNEL_OFFLINE_STATUS } from "../hooks/upstream.ts";
import * as FetchHttpClient from "effect/http/FetchHttpClient";

// A separate table leaves upstream Drizzle migrations unchanged.
export const migrate = Effect.gen(function* () {
  const { $client: sql } = yield* RelayDb;
  yield* sql`CREATE TABLE IF NOT EXISTS relay_cluster_hook_inbox (
    id text PRIMARY KEY, endpoint_key text NOT NULL, base_url text NOT NULL,
    hook_key text NOT NULL, payload jsonb NOT NULL, body bytea NOT NULL,
    received_at timestamptz NOT NULL, next_attempt_at timestamptz NOT NULL DEFAULT now(),
    failures integer NOT NULL DEFAULT 0
  )`;
  yield* sql`CREATE INDEX IF NOT EXISTS relay_cluster_hook_due
    ON relay_cluster_hook_inbox (next_attempt_at, received_at)`;
});

export class DeliveryWorker extends Context.Service<
  DeliveryWorker,
  {
    readonly drain: Effect.Effect<void, SqlError.SqlError>;
  }
>()("t3code-relay/cluster/HookInbox/DeliveryWorker") {}

interface Row {
  readonly id: string;
  readonly endpoint_key: string;
  readonly base_url: string;
  readonly payload: Omit<HeldHook, "body">;
  readonly body: Uint8Array;
  readonly failures: number;
}

const encodePayload = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));

export const layer = Layer.unwrap(
  Effect.gen(function* () {
    const { $client: sql } = yield* RelayDb;
    const lock = (key: string) => sql`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`;
    const mapError =
      (operation: HookInboxError["operation"], endpointKey: string) => (cause: unknown) =>
        new HookInboxError({ operation, endpointKey, cause });
    const inbox = HookInbox.of({
      hold: ({ endpointKey, baseUrl, hook }) =>
        sql
          .withTransaction(
            Effect.gen(function* () {
              yield* lock(endpointKey);
              yield* sql`DELETE FROM relay_cluster_hook_inbox WHERE endpoint_key = ${endpointKey}
        AND received_at < now() - interval '24 hours'`;
              const duplicate =
                yield* sql`SELECT id FROM relay_cluster_hook_inbox WHERE id = ${hook.id}`;
              if (duplicate.length) return true;
              const [size] = yield* sql<{ count: number; bytes: number; hook_count: number }>`
        SELECT count(*)::int AS count, coalesce(sum(octet_length(body)), 0)::int AS bytes,
          count(*) FILTER (WHERE hook_key = ${hook.hookKey})::int AS hook_count
        FROM relay_cluster_hook_inbox WHERE endpoint_key = ${endpointKey}`;
              if (
                !size ||
                size.count >= 1000 ||
                size.hook_count >= 100 ||
                size.bytes + hook.body.byteLength > 50 * 1048576
              )
                return false;
              const { body, ...payload } = hook;
              const encoded = yield* encodePayload(payload).pipe(Effect.orDie);
              yield* sql`INSERT INTO relay_cluster_hook_inbox
        (id, endpoint_key, base_url, hook_key, payload, body, received_at)
        VALUES (${hook.id}, ${endpointKey}, ${baseUrl}, ${hook.hookKey},
          ${encoded}::jsonb, ${Buffer.from(body)}, ${hook.receivedAt}::timestamptz)
        ON CONFLICT (id) DO NOTHING`;
              return true;
            }),
          )
          .pipe(Effect.mapError(mapError("hold", endpointKey))),
      wake: ({ endpointKey, baseUrl }) =>
        sql
          .withTransaction(
            Effect.gen(function* () {
              yield* lock(endpointKey);
              const rows = yield* sql`UPDATE relay_cluster_hook_inbox SET base_url = ${baseUrl},
        next_attempt_at = now(), failures = 0 WHERE endpoint_key = ${endpointKey} RETURNING id`;
              return rows.length > 0;
            }),
          )
          .pipe(Effect.mapError(mapError("wake", endpointKey))),
      clear: ({ endpointKey }) =>
        sql
          .withTransaction(
            Effect.gen(function* () {
              yield* lock(endpointKey);
              yield* sql`DELETE FROM relay_cluster_hook_inbox WHERE endpoint_key = ${endpointKey}`;
            }),
          )
          .pipe(Effect.mapError(mapError("clear", endpointKey))),
    });
    const drain = Effect.gen(function* () {
      yield* sql`DELETE FROM relay_cluster_hook_inbox WHERE received_at < now() - interval '24 hours'`;
      for (let index = 0; index < 20; index++) {
        const attempted = yield* sql.withTransaction(
          Effect.gen(function* () {
            // Serializes delivery processes, including overlapping pod rollouts.
            const [locked] = yield* sql<{
              acquired: boolean;
            }>`SELECT pg_try_advisory_xact_lock(782301915) AS acquired`;
            if (!locked?.acquired) return false;
            const [candidate] = yield* sql<Row>`SELECT * FROM relay_cluster_hook_inbox
          WHERE next_attempt_at <= now() ORDER BY received_at, id LIMIT 1`;
            if (!candidate) return false;
            yield* lock(candidate.endpoint_key);
            const [row] =
              yield* sql<Row>`SELECT * FROM relay_cluster_hook_inbox WHERE id = ${candidate.id}
          AND next_attempt_at <= now() FOR UPDATE`;
            if (!row) return true;
            const result = yield* sendUpstream(row.base_url, {
              ...row.payload,
              body: row.body,
            }).pipe(Effect.result);
            const status =
              Result.isSuccess(result) && Option.isSome(result.success)
                ? result.success.value.status
                : 503;
            if (![429, 500, 502, 503, 504, TUNNEL_OFFLINE_STATUS].includes(status)) {
              yield* sql`DELETE FROM relay_cluster_hook_inbox WHERE id = ${row.id}`;
            } else if (status === 429 || status === 500) {
              yield* sql`UPDATE relay_cluster_hook_inbox SET next_attempt_at = now() + interval '30 seconds'
            WHERE endpoint_key = ${row.endpoint_key} AND hook_key = ${row.payload.hookKey}`;
            } else {
              const delay = Math.min(600, 10 * 2 ** Math.min(row.failures, 6));
              yield* sql`UPDATE relay_cluster_hook_inbox SET next_attempt_at = now() + ${delay} * interval '1 second',
            failures = failures + 1 WHERE endpoint_key = ${row.endpoint_key}`;
            }
            return true;
          }),
        );
        if (!attempted) break;
      }
    }).pipe(Effect.provide(FetchHttpClient.layer));
    return Layer.merge(Layer.succeed(HookInbox, inbox), Layer.succeed(DeliveryWorker, { drain }));
  }),
);
