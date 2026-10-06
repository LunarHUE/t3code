import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Result from "effect/Result";
import { parsePrivateEndpoints } from "./config.ts";
import { parsePrivateEndpointDomains } from "../privateEndpoints.ts";
import * as PrivateEndpoints from "./PrivateEndpoints.ts";
import { HookInbox } from "../hooks/HookInbox.ts";
import { RelayConfiguration } from "../Config.ts";
import { ManagedEndpointProvider } from "../environments/ManagedEndpointProvider.ts";
import { validateManagedEndpoint } from "../environments/EnvironmentConnector.ts";
import type { RelayLinkedEnvironmentRecord } from "../environments/EnvironmentLinks.ts";

const endpoints = parsePrivateEndpoints(
  '[{"userId":"owner","environmentId":"env","url":"https://mls.internal.example.test"}]',
);
const settings = Layer.succeed(RelayConfiguration, {
  relayIssuer: "https://relay.example.test",
  privateEndpoints: endpoints,
  privateEndpointDomains: ["dev.example.test"],
  apns: null,
  clerkSecretKey: Redacted.make("test"),
  clerkPublishableKey: "test",
  clerkJwtAudience: "test",
  apnsDeliveryJobSigningSecret: Redacted.make("test"),
  cloudMintPrivateKey: Redacted.make("test"),
  cloudMintPublicKey: "test",
  managedEndpointBaseDomain: undefined,
  managedEndpointNamespace: undefined,
});
const cleared: Array<string> = [];
const layer = PrivateEndpoints.layer.pipe(
  Layer.provide(settings),
  Layer.provide(
    Layer.succeed(HookInbox, {
      hold: () => Effect.succeed(true),
      wake: () => Effect.succeed(false),
      clear: ({ endpointKey }) =>
        Effect.sync(() => {
          cleared.push(endpointKey);
        }),
    }),
  ),
);

describe("private endpoints", () => {
  it.each([
    "http://host.test",
    "https://host.test/path",
    "https://user:password@host.test",
    "https://host.test/?token=x",
    "https://host.test/#x",
  ])("rejects unsafe endpoint %s", (url) => {
    expect(() =>
      parsePrivateEndpoints(JSON.stringify([{ userId: "u", environmentId: "e", url }])),
    ).toThrow();
  });
  it.effect("only provisions the administrator-authorized user/environment pair", () =>
    Effect.gen(function* () {
      const provider = yield* ManagedEndpointProvider;
      const origin = { localHttpHost: "127.0.0.1", localHttpPort: 3773 };
      const endpoint = yield* provider.provision({ userId: "owner", environmentId: "env", origin });
      expect(endpoint.endpoint).toEqual({
        providerKind: "manual",
        httpBaseUrl: "https://mls.internal.example.test/",
        wsBaseUrl: "wss://mls.internal.example.test/ws",
      });
      const denied = yield* provider
        .provision({ userId: "other", environmentId: "env", origin })
        .pipe(Effect.result);
      expect(Result.isFailure(denied)).toBe(true);
      expect(yield* provider.deprovision({ userId: "owner", environmentId: "env" })).toBe(true);
      expect(cleared).toContain(endpoints[0]!.endpointKey);
    }).pipe(Effect.provide(layer)),
  );
  it.effect("lets any user's environment claim an origin under a shared domain", () =>
    Effect.gen(function* () {
      const provider = yield* ManagedEndpointProvider;
      const origin = { localHttpHost: "127.0.0.1", localHttpPort: 3773 };
      const requested = (httpBaseUrl: string) => ({
        httpBaseUrl,
        wsBaseUrl: "wss://ignored.test",
        providerKind: "cloudflare_tunnel" as const,
      });
      const claimed = yield* provider.provision({
        userId: "anyone",
        environmentId: "container",
        origin,
        requestedEndpoint: requested("https://box-1.dev.example.test"),
      });
      expect(claimed.endpoint).toEqual({
        providerKind: "manual",
        httpBaseUrl: "https://box-1.dev.example.test/",
        wsBaseUrl: "wss://box-1.dev.example.test/ws",
      });
      for (const url of [
        "https://dev.example.test",
        "https://box.evil-dev.example.test",
        "https://box.dev.example.test.evil.test",
        "http://box.dev.example.test",
        "https://box.dev.example.test/path",
      ]) {
        const denied = yield* provider
          .provision({
            userId: "anyone",
            environmentId: "container",
            origin,
            requestedEndpoint: requested(url),
          })
          .pipe(Effect.result);
        expect(Result.isFailure(denied), url).toBe(true);
      }
    }).pipe(Effect.provide(layer)),
  );
  it("parses shared private endpoint domains", () => {
    expect(parsePrivateEndpointDomains(" .Dev.Example.test, vpn.example.test ,")).toEqual([
      "dev.example.test",
      "vpn.example.test",
    ]);
    expect(parsePrivateEndpointDomains("")).toEqual([]);
    for (const value of ["dev.example.test:443", "dev.example.test/path", "https://dev.test"]) {
      expect(() => parsePrivateEndpointDomains(value), value).toThrow();
    }
  });
  it("accepts manual endpoints under a shared domain at connect time", () => {
    const link = {
      environmentId: "container",
      endpoint: {
        providerKind: "manual",
        httpBaseUrl: "https://box-1.dev.example.test/",
        wsBaseUrl: "wss://box-1.dev.example.test/ws",
      },
    } as RelayLinkedEnvironmentRecord;
    const input = { link, allocation: null, baseDomain: undefined, privateEndpoints: [] };
    expect(Result.isFailure(validateManagedEndpoint(input))).toBe(true);
    expect(
      Result.isSuccess(
        validateManagedEndpoint({ ...input, privateEndpointDomains: ["dev.example.test"] }),
      ),
    ).toBe(true);
    expect(
      Result.isFailure(
        validateManagedEndpoint({ ...input, privateEndpointDomains: ["other.example.test"] }),
      ),
    ).toBe(true);
  });
  it("rejects manual endpoints in the default runtime and stale private routes", () => {
    const link = {
      environmentId: "env",
      endpoint: {
        providerKind: "manual",
        httpBaseUrl: endpoints[0]!.httpBaseUrl,
        wsBaseUrl: endpoints[0]!.wsBaseUrl,
      },
    } as RelayLinkedEnvironmentRecord;
    const input = { link, allocation: null, baseDomain: undefined };
    expect(Result.isFailure(validateManagedEndpoint(input))).toBe(true);
    expect(
      Result.isSuccess(validateManagedEndpoint({ ...input, privateEndpoints: endpoints })),
    ).toBe(true);
    expect(Result.isFailure(validateManagedEndpoint({ ...input, privateEndpoints: [] }))).toBe(
      true,
    );
    expect(
      Result.isFailure(
        validateManagedEndpoint({
          ...input,
          privateEndpoints: endpoints.map((entry) => ({
            ...entry,
            httpBaseUrl: "https://changed.test/",
          })),
        }),
      ),
    ).toBe(true);
  });
});
