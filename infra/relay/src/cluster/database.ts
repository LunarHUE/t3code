import * as PgClient from "@effect/sql-pg/PgClient";
import * as PgDrizzle from "drizzle-orm/effect-postgres";
import * as Config from "effect/Config";
import * as Layer from "effect/Layer";
import { RelayDb } from "../db.ts";

export const layer = Layer.effect(RelayDb, PgDrizzle.makeWithDefaults()).pipe(
  Layer.provide(
    PgClient.layerConfig({
      url: Config.Redacted("RELAY_DATABASE_URL"),
      maxConnections: Config.Number("RELAY_DATABASE_POOL_SIZE").pipe(Config.withDefault(10)),
      prepare: Config.succeed(false),
    }),
  ),
);
