import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as Layer from "effect/Layer";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as RelayDb from "../db.ts";
import * as Config from "./config.ts";
import * as Database from "./database.ts";
import * as PrivateEndpoints from "./PrivateEndpoints.ts";
import * as HookInbox from "./HookInbox.ts";
import * as HeldHooks from "./HeldHooks.ts";
import * as OptionalServices from "../optionalServices.ts";
import * as MobileRegistrations from "../agentActivity/MobileRegistrations.ts";
import * as AgentActivityPublisher from "../agentActivity/AgentActivityPublisher.ts";
import * as ApnsDeliveries from "../agentActivity/ApnsDeliveries.ts";
import * as FcmDeliveries from "../agentActivity/FcmDeliveries.ts";
import * as FcmClient from "../agentActivity/FcmClient.ts";
import * as FcmAssertionSigner from "../agentActivity/FcmAssertionSigner.ts";
import * as ApnsClient from "../agentActivity/ApnsClient.ts";
import * as ApnsProviderTokens from "../agentActivity/ApnsProviderTokens.ts";
import * as ApnsDeliveryQueue from "../agentActivity/ApnsDeliveryQueue.ts";
import * as AgentActivityRows from "../agentActivity/AgentActivityRows.ts";
import * as Devices from "../agentActivity/Devices.ts";
import * as LiveActivities from "../agentActivity/LiveActivities.ts";
import * as DeliveryAttempts from "../agentActivity/DeliveryAttempts.ts";
import * as EnvironmentConnector from "../environments/EnvironmentConnector.ts";
import * as EnvironmentLinker from "../environments/EnvironmentLinker.ts";
import * as EnvironmentPublishSignatures from "../environments/EnvironmentPublishSignatures.ts";
import * as EnvironmentCredentials from "../environments/EnvironmentCredentials.ts";
import * as EnvironmentLinks from "../environments/EnvironmentLinks.ts";
import * as ManagedEndpointAllocations from "../environments/ManagedEndpointAllocations.ts";
import * as ManagedTunnelLimits from "../environments/ManagedTunnelLimits.ts";
import * as DpopProofs from "../auth/DpopProofs.ts";
import * as RelayTokens from "../auth/RelayTokens.ts";
import * as WebCrypto from "../WebCrypto.ts";

// Keep the Cloudflare entrypoint intact; both runtimes use the same domain services.
export const layer = Layer.empty
  .pipe(
    Layer.provideMerge(MobileRegistrations.layer),
    Layer.provideMerge(AgentActivityPublisher.layer),
    Layer.provideMerge(EnvironmentConnector.layer),
    Layer.provideMerge(EnvironmentLinker.layer),
    Layer.provideMerge(Layer.mergeAll(EnvironmentPublishSignatures.layer, HeldHooks.layer)),
    Layer.provideMerge(PrivateEndpoints.layer),
    Layer.provideMerge(DpopProofs.layer),
    Layer.provideMerge(ApnsDeliveries.layer),
    Layer.provideMerge(
      FcmDeliveries.layer.pipe(
        Layer.provide(OptionalServices.layerPushQueuesDisabled),
        Layer.provideMerge(
          FcmClient.layer.pipe(
            Layer.provide(FcmAssertionSigner.layer),
            Layer.provide(Layer.succeed(WebCrypto.WebCrypto, { subtle: globalThis.crypto.subtle })),
          ),
        ),
      ),
    ),
    Layer.provideMerge(ApnsClient.layer.pipe(Layer.provideMerge(ApnsProviderTokens.layer))),
    Layer.provideMerge(
      ApnsDeliveryQueue.layer.pipe(Layer.provide(OptionalServices.layerPushQueuesDisabled)),
    ),
    Layer.provideMerge(Layer.mergeAll(AgentActivityRows.layer, Devices.layer, HookInbox.layer)),
    Layer.provideMerge(EnvironmentCredentials.layer),
    Layer.provideMerge(
      Layer.mergeAll(
        EnvironmentLinks.layer,
        ManagedEndpointAllocations.layer,
        ManagedTunnelLimits.layer,
      ),
    ),
    Layer.provideMerge(LiveActivities.layer),
    Layer.provideMerge(DeliveryAttempts.layer),
    Layer.provideMerge(RelayTokens.layer),
    Layer.provideMerge(RelayDb.RelayTransactions.layer),
  )
  .pipe(
    Layer.provideMerge(Database.layer),
    Layer.provideMerge(Config.layer),
    Layer.provideMerge(NodeCrypto.layer),
    Layer.provideMerge(FetchHttpClient.layer),
  );
