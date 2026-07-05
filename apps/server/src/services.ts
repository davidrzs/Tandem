import { eq, or } from "drizzle-orm";
import { createDatabase, SYSTEM, user, type Actor, type Database } from "@tandem/db";
import type { AuthorIdentity } from "@tandem/editor";
import {
  CollectionService,
  CommentService,
  DocumentService,
  GroupService,
  ImageService,
  SettingsService,
  WorkspaceService,
} from "@tandem/core";

export interface Services {
  db: Database;
  actor: Actor;
  workspaces: WorkspaceService;
  documents: DocumentService;
  collections: CollectionService;
  comments: CommentService;
  groups: GroupService;
  images: ImageService;
  settings: SettingsService;
}

/** Fallback attribution for the local stdio MCP when no TANDEM_USER is set:
 * an AI agent running with the operator's own database access. */
export const LOCAL_AGENT: AuthorIdentity = {
  userId: "system",
  name: "Local agent",
  ai: true,
};

/**
 * Attribution identity for the local stdio MCP. `who` (the TANDEM_USER env
 * var) names the human the agent acts for — their email or user id — so blame
 * shows "<their name>'s AI" instead of an ownerless local agent. An unknown
 * value fails loud: silently falling back would misattribute every edit.
 */
export async function resolveLocalAuthor(
  db: Database,
  who: string | undefined,
): Promise<AuthorIdentity> {
  const wanted = who?.trim();
  if (!wanted) return LOCAL_AGENT;
  const [u] = await db
    .select({ id: user.id, name: user.name })
    .from(user)
    .where(or(eq(user.email, wanted), eq(user.id, wanted)));
  if (!u) {
    throw new Error(
      `TANDEM_USER "${wanted}" does not match any user's email or id — refusing to run with misattributed authorship`,
    );
  }
  return { userId: u.id, name: u.name, ai: true };
}

/**
 * Build the shared service layer for a given actor. Web, MCP, and Hocuspocus
 * all go through this; the actor determines RLS scoping (system bypasses) and
 * `author` determines how content written by this caller is attributed in the
 * Yjs blame layer (which human — and whether it was their AI acting for them).
 */
export function createServices(
  db: Database,
  actor: Actor = SYSTEM,
  author?: AuthorIdentity,
): Services {
  return {
    db,
    actor,
    workspaces: new WorkspaceService(db, actor),
    documents: new DocumentService(db, actor, author),
    collections: new CollectionService(db, actor),
    comments: new CommentService(db, actor),
    groups: new GroupService(db, actor),
    images: new ImageService(db, actor),
    settings: new SettingsService(db, actor),
  };
}

/** A system-scoped service layer (bypasses RLS) — for the local stdio MCP.
 * Set TANDEM_USER (email or user id) to attribute the agent's edits to your
 * own AI identity in blame. */
export async function servicesFromEnv(): Promise<Services> {
  const db = createDatabase(process.env.DATABASE_URL);
  const author = await resolveLocalAuthor(db, process.env.TANDEM_USER);
  return createServices(db, SYSTEM, author);
}
