/** E2E entrypoint: one in-memory database, migrated on boot, fixed test
 * secret — the real server otherwise (collab, MCP, auth, built SPA). */
import { createDatabase, migrateDatabase } from "@tandem/db";
import { buildHttpServer } from "./http.js";

process.env.BETTER_AUTH_SECRET ??= "e2e-secret-not-for-production-use";
process.env.PORT ??= "3799";
process.env.BETTER_AUTH_URL ??= `http://localhost:${process.env.PORT}`;
process.env.WEB_ORIGIN ??= `http://localhost:${process.env.PORT}`;

async function main() {
  const db = createDatabase("memory://");
  await migrateDatabase(db);
  const app = await buildHttpServer(db);
  await app.listen({ port: Number(process.env.PORT), host: "127.0.0.1" });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
