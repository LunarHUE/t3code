import * as NodeCrypto from "node:crypto";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as ConfigProvider from "effect/ConfigProvider";
import { RelayConfiguration } from "../Config.ts";
import * as Config from "./config.ts";
const keys = NodeCrypto.generateKeyPairSync("ed25519", {
  privateKeyEncoding: { format: "pem", type: "pkcs8" },
  publicKeyEncoding: { format: "pem", type: "spki" },
});
const env = {
  RELAY_URL: "https://relay.test",
  RELAY_SIGNING_PRIVATE_KEY: keys.privateKey,
  OIDC_ISSUER_URL: "https://identity.test/tenant/",
  OIDC_CLIENT_ID: "broker",
  OIDC_CLIENT_SECRET: "secret",
};
const load = (override: Record<string, string> = {}) =>
  RelayConfiguration.pipe(
    Effect.provide(
      Config.layer.pipe(
        Layer.provide(
          ConfigProvider.layer(ConfigProvider.fromEnv({ env: { ...env, ...override } })),
        ),
      ),
    ),
  );
describe("cluster OIDC configuration", () => {
  it.effect("preserves the issuer and defaults the callback without any Clerk credentials", () =>
    Effect.gen(function* () {
      const config = yield* load();
      expect(config.oidc?.issuerUrl).toBe(env.OIDC_ISSUER_URL);
      expect(config.oidc?.redirectUri).toBe("https://relay.test/auth/callback");
      expect(config.oidc?.refreshLifetimeSeconds).toBe(604800);
      expect(config.oidc?.tokenEndpointAuthMethod).toBe("client_secret_post");
      expect(config.clerkSecretKey).toBeUndefined();
      expect(config.cloudMintPublicKey).toBe(keys.publicKey);
    }),
  );
  it.effect.each([
    { OIDC_ISSUER_URL: "http://identity.test" },
    { OIDC_ISSUER_URL: "https://user:secret@identity.test" },
    { OIDC_REDIRECT_URI: "https://other.test/auth/callback" },
    { OIDC_REDIRECT_URI: "https://user:secret@relay.test/auth/callback" },
    { OIDC_CLIENT_SECRET: "" },
    { OIDC_SCOPES: "profile email" },
    { OIDC_TOKEN_ENDPOINT_AUTH_METHOD: "none" },
    { OIDC_REFRESH_LIFETIME_SECONDS: "0" },
    { OIDC_REFRESH_LIFETIME_SECONDS: "2592001" },
  ])("rejects invalid %j", (override) =>
    Effect.gen(function* () {
      expect(Exit.isFailure(yield* load(override).pipe(Effect.exit))).toBe(true);
    }),
  );
});
