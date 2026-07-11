import { randomBytes } from "node:crypto";
import { and, desc, eq, isNull, ne } from "drizzle-orm";
import {
  instanceInvites,
  instanceSettings,
  runAsActor,
  SYSTEM,
  user,
  userSettings,
  workspaceMembers,
  workspaces,
  type Actor,
  type Database,
  type InstanceInvite,
  type InstanceSettings,
} from "@tandem/db";

export type RegistrationMode = "open" | "invite" | "domain" | "closed";

/** The full, normalized instance settings (defaults applied when no row yet). */
export interface InstanceSettingsView {
  registrationMode: RegistrationMode;
  allowedEmailDomains: string[];
  instanceName: string;
  allowWorkspaceCreation: boolean;
}

/** The subset safe to expose to unauthenticated clients (the login screen). */
export interface PublicInstanceSettings {
  instanceName: string;
  registrationMode: RegistrationMode;
  allowedEmailDomains: string[];
}

const DEFAULTS: InstanceSettingsView = {
  registrationMode: "open",
  allowedEmailDomains: [],
  instanceName: "Tandem",
  allowWorkspaceCreation: true,
};

/**
 * Instance-wide (server) administration: the single-row settings and the
 * server-invite lifecycle. Everything here is system-managed (the tables have
 * no app_user grant), so the service always runs SYSTEM-scoped — callers gate
 * access above it (the unauthenticated setup/public routes, or the
 * role-checked adminProcedure). Mirrors SettingsService's system-op pattern.
 */
export class InstanceService {
  constructor(
    private readonly db: Database,readonly _actor: Actor = SYSTEM,
  ) {}

  private system<T>(fn: (db: Database) => Promise<T>): Promise<T> {
    return runAsActor(this.db, SYSTEM, fn);
  }

  /** True when no account exists yet — the server still needs its first admin. */
  async needsSetup(): Promise<boolean> {
    return this.system(async (db) => {
      const [row] = await db.select({ id: user.id }).from(user).limit(1);
      return !row;
    });
  }

  /** The full settings, with column defaults applied when the row is absent. */
  async getSettings(): Promise<InstanceSettingsView> {
    return this.system(async (db) => {
      const [row] = await db.select().from(instanceSettings).limit(1);
      return row ? normalize(row) : { ...DEFAULTS };
    });
  }

  /** The unauthenticated-safe subset for the login/signup screen. */
  async getPublicSettings(): Promise<PublicInstanceSettings> {
    const s = await this.getSettings();
    return {
      instanceName: s.instanceName,
      registrationMode: s.registrationMode,
      allowedEmailDomains: s.allowedEmailDomains,
    };
  }

  /** Create or replace the settings row (used by the first-run setup wizard). */
  async initialize(input: {
    registrationMode: RegistrationMode;
    allowedEmailDomains?: string[];
    instanceName?: string;
  }): Promise<InstanceSettingsView> {
    return this.updateSettings(input);
  }

  /** Upsert a partial patch onto the single settings row. */
  async updateSettings(patch: {
    registrationMode?: RegistrationMode;
    allowedEmailDomains?: string[];
    instanceName?: string;
    allowWorkspaceCreation?: boolean;
  }): Promise<InstanceSettingsView> {
    const clean = {
      ...patch,
      ...(patch.allowedEmailDomains
        ? { allowedEmailDomains: normalizeDomains(patch.allowedEmailDomains) }
        : {}),
    };
    return this.system(async (db) => {
      const [row] = await db
        .insert(instanceSettings)
        .values({ id: true, ...clean })
        .onConflictDoUpdate({
          target: instanceSettings.id,
          set: { ...clean, updatedAt: new Date() },
        })
        .returning();
      return normalize(row!);
    });
  }

  // --- server invites ---

  /** Mint a server-invite link. `role` may grant admin; email optionally binds. */
  async createInvite(input: {
    createdBy: string;
    email?: string | null;
    role?: "user" | "admin";
    expiresInDays?: number;
  }): Promise<InstanceInvite> {
    const token = randomBytes(24).toString("base64url");
    const expiresAt = input.expiresInDays
      ? new Date(Date.now() + input.expiresInDays * 86_400_000)
      : null;
    return this.system(async (db) => {
      const [row] = await db
        .insert(instanceInvites)
        .values({
          token,
          email: input.email?.trim() || null,
          role: input.role === "admin" ? "admin" : "user",
          createdBy: input.createdBy,
          expiresAt,
        })
        .returning();
      return row!;
    });
  }

  /** Outstanding (unaccepted) server invites, newest first. */
  async listInvites(): Promise<InstanceInvite[]> {
    return this.system((db) =>
      db
        .select()
        .from(instanceInvites)
        .where(isNull(instanceInvites.acceptedAt))
        .orderBy(desc(instanceInvites.createdAt)),
    );
  }

  async revokeInvite(id: string): Promise<void> {
    await this.system((db) =>
      db
        .delete(instanceInvites)
        .where(and(eq(instanceInvites.id, id), isNull(instanceInvites.acceptedAt))),
    );
  }

  /**
   * Names of workspaces this user solely owns while other members remain.
   * Deleting such a user would leave the workspace unmanageable (readable via
   * RLS, but nobody left who can administer sharing) — callers should refuse
   * the deletion and ask for an ownership transfer first.
   */
  async soleOwnedSharedWorkspaces(userId: string): Promise<string[]> {
    return this.system(async (db) => {
      const owned = await db
        .select({ id: workspaces.id, name: workspaces.name })
        .from(workspaces)
        .innerJoin(workspaceMembers, eq(workspaceMembers.workspaceId, workspaces.id))
        .where(and(eq(workspaceMembers.userId, userId), eq(workspaceMembers.role, "owner")));
      const blockers: string[] = [];
      for (const ws of owned) {
        const others = await db
          .select({ role: workspaceMembers.role })
          .from(workspaceMembers)
          .where(
            and(eq(workspaceMembers.workspaceId, ws.id), ne(workspaceMembers.userId, userId)),
          );
        if (others.length > 0 && !others.some((m) => m.role === "owner")) {
          blockers.push(ws.name);
        }
      }
      return blockers;
    });
  }

  /**
   * Clean up when an account is deleted: drop workspaces where the user was
   * the only member (their personal spaces — FK cascade removes collections,
   * documents, and membership rows), then the tables that reference the user
   * by bare id with no FK cascade: remaining memberships and settings.
   * Authored content (documents/comments) keeps its id and simply shows as an
   * unknown author — reassigning it is out of scope. Wired to the better-auth
   * user.delete.after hook, so it runs for every deletion path.
   */
  async onUserDeleted(userId: string): Promise<void> {
    await this.system(async (db) => {
      const mine = await db
        .select({ workspaceId: workspaceMembers.workspaceId })
        .from(workspaceMembers)
        .where(eq(workspaceMembers.userId, userId));
      for (const { workspaceId } of mine) {
        const [other] = await db
          .select({ id: workspaceMembers.id })
          .from(workspaceMembers)
          .where(
            and(
              eq(workspaceMembers.workspaceId, workspaceId),
              ne(workspaceMembers.userId, userId),
            ),
          )
          .limit(1);
        if (!other) await db.delete(workspaces).where(eq(workspaces.id, workspaceId));
      }
      await db.delete(workspaceMembers).where(eq(workspaceMembers.userId, userId));
      await db.delete(userSettings).where(eq(userSettings.userId, userId));
    });
  }
}

function normalize(row: InstanceSettings): InstanceSettingsView {
  return {
    registrationMode: (row.registrationMode as RegistrationMode) ?? DEFAULTS.registrationMode,
    allowedEmailDomains: row.allowedEmailDomains ?? [],
    instanceName: row.instanceName || DEFAULTS.instanceName,
    allowWorkspaceCreation: row.allowWorkspaceCreation,
  };
}

/** Trim, lowercase, strip a leading @, drop empties, dedupe. */
function normalizeDomains(domains: readonly string[]): string[] {
  const seen = new Set<string>();
  for (const raw of domains) {
    const d = raw.trim().toLowerCase().replace(/^@/, "");
    if (d) seen.add(d);
  }
  return [...seen];
}
