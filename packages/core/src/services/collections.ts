import { and, eq, isNull } from "drizzle-orm";
import {
  collections,
  runAsActor,
  SYSTEM,
  workspaces,
  type Actor,
  type Collection,
  type Database,
} from "@realtime/db";

export interface CreateCollectionInput {
  name: string;
  slug: string;
  description?: string;
  icon?: string;
  color?: string;
  // System callers must specify the workspace; user actors default to theirs.
  workspaceId?: string;
}

export class CollectionService {
  constructor(
    private readonly db: Database,
    private readonly actor: Actor = SYSTEM,
  ) {}

  private exec<T>(fn: (db: Database) => Promise<T>): Promise<T> {
    return runAsActor(this.db, this.actor, fn);
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

  async list(): Promise<Collection[]> {
    return this.exec((db) =>
      db
        .select()
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
}
