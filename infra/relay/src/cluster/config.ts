import * as NodeCrypto from "node:crypto";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import { RelayConfiguration } from "../Config.ts";

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
    const parsed = new URL(url);
    if (
      parsed.protocol !== "https:" ||
      parsed.username ||
      parsed.password ||
      parsed.search ||
      parsed.hash ||
      parsed.pathname !== "/"
    ) {
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
      httpBaseUrl: parsed.href,
      wsBaseUrl: `wss://${parsed.host}/ws`,
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
    return RelayConfiguration.of({
      relayIssuer: issuerUrl.origin,
      privateEndpoints,
      clerkSecretKey: yield* Config.Redacted("CLERK_SECRET_KEY"),
      clerkPublishableKey: yield* Config.NonEmptyString("CLERK_PUBLISHABLE_KEY"),
      clerkJwtAudience: yield* Config.String("CLERK_JWT_AUDIENCE").pipe(
        Config.withDefault("t3-code-relay"),
      ),
      cloudMintPrivateKey,
      cloudMintPublicKey: NodeCrypto.createPublicKey(key)
        .export({ type: "spki", format: "pem" })
        .toString(),
      apns: null,
      apnsDeliveryJobSigningSecret: Redacted.make("disabled-in-cluster-runtime"),
      managedEndpointBaseDomain: undefined,
      managedEndpointNamespace: undefined,
    });
  }),
);
