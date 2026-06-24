import { isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { sql } from "drizzle-orm";
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

/**
 * Who is acting. `system` uses the base (superuser) connection and bypasses
 * RLS — for signup provisioning, the local stdio MCP, and tests. `user` runs
 * inside a transaction as the non-privileged `app_user` role with
 * `app.user_id` set, so RLS policies scope every query to that user's
 * workspaces.
 */
export type Actor = { kind: "system" } | { kind: "user"; userId: string };
export const SYSTEM: Actor = { kind: "system" };

/** Run `fn` under the actor's authority. The db handed to `fn` must be used for
 * all queries so they share the actor's transaction/role. */
export async function runAsActor<T>(
  db: Database,
  actor: Actor,
  fn: (db: Database) => Promise<T>,
): Promise<T> {
  if (actor.kind === "system") return fn(db);
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT set_config('app.user_id', ${actor.userId}, true)`);
    await tx.execute(sql`SET LOCAL ROLE app_user`);
    return fn(tx as unknown as Database);
  });
}

export * from "./schema.js";
export * from "./auth-schema.js";
export { migrateDatabase } from "./migrate.js";
export { schema };
