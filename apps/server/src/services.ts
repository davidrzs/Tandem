import { SYSTEM, type Actor, type Database } from "@tandem/db";
import type { AuthorIdentity } from "@tandem/editor";
import {
  CollectionService,
  CommentService,
  DocumentService,
  GroupService,
  ImageService,
  InstanceService,
  SettingsService,
  SnapshotService,
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
  instance: InstanceService;
  settings: SettingsService;
  snapshots: SnapshotService;
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
    instance: new InstanceService(db, actor),
    settings: new SettingsService(db, actor),
    snapshots: new SnapshotService(db, actor),
  };
}
