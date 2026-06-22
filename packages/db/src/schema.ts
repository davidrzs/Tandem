import { sql } from "drizzle-orm";
import {
  customType,
  doublePrecision,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

/** Raw binary column for the persisted Yjs CRDT update (the live write model). */
const bytea = customType<{ data: Uint8Array; driverData: Buffer }>({
  dataType: () => "bytea",
  toDriver: (v) => Buffer.from(v),
  fromDriver: (v) => new Uint8Array(v),
});

/** Postgres full-text search vector. Generated from title + markdown body. */
const tsvector = customType<{ data: string }>({
  dataType: () => "tsvector",
});

export const collections = pgTable("collections", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  slug: text("slug").notNull().unique(),
  description: text("description"),
  icon: text("icon"),
  color: text("color"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
});

export const documents = pgTable(
  "documents",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    collectionId: uuid("collection_id")
      .notNull()
      .references(() => collections.id, { onDelete: "cascade" }),
    // Self-referential tree. Null = top-level document in its collection.
    parentDocumentId: uuid("parent_document_id").references(
      (): any => documents.id,
      { onDelete: "cascade" },
    ),
    // Sibling ordering within a parent (sparse; new docs go at max+1).
    position: doublePrecision("position").notNull().default(0),

    title: text("title").notNull().default(""),

    // Derived READ model: canonical markdown, serialized from the Y.Doc on save.
    contentMd: text("content_md").notNull().default(""),
    // ProseMirror JSON cache for fast editor hydration when no live session exists.
    contentJson: jsonb("content_json"),
    // Live WRITE model: persisted Yjs CRDT state. Null until first edit session.
    ydocState: bytea("ydoc_state"),

    searchVector: tsvector("search_vector").generatedAlwaysAs(
      (): any =>
        sql`setweight(to_tsvector('simple', coalesce(title, '')), 'A') || setweight(to_tsvector('simple', coalesce(content_md, '')), 'B')`,
    ),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    publishedAt: timestamp("published_at", { withTimezone: true }),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (t) => [
    index("documents_collection_idx").on(t.collectionId),
    index("documents_parent_idx").on(t.parentDocumentId),
    index("documents_search_idx").using("gin", t.searchVector),
  ],
);

export type Collection = typeof collections.$inferSelect;
export type NewCollection = typeof collections.$inferInsert;
export type Document = typeof documents.$inferSelect;
export type NewDocument = typeof documents.$inferInsert;
