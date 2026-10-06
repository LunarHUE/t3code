import { defineConfig } from "drizzle-kit";

// GitHub-hosted runners can use Supabase's IPv4 session pooler for migrations.
// Hyperdrive uses the separate direct connection in RELAY_DATABASE_URL.
const url = process.env.RELAY_MIGRATION_DATABASE_URL;

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/persistence/schema.ts",
  out: "./migrations/postgres",
  // Tools may load this config without a database. Drizzle requires credentials for migrate.
  ...(url ? { dbCredentials: { url } } : {}),
  migrations: { table: "relay_migrations", schema: "public" },
});
