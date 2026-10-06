import * as NodeCrypto from "node:crypto";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import { signRelayJwt, verifyRelayJwt, normalizeRelayIssuer } from "@t3tools/shared/relayJwt";
import type { RelayConfiguration } from "../Config.ts";

export const ACCOUNT_TOKEN_TTL_SECONDS = 600;
const typ = "t3-relay-account-access+jwt";
export const AccountUserSchema = Schema.Struct({
  id: Schema.NonEmptyString,
  email: Schema.optionalKey(Schema.String),
  name: Schema.optionalKey(Schema.String),
});
const decodeAccountUser = Schema.decodeUnknownEffect(AccountUserSchema);
export type AccountUser = typeof AccountUserSchema.Type;
export function accountUserId(issuer: string, subject: string): string {
  return `oidc_${NodeCrypto.createHash("sha256")
    .update(JSON.stringify([issuer, subject]))
    .digest("hex")}`;
}
export function issueAccountToken(
  config: RelayConfiguration["Service"],
  user: AccountUser,
  now: number,
) {
  const issuer = normalizeRelayIssuer(config.relayIssuer);
  return signRelayJwt({
    privateKey: Redacted.value(config.cloudMintPrivateKey),
    typ,
    payload: {
      iss: issuer,
      aud: `${issuer}/account`,
      sub: user.id,
      iat: now,
      exp: now + ACCOUNT_TOKEN_TTL_SECONDS,
      jti: NodeCrypto.randomUUID(),
      email: user.email,
      name: user.name,
    },
  });
}
class InvalidAccountToken extends Schema.TaggedError<InvalidAccountToken>()(
  "InvalidAccountToken",
  {},
) {
  override get message() {
    return "Account access token is invalid or expired.";
  }
}

export function verifyAccountToken(
  config: RelayConfiguration["Service"],
  token: string,
  now: number,
) {
  const issuer = normalizeRelayIssuer(config.relayIssuer);
  return verifyRelayJwt({
    publicKey: config.cloudMintPublicKey,
    token,
    typ,
    issuer,
    audience: `${issuer}/account`,
    nowEpochSeconds: now,
    maxTokenAge: ACCOUNT_TOKEN_TTL_SECONDS,
  }).pipe(
    Effect.flatMap((claims) =>
      Effect.gen(function* () {
        if (
          typeof claims.exp !== "number" ||
          typeof claims.iat !== "number" ||
          claims.exp <= now ||
          claims.exp - claims.iat > ACCOUNT_TOKEN_TTL_SECONDS
        ) {
          return yield* new InvalidAccountToken({});
        }
        return yield* decodeAccountUser({
          id: claims.sub,
          ...(typeof claims.email === "string" ? { email: claims.email } : {}),
          ...(typeof claims.name === "string" ? { name: claims.name } : {}),
        });
      }),
    ),
  );
}
