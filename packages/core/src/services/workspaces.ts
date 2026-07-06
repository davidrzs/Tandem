import { randomBytes } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import {
  runAsActor,
  SYSTEM,
  user,
  workspaceInvites,
  workspaceMembers,
  workspaces,
  type Actor,
  type Database,
  type Workspace,
} from "@tandem/db";

export interface WorkspaceMemberInfo {
  userId: string;
  role: string;
  name: string;
  email: string;
  joinedAt: Date;
}

export class WorkspaceService {
  constructor(
    private readonly db: Database,
    private readonly actor: Actor = SYSTEM,
  ) {}

  private exec<T>(fn: (db: Database) => Promise<T>): Promise<T> {
    return runAsActor(this.db, this.actor, fn);
  }

  /** Run as the superuser connection (bypasses RLS) — for system-gated ops. */
  private system<T>(fn: (db: Database) => Promise<T>): Promise<T> {
    return runAsActor(this.db, SYSTEM, fn);
  }

  private userId(): string {
    if (this.actor.kind !== "user") throw new Error("requires a user actor");
    return this.actor.userId;
  }

  /** Workspaces the actor belongs to (RLS-scoped for user actors). */
  async listMine(): Promise<Workspace[]> {
    return this.exec((db) => db.select().from(workspaces).orderBy(workspaces.name));
  }

  /** Create workspace + owner membership for the given user (system). */
  async provisionForUser(
    userId: string,
    input: { name: string; slug: string },
  ): Promise<Workspace> {
    return this.system((db) =>
      // Atomic: a failed member insert must not orphan the workspace (which
      // would be invisible under RLS and permanently reserve the slug).
      db.transaction(async (tx) => {
        const [ws] = await tx.insert(workspaces).values(input).returning();
        await tx
          .insert(workspaceMembers)
          .values({ workspaceId: ws!.id, userId, role: "owner" });
        return ws!;
      }),
    );
  }

  /** The current user creates a new (team) workspace and becomes its owner. */
  async create(input: { name: string; slug: string }): Promise<Workspace> {
    return this.provisionForUser(this.userId(), input);
  }

  /** The actor's role in a workspace, or null if not a member. */
  private async myRole(workspaceId: string): Promise<string | null> {
    return this.exec(async (db) => {
      const [row] = await db
        .select({ role: workspaceMembers.role })
        .from(workspaceMembers)
        .where(
          and(
            eq(workspaceMembers.workspaceId, workspaceId),
            eq(workspaceMembers.userId, this.userId()),
          ),
        );
      return row?.role ?? null;
    });
  }

  /** Create an invite link. Owner/admin only. */
  async createInvite(input: {
    workspaceId: string;
    role?: string;
    email?: string;
    expiresInDays?: number;
  }): Promise<{ token: string; workspaceId: string; role: string }> {
    const role = await this.myRole(input.workspaceId);
    if (role !== "owner" && role !== "admin") {
      throw new Error("only an owner or admin can invite");
    }
    // Validate the granted role in the service (not just the tRPC enum): you
    // can't grant a role above your own — only an owner may invite owners.
    const granted = input.role ?? "member";
    if (!["member", "admin", "owner"].includes(granted)) {
      throw new Error("invalid invite role");
    }
    if (granted === "owner" && role !== "owner") {
      throw new Error("only an owner can grant the owner role");
    }
    const token = randomBytes(24).toString("base64url");
    const expiresAt = input.expiresInDays
      ? new Date(Date.now() + input.expiresInDays * 86_400_000)
      : null;
    // Actor-scoped: the RLS insert policy independently enforces that the
    // creator is an owner/admin and pins created_by to them.
    return this.exec(async (db) => {
      const [row] = await db
        .insert(workspaceInvites)
        .values({
          workspaceId: input.workspaceId,
          role: granted,
          email: input.email ?? null,
          token,
          createdBy: this.userId(),
          expiresAt,
        })
        .returning();
      return { token: row!.token, workspaceId: row!.workspaceId, role: row!.role };
    });
  }

  /** Accept an invite by its secret token — joins the acting user to the
   * workspace. Redemption runs through the SECURITY DEFINER app_accept_invite():
   * the invitee isn't a member yet, so no RLS membership policy could authorize
   * the read/join — the unguessable token is the capability. The function acts
   * only for app.user_id, so a user can only ever accept an invite as themselves. */
  async acceptInvite(token: string): Promise<Workspace> {
    return this.exec(async (db) => {
      // Raises on an invalid / expired / already-used token; joins on success.
      const result = await db.execute(
        sql`SELECT app_accept_invite(${token}) AS workspace_id`,
      );
      // execute()'s row shape differs by driver: an array for postgres-js, a
      // { rows } object for PGlite. Normalize before reading the returned id.
      const rows = (Array.isArray(result) ? result : (result as { rows?: unknown[] }).rows) ?? [];
      const wsId = (rows[0] as { workspace_id?: string } | undefined)?.workspace_id;
      if (!wsId) throw new Error("invalid or already-used invite");
      const [ws] = await db.select().from(workspaces).where(eq(workspaces.id, wsId));
      return ws!;
    });
  }

  /** Workspace members with their user identity — for the member list,
   * sharing pickers, and blame name resolution. Members only. */
  async members(workspaceId: string): Promise<WorkspaceMemberInfo[]> {
    const role = await this.myRole(workspaceId);
    if (!role) throw new Error("not a member of this workspace");
    // The auth user table isn't RLS-granted; join it system-scoped after the
    // membership check above.
    return this.system((db) =>
      db
        .select({
          userId: workspaceMembers.userId,
          role: workspaceMembers.role,
          name: user.name,
          email: user.email,
          joinedAt: workspaceMembers.createdAt,
        })
        .from(workspaceMembers)
        .innerJoin(user, eq(user.id, workspaceMembers.userId))
        .where(eq(workspaceMembers.workspaceId, workspaceId))
        .orderBy(workspaceMembers.createdAt),
    );
  }
}
