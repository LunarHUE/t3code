import * as Oidc from "openid-client";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import { RelayConfiguration } from "../Config.ts";
import { accountUserId, type AccountUser } from "./AccountTokens.ts";

export class OidcClientError extends Schema.TaggedError<OidcClientError>()("OidcClientError", {
  operation: Schema.Literals(["authorize", "callback"]),
  cause: Schema.Defect(),
}) {
  override get message() {
    return "Identity provider request failed.";
  }
}
export class OidcClient extends Context.Service<
  OidcClient,
  {
    readonly authorize: (input: {
      state: string;
      nonce: string;
      verifier: string;
    }) => Effect.Effect<string, OidcClientError>;
    readonly callback: (input: {
      url: string;
      state: string;
      nonce: string;
      verifier: string;
    }) => Effect.Effect<AccountUser, OidcClientError>;
  }
>()("t3code-relay/auth/OidcClient") {}
const make = Effect.gen(function* () {
  const config = (yield* RelayConfiguration).oidc;
  if (!config) return yield* Effect.die("OIDC broker configuration missing.");
  // Acquisition is lazy so migrate/cleanup/health never need provider connectivity.
  let discovery: Promise<Oidc.Configuration> | undefined;
  const getConfiguration = () =>
    (discovery ??= Oidc.discovery(
      new URL(config.issuerUrl),
      config.clientId,
      { client_secret: Redacted.value(config.clientSecret) },
      config.tokenEndpointAuthMethod === "client_secret_basic"
        ? Oidc.ClientSecretBasic(Redacted.value(config.clientSecret))
        : Oidc.ClientSecretPost(Redacted.value(config.clientSecret)),
      { timeout: 10, execute: [Oidc.enableNonRepudiationChecks] },
    ).catch((cause: unknown) => {
      discovery = undefined;
      throw cause;
    }));
  return OidcClient.of({
    authorize: (input) =>
      Effect.tryPromise({
        try: async () => {
          const provider = await getConfiguration();
          return Oidc.buildAuthorizationUrl(provider, {
            redirect_uri: config.redirectUri,
            scope: config.scopes,
            state: input.state,
            nonce: input.nonce,
            prompt: "select_account",
            code_challenge: await Oidc.calculatePKCECodeChallenge(input.verifier),
            code_challenge_method: "S256",
          }).href;
        },
        catch: (cause) => new OidcClientError({ operation: "authorize", cause }),
      }),
    callback: (input) =>
      Effect.tryPromise({
        try: async () => {
          const provider = await getConfiguration();
          const tokens = await Oidc.authorizationCodeGrant(provider, new URL(input.url), {
            expectedState: input.state,
            expectedNonce: input.nonce,
            pkceCodeVerifier: input.verifier,
            idTokenExpected: true,
          });
          const claims = tokens.claims();
          if (!claims?.sub || claims.iss !== provider.serverMetadata().issuer)
            throw new Error("Invalid identity claims.");
          return {
            id: accountUserId(claims.iss, claims.sub),
            ...(typeof claims.email === "string" ? { email: claims.email } : {}),
            ...(typeof claims.name === "string" ? { name: claims.name } : {}),
          };
        },
        catch: (cause) => new OidcClientError({ operation: "callback", cause }),
      }),
  });
});
export const layer = Layer.effect(OidcClient, make);
