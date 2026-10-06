// @effect-diagnostics-next-line nodeBuiltinImport:off -- NodeHttpServer requires the native server factory.
import * as NodeHttp from "node:http";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as Config from "effect/Config";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpMiddleware from "effect/http/HttpMiddleware";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";
import { RelayApi } from "@t3tools/contracts/relay";
import * as Api from "../http/Api.ts";
import * as AuthApi from "../http/AuthApi.ts";
import * as BrokerStore from "../auth/BrokerStore.ts";
import * as HookForwarder from "../hooks/HookForwarder.ts";
import * as DpopProofs from "../auth/DpopProofs.ts";
import * as AgentActivityRows from "../agentActivity/AgentActivityRows.ts";
import { RelayDb } from "../db.ts";
import * as Runtime from "./runtime.ts";
import * as Database from "./database.ts";
import * as HookInbox from "./HookInbox.ts";
import * as RateLimiter from "./RateLimiter.ts";

const routes = Layer.mergeAll(
  Api.layerHealthApi,
  Api.layerMetadataApi,
  Api.layerMobileApi,
  Api.layerClientApi,
  Api.layerTokenApi,
  Api.layerDpopClientApi,
  Api.layerServerApi,
  HookForwarder.layerApi.pipe(Layer.provide(HookForwarder.layer), Layer.provide(RateLimiter.layer)),
).pipe(
  Layer.provideMerge(Api.layerClientAuth),
  Layer.provideMerge(Api.layerDpopClientAuth),
  Layer.provideMerge(Api.layerEnvironmentAuth),
);
const app = Layer.mergeAll(
  HttpApiBuilder.layer(RelayApi, { openapiPath: "/openapi.json" }).pipe(Layer.provide(routes)),
  HttpRouter.add("GET", "/livez", HttpServerResponse.json({ ok: true })),
  AuthApi.layer,
).pipe(Layer.provide(Api.layerCors));

const serve = Layer.unwrap(
  Effect.gen(function* () {
    const port = yield* Config.Number("PORT").pipe(Config.withDefault(8080));
    return HttpRouter.serve(app, { middleware: HttpMiddleware.xForwardedHeaders }).pipe(
      Layer.provide(Layer.succeed(HttpRouter.RouterConfig, Api.RELAY_HTTP_ROUTER_CONFIG)),
      Layer.provide(Runtime.layer),
      Layer.provide(NodeHttpServer.layer(NodeHttp.createServer, { host: "0.0.0.0", port })),
    );
  }),
);
const cleanup = Effect.gen(function* () {
  yield* (yield* DpopProofs.DpopProofReplay).pruneExpired;
  yield* (yield* BrokerStore.BrokerStore).prune;
  const now = yield* DateTime.now;
  yield* (yield* AgentActivityRows.AgentActivityRows).pruneTerminal({
    updatedBefore: DateTime.formatIso(DateTime.subtract(now, { minutes: 30 })),
  });
  const { $client: sql } = yield* RelayDb;
  yield* sql`DELETE FROM relay_cluster_rate_limits WHERE reset_at < now()`;
  yield* sql`DELETE FROM relay_cluster_hook_inbox WHERE received_at < now() - interval '24 hours'`;
}).pipe(Effect.provide(Runtime.layer));
const deliver = Effect.gen(function* () {
  const worker = yield* HookInbox.DeliveryWorker;
  yield* worker.drain.pipe(
    Effect.catch(() =>
      Effect.logWarning("Cluster hook delivery failed; retained requests will retry"),
    ),
    Effect.repeat(Schedule.spaced("5 seconds")),
  );
}).pipe(Effect.provide(Runtime.layer));

const command = process.argv[2] ?? "serve";
const program = Effect.gen(function* () {
  switch (command) {
    case "serve":
      return yield* Layer.launch(serve);
    case "cleanup":
      return yield* cleanup;
    case "deliver":
      return yield* deliver;
    case "migrate-cluster":
      return yield* Effect.all([HookInbox.migrate, RateLimiter.migrate, BrokerStore.migrate], {
        discard: true,
      }).pipe(Effect.provide(Database.layer));
    default:
      return yield* Effect.die("Expected serve, cleanup, deliver, or migrate-cluster.");
  }
});
NodeRuntime.runMain(program);
