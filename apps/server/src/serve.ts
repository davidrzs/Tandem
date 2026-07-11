import { createDatabase } from "@tandem/db";
import { buildHttpServer } from "./http.js";
import { startMaintenance } from "./maintenance.js";

const port = Number(process.env.PORT ?? 3001);
const db = createDatabase(process.env.DATABASE_URL);

buildHttpServer(db)
  .then((app) => {
    // Daily snapshot retention + orphaned-image GC (see maintenance.ts).
    startMaintenance(db, (msg) => app.log.info(msg));
    return app.listen({ port, host: "0.0.0.0" });
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
