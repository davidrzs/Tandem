import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import type { Database } from "@realtime/db";

export type Auth = ReturnType<typeof createAuth>;

/**
 * Better Auth instance, backed by the SAME Drizzle db the services use
 * (PGlite allows one connection per data dir, so the db must be shared).
 * Email/password is enabled; OAuth providers slot in here later.
 */
export function createAuth(db: Database) {
  return betterAuth({
    database: drizzleAdapter(db, { provider: "pg" }),
    emailAndPassword: { enabled: true },
    secret: process.env.BETTER_AUTH_SECRET,
    baseURL: process.env.BETTER_AUTH_URL ?? "http://localhost:5173",
    trustedOrigins: [process.env.WEB_ORIGIN ?? "http://localhost:5173"],
  });
}
