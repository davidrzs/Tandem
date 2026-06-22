import { fileURLToPath } from "node:url";
import { migrate as pgliteMigrate } from "drizzle-orm/pglite/migrator";
import { migrate as pgMigrate } from "drizzle-orm/postgres-js/migrator";
import type { Database } from "./index.js";

const MIGRATIONS_FOLDER = fileURLToPath(new URL("../drizzle", import.meta.url));

/** Apply pending migrations using the migrator matching the active driver. */
export async function migrateDatabase(db: Database): Promise<void> {
  const opts = { migrationsFolder: MIGRATIONS_FOLDER };
  if (db.$kind === "postgres") {
    await pgMigrate(db as never, opts);
  } else {
    await pgliteMigrate(db as never, opts);
  }
}
