// Config entry for the Better Auth CLI (`@better-auth/cli generate`). Uses an
// ephemeral in-memory db purely so the CLI can read the config and emit the
// Drizzle schema — no data is touched.
import { createDatabase } from "@tandem/db";
import { createAuth } from "./auth.js";

export const auth = createAuth(createDatabase("memory://"));
