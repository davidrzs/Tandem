import { and, eq, getTableColumns, isNull, sql } from "drizzle-orm";
import {
  collectionPermissions,
  collections,
  runAsActor,
  SYSTEM,
  workspaceMembers,
  workspaces,
  type Actor,
  type Collection,
  type CollectionPermission,
  type Database,
} from "@realtime/db";

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
      const workspaceId =
        input.workspaceId ??
        (await db.select({ id: workspaces.id }).from(workspaces).limit(1))[0]?.id;
      if (!workspaceId) throw new Error("no workspace available for collection");
      const { workspaceId: _omit, ...rest } = input;
      const [row] = await db
        .insert(collections)
        .values({ ...rest, workspaceId })
        .returning();
      return row!;
    });
  }

  async get(id: string): Promise<Collection | null> {
    return this.exec(async (db) => {
      const [row] = await db
        .select()
        .from(collections)
        .where(and(eq(collections.id, id), isNull(collections.deletedAt)));
      return row ?? null;
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

  async softDelete(id: string): Promise<void> {
    await this.exec(async (db) => {
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
    await this.system(async (db) => {
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
    await this.system(async (db) => {
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
    return this.system((db) =>
      db
        .select()
        .from(collectionPermissions)
        .where(eq(collectionPermissions.collectionId, id)),
    );
  }
}
