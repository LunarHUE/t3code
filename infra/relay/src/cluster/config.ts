import * as NodeCrypto from "node:crypto";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import {
  endpointHealthFailureThresholdConfig,
  endpointHealthTimeoutMsConfig,
  RelayConfiguration,
} from "../Config.ts";
import { parsePrivateEndpointDomains, privateEndpointForUrl } from "../privateEndpoints.ts";

const EndpointInput = Schema.Array(
  Schema.Struct({
    userId: Schema.NonEmptyString,
    environmentId: Schema.NonEmptyString,
    url: Schema.NonEmptyString,
  }),
);

const decodeEndpoints = Schema.decodeSync(Schema.fromJsonString(EndpointInput));

export function privateEndpointKey(userId: string, environmentId: string) {
  return NodeCrypto.createHash("sha256")
    .update(JSON.stringify([userId, environmentId]))
    .digest("hex")
    .slice(0, 16);
}

export function parsePrivateEndpoints(json: string) {
  const entries = decodeEndpoints(json);
  const seen = new Set<string>();
  return entries.map(({ userId, environmentId, url }) => {
    const endpoint = privateEndpointForUrl(url);
    if (endpoint === null) {
      throw new Error(
        "Private endpoints must be HTTPS origins without credentials, paths, or query strings.",
      );
    }
    const identity = JSON.stringify([userId, environmentId]);
    if (seen.has(identity)) throw new Error("Duplicate private environment registration.");
    seen.add(identity);
    return {
      userId,
      environmentId,
      endpointKey: privateEndpointKey(userId, environmentId),
      ...endpoint,
    };
  });
}

export const layer = Layer.effect(
  RelayConfiguration,
  Effect.gen(function* () {
    const issuer = yield* Config.NonEmptyString("RELAY_URL");
    const issuerUrl = new URL(issuer);
    if (
      issuerUrl.protocol !== "https:" ||
      issuerUrl.username ||
      issuerUrl.password ||
      issuerUrl.search ||
      issuerUrl.hash ||
      issuerUrl.pathname !== "/"
    ) {
      return yield* Effect.die("RELAY_URL must be an HTTPS origin.");
    }
    const cloudMintPrivateKey = yield* Config.Redacted("RELAY_SIGNING_PRIVATE_KEY");
    // Validate at startup, never generate ephemeral keys that invalidate existing links on restart.
    const key = NodeCrypto.createPrivateKey(Redacted.value(cloudMintPrivateKey));
    if (key.asymmetricKeyType !== "ed25519")
      return yield* Effect.die("Relay signing key must be Ed25519.");
    const privateEndpoints = parsePrivateEndpoints(
      yield* Config.String("RELAY_PRIVATE_ENDPOINTS").pipe(Config.withDefault("[]")),
    );
    const privateEndpointDomains = parsePrivateEndpointDomains(
      yield* Config.String("RELAY_PRIVATE_ENDPOINT_DOMAINS").pipe(Config.withDefault("")),
    );
    const oidcIssuer = new URL(yield* Config.NonEmptyString("OIDC_ISSUER_URL"));
    if (
      oidcIssuer.protocol !== "https:" ||
      oidcIssuer.username ||
      oidcIssuer.password ||
      oidcIssuer.search ||
      oidcIssuer.hash
    )
      return yield* Effect.die("OIDC_ISSUER_URL must be an HTTPS issuer URL.");
    const redirectUri = yield* Config.String("OIDC_REDIRECT_URI").pipe(
      Config.withDefault(`${issuerUrl.origin}/auth/callback`),
    );
    const redirect = new URL(redirectUri);
    if (
      redirect.origin !== issuerUrl.origin ||
      redirect.pathname !== "/auth/callback" ||
      redirect.username ||
      redirect.password ||
      redirect.search ||
      redirect.hash
    )
      return yield* Effect.die("OIDC_REDIRECT_URI must be RELAY_URL/auth/callback.");
    const scopes = yield* Config.NonEmptyString("OIDC_SCOPES").pipe(
      Config.withDefault("openid profile email"),
    );
    if (!scopes.split(/\s+/u).includes("openid"))
      return yield* Effect.die("OIDC_SCOPES must include openid.");
    const refreshLifetimeSeconds = yield* Config.Number("OIDC_REFRESH_LIFETIME_SECONDS").pipe(
      Config.withDefault(604800),
    );
    if (
      !Number.isInteger(refreshLifetimeSeconds) ||
      refreshLifetimeSeconds < 600 ||
      refreshLifetimeSeconds > 2592000
    )
      return yield* Effect.die("OIDC_REFRESH_LIFETIME_SECONDS must be between 600 and 2592000.");
    const clientSecret = yield* Config.Redacted("OIDC_CLIENT_SECRET");
    if (!Redacted.value(clientSecret).trim())
      return yield* Effect.die("OIDC_CLIENT_SECRET must not be empty.");
    const tokenEndpointAuthMethod = yield* Config.Literals(
      ["client_secret_post", "client_secret_basic"],
      "OIDC_TOKEN_ENDPOINT_AUTH_METHOD",
    ).pipe(Config.withDefault("client_secret_post"));
    const oidc = {
      issuerUrl: oidcIssuer.href,
      clientId: yield* Config.NonEmptyString("OIDC_CLIENT_ID"),
      clientSecret,
      tokenEndpointAuthMethod,
      redirectUri,
      scopes,
      refreshLifetimeSeconds,
    };
    return RelayConfiguration.of({
      relayIssuer: issuerUrl.origin,
      privateEndpoints,
      privateEndpointDomains,
      oidc,
      cloudMintPrivateKey,
      cloudMintPublicKey: NodeCrypto.createPublicKey(key)
        .export({ type: "spki", format: "pem" })
        .toString(),
      apns: null,
      apnsDeliveryJobSigningSecret: Redacted.make("disabled-in-cluster-runtime"),
      managedEndpointBaseDomain: undefined,
      managedEndpointNamespace: undefined,
      endpointHealthTimeoutMs: yield* endpointHealthTimeoutMsConfig,
      endpointHealthFailureThreshold: yield* endpointHealthFailureThresholdConfig,
    });
  }),
);
