import { and, desc, eq, inArray } from "drizzle-orm";
import {
  auditLog,
  runAsActor,
  SYSTEM,
  user,
  userSettings,
  workspaceMembers,
  type Actor,
  type Database,
} from "@tandem/db";

export interface AuditView {
  id: string;
  userId: string;
  userName: string;
  action: string;
  detail: string;
  createdAt: Date;
}

/**
 * Per-user settings and the AI audit trail. Settings rows are system-managed
 * (RLS has no grants) and only ever read/written for the acting user; audit
 * entries are written system-side by the MCP layer and read RLS-scoped.
 */
export class SettingsService {
  constructor(
    private readonly db: Database,
    private readonly actor: Actor = SYSTEM,
  ) {}

  private system<T>(fn: (db: Database) => Promise<T>): Promise<T> {
    return runAsActor(this.db, SYSTEM, fn);
  }

  private userId(): string {
    if (this.actor.kind !== "user") throw new Error("requires a user actor");
    return this.actor.userId;
  }

  /** Whether MCP agents may act as this user. Defaults to enabled. */
  async mcpEnabled(userId = this.userId()): Promise<boolean> {
    return this.system(async (db) => {
      const [row] = await db
        .select({ mcpEnabled: userSettings.mcpEnabled })
        .from(userSettings)
        .where(eq(userSettings.userId, userId));
      return row?.mcpEnabled ?? true;
    });
  }

  async setMcpEnabled(enabled: boolean): Promise<void> {
    const userId = this.userId();
    await this.system(async (db) => {
      await db
        .insert(userSettings)
        .values({ userId, mcpEnabled: enabled, updatedAt: new Date() })
        .onConflictDoUpdate({
          target: userSettings.userId,
          set: { mcpEnabled: enabled, updatedAt: new Date() },
        });
    });
  }

  /** Record an agent action (system write — callers are trusted server code). */
  async recordAudit(entry: {
    workspaceId: string | null;
    userId: string;
    action: string;
    detail: string;
  }): Promise<void> {
    await this.system(async (db) => {
      await db.insert(auditLog).values(entry);
    });
  }

  /** Recent agent actions in a workspace. RLS scopes to members; the caller's
   * membership is additionally asserted so a non-member gets an error rather
   * than an empty list. */
  async auditTrail(workspaceId: string): Promise<AuditView[]> {
    const me = this.userId();
    const rows = await this.system(async (db) => {
      const [member] = await db
        .select({ id: workspaceMembers.id })
        .from(workspaceMembers)
        .where(
          and(
            eq(workspaceMembers.workspaceId, workspaceId),
            eq(workspaceMembers.userId, me),
          ),
        );
      if (!member) throw new Error("not a member of this workspace");
      return db
        .select()
        .from(auditLog)
        .where(eq(auditLog.workspaceId, workspaceId))
        .orderBy(desc(auditLog.createdAt))
        .limit(100);
    });
    if (rows.length === 0) return [];
    const ids = [...new Set(rows.map((r) => r.userId))];
    const users = await this.system((db) =>
      db.select({ id: user.id, name: user.name }).from(user).where(inArray(user.id, ids)),
    );
    const names = new Map(users.map((u) => [u.id, u.name]));
    return rows.map((r) => ({
      id: r.id,
      userId: r.userId,
      userName: names.get(r.userId) ?? "Unknown",
      action: r.action,
      detail: r.detail,
      createdAt: r.createdAt,
    }));
  }
}
