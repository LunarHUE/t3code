import { expect, it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import {
  endpointHealthFailureThresholdConfig,
  endpointHealthTimeoutMsConfig,
  legacyManagedEndpointCleanupModeConfig,
  legacyTunnelGraceMinutesConfig,
  managedEndpointCleanupModeConfig,
} from "./Config.ts";

it.effect.each([
  { name: "missing", env: {}, expected: "off" },
  { name: "empty", env: { RELAY_TUNNEL_CLEANUP_MODE: "" }, expected: "off" },
  { name: "whitespace", env: { RELAY_TUNNEL_CLEANUP_MODE: "  \t" }, expected: "off" },
  { name: "off", env: { RELAY_TUNNEL_CLEANUP_MODE: "off" }, expected: "off" },
  {
    name: "dry-run",
    env: { RELAY_TUNNEL_CLEANUP_MODE: "dry-run" },
    expected: "dry-run",
  },
  { name: "enabled", env: { RELAY_TUNNEL_CLEANUP_MODE: "enabled" }, expected: "enabled" },
] as const)("loads $name cleanup mode as $expected", ({ env, expected }) =>
  Effect.gen(function* () {
    const provider = ConfigProvider.fromEnv({ env });
    expect(yield* managedEndpointCleanupModeConfig.parse(provider)).toBe(expected);
  }),
);

it.effect("rejects an invalid cleanup mode", () =>
  Effect.gen(function* () {
    const provider = ConfigProvider.fromEnv({
      env: { RELAY_TUNNEL_CLEANUP_MODE: "delete-everything" },
    });
    const error = yield* Effect.flip(managedEndpointCleanupModeConfig.parse(provider));

    expect(error._tag).toBe("ConfigError");
    expect(error.message).toContain('Expected "off" | "dry-run" | "enabled"');
  }),
);

it.effect("reads the legacy cleanup mode independently of the main one", () =>
  Effect.gen(function* () {
    const provider = ConfigProvider.fromEnv({
      env: { RELAY_TUNNEL_CLEANUP_MODE: "enabled", RELAY_LEGACY_TUNNEL_CLEANUP_MODE: "dry-run" },
    });
    expect(yield* managedEndpointCleanupModeConfig.parse(provider)).toBe("enabled");
    expect(yield* legacyManagedEndpointCleanupModeConfig.parse(provider)).toBe("dry-run");
    expect(
      yield* legacyManagedEndpointCleanupModeConfig.parse(ConfigProvider.fromEnv({ env: {} })),
    ).toBe("off");
  }),
);

it.effect.each([
  { name: "missing", env: {}, expected: Option.none() },
  {
    name: "positive",
    env: { RELAY_LEGACY_TUNNEL_GRACE_MINUTES: "10" },
    expected: Option.some(10),
  },
] as const)("loads a $name legacy grace override", ({ env, expected }) =>
  Effect.gen(function* () {
    const minutes = yield* legacyTunnelGraceMinutesConfig.parse(ConfigProvider.fromEnv({ env }));
    expect(minutes).toEqual(expected);
  }),
);

it.effect.each(["0", "-10"])("rejects a grace override of %s minutes", (value) =>
  Effect.gen(function* () {
    const error = yield* Effect.flip(
      legacyTunnelGraceMinutesConfig.parse(
        ConfigProvider.fromEnv({ env: { RELAY_LEGACY_TUNNEL_GRACE_MINUTES: value } }),
      ),
    );
    expect(error._tag).toBe("ConfigError");
  }),
);

it.effect.each([
  { name: "unset", env: {}, expected: 30_000 },
  { name: "empty", env: { RELAY_ENDPOINT_HEALTH_TIMEOUT_MS: "" }, expected: 30_000 },
  { name: "set", env: { RELAY_ENDPOINT_HEALTH_TIMEOUT_MS: "45000" }, expected: 45_000 },
  { name: "the minimum", env: { RELAY_ENDPOINT_HEALTH_TIMEOUT_MS: "1000" }, expected: 1_000 },
  { name: "the maximum", env: { RELAY_ENDPOINT_HEALTH_TIMEOUT_MS: "120000" }, expected: 120_000 },
] as const)("loads the endpoint health timeout when $name", ({ env, expected }) =>
  Effect.gen(function* () {
    const timeoutMs = yield* endpointHealthTimeoutMsConfig.parse(ConfigProvider.fromEnv({ env }));
    expect(timeoutMs).toBe(expected);
  }),
);

it.effect.each([" ", "abc", "30s", "999", "120001", "1500.5"])(
  "rejects an endpoint health timeout of '%s'",
  (value) =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        endpointHealthTimeoutMsConfig.parse(
          ConfigProvider.fromEnv({ env: { RELAY_ENDPOINT_HEALTH_TIMEOUT_MS: value } }),
        ),
      );
      expect(error._tag).toBe("ConfigError");
      expect(error.message).toContain(
        `RELAY_ENDPOINT_HEALTH_TIMEOUT_MS must be an integer from 1000 to 120000, got '${value}'.`,
      );
    }),
);

it.effect("loads the endpoint health failure threshold", () =>
  Effect.gen(function* () {
    const parse = (env: Record<string, string>) =>
      endpointHealthFailureThresholdConfig.parse(ConfigProvider.fromEnv({ env }));
    expect(yield* parse({})).toBe(2);
    expect(yield* parse({ RELAY_ENDPOINT_HEALTH_FAILURE_THRESHOLD: "3" })).toBe(3);
    const error = yield* Effect.flip(parse({ RELAY_ENDPOINT_HEALTH_FAILURE_THRESHOLD: "0" }));
    expect(error.message).toContain(
      "RELAY_ENDPOINT_HEALTH_FAILURE_THRESHOLD must be an integer from 1 to 10, got '0'.",
    );
  }),
);
