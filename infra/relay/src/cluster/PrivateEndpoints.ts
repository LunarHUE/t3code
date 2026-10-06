import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HookInbox } from "../hooks/HookInbox.ts";
import { privateEndpointKey } from "./config.ts";
import { RelayConfiguration } from "../Config.ts";
import * as Provider from "../environments/ManagedEndpointProvider.ts";

export const layer = Layer.effect(
  Provider.ManagedEndpointProvider,
  Effect.gen(function* () {
    const config = yield* RelayConfiguration;
    const inbox = yield* HookInbox;
    return Provider.ManagedEndpointProvider.of({
      provision: (input) => {
        const endpoint = config.privateEndpoints?.find(
          (entry) => entry.userId === input.userId && entry.environmentId === input.environmentId,
        );
        if (!endpoint)
          return Effect.fail(
            new Provider.ManagedEndpointProvisioningFailed({
              userId: input.userId,
              environmentId: input.environmentId,
              stage: "verify-endpoint",
              reason: "endpoint-mismatch",
            }),
          );
        return Effect.succeed({
          endpoint: {
            httpBaseUrl: endpoint.httpBaseUrl,
            wsBaseUrl: endpoint.wsBaseUrl,
            providerKind: "manual" as const,
          },
          // The shared linker strips this unused runtime from manual endpoint responses.
          runtime: { providerKind: "manual" as const, connectorToken: "unused-private-endpoint" },
        });
      },
      reconcileOrigin: () => Effect.succeed("ready" as const),
      prepareDeprovision: () => Effect.succeed(null),
      // The cluster administrator owns ingress/DNS; unlinking never deletes them.
      deprovision: (input) =>
        inbox.clear({ endpointKey: privateEndpointKey(input.userId, input.environmentId) }).pipe(
          Effect.as(true),
          Effect.mapError(
            (cause) =>
              new Provider.ManagedEndpointDeprovisioningFailed({
                ...input,
                stage: "remove-allocation",
                cause,
              }),
          ),
        ),
      release: () => Effect.succeed(true),
    });
  }),
);
