import { createDatabase, SYSTEM, type Actor, type Database } from "@realtime/db";
import {
  CollectionService,
  DocumentService,
  WorkspaceService,
} from "@realtime/core";

export interface Services {
  db: Database;
  actor: Actor;
  workspaces: WorkspaceService;
  documents: DocumentService;
  collections: CollectionService;
}

/**
 * Build the shared service layer for a given actor. Web, MCP, and Hocuspocus
 * all go through this; the actor determines RLS scoping (system bypasses).
 */
export function createServices(db: Database, actor: Actor = SYSTEM): Services {
  return {
    db,
    actor,
    workspaces: new WorkspaceService(db, actor),
    documents: new DocumentService(db, actor),
    collections: new CollectionService(db, actor),
  };
}

/** A system-scoped service layer (bypasses RLS) — for the local stdio MCP. */
export function servicesFromEnv(): Services {
  return createServices(createDatabase(process.env.DATABASE_URL));
}
