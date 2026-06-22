import { createDatabase, type Database } from "@realtime/db";
import { CollectionService, DocumentService } from "@realtime/core";

export interface Services {
  db: Database;
  documents: DocumentService;
  collections: CollectionService;
}

/** Build the shared service layer. Web, MCP, and Hocuspocus all go through this. */
export function createServices(db: Database): Services {
  return {
    db,
    documents: new DocumentService(db),
    collections: new CollectionService(db),
  };
}

export function servicesFromEnv(): Services {
  // createDatabase reads DATABASE_URL itself and falls back to in-memory PGlite.
  return createServices(createDatabase(process.env.DATABASE_URL));
}
