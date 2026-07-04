import { createDatabase, SYSTEM, type Actor, type Database } from "@tandem/db";
import type { AuthorIdentity } from "@tandem/editor";
import {
  CollectionService,
  DocumentService,
  GroupService,
  ImageService,
  WorkspaceService,
} from "@tandem/core";

export interface Services {
  db: Database;
  actor: Actor;
  workspaces: WorkspaceService;
  documents: DocumentService;
  collections: CollectionService;
  groups: GroupService;
  images: ImageService;
}

/** Attribution identity for the local system-scoped stdio MCP: an AI agent
 * running with the operator's own database access. */
export const LOCAL_AGENT: AuthorIdentity = {
  userId: "system",
  name: "Local agent",
  ai: true,
};

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
    groups: new GroupService(db, actor),
    images: new ImageService(db, actor),
  };
}

/** A system-scoped service layer (bypasses RLS) — for the local stdio MCP. */
export function servicesFromEnv(): Services {
  return createServices(createDatabase(process.env.DATABASE_URL), SYSTEM, LOCAL_AGENT);
}
