import * as NodeCrypto from "node:crypto";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";
import * as Redacted from "effect/Redacted";
import { signRelayJwt } from "@t3tools/shared/relayJwt";
import { RelayConfiguration } from "../Config.ts";
import { verifyRelayClientBearerToken } from "../http/Api.ts";
import { accountUserId, issueAccountToken, verifyAccountToken } from "./AccountTokens.ts";
const keys = NodeCrypto.generateKeyPairSync("ed25519", {
  privateKeyEncoding: { format: "pem", type: "pkcs8" },
  publicKeyEncoding: { format: "pem", type: "spki" },
});
const config = RelayConfiguration.of({
  relayIssuer: "https://relay.test",
  oidc: {
    issuerUrl: "https://id.test",
    clientId: "server",
    clientSecret: Redacted.make("secret"),
    redirectUri: "https://relay.test/auth/callback",
    scopes: "openid",
    refreshLifetimeSeconds: 604800,
  },
  apns: null,
  apnsDeliveryJobSigningSecret: Redacted.make("disabled"),
  cloudMintPrivateKey: Redacted.make(keys.privateKey),
  cloudMintPublicKey: keys.publicKey,
  managedEndpointBaseDomain: undefined,
  managedEndpointNamespace: undefined,
});
const user = {
  id: accountUserId("https://id.test", "subject"),
  email: "person@example.test",
  name: "Person",
};
describe("relay account tokens", () => {
  it("namespaces subjects and fits every existing user ID column", () => {
    expect(accountUserId("https://id.test", "subject")).toBe(user.id);
    expect(accountUserId("https://other.test", "subject")).not.toBe(user.id);
    expect(accountUserId("https://id.test", "other")).not.toBe(user.id);
    expect(user.id.length).toBeLessThan(191);
  });
  it.effect("returns the same canonical account to bearer APIs and rejects expiry", () =>
    Effect.gen(function* () {
      const token = yield* issueAccountToken(config, user, 100);
      expect(yield* verifyAccountToken(config, token, 200)).toEqual(user);
      expect(yield* verifyAccountToken(config, token, 700).pipe(Effect.isFailure)).toBe(true);
      const now = Math.floor((yield* DateTime.now).epochMilliseconds / 1000);
      const current = yield* issueAccountToken(config, user, now);
      expect(yield* verifyRelayClientBearerToken(config, current)).toEqual({
        sub: user.id,
        mode: "account_bearer",
      });
    }),
  );
  it.effect(
    "rejects DPoP, link challenge and wrong audience tokens despite the same signing key",
    () =>
      Effect.gen(function* () {
        for (const [typ, aud] of [
          ["t3-relay-dpop-access+jwt", config.relayIssuer],
          ["t3-link-challenge+jwt", config.relayIssuer],
          ["t3-relay-account-access+jwt", config.relayIssuer],
        ]) {
          const token = yield* signRelayJwt({
            privateKey: keys.privateKey,
            typ: typ!,
            payload: { iss: config.relayIssuer, aud: aud!, sub: user.id, iat: 100, exp: 700 },
          });
          expect(yield* verifyAccountToken(config, token, 200).pipe(Effect.isFailure)).toBe(true);
        }
      }),
  );
  it.effect("rejects an account token signed by another cluster", () =>
    Effect.gen(function* () {
      const other = NodeCrypto.generateKeyPairSync("ed25519", {
        privateKeyEncoding: { format: "pem", type: "pkcs8" },
        publicKeyEncoding: { format: "pem", type: "spki" },
      });
      const token = yield* issueAccountToken(
        { ...config, cloudMintPrivateKey: Redacted.make(other.privateKey) },
        user,
        100,
      );
      expect(yield* verifyAccountToken(config, token, 200).pipe(Effect.isFailure)).toBe(true);
    }),
  );
});
