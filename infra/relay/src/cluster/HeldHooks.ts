import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { RelayDb } from "../db.ts";
import { RelayConfiguration } from "../Config.ts";
import * as EnvironmentLinks from "../environments/EnvironmentLinks.ts";
import { HeldHooks } from "../hooks/HeldHooks.ts";
import { HookInbox } from "../hooks/HookInbox.ts";

export const layer = Layer.effect(
  HeldHooks,
  Effect.gen(function* () {
    const config = yield* RelayConfiguration;
    const links = yield* EnvironmentLinks.EnvironmentLinks;
    const inbox = yield* HookInbox;
    const entries = config.privateEndpoints ?? [];
    const { $client: sql } = yield* RelayDb;
    const find = (entry: (typeof entries)[number]) =>
      sql<{
        readonly environment_public_key: string;
        readonly hold_webhooks_while_offline: boolean;
        readonly endpoint_provider_kind: string;
        readonly endpoint_http_base_url: string;
      }>`SELECT environment_public_key, hold_webhooks_while_offline, endpoint_provider_kind, endpoint_http_base_url
      FROM relay_environment_links WHERE user_id = ${entry.userId} AND environment_id = ${entry.environmentId}
      AND revoked_at IS NULL AND managed_tunnels_enabled = true`.pipe(
        Effect.map((rows) => rows[0]),
        Effect.mapError(
          (cause) =>
            new EnvironmentLinks.EnvironmentLinkEnvironmentLookupPersistenceError({
              environmentId: entry.environmentId,
              cause,
            }),
        ),
      );
    const resolveEndpoint: HeldHooks["Service"]["resolveEndpoint"] = Effect.fn(
      function* (endpointKey) {
        const entry = entries.find((item) => item.endpointKey === endpointKey);
        if (!entry) return null;
        const link = yield* find(entry);
        if (
          !link ||
          link.endpoint_provider_kind !== "manual" ||
          link.endpoint_http_base_url !== entry.httpBaseUrl
        )
          return null;
        return {
          httpBaseUrl: entry.httpBaseUrl,
          environmentId: entry.environmentId,
          holdWhileOffline: link.hold_webhooks_while_offline,
        };
      },
    );
    const own = Effect.fn(function* (input: {
      readonly environmentId: string;
      readonly environmentPublicKey: string;
    }) {
      const owned: Array<(typeof entries)[number]> = [];
      for (const entry of entries.filter((item) => item.environmentId === input.environmentId)) {
        const link = yield* find(entry);
        if (link?.environment_public_key === input.environmentPublicKey) owned.push(entry);
      }
      return owned;
    });
    return HeldHooks.of({
      resolveEndpoint,
      setHoldWhileOffline: Effect.fn(function* (input) {
        yield* links.setHoldWebhooksWhileOffline(input);
        if (!input.holdWebhooksWhileOffline) {
          for (const entry of yield* own(input)) yield* inbox.clear(entry);
        }
      }),
      wake: Effect.fn(function* (input) {
        let pending = false;
        for (const entry of yield* own(input)) {
          pending =
            (yield* inbox.wake({ endpointKey: entry.endpointKey, baseUrl: entry.httpBaseUrl })) ||
            pending;
        }
        return pending;
      }),
    });
  }),
);
