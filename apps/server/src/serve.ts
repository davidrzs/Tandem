import { backfillTaskRows } from "@tandem/core";
import { createDatabase, migrateDatabase } from "@tandem/db";
import { buildHttpServer } from "./http.js";
import { startMaintenance } from "./maintenance.js";

const port = Number(process.env.PORT ?? 3001);
const db = createDatabase(process.env.DATABASE_URL);

// Apply pending migrations before serving, so a deploy can't start new code
// against an old schema. MIGRATE_ON_BOOT=0 leaves it to a separate release
// step (e.g. several instances starting at once).
(process.env.MIGRATE_ON_BOOT === "0" ? Promise.resolve() : migrateDatabase(db))
  // Pages last saved before the tasks table get their rows before any live
  // session can hold them (see backfillTaskRows).
  .then(() => backfillTaskRows(db))
  .then(() => buildHttpServer(db))
  .then((app) => {
    // Daily snapshot retention + orphaned-image GC (see maintenance.ts).
    startMaintenance(db, (msg) => app.log.info(msg));
    // As PID 1 in a container, node ignores SIGTERM without a handler and gets
    // SIGKILLed after the stop timeout, dropping unsaved collab edits.
    for (const signal of ["SIGTERM", "SIGINT"] as const) {
      process.once(signal, () => {
        app.log.info(`${signal}: shutting down`);
        // Stay under docker's 10s stop timeout even if a save hangs.
        setTimeout(() => process.exit(1), 8000).unref();
        app.close().then(
          () => process.exit(0),
          (err) => {
            app.log.error(err);
            process.exit(1);
          },
        );
      });
    }
    return app.listen({ port, host: "0.0.0.0" });
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
