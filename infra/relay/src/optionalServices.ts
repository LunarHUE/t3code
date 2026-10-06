import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { ApnsDeliveryQueueSender } from "./agentActivity/ApnsDeliveryQueue.ts";
import { FcmDeliveryQueueSender } from "./agentActivity/FcmDeliveryQueueSender.ts";

export const layerPushQueuesDisabled = Layer.mergeAll(
  Layer.succeed(ApnsDeliveryQueueSender, { send: () => Effect.void }),
  Layer.succeed(FcmDeliveryQueueSender, { send: () => Effect.void }),
);
