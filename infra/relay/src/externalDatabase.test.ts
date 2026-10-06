import { expect, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";

import { ConfiguredDatabase } from "./db.ts";
import { parseDatabaseOrigin } from "./externalDatabase.ts";

it("decodes PostgreSQL credentials and keeps the password redacted", () => {
  const origin = parseDatabaseOrigin(
    Redacted.make(
      "postgresql://relay%40user:p%40ss%3Aword@db.example.com:5432/postgres?sslmode=require",
    ),
  );
  expect(origin.host).toBe("db.example.com");
  expect(origin.port).toBe(5432);
  expect(origin.user).toBe("relay@user");
  expect(origin.database).toBe("postgres");
  expect(Redacted.value(origin.password)).toBe("p@ss:word");
  expect(JSON.stringify(origin)).not.toContain("p@ss:word");
});

it.each([
  "https://user:secret@db.example.com/postgres",
  "postgresql://user:secret@db.example.com:6543/postgres",
  "postgresql://user:secret@db.example.com/",
  "postgresql://user@db.example.com/postgres",
  "postgresql://user:secret%ZZ@db.example.com/postgres",
  "secret-not-a-url",
])("rejects invalid database connection input without leaking it", (url) => {
  try {
    parseDatabaseOrigin(Redacted.make(url));
    expect.fail("Expected invalid connection to fail");
  } catch (error) {
    expect(String(error)).toContain("RELAY_DATABASE_URL");
    expect(String(error)).not.toContain("secret");
    expect(String(error)).not.toContain(url);
  }
});

it.effect("uses the existing database without PlanetScale or an Alchemy stack", () =>
  Effect.gen(function* () {
    const db = yield* ConfiguredDatabase.pipe(
      // Deliberately omit provisioning services: disabled mode must never request them.
      Effect.provide(
        Context.empty() as Context.Context<Effect.Services<typeof ConfiguredDatabase>>,
      ),
    );
    expect(db.databaseName).toBe("postgres");
    expect(db.branchName).toBe("external");
  }).pipe(
    Effect.provide(
      ConfigProvider.layer(
        ConfigProvider.fromUnknown({
          RELAY_DATABASE_URL: "postgresql://relay:secret@db.example.com/postgres",
        }),
      ),
    ),
  ),
);
