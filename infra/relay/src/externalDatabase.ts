import type * as Cloudflare from "alchemy/Cloudflare";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";

export const databaseProvider = Config.Literals(
  ["external", "planetscale"],
  "RELAY_DATABASE_PROVIDER",
).pipe(Config.withDefault("external"));

export class InvalidDatabaseUrl extends Schema.TaggedError<InvalidDatabaseUrl>()(
  "InvalidDatabaseUrl",
  {},
) {
  override get message() {
    return "RELAY_DATABASE_URL must be a PostgreSQL URL with a host, user, password, and database. Use the direct connection, not the transaction pooler.";
  }
}

// Never include a connection URL or a URL parser error in diagnostics.
export function parseDatabaseOrigin(
  value: Redacted.Redacted<string>,
): Cloudflare.Hyperdrive.PublicOrigin {
  try {
    const url = new URL(Redacted.value(value));
    if (
      !["postgres:", "postgresql:"].includes(url.protocol) ||
      !url.hostname ||
      !url.username ||
      !url.password ||
      url.pathname.length < 2 ||
      url.port === "6543" ||
      url.hash
    )
      throw new InvalidDatabaseUrl();
    return {
      scheme: "postgresql",
      host: url.hostname,
      port: url.port ? Number(url.port) : 5432,
      database: decodeURIComponent(url.pathname.slice(1)),
      user: decodeURIComponent(url.username),
      password: Redacted.make(decodeURIComponent(url.password)),
    };
  } catch {
    throw new InvalidDatabaseUrl();
  }
}

export const externalDatabaseOrigin = Config.Redacted("RELAY_DATABASE_URL").pipe(
  Effect.flatMap((value) =>
    Effect.try({
      try: () => parseDatabaseOrigin(value),
      catch: () => new InvalidDatabaseUrl(),
    }).pipe(Effect.orDie),
  ),
);
