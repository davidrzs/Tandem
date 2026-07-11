import { and, desc, eq, isNull, sql } from "drizzle-orm";
import {
  comments,
  notifications,
  runAsActor,
  SYSTEM,
  user,
  workspaceMembers,
  type Actor,
  type Database,
} from "@tandem/db";
import { ForbiddenError } from "../errors.js";

export interface NotificationView {
  id: string;
  documentId: string | null;
  documentTitle: string;
  kind: string;
  actorName: string;
  ai: boolean;
  snippet: string;
  createdAt: Date;
  readAt: Date | null;
}

/** Who performed the action that triggers a notification. */
export interface NotifyActor {
  userId: string;
  name: string;
  ai: boolean;
}

const MENTION_RE = /@([a-z0-9._+-]+(?:@[a-z0-9.-]+)?)/gi;
const SNIPPET_MAX = 140;

const snippet = (s: string) => (s.length > SNIPPET_MAX ? `${s.slice(0, SNIPPET_MAX - 1)}…` : s);

/**
 * In-app notifications. System-managed table: trusted server code produces
 * entries; reads/updates are pinned to the acting user here. Notifications
 * are best-effort — producers must never fail the action they describe.
 */
export class NotificationService {
  constructor(
    private readonly db: Database,
    private readonly actor: Actor = SYSTEM,
  ) {}

  private userId(): string {
    if (this.actor.kind !== "user") throw new ForbiddenError("requires a user actor");
    return this.actor.userId;
  }

  private system<T>(fn: (db: Database) => Promise<T>): Promise<T> {
    return runAsActor(this.db, SYSTEM, fn);
  }

  async listMine(): Promise<NotificationView[]> {
    const userId = this.userId();
    return this.system((db) =>
      db
        .select({
          id: notifications.id,
          documentId: notifications.documentId,
          documentTitle: notifications.documentTitle,
          kind: notifications.kind,
          actorName: notifications.actorName,
          ai: notifications.ai,
          snippet: notifications.snippet,
          createdAt: notifications.createdAt,
          readAt: notifications.readAt,
        })
        .from(notifications)
        .where(eq(notifications.userId, userId))
        .orderBy(desc(notifications.createdAt))
        .limit(50),
    );
  }

  async unreadCount(): Promise<number> {
    const userId = this.userId();
    const [row] = await this.system((db) =>
      db
        .select({ n: sql<number>`count(*)::int` })
        .from(notifications)
        .where(and(eq(notifications.userId, userId), isNull(notifications.readAt))),
    );
    return row?.n ?? 0;
  }

  async markAllRead(): Promise<void> {
    const userId = this.userId();
    await this.system(async (db) => {
      await db
        .update(notifications)
        .set({ readAt: new Date() })
        .where(and(eq(notifications.userId, userId), isNull(notifications.readAt)));
    });
  }

  /** Raw insert for trusted producers; the actor never notifies themselves. */
  async record(entry: {
    userId: string;
    workspaceId: string | null;
    documentId: string | null;
    documentTitle: string;
    kind: string;
    actor: NotifyActor;
    snippet: string;
  }): Promise<void> {
    if (entry.userId === entry.actor.userId) return;
    await this.system(async (db) => {
      await db.insert(notifications).values({
        userId: entry.userId,
        workspaceId: entry.workspaceId,
        documentId: entry.documentId,
        documentTitle: entry.documentTitle,
        kind: entry.kind,
        actorName: entry.actor.name,
        ai: entry.actor.ai,
        snippet: snippet(entry.snippet),
      });
    });
  }

  /** Resolve @handles (email local part or full email) to workspace member
   * user ids. Unknown handles are ignored. */
  private async membersByHandle(
    workspaceId: string,
    handles: Set<string>,
  ): Promise<Map<string, string>> {
    if (handles.size === 0) return new Map();
    const rows = await this.system((db) =>
      db
        .select({ userId: workspaceMembers.userId, email: user.email })
        .from(workspaceMembers)
        .innerJoin(user, eq(user.id, workspaceMembers.userId))
        .where(eq(workspaceMembers.workspaceId, workspaceId)),
    );
    const out = new Map<string, string>();
    for (const r of rows) {
      const email = r.email.toLowerCase();
      const local = email.split("@")[0]!;
      if (handles.has(email)) out.set(email, r.userId);
      if (handles.has(local)) out.set(local, r.userId);
    }
    return out;
  }

  /**
   * Notifications for a new comment: thread participants hear about replies,
   * @mentioned members hear about mentions (reply or top-level). Call after
   * the comment is committed; failures must be swallowed by the caller.
   */
  async onCommentCreated(input: {
    comment: {
      id: string;
      documentId: string;
      parentId: string | null;
      body: string;
    };
    workspaceId: string;
    documentTitle: string;
    actor: NotifyActor;
  }): Promise<void> {
    const { comment, workspaceId, documentTitle, actor } = input;
    const recipients = new Map<string, string>(); // userId -> kind

    if (comment.parentId) {
      const participants = await this.system((db) =>
        db
          .select({ authorId: comments.authorId })
          .from(comments)
          .where(eq(comments.id, comment.parentId!)),
      );
      const replies = await this.system((db) =>
        db
          .select({ authorId: comments.authorId })
          .from(comments)
          .where(eq(comments.parentId, comment.parentId!)),
      );
      for (const p of [...participants, ...replies]) {
        recipients.set(p.authorId, "comment_reply");
      }
    }

    const handles = new Set(
      [...comment.body.matchAll(MENTION_RE)].map((m) => m[1]!.toLowerCase()),
    );
    for (const userId of (await this.membersByHandle(workspaceId, handles)).values()) {
      recipients.set(userId, "comment_mention"); // mention outranks reply
    }

    for (const [userId, kind] of recipients) {
      await this.record({
        userId,
        workspaceId,
        documentId: comment.documentId,
        documentTitle,
        kind,
        actor,
        snippet: comment.body,
      });
    }
  }

  /** Notify the thread author when their thread is resolved. */
  async onCommentResolved(input: {
    comment: { id: string; documentId: string; authorId: string; body: string };
    workspaceId: string;
    documentTitle: string;
    actor: NotifyActor;
  }): Promise<void> {
    await this.record({
      userId: input.comment.authorId,
      workspaceId: input.workspaceId,
      documentId: input.comment.documentId,
      documentTitle: input.documentTitle,
      kind: "comment_resolved",
      actor: input.actor,
      snippet: input.comment.body,
    });
  }

  /**
   * Diff two markdown bodies and notify members newly assigned an open task
   * (`- [ ] @handle …`). Tasks are matched by their full text, so editing an
   * existing task's wording re-notifies — acceptable for a v1.
   */
  async onDocumentStored(input: {
    documentId: string;
    workspaceId: string;
    documentTitle: string;
    oldMarkdown: string | null;
    newMarkdown: string;
    actor: NotifyActor;
    scan: (md: string) => Array<{ text: string; done: boolean; mentions: string[] }>;
  }): Promise<void> {
    const oldTasks = new Set(
      (input.oldMarkdown ? input.scan(input.oldMarkdown) : [])
        .filter((t) => !t.done)
        .map((t) => t.text),
    );
    const fresh = input
      .scan(input.newMarkdown)
      .filter((t) => !t.done && t.mentions.length > 0 && !oldTasks.has(t.text));
    if (fresh.length === 0) return;

    const handles = new Set(fresh.flatMap((t) => t.mentions.map((m) => m.toLowerCase())));
    const byHandle = await this.membersByHandle(input.workspaceId, handles);
    for (const task of fresh) {
      const notified = new Set<string>();
      for (const m of task.mentions) {
        const userId = byHandle.get(m.toLowerCase());
        if (!userId || notified.has(userId)) continue;
        notified.add(userId);
        await this.record({
          userId,
          workspaceId: input.workspaceId,
          documentId: input.documentId,
          documentTitle: input.documentTitle,
          kind: "task_assigned",
          actor: input.actor,
          snippet: task.text,
        });
      }
    }
  }
}
