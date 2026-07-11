import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import {
  documentFavorites,
  documents,
  runAsActor,
  SYSTEM,
  type Actor,
  type Database,
} from "@tandem/db";
import { ForbiddenError, NotFoundError } from "../errors.js";
import { DocumentService, type DocumentMeta } from "./documents.js";

/**
 * Per-user starred documents. The table is system-managed (no app_user
 * grant); authorization happens here: adding checks the document is readable
 * actor-scoped, and listing re-filters ids through an RLS-scoped read, so a
 * favorite whose access was revoked silently drops out.
 */
export class FavoriteService {
  constructor(
    private readonly db: Database,
    private readonly actor: Actor = SYSTEM,
  ) {}

  private userId(): string {
    if (this.actor.kind !== "user") throw new ForbiddenError("requires a user actor");
    return this.actor.userId;
  }

  private exec<T>(fn: (db: Database) => Promise<T>): Promise<T> {
    return runAsActor(this.db, this.actor, fn);
  }

  private system<T>(fn: (db: Database) => Promise<T>): Promise<T> {
    return runAsActor(this.db, SYSTEM, fn);
  }

  async add(documentId: string): Promise<void> {
    const userId = this.userId();
    // Actor-scoped existence check = readability check (RLS).
    const [visible] = await this.exec((db) =>
      db
        .select({ id: documents.id })
        .from(documents)
        .where(and(eq(documents.id, documentId), isNull(documents.deletedAt))),
    );
    if (!visible) throw new NotFoundError("document not found");
    await this.system(async (db) => {
      await db
        .insert(documentFavorites)
        .values({ userId, documentId })
        .onConflictDoNothing();
    });
  }

  async remove(documentId: string): Promise<void> {
    const userId = this.userId();
    await this.system(async (db) => {
      await db
        .delete(documentFavorites)
        .where(
          and(
            eq(documentFavorites.userId, userId),
            eq(documentFavorites.documentId, documentId),
          ),
        );
    });
  }

  /** The user's favorites, newest-starred first, restricted to documents they
   * can still read (archived ones stay listed — they're still theirs). */
  async list(): Promise<DocumentMeta[]> {
    const userId = this.userId();
    const rows = await this.system((db) =>
      db
        .select({ documentId: documentFavorites.documentId })
        .from(documentFavorites)
        .where(eq(documentFavorites.userId, userId))
        .orderBy(desc(documentFavorites.createdAt))
        .limit(200),
    );
    if (rows.length === 0) return [];
    const ids = rows.map((r) => r.documentId);
    const docs = await this.exec((db) =>
      db
        .select(DocumentService.metaColumns)
        .from(documents)
        .where(and(inArray(documents.id, ids), isNull(documents.deletedAt))),
    );
    const byId = new Map(docs.map((d) => [d.id, d]));
    return ids.map((id) => byId.get(id)).filter((d): d is DocumentMeta => !!d);
  }
}
