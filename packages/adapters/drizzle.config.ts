import { defineConfig } from "drizzle-kit";

// Used only by `drizzle-kit generate`. Migrations are committed SQL and run by `runMigrations`.
export default defineConfig({
  dialect: "postgresql",
  schema: "./src/postgres/schema.ts",
  out: "./drizzle",
});
