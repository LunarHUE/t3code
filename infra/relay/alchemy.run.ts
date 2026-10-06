// @effect-diagnostics anyUnknownInErrorContext:off layerMergeAllWithDependencies:off - Alchemy provider helpers expose framework-owned any requirements.
import * as Alchemy from "alchemy";
import * as Output from "alchemy/Output";
import * as Axiom from "alchemy/Axiom";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Drizzle from "alchemy/Drizzle";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import { databaseProvider } from "./src/externalDatabase.ts";
import { telemetryEnabled } from "./src/Config.ts";
import * as Planetscale from "alchemy/Planetscale";

import { PublishClientConfig, tokenDigest } from "./src/clientConfig.ts";
import * as RelayDb from "./src/db.ts";
import { RelayObservability } from "./src/observability.ts";
import { ManagedEndpointZone, RelayApiZone } from "./src/zone.ts";
import * as RelayWorker from "./src/worker.ts";

export default Alchemy.Stack(
  "T3CodeRelay",
  {
    providers: Layer.mergeAll(
      Layer.unwrap(
        Effect.map(telemetryEnabled, (enabled) => (enabled ? Axiom.providers() : Layer.empty)).pipe(
          Effect.orDie,
        ),
      ),
      Cloudflare.providers(),
      Drizzle.providers(),
      Layer.unwrap(
        Effect.map(databaseProvider, (provider) =>
          provider === "planetscale" ? Planetscale.providers() : Layer.empty,
        ).pipe(Effect.orDie),
      ),
    ),
    state: Cloudflare.state(),
  },
  Effect.gen(function* () {
    const db = yield* RelayDb.ConfiguredDatabase;
    const hyperdrive = yield* RelayDb.RelayHyperdrive;
    const managedEndpointZone = yield* ManagedEndpointZone.pipe(Effect.orDie);
    const relayApiZone = yield* RelayApiZone.pipe(Effect.orDie);
    const observability = yield* RelayObservability;
    const api = yield* RelayWorker.Api;
    yield* PublishClientConfig({
      url: api.url,
      mobileTracingUrl: observability?.traces.otelTracesEndpoint ?? "",
      mobileTracingDataset: observability?.traces.name ?? "",
      mobileTracingToken: observability?.mobileIngestToken.token ?? Redacted.make(""),
      clientTracingUrl: observability?.traces.otelTracesEndpoint ?? "",
      clientTracingDataset: observability?.traces.name ?? "",
      clientTracingToken: observability?.clientIngestToken.token ?? Redacted.make(""),
      tokenDigest: observability
        ? Output.map(
            Output.all(
              observability.mobileIngestToken.token,
              observability.clientIngestToken.token,
            ),
            tokenDigest,
          )
        : tokenDigest([Redacted.make(""), Redacted.make("")]),
    });

    return {
      databaseName: db.databaseName,
      databaseBranchName: db.branchName,
      hyperdriveName: hyperdrive.name,
      workerName: api.workerName,
      url: api.url,
      relayApiZoneId: relayApiZone.zoneId,
      managedEndpointZoneId: managedEndpointZone.zoneId,
      mobileTracingUrl: observability?.traces.otelTracesEndpoint ?? "",
      mobileTracingDataset: observability?.traces.name ?? "",
      mobileTracingToken: observability?.mobileIngestToken.token ?? Redacted.make(""),
      clientTracingUrl: observability?.traces.otelTracesEndpoint ?? "",
      clientTracingDataset: observability?.traces.name ?? "",
      clientTracingToken: observability?.clientIngestToken.token ?? Redacted.make(""),
    };
  }).pipe(Effect.provide(RelayWorker.layer)),
);
