import { isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { drizzle as drizzlePglite } from "drizzle-orm/pglite";
import { drizzle as drizzlePg } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as authSchema from "./auth-schema.js";
import * as appSchema from "./schema.js";

// Runtime schema = app tables + Better Auth tables. drizzle-kit reads the two
// files directly (see drizzle.config), so we don't re-export across them.
const schema = { ...appSchema, ...authSchema };

// Repo root, resolved from this file (packages/db/src/index.ts) so a relative
// PGlite data dir is stable no matter which package's cwd launches the process.
const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));

function isPostgresUrl(conn: string): boolean {
  return conn.startsWith("postgres://") || conn.startsWith("postgresql://");
}

/** Resolve a DATABASE_URL into a PGlite data dir ("memory://" or an abs path). */
function pgliteDir(conn: string): string {
  if (conn === "" || conn === "memory://" || conn === ":memory:") return "memory://";
  const raw = conn
    .replace(/^pglite:\/\//, "")
    .replace(/^file:\/\//, "")
    .replace(/^file:/, "");
  if (raw === "") return "memory://";
  return isAbsolute(raw) ? raw : resolve(REPO_ROOT, raw);
}

function makePostgres(conn: string) {
  const client = postgres(conn, { max: 10 });
  return Object.assign(drizzlePg(client, { schema, casing: "snake_case" }), {
    $kind: "postgres" as const,
    $dispose: async () => {
      await client.end();
    },
  });
}

type BaseDatabase = Omit<ReturnType<typeof makePostgres>, "$kind">;
export type Database = BaseDatabase & {
  $kind: "postgres" | "pglite";
  $dispose: () => Promise<void>;
};

/**
 * One factory, two drivers. `postgres://` URLs use a real server (prod, CI);
 * anything else (a path, `file:`, `pglite://`, or empty) runs PGlite in-process
 * — same Postgres SQL, tsvector FTS and all, with zero local setup.
 */
export function createDatabase(
  connectionString: string = process.env.DATABASE_URL ?? "memory://",
): Database {
  if (isPostgresUrl(connectionString)) {
    return makePostgres(connectionString) as Database;
  }
  const client = new PGlite(pgliteDir(connectionString));
  return Object.assign(drizzlePglite(client, { schema, casing: "snake_case" }), {
    $kind: "pglite" as const,
    $dispose: async () => {
      await client.close();
    },
  }) as unknown as Database;
}

export * from "./schema.js";
export * from "./auth-schema.js";
export { migrateDatabase } from "./migrate.js";
export { schema };
