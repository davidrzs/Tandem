import { createDatabase } from "./index.js";
import { migrateDatabase } from "./migrate.js";

const db = createDatabase();
await migrateDatabase(db);
console.log(`migrations applied (${db.$kind})`);
await db.$dispose();
