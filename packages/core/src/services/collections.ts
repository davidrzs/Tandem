import { and, eq, isNull } from "drizzle-orm";
import type { Database } from "@realtime/db";
import { collections, type Collection } from "@realtime/db";

export interface CreateCollectionInput {
  name: string;
  slug: string;
  description?: string;
  icon?: string;
  color?: string;
}

export class CollectionService {
  constructor(private readonly db: Database) {}

  async create(input: CreateCollectionInput): Promise<Collection> {
    const [row] = await this.db.insert(collections).values(input).returning();
    return row!;
  }

  async get(id: string): Promise<Collection | null> {
    const [row] = await this.db
      .select()
      .from(collections)
      .where(and(eq(collections.id, id), isNull(collections.deletedAt)));
    return row ?? null;
  }

  async list(): Promise<Collection[]> {
    return this.db
      .select()
      .from(collections)
      .where(isNull(collections.deletedAt))
      .orderBy(collections.name);
  }

  async update(
    id: string,
    patch: Partial<CreateCollectionInput>,
  ): Promise<Collection | null> {
    const [row] = await this.db
      .update(collections)
      .set({ ...patch, updatedAt: new Date() })
      .where(and(eq(collections.id, id), isNull(collections.deletedAt)))
      .returning();
    return row ?? null;
  }

  async softDelete(id: string): Promise<void> {
    await this.db
      .update(collections)
      .set({ deletedAt: new Date() })
      .where(eq(collections.id, id));
  }
}
