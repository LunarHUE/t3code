import { expect, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";

import { RelayObservability } from "./observability.ts";
import { mobilePushEnabled, telemetryEnabled } from "./Config.ts";
import { layerPushQueuesDisabled } from "./optionalServices.ts";
import { ApnsDeliveryQueueSender } from "./agentActivity/ApnsDeliveryQueue.ts";
import { FcmDeliveryQueueSender } from "./agentActivity/FcmDeliveryQueueSender.ts";

it.effect("disabled telemetry needs no Axiom credentials or provisioning context", () =>
  Effect.gen(function* () {
    expect(
      yield* RelayObservability.pipe(
        // Deliberately omit provisioning services: disabled mode must never request them.
        Effect.provide(
          Context.empty() as Context.Context<Effect.Services<typeof RelayObservability>>,
        ),
      ),
    ).toBeUndefined();
  }).pipe(Effect.provide(ConfigProvider.layer(ConfigProvider.fromUnknown({})))),
);

it.effect("requires explicit opt-in for telemetry and mobile push", () =>
  Effect.gen(function* () {
    const empty = ConfigProvider.fromUnknown({});
    expect(yield* telemetryEnabled.parse(empty)).toBe(false);
    expect(yield* mobilePushEnabled.parse(empty)).toBe(false);
    const enabled = ConfigProvider.fromUnknown({
      RELAY_TELEMETRY_ENABLED: "true",
      RELAY_MOBILE_PUSH_ENABLED: "true",
    });
    expect(yield* telemetryEnabled.parse(enabled)).toBe(true);
    expect(yield* mobilePushEnabled.parse(enabled)).toBe(true);
  }),
);

it.effect("disabled queue adapters need no Cloudflare runtime", () =>
  Effect.gen(function* () {
    const apns = yield* ApnsDeliveryQueueSender;
    const fcm = yield* FcmDeliveryQueueSender;
    // The disabled transport must not inspect or serialize queued data.
    const body = new Proxy(
      {},
      {
        get: () => {
          throw new Error("unexpected payload access");
        },
      },
    );
    yield* apns.send(body as Parameters<typeof apns.send>[0]);
    yield* fcm.send(body as Parameters<typeof fcm.send>[0]);
  }).pipe(Effect.provide(layerPushQueuesDisabled)),
);
