import { and, eq } from "drizzle-orm";
import {
  groupMembers,
  groups,
  runAsActor,
  SYSTEM,
  workspaceMembers,
  type Actor,
  type Database,
  type Group,
} from "@tandem/db";

export class GroupService {
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

  private async roleIn(db: Database, workspaceId: string): Promise<string | null> {
    const [m] = await db
      .select({ role: workspaceMembers.role })
      .from(workspaceMembers)
      .where(
        and(
          eq(workspaceMembers.workspaceId, workspaceId),
          eq(workspaceMembers.userId, this.userId()),
        ),
      );
    return m?.role ?? null;
  }

  /** Groups in a workspace — visible to any member. */
  async list(workspaceId: string): Promise<Group[]> {
    return this.system(async (db) => {
      if (!(await this.roleIn(db, workspaceId))) throw new Error("not a member");
      return db.select().from(groups).where(eq(groups.workspaceId, workspaceId));
    });
  }

  async create(workspaceId: string, name: string): Promise<Group> {
    return this.system(async (db) => {
      const role = await this.roleIn(db, workspaceId);
      if (role !== "owner" && role !== "admin") {
        throw new Error("only an owner or admin can create groups");
      }
      const [row] = await db.insert(groups).values({ workspaceId, name }).returning();
      return row!;
    });
  }

  private async assertCanManageGroup(db: Database, groupId: string): Promise<void> {
    const [g] = await db
      .select({ ws: groups.workspaceId })
      .from(groups)
      .where(eq(groups.id, groupId));
    if (!g) throw new Error("group not found");
    const role = await this.roleIn(db, g.ws);
    if (role !== "owner" && role !== "admin") {
      throw new Error("only an owner or admin can manage groups");
    }
  }

  async addMember(groupId: string, userId: string): Promise<void> {
    await this.system(async (db) => {
      await this.assertCanManageGroup(db, groupId);
      // Only workspace members can be grouped (a foreign id would be inert
      // under RLS, but don't store it).
      const [g] = await db
        .select({ ws: groups.workspaceId })
        .from(groups)
        .where(eq(groups.id, groupId));
      const [m] = await db
        .select({ userId: workspaceMembers.userId })
        .from(workspaceMembers)
        .where(
          and(eq(workspaceMembers.workspaceId, g!.ws), eq(workspaceMembers.userId, userId)),
        );
      if (!m) throw new Error("that user is not a member of this workspace");
      await db.insert(groupMembers).values({ groupId, userId }).onConflictDoNothing();
    });
  }

  async removeMember(groupId: string, userId: string): Promise<void> {
    await this.system(async (db) => {
      await this.assertCanManageGroup(db, groupId);
      await db
        .delete(groupMembers)
        .where(and(eq(groupMembers.groupId, groupId), eq(groupMembers.userId, userId)));
    });
  }

  /** User ids in a group — visible to any member of its workspace. */
  async members(groupId: string): Promise<string[]> {
    return this.system(async (db) => {
      const [g] = await db
        .select({ ws: groups.workspaceId })
        .from(groups)
        .where(eq(groups.id, groupId));
      if (!g) throw new Error("group not found");
      if (!(await this.roleIn(db, g.ws))) throw new Error("not a member");
      const rows = await db
        .select({ userId: groupMembers.userId })
        .from(groupMembers)
        .where(eq(groupMembers.groupId, groupId));
      return rows.map((r) => r.userId);
    });
  }

  /** Delete a group (its collection grants cascade away with it). */
  async delete(groupId: string): Promise<void> {
    await this.system(async (db) => {
      await this.assertCanManageGroup(db, groupId);
      await db.delete(groups).where(eq(groups.id, groupId));
    });
  }
}
