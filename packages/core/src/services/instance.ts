import { randomBytes } from "node:crypto";
import { and, desc, eq, isNull } from "drizzle-orm";
import {
  instanceInvites,
  instanceSettings,
  runAsActor,
  SYSTEM,
  user,
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
    private readonly db: Database,
    private readonly actor: Actor = SYSTEM,
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
