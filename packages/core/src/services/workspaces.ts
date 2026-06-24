import {
  runAsActor,
  SYSTEM,
  workspaceMembers,
  workspaces,
  type Actor,
  type Database,
  type Workspace,
} from "@realtime/db";

export class WorkspaceService {
  constructor(
    private readonly db: Database,
    private readonly actor: Actor = SYSTEM,
  ) {}

  private exec<T>(fn: (db: Database) => Promise<T>): Promise<T> {
    return runAsActor(this.db, this.actor, fn);
  }

  /** Workspaces the actor belongs to (RLS-scoped for user actors). */
  async listMine(): Promise<Workspace[]> {
    return this.exec((db) => db.select().from(workspaces).orderBy(workspaces.name));
  }

  /** The actor's default (first) workspace id, or null. */
  async defaultWorkspaceId(): Promise<string | null> {
    return this.exec(async (db) => {
      const [row] = await db.select({ id: workspaces.id }).from(workspaces).limit(1);
      return row?.id ?? null;
    });
  }

  /**
   * Provision a workspace with the given user as owner. System-only (the
   * signup hook) — creating a workspace + its first membership can't be done
   * under RLS by a user who isn't a member of it yet.
   */
  async provisionForUser(
    userId: string,
    input: { name: string; slug: string },
  ): Promise<Workspace> {
    return this.exec(async (db) => {
      const [ws] = await db.insert(workspaces).values(input).returning();
      await db.insert(workspaceMembers).values({
        workspaceId: ws!.id,
        userId,
        role: "owner",
      });
      return ws!;
    });
  }
}
