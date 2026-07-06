import { and, eq, getTableColumns, isNull, sql } from "drizzle-orm";
import {
  collectionPermissions,
  collections,
  groups,
  runAsActor,
  SYSTEM,
  workspaceMembers,
  workspaces,
  type Actor,
  type Collection,
  type CollectionPermission,
  type Database,
} from "@tandem/db";

export interface CreateCollectionInput {
  name: string;
  slug: string;
  description?: string;
  icon?: string;
  color?: string;
  workspaceId?: string;
}

export type CollectionRole = "none" | "read" | "read_write";
export interface CollectionWithAccess extends Collection {
  writable: boolean;
}

export class CollectionService {
  constructor(
    private readonly db: Database,
    private readonly actor: Actor = SYSTEM,
  ) {}

  private exec<T>(fn: (db: Database) => Promise<T>): Promise<T> {
    return runAsActor(this.db, this.actor, fn);
  }
  private system<T>(fn: (db: Database) => Promise<T>): Promise<T> {
    return runAsActor(this.db, SYSTEM, fn);
  }
  private userId(): string {
    if (this.actor.kind !== "user") throw new Error("requires a user actor");
    return this.actor.userId;
  }

  /** Only a workspace owner/admin may change a collection's sharing. */
  private async assertCanManage(collectionId: string): Promise<void> {
    const userId = this.userId();
    await this.system(async (db) => {
      const [col] = await db
        .select({ ws: collections.workspaceId })
        .from(collections)
        .where(eq(collections.id, collectionId));
      if (!col) throw new Error("collection not found");
      const [m] = await db
        .select({ role: workspaceMembers.role })
        .from(workspaceMembers)
        .where(
          and(
            eq(workspaceMembers.workspaceId, col.ws),
            eq(workspaceMembers.userId, userId),
          ),
        );
      if (!m || (m.role !== "owner" && m.role !== "admin")) {
        throw new Error("only an owner or admin can manage sharing");
      }
    });
  }

  async create(input: CreateCollectionInput): Promise<Collection> {
    return this.exec(async (db) => {
      let workspaceId = input.workspaceId;
      if (!workspaceId) {
        // The list is RLS-scoped to the actor's own workspaces. A single
        // result is a safe default; more than one is ambiguous — refuse to
        // guess, or we'd write into an arbitrary tenant.
        const rows = await db.select({ id: workspaces.id }).from(workspaces).limit(2);
        if (rows.length === 0) throw new Error("no workspace available for collection");
        if (rows.length > 1) {
          throw new Error("workspaceId is required: you belong to more than one workspace");
        }
        workspaceId = rows[0]!.id;
      }
      const { workspaceId: _omit, ...rest } = input;
      try {
        const [row] = await db
          .insert(collections)
          .values({ ...rest, workspaceId })
          .returning();
        return row!;
      } catch (err) {
        const code = (err as { code?: string })?.code;
        if (code !== "23505") throw err;
        throw Object.assign(
          new Error(`a collection with slug "${input.slug}" already exists in this workspace`),
          { code: "23505" },
        );
      }
    });
  }

  /** Readable collections (RLS-scoped), each flagged with whether the actor can write. */
  async list(): Promise<CollectionWithAccess[]> {
    return this.exec((db) =>
      db
        .select({
          ...getTableColumns(collections),
          writable: sql<boolean>`(${collections.id} IN (SELECT app_writable_collections()))`,
        })
        .from(collections)
        .where(isNull(collections.deletedAt))
        .orderBy(collections.name),
    );
  }

  async update(
    id: string,
    patch: Partial<Omit<CreateCollectionInput, "workspaceId">>,
  ): Promise<Collection | null> {
    return this.exec(async (db) => {
      const [row] = await db
        .update(collections)
        .set({ ...patch, updatedAt: new Date() })
        .where(and(eq(collections.id, id), isNull(collections.deletedAt)))
        .returning();
      return row ?? null;
    });
  }

  /** Soft-delete a collection (and hide its documents). Owner/admin only —
   * too destructive to hand to every member with write access. */
  async softDelete(id: string): Promise<void> {
    await this.assertCanManage(id);
    await this.system(async (db) => {
      await db
        .update(collections)
        .set({ deletedAt: new Date() })
        .where(eq(collections.id, id));
    });
  }

  // --- sharing (owner/admin only) ---

  async setDefaultRole(id: string, role: CollectionRole): Promise<void> {
    await this.assertCanManage(id);
    await this.system(async (db) => {
      await db
        .update(collections)
        .set({ defaultRole: role, updatedAt: new Date() })
        .where(eq(collections.id, id));
    });
  }

  async grant(
    id: string,
    principalType: "user" | "group",
    principalId: string,
    role: "read" | "read_write",
  ): Promise<void> {
    await this.assertCanManage(id);
    await this.exec(async (db) => {
      // The principal must belong to this collection's workspace — a foreign
      // principal would be inert under RLS today, but don't store it.
      const [col] = await db
        .select({ ws: collections.workspaceId })
        .from(collections)
        .where(eq(collections.id, id));
      if (principalType === "user") {
        const [m] = await db
          .select({ id: workspaceMembers.id })
          .from(workspaceMembers)
          .where(
            and(
              eq(workspaceMembers.workspaceId, col!.ws),
              eq(workspaceMembers.userId, principalId),
            ),
          );
        if (!m) throw new Error("that user is not a member of this workspace");
      } else {
        const isUuid = /^[0-9a-f-]{36}$/i.test(principalId);
        const [g] = isUuid
          ? await db
              .select({ ws: groups.workspaceId })
              .from(groups)
              .where(eq(groups.id, principalId))
          : [];
        if (!g || g.ws !== col!.ws) {
          throw new Error("that group does not belong to this workspace");
        }
      }
      await db
        .insert(collectionPermissions)
        .values({ collectionId: id, principalType, principalId, role })
        .onConflictDoUpdate({
          target: [
            collectionPermissions.collectionId,
            collectionPermissions.principalType,
            collectionPermissions.principalId,
          ],
          set: { role },
        });
    });
  }

  async revoke(
    id: string,
    principalType: "user" | "group",
    principalId: string,
  ): Promise<void> {
    await this.assertCanManage(id);
    await this.exec(async (db) => {
      await db
        .delete(collectionPermissions)
        .where(
          and(
            eq(collectionPermissions.collectionId, id),
            eq(collectionPermissions.principalType, principalType),
            eq(collectionPermissions.principalId, principalId),
          ),
        );
    });
  }

  async listPermissions(id: string): Promise<CollectionPermission[]> {
    await this.assertCanManage(id);
    return this.exec((db) =>
      db
        .select()
        .from(collectionPermissions)
        .where(eq(collectionPermissions.collectionId, id)),
    );
  }
}
