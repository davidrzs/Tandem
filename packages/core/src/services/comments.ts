import { ForbiddenError, InvalidInputError, NotFoundError } from "../errors.js";
import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import {
  comments,
  documents,
  runAsActor,
  SYSTEM,
  user,
  type Actor,
  type Comment,
  type Database,
} from "@tandem/db";

export interface CommentInput {
  documentId: string;
  body: string;
  /** Base64 Y.RelativePosition pair marking the discussed span (top-level only). */
  anchor?: string;
  head?: string;
  parentId?: string;
}

export interface CommentView {
  id: string;
  documentId: string;
  parentId: string | null;
  authorId: string;
  authorName: string;
  body: string;
  anchor: string | null;
  head: string | null;
  createdAt: Date;
  resolvedAt: Date | null;
}

/**
 * Inline discussions. Visibility rides on document readability (RLS): anyone
 * who can read a document can comment on it — commenting is not editing.
 * Anchors are opaque Yjs relative positions supplied by the editor.
 */
export class CommentService {
  constructor(
    private readonly db: Database,
    private readonly actor: Actor = SYSTEM,
  ) {}

  private exec<T>(fn: (db: Database) => Promise<T>): Promise<T> {
    return runAsActor(this.db, this.actor, fn);
  }

  private userId(): string {
    if (this.actor.kind !== "user") throw new ForbiddenError("requires a user actor");
    return this.actor.userId;
  }

  /** All threads of a document (RLS returns nothing if it isn't readable). */
  async list(documentId: string): Promise<CommentView[]> {
    const rows = await this.exec((db) =>
      db
        .select()
        .from(comments)
        .where(eq(comments.documentId, documentId))
        .orderBy(asc(comments.createdAt)),
    );
    if (rows.length === 0) return [];
    // Author names come from the auth user table (not RLS-granted) — resolve
    // them system-scoped only for comments RLS already let us see.
    const ids = [...new Set(rows.map((r) => r.authorId))];
    const users = await runAsActor(this.db, SYSTEM, (db) =>
      db.select({ id: user.id, name: user.name }).from(user).where(inArray(user.id, ids)),
    );
    const names = new Map(users.map((u) => [u.id, u.name]));
    return rows.map((r) => ({
      id: r.id,
      documentId: r.documentId,
      parentId: r.parentId,
      authorId: r.authorId,
      authorName: names.get(r.authorId) ?? "Unknown",
      body: r.body,
      anchor: r.anchor,
      head: r.head,
      createdAt: r.createdAt,
      resolvedAt: r.resolvedAt,
    }));
  }

  async create(input: CommentInput): Promise<Comment> {
    const authorId = this.userId();
    return this.exec(async (db) => {
      const [doc] = await db
        .select({ workspaceId: documents.workspaceId })
        .from(documents)
        .where(and(eq(documents.id, input.documentId), isNull(documents.deletedAt)));
      if (!doc) throw new NotFoundError("document not found");

      if (input.parentId) {
        const [parent] = await db
          .select({ documentId: comments.documentId, parentId: comments.parentId })
          .from(comments)
          .where(eq(comments.id, input.parentId));
        if (!parent || parent.documentId !== input.documentId) {
          throw new NotFoundError("parent comment not found on this document");
        }
        if (parent.parentId) throw new InvalidInputError("replies cannot be nested");
      }

      const [row] = await db
        .insert(comments)
        .values({
          workspaceId: doc.workspaceId,
          documentId: input.documentId,
          parentId: input.parentId ?? null,
          authorId,
          body: input.body,
          // Anchors belong to threads, not replies.
          anchor: input.parentId ? null : (input.anchor ?? null),
          head: input.parentId ? null : (input.head ?? null),
        })
        .returning();
      return row!;
    });
  }

  /** Resolve/reopen a thread. Allowed for the author or anyone who can write
   * the document (enforced by RLS on UPDATE). */
  async setResolved(id: string, resolved: boolean): Promise<Comment> {
    return this.exec(async (db) => {
      const [row] = await db
        .update(comments)
        .set({ resolvedAt: resolved ? new Date() : null })
        .where(and(eq(comments.id, id), isNull(comments.parentId)))
        .returning();
      if (!row) throw new NotFoundError("comment not found or you may not resolve it");
      return row;
    });
  }

  /** Delete own comment; deleting a thread removes its replies with it.
   * Returns the deleted row (for change notification), or null if RLS said no. */
  async remove(id: string): Promise<Comment | null> {
    return this.exec(async (db) => {
      const [row] = await db.delete(comments).where(eq(comments.id, id)).returning();
      return row ?? null;
    });
  }
}
