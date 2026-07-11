import { betterAuth } from "better-auth";
import { APIError, createAuthMiddleware, getSessionFromCtx } from "better-auth/api";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { admin, mcp, twoFactor } from "better-auth/plugins";
import { eq } from "drizzle-orm";
import { SYSTEM, user as userTable, type Database } from "@tandem/db";
import { InstanceService, SettingsService, WorkspaceService } from "@tandem/core";
import {
  consumeInstanceInvite,
  INVITE_TOKEN_HEADER,
  reconcileBootstrapAdmin,
  registrationRole,
} from "./registration.js";

/** Better Auth admin endpoints that must leave an instance-level audit entry.
 * remove-user is audited in the user.delete.after hook instead — by the time
 * this endpoint hook runs, the row (and its email) is gone. */
const AUDITED_ADMIN_PATHS: Record<string, string> = {
  "/admin/set-role": "admin_set_role",
  "/admin/ban-user": "admin_ban_user",
  "/admin/unban-user": "admin_unban_user",
  "/admin/create-user": "admin_create_user",
  "/admin/set-user-password": "admin_set_password",
};

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
      // Optional TOTP second factor (enrolled per-user in Settings). Sign-in
      // for an enrolled user returns { twoFactorRedirect: true } until the
      // code (or a backup code) is verified.
      twoFactor(),
    ],
    hooks: {
      // Instance-level audit: every state-changing admin() endpoint records
      // who did what to whom. Runs only after a SUCCESSFUL handler (thrown
      // APIErrors skip after-hooks), and never fails the request itself.
      after: createAuthMiddleware(async (ctx) => {
        const action = AUDITED_ADMIN_PATHS[ctx.path];
        if (!action) return;
        try {
          const session = await getSessionFromCtx(ctx);
          if (!session) return;
          const body = (ctx.body ?? {}) as Record<string, unknown>;
          const targetId = typeof body.userId === "string" ? body.userId : null;
          const [target] = targetId
            ? await db
                .select({ email: userTable.email })
                .from(userTable)
                .where(eq(userTable.id, targetId))
            : [];
          const detail = [
            // remove-user: the row is gone by now; fall back to the raw id.
            target?.email ?? (typeof body.email === "string" ? body.email : targetId ?? ""),
            typeof body.role === "string" ? `role=${body.role}` : "",
          ]
            .filter(Boolean)
            .join(" ");
          await new SettingsService(db).recordAudit({
            workspaceId: null,
            userId: session.user.id,
            ai: false,
            action,
            detail,
          });
        } catch (err) {
          console.error("admin audit write failed", err);
        }
      }),
    },
    databaseHooks: {
      user: {
        create: {
          // Enforce the instance registration policy (open/invite/domain/closed)
          // before the account is created. The very first user is always allowed
          // and becomes the server admin; a valid invite token (passed as a
          // request header) allows a signup in any mode. Throws a clean 403
          // otherwise. Runs after the admin() plugin's own before-hook, so a
          // returned { role } overrides its default 'user' role. Admin-created
          // accounts (/admin/create-user) bypass the policy: the plugin already
          // verified the caller is an admin, and closed mode exists precisely
          // so that the admin is the one who creates accounts.
          before: async (userData, ctx) => {
            if (ctx?.path === "/admin/create-user") return;
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
            // Bootstrap admins only (plain signup, no invite): converge a
            // concurrent double-bootstrap to a single admin.
            if (user.role === "admin" && !token && ctx?.path === "/sign-up/email") {
              await reconcileBootstrapAdmin(db, user.id);
            }
          },
        },
        delete: {
          // Refuse to delete the sole owner of a workspace other people still
          // use — the workspace would become unmanageable. Transfer ownership
          // first. (Personal, sole-member workspaces are deleted with the user.)
          before: async (user) => {
            const blockers = await new InstanceService(db, SYSTEM).soleOwnedSharedWorkspaces(
              user.id,
            );
            if (blockers.length > 0) {
              throw new APIError("BAD_REQUEST", {
                message:
                  `This user is the only owner of shared workspace(s): ` +
                  `${blockers.join(", ")}. Transfer ownership before deleting the account.`,
              });
            }
          },
          // Tidy up: drop their sole-member workspaces (FK cascade takes the
          // content), then the bare-id rows (memberships, settings). Audited
          // here rather than in the endpoint hook so the target's email is
          // still known.
          after: async (user, ctx) => {
            await new InstanceService(db, SYSTEM).onUserDeleted(user.id);
            try {
              const session = ctx ? await getSessionFromCtx(ctx) : null;
              await new SettingsService(db).recordAudit({
                workspaceId: null,
                userId: session?.user.id ?? "unknown",
                ai: false,
                action: "admin_remove_user",
                detail: user.email,
              });
            } catch (err) {
              console.error("admin audit write failed", err);
            }
          },
        },
      },
    },
  });
}
