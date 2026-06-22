import { defineConfig } from "drizzle-kit";

// `generate` only needs the schema; `push`/introspect (Postgres only) need a
// real URL. PGlite dev migrations run via `pnpm db:migrate` (programmatic).
const url = process.env.DATABASE_URL ?? "postgres://localhost:5432/realtime";

export default defineConfig({
  schema: ["./src/schema.ts", "./src/auth-schema.ts"],
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: { url },
  casing: "snake_case",
});
