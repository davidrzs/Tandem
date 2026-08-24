import { ForbiddenError } from "../errors.js";
import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import {
  auditLog,
  documents,
  runAsActor,
  SYSTEM,
  user,
  userSettings,
  workspaceMembers,
  type Actor,
  type AuditEntry,
  type Database,
} from "@tandem/db";

export interface SidebarState {
  /** Collection ids the user has unfolded (collections default collapsed). */
  expandedCollections: string[];
  /** Document ids the user has folded (document nodes default expanded). */
  collapsedDocs: string[];
}

export interface AuditView {
  id: string;
  userId: string;
  userName: string;
  /** True when an AI agent performed the action on the user's behalf. */
  ai: boolean;
  action: string;
  detail: string;
  documentId: string | null;
  documentTitle: string | null;
  sessionId: string | null;
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
    if (this.actor.kind !== "user") throw new ForbiddenError("requires a user actor");
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

  /** Sidebar fold state. Collections store the expanded set (default
   * collapsed); document nodes store the collapsed set (default expanded). */
  async sidebarState(): Promise<SidebarState> {
    const userId = this.userId();
    return this.system(async (db) => {
      const [row] = await db
        .select({
          expandedCollections: userSettings.sidebarExpandedCollections,
          collapsedDocs: userSettings.sidebarCollapsedDocs,
        })
        .from(userSettings)
        .where(eq(userSettings.userId, userId));
      return row ?? { expandedCollections: [], collapsedDocs: [] };
    });
  }

  /** Record one fold toggle. Per-id array add/remove (not a whole-set
   * replace), so concurrent tabs never clobber each other. Idempotent. */
  async setSidebarNode(
    kind: "collection" | "doc",
    id: string,
    expanded: boolean,
  ): Promise<void> {
    const userId = this.userId();
    const isCollection = kind === "collection";
    const key = isCollection ? "sidebarExpandedCollections" : "sidebarCollapsedDocs";
    const column = userSettings[key];
    // Inverted semantics: collections store the expanded set, docs the collapsed set.
    const member = isCollection ? expanded : !expanded;
    await this.system(async (db) => {
      await db
        .insert(userSettings)
        .values({ userId, [key]: member ? [id] : [], updatedAt: new Date() })
        .onConflictDoUpdate({
          target: userSettings.userId,
          set: {
            [key]: member
              ? sql`array_append(array_remove(${column}, ${id}), ${id})`
              : sql`array_remove(${column}, ${id})`,
            updatedAt: new Date(),
          },
        });
    });
  }

  /** Record an audit entry (system write — callers are trusted server code).
   * `ai: true` marks agent (MCP) actions; sensitive human actions pass false. */
  async recordAudit(entry: {
    workspaceId: string | null;
    userId: string;
    ai: boolean;
    action: string;
    detail: string;
    documentId?: string | null;
    sessionId?: string | null;
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
      if (!member) throw new ForbiddenError("not a member of this workspace");
      // The title is joined rather than parsed back out of `detail`, which is
      // a display string. Both name the same document to the same members.
      return db
        .select({ entry: auditLog, documentTitle: documents.title })
        .from(auditLog)
        .leftJoin(documents, eq(documents.id, auditLog.documentId))
        .where(eq(auditLog.workspaceId, workspaceId))
        .orderBy(desc(auditLog.createdAt))
        .limit(100);
    });
    return this.withNames(rows);
  }

  /** Recent instance-level administration actions (entries with no workspace).
   * Authorization is the caller's job — only reachable via adminProcedure. */
  async instanceAuditTrail(): Promise<AuditView[]> {
    const rows = await this.system((db) =>
      db
        .select()
        .from(auditLog)
        .where(isNull(auditLog.workspaceId))
        .orderBy(desc(auditLog.createdAt))
        .limit(100),
    );
    // Instance-level administration never targets a document.
    return this.withNames(rows.map((entry) => ({ entry, documentTitle: null })));
  }

  /** Resolve actor names onto raw audit rows (deleted users show as Unknown). */
  private async withNames(
    rows: Array<{ entry: AuditEntry; documentTitle: string | null }>,
  ): Promise<AuditView[]> {
    if (rows.length === 0) return [];
    const ids = [...new Set(rows.map((r) => r.entry.userId))];
    const users = await this.system((db) =>
      db.select({ id: user.id, name: user.name }).from(user).where(inArray(user.id, ids)),
    );
    const names = new Map(users.map((u) => [u.id, u.name]));
    return rows.map(({ entry, documentTitle }) => ({
      id: entry.id,
      userId: entry.userId,
      userName: names.get(entry.userId) ?? "Unknown",
      ai: entry.ai,
      action: entry.action,
      detail: entry.detail,
      documentId: entry.documentId,
      documentTitle,
      sessionId: entry.sessionId,
      createdAt: entry.createdAt,
    }));
  }
}
