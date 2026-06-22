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
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is required");
  return createServices(createDatabase(url));
}
