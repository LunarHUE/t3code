import * as NodeCrypto from "node:crypto";
import * as Crypto from "@effect/platform-node/NodeCrypto";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpServer from "effect/http/HttpServer";
import * as HttpApi from "effect/http-api/HttpApi";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";
import { RelayApi } from "@t3tools/contracts/relay";
import { RelayConfiguration } from "../Config.ts";
import * as Api from "../http/Api.ts";
import * as Dpop from "./DpopProofs.ts";
import * as Tokens from "./RelayTokens.ts";
import { issueAccountToken, accountUserId } from "./AccountTokens.ts";
const keys = NodeCrypto.generateKeyPairSync("ed25519", {
  privateKeyEncoding: { format: "pem", type: "pkcs8" },
  publicKeyEncoding: { format: "pem", type: "spki" },
});
const config = RelayConfiguration.of({
  relayIssuer: "https://relay.test",
  oidc: {
    issuerUrl: "https://id.test",
    clientId: "broker",
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
// @effect-diagnostics-next-line globalDate:off -- The web handler runs on its own live runtime clock.
const now = Math.floor(Date.now() / 1000);
const decodeToken = Schema.decodeUnknownEffect(
  Schema.Struct({ access_token: Schema.String, token_type: Schema.String }),
);
it.effect(
  "exchanges account access for user-bound DPoP and rejects using DPoP as account access",
  () =>
    Effect.gen(function* () {
      const user = { id: accountUserId("https://id.test", "person") };
      const account = yield* issueAccountToken(config, user, now);
      const tokenLayer = Tokens.layer.pipe(
        Layer.provide(Layer.succeed(RelayConfiguration, config)),
      );
      const handlers = Api.layerTokenApi.pipe(
        Layer.provide(
          Layer.mergeAll(
            Layer.succeed(RelayConfiguration, config),
            Crypto.layer,
            tokenLayer,
            Layer.mock(Dpop.DpopProofReplay, {
              verifyAndConsume: ({ method, url, proof }) => {
                expect(method).toBe("POST");
                expect(url).toBe("https://relay.test/v1/client/dpop-token");
                expect(proof).toBe("proof");
                return Effect.succeed("bound-key");
              },
            }),
          ),
        ),
      );
      const app = yield* Effect.acquireRelease(
        Effect.sync(() =>
          HttpRouter.toWebHandler(
            HttpApiBuilder.layer(HttpApi.make("RelayApi").add(RelayApi.groups.token)).pipe(
              Layer.provide(handlers),
              Layer.provide(HttpServer.layerServices),
            ),
            { disableLogger: true },
          ),
        ),
        (app) => Effect.promise(() => app.dispose()),
      );
      const exchange = (subject: string) =>
        Effect.promise(() =>
          app.handler(
            new Request("https://relay.test/v1/client/dpop-token", {
              method: "POST",
              headers: {
                "content-type": "application/x-www-form-urlencoded",
                dpop: "proof",
                host: "relay.test",
                "x-forwarded-proto": "https",
              },
              body: new URLSearchParams({
                grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
                subject_token: subject,
                subject_token_type: "urn:ietf:params:oauth:token-type:jwt",
                requested_token_type: "urn:ietf:params:oauth:token-type:access_token",
                resource: config.relayIssuer,
                scope: "environment:connect environment:status",
                client_id: "t3-web",
              }),
            }),
          ),
        );
      const response = yield* exchange(account);
      expect(response.status).toBe(200);
      const result = yield* decodeToken(yield* Effect.promise(() => response.json()));
      expect(result.token_type).toBe("DPoP");
      const verifier = yield* Tokens.RelayTokens.pipe(Effect.provide(tokenLayer));
      expect(
        yield* verifier.verifyDpopAccessToken({ token: result.access_token, nowEpochSeconds: now }),
      ).toMatchObject({ sub: user.id, cnf: { jkt: "bound-key" } });
      expect((yield* exchange(result.access_token)).status).toBe(401);
    }).pipe(Effect.scoped),
);
