import { sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  boolean,
  customType,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
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
    // Sidebar ordering within the workspace (sparse; new collections go at max+1).
    position: doublePrecision("position").notNull().default(0),
    name: text("name").notNull(),
    slug: text("slug").notNull(),
    description: text("description"),
    icon: text("icon"),
    color: text("color"),
    // New pages here start from this template unless a deeper folder sets one.
    defaultTemplateId: uuid("default_template_id").references((): AnyPgColumn => templates.documentId, {
      onDelete: "set null",
    }),
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
    // New pages under this one start from this template (deepest ancestor wins).
    defaultTemplateId: uuid("default_template_id").references((): AnyPgColumn => templates.documentId, {
      onDelete: "set null",
    }),
    // Provenance of a page created from a template; never updated afterwards.
    origin: jsonb("origin").$type<DocumentOrigin>(),
    // What the page is: at most one type. Detaching clears this and keeps
    // the values, which reference field ids, not the type.
    typeId: uuid("type_id").references((): AnyPgColumn => documentTypes.id, {
      onDelete: "set null",
    }),
    // Derived READ model of the ydoc's `properties` map, validated against
    // the field registry: valid values by field id, the values that failed
    // as issues, and their searchable text. Written only together with the
    // ydoc_state it was projected from.
    properties: jsonb("properties").$type<Record<string, unknown>>().notNull().default({}),
    propertyIssues: jsonb("property_issues").$type<PropertyIssue[]>().notNull().default([]),
    propertiesText: text("properties_text").notNull().default(""),

    searchVector: tsvector("search_vector").generatedAlwaysAs(
      (): any =>
        sql`setweight(to_tsvector('simple', coalesce(title, '')), 'A') || setweight(to_tsvector('simple', coalesce(content_md, '')), 'B') || setweight(to_tsvector('simple', coalesce(properties_text, '')), 'C')`,
    ),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    // Millisecond precision: every app write is a JS Date (ms) and the
    // recent-documents keyset cursor round-trips through one, so the
    // microseconds now() would add could only make that cursor skip rows.
    updatedAt: timestamp("updated_at", { withTimezone: true, precision: 3 })
      .notNull()
      .defaultNow(),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (t) => [
    index("documents_collection_idx").on(t.collectionId),
    index("documents_parent_idx").on(t.parentDocumentId),
    index("documents_search_idx").using("gin", t.searchVector),
    index("documents_title_trgm_idx")
      .using("gin", sql`lower(${t.title}) gin_trgm_ops`)
      .where(sql`${t.deletedAt} IS NULL AND ${t.archivedAt} IS NULL`),
    index("documents_tags_idx").using("gin", t.tags),
    index("documents_recent_idx")
      .on(t.updatedAt, t.id)
      .where(sql`${t.deletedAt} IS NULL AND ${t.archivedAt} IS NULL`),
    index("documents_collection_recent_idx")
      .on(t.collectionId, t.updatedAt, t.id)
      .where(sql`${t.deletedAt} IS NULL AND ${t.archivedAt} IS NULL`),
  ],
);

/** Which template a page started from: the template document and its
 * `updated_at` at instantiation. */
export interface DocumentOrigin {
  templateId: string;
  version: string;
}

/** Field kinds. List kinds (multi_select, doc_list) hold several values;
 * `json` holds imported structures the app can't edit. */
export const FIELD_KINDS = [
  "text",
  "number",
  "checkbox",
  "date",
  "datetime",
  "select",
  "multi_select",
  "url",
  "doc",
  "doc_list",
  "json",
] as const;
export type FieldKind = (typeof FIELD_KINDS)[number];

/** A select option. Ids are stable; a removed option is retired, never
 * deleted, so values that hold it stay readable. */
export interface FieldOption {
  id: string;
  label: string;
  retired?: boolean;
}

/** A stored value the projection could not accept as valid. */
export interface PropertyIssue {
  fieldId: string;
  code: "unknown_field" | "retired_field" | "retired_option" | "invalid_value";
  message: string;
  value: unknown;
}

/** What a page is (Meeting, Project). Defined by workspace owners and admins. */
export const documentTypes = pgTable(
  "document_types",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    createdBy: text("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("document_types_name_unique").on(t.workspaceId, sql`lower(${t.name})`)],
);

/** A property definition. `type_id` null is an ad-hoc workspace field.
 * Values in documents are keyed by `id`, so renames, kind changes and
 * retirement never rewrite a document. */
export const typeFields = pgTable(
  "type_fields",
  {
    id: text("id").primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    typeId: uuid("type_id").references(() => documentTypes.id, { onDelete: "set null" }),
    key: text("key").notNull(),
    label: text("label").notNull(),
    kind: text("kind").$type<FieldKind>().notNull(),
    position: doublePrecision("position").notNull().default(0),
    options: jsonb("options").$type<FieldOption[]>().notNull().default([]),
    retiredAt: timestamp("retired_at", { withTimezone: true }),
    createdBy: text("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("type_fields_workspace_idx").on(t.workspaceId),
    // One live field per key within a type (or among the ad-hoc fields).
    uniqueIndex("type_fields_live_key_unique")
      .on(
        t.workspaceId,
        sql`coalesce(${t.typeId}, '00000000-0000-0000-0000-000000000000'::uuid)`,
        sql`lower(${t.key})`,
      )
      .where(sql`${t.retiredAt} IS NULL`),
  ],
);

/** Keys a field had before a rename. Append-only, so old keys keep working
 * for agents and imports. */
export const fieldKeyAliases = pgTable(
  "field_key_aliases",
  {
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    key: text("key").notNull(),
    fieldId: text("field_id")
      .notNull()
      .references(() => typeFields.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.fieldId, t.key] }),
    index("field_key_aliases_workspace_idx").on(t.workspaceId),
  ],
);

/** Expressions a template default can use besides a literal value. `today`
 * and `now` are the moment of instantiation, `me` the creator's name, and
 * `from_previous_sibling` the same field on the latest earlier page of the
 * type under the same parent. */
export const DEFAULT_EXPRESSIONS = ["today", "now", "me", "from_previous_sibling"] as const;
export type DefaultExpression = (typeof DEFAULT_EXPRESSIONS)[number];

/** How a template fills one field of a new page. A literal is stored like a
 * property value: option ids, document ids, ISO dates; a list for list kinds. */
export type TemplateDefault = { kind: "value"; value: unknown } | { kind: DefaultExpression };

/** A template is an ordinary document (same editor, blame, versions) plus
 * this row. Template documents and their subtrees stay out of search,
 * backlinks, recents and tasks. New pages get `default_type_id` as their
 * type and `defaults` (by field id) as their first values. */
export const templates = pgTable(
  "templates",
  {
    documentId: uuid("document_id")
      .primaryKey()
      .references(() => documents.id, { onDelete: "cascade" }),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    defaultTypeId: uuid("default_type_id").references(() => documentTypes.id, { onDelete: "set null" }),
    defaults: jsonb("defaults").$type<Record<string, TemplateDefault>>().notNull().default({}),
    createdBy: text("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("templates_workspace_idx").on(t.workspaceId)],
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
  // Sidebar fold state, synced across devices. Inverted semantics on purpose:
  // collections store the EXPANDED set (they default collapsed), document
  // nodes store the COLLAPSED set (they default expanded). Ids of deleted
  // rows may linger; membership checks make that harmless.
  sidebarExpandedCollections: text("sidebar_expanded_collections")
    .array()
    .notNull()
    .default([]),
  sidebarCollapsedDocs: text("sidebar_collapsed_docs").array().notNull().default([]),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/** Derived READ model of a page's task items, one row per item keyed by its
 * block id, rewritten with every save of the page. Templates keep rows like
 * any page; readers exclude them. */
export const tasks = pgTable(
  "tasks",
  {
    documentId: uuid("document_id")
      .notNull()
      .references(() => documents.id, { onDelete: "cascade" }),
    blockId: text("block_id").notNull(),
    text: text("text").notNull(),
    done: boolean("done").notNull().default(false),
    // Lower-cased @handles the task assigns (`- [ ] @alice …`).
    handles: text("handles").array().notNull().default([]),
    position: integer("position").notNull(),
    // From blame: who wrote the item, and whether as an agent. Null when the
    // item predates blame.
    createdBy: text("created_by"),
    ai: boolean("ai").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    // When the save that first saw it done ran; null while open.
    closedAt: timestamp("closed_at", { withTimezone: true }),
  },
  (t) => [
    primaryKey({ columns: [t.documentId, t.blockId] }),
    index("tasks_handles_idx").using("gin", t.handles),
  ],
);

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
    /** Optional deep-link target within the document. Kept generic so the
     * inbox can later point at tasks and AI review sessions as well as
     * comments without another schema change. */
    targetType: text("target_type"),
    targetId: text("target_id"),
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
    /** Exact target for action-center review links. */
    documentId: uuid("document_id").references(() => documents.id, {
      onDelete: "set null",
    }),
    /** Yjs author session for one attributed agent edit, when applicable. */
    sessionId: text("session_id"),
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
export type Template = typeof templates.$inferSelect;
export type DocumentType = typeof documentTypes.$inferSelect;
export type TypeField = typeof typeFields.$inferSelect;
export type Task = typeof tasks.$inferSelect;
