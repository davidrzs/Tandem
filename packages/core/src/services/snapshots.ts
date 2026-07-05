import { desc, eq } from "drizzle-orm";
import {
  documentSnapshots,
  runAsActor,
  SYSTEM,
  type Actor,
  type Database,
} from "@tandem/db";

/** A session that contributed since the previous snapshot (for the row label). */
export interface SnapshotSession {
  userId: string;
  name: string;
  ai: boolean;
  at: number;
}

export interface SnapshotAuthor {
  userId: string;
  name: string;
  ai: boolean;
}

/** List item — metadata only, no Yjs bytes. */
export interface SnapshotView {
  id: string;
  createdAt: Date;
  kind: string;
  authors: SnapshotAuthor[];
}

/** Distinct (user, human/AI) labels for the sessions active since the previous
 * snapshot. Falls back to the most recent session so a row is never blank. */
function labelAuthors(sessions: SnapshotSession[], since: Date | null): SnapshotAuthor[] {
  const cutoff = since ? since.getTime() : 0;
  let recent = sessions.filter((s) => s.at >= cutoff);
  if (recent.length === 0 && sessions.length > 0) {
    recent = [sessions.reduce((a, b) => (b.at > a.at ? b : a))];
  }
  const seen = new Set<string>();
  const out: SnapshotAuthor[] = [];
  for (const s of recent) {
    const key = `${s.userId}:${s.ai}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ userId: s.userId, name: s.name, ai: s.ai });
  }
  return out;
}

/**
 * Point-in-time document versions. Captures are system writes (session
 * boundaries, long-session intervals, pre-restore); reads are RLS-scoped to the
 * document's readers. A capture is skipped when the latest snapshot already
 * holds identical Yjs bytes, so title/move bumps never create duplicates.
 */
export class SnapshotService {
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

  /** Versions of a document, newest first (no bytes). */
  async list(documentId: string): Promise<SnapshotView[]> {
    const rows = await this.exec((db) =>
      db
        .select({
          id: documentSnapshots.id,
          createdAt: documentSnapshots.createdAt,
          kind: documentSnapshots.kind,
          authors: documentSnapshots.authors,
        })
        .from(documentSnapshots)
        .where(eq(documentSnapshots.documentId, documentId))
        .orderBy(desc(documentSnapshots.createdAt))
        .limit(100),
    );
    return rows.map((r) => ({
      id: r.id,
      createdAt: r.createdAt,
      kind: r.kind,
      authors: (r.authors as SnapshotAuthor[]) ?? [],
    }));
  }

  /** A single version including its Yjs bytes (server-side use). RLS-scoped. */
  async get(
    id: string,
  ): Promise<{ documentId: string; ydocState: Uint8Array; createdAt: Date; kind: string } | null> {
    const [row] = await this.exec((db) =>
      db
        .select({
          documentId: documentSnapshots.documentId,
          ydocState: documentSnapshots.ydocState,
          createdAt: documentSnapshots.createdAt,
          kind: documentSnapshots.kind,
        })
        .from(documentSnapshots)
        .where(eq(documentSnapshots.id, id)),
    );
    return row ?? null;
  }

  /** Capture at a session boundary (the persisted end-state of a session). */
  captureBoundary(input: {
    documentId: string;
    workspaceId: string;
    ydocState: Uint8Array;
    sessions: SnapshotSession[];
  }): Promise<void> {
    return this.insertIfChanged({ ...input, kind: "auto", minAgeMs: 0 });
  }

  /** Capture during a long session, at most once per `minAgeMs`. */
  captureInterval(
    input: { documentId: string; workspaceId: string; ydocState: Uint8Array; sessions: SnapshotSession[] },
    minAgeMs = 10 * 60 * 1000,
  ): Promise<void> {
    return this.insertIfChanged({ ...input, kind: "auto", minAgeMs });
  }

  /** Capture the current (live) state before a restore, so restores are undoable. */
  capturePreRestore(input: {
    documentId: string;
    workspaceId: string;
    ydocState: Uint8Array;
    author: SnapshotAuthor;
  }): Promise<void> {
    return this.insertIfChanged({
      documentId: input.documentId,
      workspaceId: input.workspaceId,
      ydocState: input.ydocState,
      sessions: [{ ...input.author, at: Number.MAX_SAFE_INTEGER }],
      kind: "pre-restore",
      minAgeMs: 0,
    });
  }

  private async insertIfChanged(input: {
    documentId: string;
    workspaceId: string;
    ydocState: Uint8Array;
    sessions: SnapshotSession[];
    kind: string;
    minAgeMs: number;
  }): Promise<void> {
    await this.system(async (db) => {
      // Cheap age gate first (no bytes) — short-circuits the frequent path.
      const [meta] = await db
        .select({ createdAt: documentSnapshots.createdAt })
        .from(documentSnapshots)
        .where(eq(documentSnapshots.documentId, input.documentId))
        .orderBy(desc(documentSnapshots.createdAt))
        .limit(1);
      if (meta && input.minAgeMs > 0 && Date.now() - meta.createdAt.getTime() < input.minAgeMs) {
        return;
      }
      // Skip if the latest snapshot already holds identical bytes.
      const [latest] = await db
        .select({ ydocState: documentSnapshots.ydocState })
        .from(documentSnapshots)
        .where(eq(documentSnapshots.documentId, input.documentId))
        .orderBy(desc(documentSnapshots.createdAt))
        .limit(1);
      if (latest && Buffer.from(latest.ydocState).equals(Buffer.from(input.ydocState))) {
        return;
      }
      await db.insert(documentSnapshots).values({
        workspaceId: input.workspaceId,
        documentId: input.documentId,
        ydocState: input.ydocState,
        authors: labelAuthors(input.sessions, meta?.createdAt ?? null),
        kind: input.kind,
      });
    });
  }
}
