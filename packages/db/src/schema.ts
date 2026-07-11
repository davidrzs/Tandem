import { sql } from "drizzle-orm";
import {
  boolean,
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
    // Free-form labels for filtering/organization. Normalized in the service.
    tags: text("tags").array().notNull().default([]),

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
    index("documents_tags_idx").using("gin", t.tags),
  ],
);

/** Inline discussion on a document. A top-level comment may be anchored to a
 * span via encoded Yjs relative positions (anchor/head), so the highlight
 * follows the text through edits; replies reference their parent. */
export const comments = pgTable(
  "comments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    documentId: uuid("document_id")
      .notNull()
      .references(() => documents.id, { onDelete: "cascade" }),
    parentId: uuid("parent_id").references((): any => comments.id, {
      onDelete: "cascade",
    }),
    authorId: text("author_id").notNull(),
    body: text("body").notNull(),
    // Base64-encoded Y.RelativePosition pair; null = whole-document comment.
    anchor: text("anchor"),
    head: text("head"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
  },
  (t) => [index("comments_document_idx").on(t.documentId)],
);

/** Instance-wide server settings for this self-hosted deployment. Exactly one
 * row (the `id` sentinel). System-managed: app_user has no grant — read via
 * SYSTEM-scoped service code and the unauthenticated setup/public routes. */
export const instanceSettings = pgTable("instance_settings", {
  // Single-row sentinel: id is always true, so a second insert conflicts.
  id: boolean("id").primaryKey().default(true),
  // open | invite | domain | closed — who may self-register.
  registrationMode: text("registration_mode").notNull().default("open"),
  // Allowlisted email domains when registrationMode = 'domain' (e.g. "acme.com").
  allowedEmailDomains: text("allowed_email_domains").array().notNull().default([]),
  instanceName: text("instance_name").notNull().default("Tandem"),
  // Whether non-admin members may create additional (team) workspaces.
  allowWorkspaceCreation: boolean("allow_workspace_creation").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/** Server-level (instance) invites: a capability link to create an account when
 * self-registration is gated. Distinct from workspace_invites (which grant
 * membership in one workspace). System-managed: app_user has no grant. */
export const instanceInvites = pgTable("instance_invites", {
  id: uuid("id").primaryKey().defaultRandom(),
  // Optional binding: if set, only this email may redeem the link.
  email: text("email"),
  token: text("token").notNull().unique(),
  // Server role granted on signup: 'user' | 'admin'.
  role: text("role").notNull().default("user"),
  createdBy: text("created_by").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }),
  acceptedAt: timestamp("accepted_at", { withTimezone: true }),
  acceptedBy: text("accepted_by"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/** Per-user application settings (product prefs, not auth data).
 * System-managed: app_user has no grant. */
export const userSettings = pgTable("user_settings", {
  userId: text("user_id").primaryKey(),
  // Kill switch: when false, MCP tokens for this user are refused.
  mcpEnabled: boolean("mcp_enabled").notNull().default(true),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/** A user's starred documents. System-managed like user_settings (no
 * app_user grant): the service checks document readability actor-scoped,
 * then writes system-side; listing re-filters through RLS reads. */
export const documentFavorites = pgTable(
  "document_favorites",
  {
    userId: text("user_id").notNull(),
    documentId: uuid("document_id")
      .notNull()
      .references(() => documents.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.documentId] })],
);

/** In-app notifications (comment replies/mentions/resolves, task assignment).
 * System-managed like user_settings: produced by trusted server code, read
 * back only for the owning user. The document title is snapshotted so an
 * entry stays renderable even after access to the document is revoked. */
export const notifications = pgTable(
  "notifications",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** Recipient. */
    userId: text("user_id").notNull(),
    workspaceId: uuid("workspace_id").references(() => workspaces.id, {
      onDelete: "cascade",
    }),
    documentId: uuid("document_id").references(() => documents.id, {
      onDelete: "cascade",
    }),
    documentTitle: text("document_title").notNull().default(""),
    /** comment_reply | comment_mention | comment_resolved | task_assigned */
    kind: text("kind").notNull(),
    actorName: text("actor_name").notNull().default(""),
    /** True when the acting side was an AI agent. */
    ai: boolean("ai").notNull().default(false),
    snippet: text("snippet").notNull().default(""),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    readAt: timestamp("read_at", { withTimezone: true }),
  },
  (t) => [index("notifications_user_idx").on(t.userId, t.createdAt)],
);

/** Append-only audit of agent (MCP) actions and sensitive human actions
 * (sharing changes, invites, import/export), for workspace transparency.
 * Written system-side only; members read their workspaces' entries. */
export const auditLog = pgTable(
  "audit_log",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").references(() => workspaces.id, {
      onDelete: "cascade",
    }),
    /** The human who acted — directly, or whose credentials the agent used. */
    userId: text("user_id").notNull(),
    /** True when an AI agent performed the action on the user's behalf. */
    ai: boolean("ai").notNull().default(false),
    /** Tool/action name, e.g. "edit_document". */
    action: text("action").notNull(),
    /** Human-readable target, e.g. the document title. */
    detail: text("detail").notNull().default(""),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("audit_log_workspace_idx").on(t.workspaceId, t.createdAt)],
);

/** Point-in-time copies of a document's Yjs state, for version history and
 * restore. Full state (not a Yjs snapshot) so no gc:false is required. Written
 * system-side only (capture at session boundaries / intervals / pre-restore);
 * members read their readable documents' versions. Old rows are pruned by
 * the daily maintenance job (SNAPSHOT_RETENTION_DAYS, newest kept). */
export const documentSnapshots = pgTable(
  "document_snapshots",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    documentId: uuid("document_id")
      .notNull()
      .references(() => documents.id, { onDelete: "cascade" }),
    // Full Y.encodeStateAsUpdate copy of the document at this point.
    ydocState: bytea("ydoc_state").notNull(),
    // Small label data: the sessions active since the previous snapshot,
    // as [{ userId, name, ai }]. Cosmetic — for the history list.
    authors: jsonb("authors").notNull().default([]),
    // 'auto' (boundary/interval) or 'pre-restore'.
    kind: text("kind").notNull().default("auto"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("document_snapshots_doc_idx").on(t.documentId, t.createdAt)],
);

export type Workspace = typeof workspaces.$inferSelect;
export type WorkspaceMember = typeof workspaceMembers.$inferSelect;
export type Image = typeof images.$inferSelect;
export type Group = typeof groups.$inferSelect;
export type CollectionPermission = typeof collectionPermissions.$inferSelect;
export type Collection = typeof collections.$inferSelect;
export type NewCollection = typeof collections.$inferInsert;
export type Document = typeof documents.$inferSelect;
export type Comment = typeof comments.$inferSelect;
export type AuditEntry = typeof auditLog.$inferSelect;
export type DocumentSnapshot = typeof documentSnapshots.$inferSelect;
export type InstanceSettings = typeof instanceSettings.$inferSelect;
export type InstanceInvite = typeof instanceInvites.$inferSelect;
export type NewDocument = typeof documents.$inferInsert;
