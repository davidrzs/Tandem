import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { admin, mcp } from "better-auth/plugins";
import { SYSTEM, type Database } from "@tandem/db";
import { InstanceService, WorkspaceService } from "@tandem/core";
import {
  consumeInstanceInvite,
  INVITE_TOKEN_HEADER,
  registrationRole,
} from "./registration.js";

export type Auth = ReturnType<typeof createAuth>;

/**
 * Better Auth instance, backed by the SAME Drizzle db the services use
 * (PGlite allows one connection per data dir, so the db must be shared).
 * The mcp() plugin makes this an OAuth 2.1 provider for the MCP endpoint
 * (discovery + dynamic client registration + token issuance).
 */
export function createAuth(db: Database) {
  return betterAuth({
    database: drizzleAdapter(db, { provider: "pg" }),
    emailAndPassword: { enabled: true },
    secret: process.env.BETTER_AUTH_SECRET,
    baseURL: process.env.BETTER_AUTH_URL ?? "http://localhost:5173",
    trustedOrigins: [process.env.WEB_ORIGIN ?? "http://localhost:5173"],
    plugins: [
      mcp({
        loginPage: "/",
        oidcConfig: { loginPage: "/", consentPage: "/oauth/consent" },
      }),
      // Server-level administration (user.role, ban, impersonate, list-users).
      admin(),
    ],
    databaseHooks: {
      user: {
        create: {
          // Enforce the instance registration policy (open/invite/domain/closed)
          // before the account is created. The very first user is always allowed
          // and becomes the server admin; a valid invite token (passed as a
          // request header) allows a signup in any mode. Throws a clean 403
          // otherwise. Runs after the admin() plugin's own before-hook, so a
          // returned { role } overrides its default 'user' role.
          before: async (userData, ctx) => {
            const token =
              ctx?.headers?.get(INVITE_TOKEN_HEADER) ?? undefined;
            const { role } = await registrationRole(db, userData.email, token);
            return role ? { data: { role } } : undefined;
          },
          // Give every new user a personal workspace (system-scoped), and burn
          // the instance invite that admitted them (single-use). Workspace
          // invites stay pending here — acceptInvite consumes them on join.
          after: async (user, ctx) => {
            await new WorkspaceService(db, SYSTEM).provisionForUser(user.id, {
              name: `${user.name || "Personal"} workspace`,
              slug: `ws-${user.id}`,
            });
            const token = ctx?.headers?.get(INVITE_TOKEN_HEADER);
            if (token) await consumeInstanceInvite(db, token, user.id);
          },
        },
        delete: {
          // Tidy up rows that reference the user by bare id (no FK cascade):
          // workspace memberships and per-user settings.
          after: async (user) => {
            await new InstanceService(db, SYSTEM).onUserDeleted(user.id);
          },
        },
      },
    },
  });
}
