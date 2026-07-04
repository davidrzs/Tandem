import { sql } from "drizzle-orm";
import {
  customType,
  doublePrecision,
  index,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";

/** Tenant boundary. Every collection/document belongs to exactly one workspace. */
export const workspaces = pgTable("workspaces", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  slug: text("slug").notNull().unique(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/** Pending invitations to join a workspace. System-managed (app_user has no grant). */
export const workspaceInvites = pgTable("workspace_invites", {
  id: uuid("id").primaryKey().defaultRandom(),
  workspaceId: uuid("workspace_id")
    .notNull()
    .references(() => workspaces.id, { onDelete: "cascade" }),
  email: text("email"),
  token: text("token").notNull().unique(),
  role: text("role").notNull().default("member"),
  createdBy: text("created_by").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }),
  acceptedAt: timestamp("accepted_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/** Who belongs to a workspace, and at what role. userId references Better Auth's user.id (text). */
export const workspaceMembers = pgTable(
  "workspace_members",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    userId: text("user_id").notNull(),
    role: text("role").notNull().default("member"), // owner | admin | member
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("workspace_members_unique").on(t.workspaceId, t.userId),
    index("workspace_members_user_idx").on(t.userId),
  ],
);

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

/** Named bundles of users within a workspace, for granting access in bulk. */
export const groups = pgTable(
  "groups",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("groups_workspace_idx").on(t.workspaceId)],
);

export const groupMembers = pgTable(
  "group_members",
  {
    groupId: uuid("group_id")
      .notNull()
      .references(() => groups.id, { onDelete: "cascade" }),
    userId: text("user_id").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.groupId, t.userId] }),
    index("group_members_user_idx").on(t.userId),
  ],
);

/** Explicit grant of a collection to a user or group (read | read_write). */
export const collectionPermissions = pgTable(
  "collection_permissions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    collectionId: uuid("collection_id")
      .notNull()
      .references(() => collections.id, { onDelete: "cascade" }),
    principalType: text("principal_type").notNull(), // 'user' | 'group'
    principalId: text("principal_id").notNull(),
    role: text("role").notNull(), // 'read' | 'read_write'
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("collection_permissions_unique").on(
      t.collectionId,
      t.principalType,
      t.principalId,
    ),
    index("collection_permissions_collection_idx").on(t.collectionId),
  ],
);

/** Uploaded image metadata. Bytes live on disk (UPLOADS_DIR/<id>); access is
 * workspace-scoped via RLS, served only to members through /api/images/:id. */
export const images = pgTable(
  "images",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    uploadedBy: text("uploaded_by").notNull(),
    mime: text("mime").notNull(),
    size: doublePrecision("size").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("images_workspace_idx").on(t.workspaceId)],
);

export const collections = pgTable(
  "collections",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    // Baseline access for workspace members without an explicit grant.
    defaultRole: text("default_role").notNull().default("read_write"), // none|read|read_write
    name: text("name").notNull(),
    slug: text("slug").notNull(),
    description: text("description"),
    icon: text("icon"),
    color: text("color"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (t) => [
    unique("collections_workspace_slug_unique").on(t.workspaceId, t.slug),
    index("collections_workspace_idx").on(t.workspaceId),
  ],
);

export const documents = pgTable(
  "documents",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // Denormalized from the collection (docs never change collection) so RLS
    // policies on documents are a simple workspace check.
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
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
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (t) => [
    index("documents_collection_idx").on(t.collectionId),
    index("documents_parent_idx").on(t.parentDocumentId),
    index("documents_search_idx").using("gin", t.searchVector),
  ],
);

export type Workspace = typeof workspaces.$inferSelect;
export type WorkspaceMember = typeof workspaceMembers.$inferSelect;
export type Image = typeof images.$inferSelect;
export type Group = typeof groups.$inferSelect;
export type CollectionPermission = typeof collectionPermissions.$inferSelect;
export type Collection = typeof collections.$inferSelect;
export type NewCollection = typeof collections.$inferInsert;
export type Document = typeof documents.$inferSelect;
export type NewDocument = typeof documents.$inferInsert;
