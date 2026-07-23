import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as Y from "yjs";
import { z } from "zod";
import { DocumentWriteDeniedError, type DocumentMeta } from "@tandem/core";
import {
  appendMarkdown,
  blameSpans,
  COLLAB_FIELD,
  getAuthors,
  insertAfterHeading,
  jsonToMarkdown,
  MarkdownEditError,
  replaceSection,
  replaceText,
  schema,
  stateToJSON,
  UNKNOWN_AUTHOR,
} from "@tandem/editor";
import type { CollabWriter } from "./collab-writer.js";
import { isAllowedImageMime, saveImageBytes } from "./images.js";
import type { Services } from "./services.js";

/** Decoded-bytes cap for MCP uploads (REST allows 25MB; agents send small images). */
export const MCP_IMAGE_MAX_BYTES = 8 * 1024 * 1024;
/** JSON-RPC body ceiling for POST /mcp: base64 of the cap (~4/3) + envelope headroom. */
export const MCP_BODY_LIMIT = 12 * 1024 * 1024;

/** Compact, machine-friendly document shape (drops binary/search internals). */
function publicDoc(d: DocumentMeta & { rank?: number }) {
  return {
    id: d.id,
    title: d.title,
    tags: d.tags,
    collectionId: d.collectionId,
    parentDocumentId: d.parentDocumentId,
    position: d.position,
    archivedAt: d.archivedAt,
    updatedAt: d.updatedAt,
    ...(d.rank !== undefined ? { rank: d.rank } : {}),
  };
}

function json(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
}

function toolError(message: string) {
  return { isError: true, content: [{ type: "text" as const, text: message }] };
}

function notFound(what: string) {
  return toolError(`${what} not found`);
}

const READ_ONLY_MESSAGE =
  "permission denied: this document is read-only for you (its collection does not grant you write access)";

/**
 * Build the MCP server exposing the wiki content. Every tool delegates to the
 * shared core services — no document logic lives here.
 *
 * Body edits are deliberately TARGETED (find/replace, per-section) rather than
 * whole-document rewrites: edits flow through a structural Yjs diff, so only
 * the spans an agent actually changes are attributed to it — a full rewrite
 * would re-attribute the entire document and destroy human authorship (blame).
 */
export type AuditHook = (
  action: string,
  detail: string,
  workspaceId: string | null,
) => void;

export function createMcpServer(
  services: Services,
  writer?: CollabWriter,
  audit?: AuditHook,
  notify?: (documentId: string, topic: "comments" | "snapshots" | "meta") => void,
  /** Who the agent acts for — used for inbox notifications it produces. */
  identity?: { userId: string; name: string; ai: boolean },
): McpServer {
  const { documents, collections, comments, workspaces, snapshots } = services;
  const server = new McpServer({ name: "tandem", version: "0.1.0" });

  /** Record a successful write for the workspace's audit trail. */
  const logAudit = (
    action: string,
    target?: { workspaceId: string | null; title?: string | null } | null,
    detail?: string,
  ) => {
    audit?.(
      action,
      detail ?? (target?.title ? `"${target.title}"` : ""),
      target?.workspaceId ?? null,
    );
  };

  /**
   * Apply a markdown transform to a document body through the single write
   * path: the live collab doc when a writer is wired (the HTTP server), else
   * directly against the persisted Yjs state. Maps permission/target failures
   * to clean tool errors instead of fake success.
   */
  async function editBody(
    action: string,
    id: string,
    transform: (md: string) => string,
  ) {
    if (!(await documents.get(id))) return notFound("document");
    try {
      if (writer) await writer.transform(id, transform);
      else await documents.editBody(id, transform);
    } catch (err) {
      if (err instanceof DocumentWriteDeniedError) return toolError(READ_ONLY_MESSAGE);
      if (err instanceof MarkdownEditError) return toolError(err.message);
      throw err;
    }
    const doc = await documents.get(id);
    if (!doc) return notFound("document");
    logAudit(action, doc);
    return json(publicDoc(doc));
  }

  /** A null row from an RLS-scoped write on an existing doc = access denied. */
  async function writeResult(id: string, row: DocumentMeta | null) {
    if (row) return json(publicDoc(row));
    return (await documents.get(id)) ? toolError(READ_ONLY_MESSAGE) : notFound("document");
  }

  server.registerTool(
    "list_collections",
    {
      title: "List collections",
      description: "List all collections (top-level groupings of documents).",
      inputSchema: {},
    },
    async () => json(await collections.list()),
  );

  server.registerTool(
    "create_collection",
    {
      title: "Create collection",
      description:
        "Create a new collection. workspaceId is required when you belong to " +
        "more than one workspace.",
      inputSchema: {
        name: z.string().min(1),
        slug: z.string().min(1),
        description: z.string().optional(),
        workspaceId: z.string().uuid().optional(),
      },
    },
    async (args) => {
      const collection = await collections.create(args);
      logAudit("create_collection", { workspaceId: collection.workspaceId, title: collection.name });
      return json(collection);
    },
  );

  server.registerTool(
    "list_documents",
    {
      title: "List documents",
      description: "List documents in a collection as a nested tree.",
      inputSchema: { collectionId: z.string().uuid() },
    },
    async ({ collectionId }) => json(await documents.tree(collectionId)),
  );

  server.registerTool(
    "get_document",
    {
      title: "Get document",
      description:
        "Fetch a single document's markdown content and metadata by id.",
      inputSchema: { id: z.string().uuid() },
    },
    async ({ id }) => {
      const doc = await documents.get(id);
      if (!doc) return notFound("document");
      return json({ ...publicDoc(doc), markdown: documents.toMarkdown(doc) });
    },
  );

  server.registerTool(
    "search_documents",
    {
      title: "Search documents",
      description:
        "Full-text search over document titles and bodies. Optionally scope to a " +
        "collection, or filter/browse by an exact tag (pass an empty query with a " +
        "tag to list everything carrying that tag).",
      inputSchema: {
        query: z.string(),
        collectionId: z.string().uuid().optional(),
        limit: z.number().int().min(1).max(100).optional(),
        tag: z.string().optional(),
      },
    },
    async ({ query, collectionId, limit, tag }) => {
      const hits = await documents.search(query, { collectionId, limit, tag });
      return json(hits.map((h) => ({ ...publicDoc(h), snippet: h.snippet })));
    },
  );

  server.registerTool(
    "create_document",
    {
      title: "Create document",
      description:
        "Create a document in a collection. Body is markdown; parentDocumentId nests it.",
      inputSchema: {
        collectionId: z.string().uuid(),
        title: z.string().optional(),
        markdown: z.string().optional(),
        parentDocumentId: z.string().uuid().optional(),
      },
    },
    async (args) => {
      const doc = await documents.create(args);
      logAudit("create_document", doc);
      return json(publicDoc(doc));
    },
  );

  server.registerTool(
    "upload_image",
    {
      title: "Upload image",
      description:
        "Upload an image (base64) and get back a markdown snippet " +
        "`![alt](/api/images/<id>)` to embed with create_document or the edit " +
        "tools. Images are private to workspace members. Raster formats only " +
        "(no SVG); max 8MB decoded. workspaceId is required when you belong " +
        "to more than one workspace.",
      inputSchema: {
        data: z.string().min(1),
        mime: z.string().min(1),
        alt: z.string().max(500).optional(),
        workspaceId: z.string().uuid().optional(),
      },
    },
    async ({ data, mime, alt, workspaceId }) => {
      const actor = services.actor;
      if (actor.kind !== "user") return toolError("image upload requires a user identity");
      if (!isAllowedImageMime(mime)) {
        return toolError("not a supported image type (raster image/* only, no SVG)");
      }
      // Node's base64 decoder silently skips invalid characters, so vet the
      // input strictly first — otherwise garbage would decode to garbage bytes.
      const b64 = data.replace(/^data:[^;,]+;base64,/, "").replace(/\s+/g, "");
      if (!/^[A-Za-z0-9+/]*={0,2}$/.test(b64) || b64.length % 4 !== 0) {
        return toolError("data is not valid base64");
      }
      const bytes = Buffer.from(b64, "base64");
      if (bytes.length === 0) return toolError("image data is empty");
      if (bytes.length > MCP_IMAGE_MAX_BYTES) {
        return toolError("image exceeds 8MB — use the web app to upload larger images");
      }
      const mine = await workspaces.listMine();
      if (workspaceId && !mine.some((w) => w.id === workspaceId)) {
        return notFound("workspace");
      }
      if (!workspaceId) {
        if (mine.length === 0) return toolError("no workspace available");
        if (mine.length > 1) {
          return toolError("workspaceId is required: you belong to more than one workspace");
        }
        workspaceId = mine[0]!.id;
      }
      const id = await saveImageBytes(services, {
        workspaceId,
        uploadedBy: actor.userId,
        mime,
        bytes,
      });
      logAudit("upload_image", { workspaceId, title: null }, `${mime}, ${bytes.length} bytes`);
      const url = `/api/images/${id}`;
      return json({
        id,
        url,
        // Square brackets would break the snippet's markdown; drop them.
        markdown: `![${(alt ?? "").replace(/[[\]]/g, "")}](${url})`,
        mime,
        size: bytes.length,
      });
    },
  );

  server.registerTool(
    "update_document",
    {
      title: "Update document metadata",
      description:
        "Set a document's title and/or tags (labels for organization and search). " +
        "Body edits use the targeted edit tools (edit_document, " +
        "insert_after_heading, replace_section, append_section) so that only what " +
        "actually changed is attributed to this agent.",
      inputSchema: {
        id: z.string().uuid(),
        title: z.string().optional(),
        tags: z.array(z.string()).optional(),
      },
    },
    async ({ id, title, tags }) => {
      if (title === undefined && tags === undefined) {
        return toolError("provide a title and/or tags to update");
      }
      const doc = await documents.update(id, { title, tags });
      if (doc) {
        logAudit(title !== undefined ? "rename_document" : "tag_document", doc);
        // Titles live outside the CRDT body: ping open editors to refetch.
        if (title !== undefined) notify?.(id, "meta");
      }
      return writeResult(id, doc);
    },
  );

  server.registerTool(
    "edit_document",
    {
      title: "Edit document",
      description:
        "Replace an exact string in a document's markdown body. old_string must " +
        "match the document text exactly (including whitespace) and exactly once — " +
        "copy it verbatim from get_document and include enough surrounding context " +
        "to make it unique, or set replace_all to change every occurrence. " +
        "Prefer this (smallest possible change) over rewriting sections.",
      inputSchema: {
        id: z.string().uuid(),
        old_string: z.string().min(1),
        new_string: z.string(),
        replace_all: z.boolean().optional(),
      },
    },
    async ({ id, old_string, new_string, replace_all }) =>
      editBody("edit_document", id, (md) => replaceText(md, old_string, new_string, replace_all)),
  );

  server.registerTool(
    "insert_after_heading",
    {
      title: "Insert after heading",
      description:
        "Insert a markdown block directly below a heading (before the section's " +
        "existing content). Identify the heading by its text, e.g. \"Setup\" or " +
        "\"## Setup\".",
      inputSchema: {
        id: z.string().uuid(),
        heading: z.string().min(1),
        markdown: z.string().min(1),
      },
    },
    async ({ id, heading, markdown }) =>
      editBody("insert_after_heading", id, (md) => insertAfterHeading(md, heading, markdown)),
  );

  server.registerTool(
    "replace_section",
    {
      title: "Replace section",
      description:
        "Replace the body of the section under a heading (up to the next heading " +
        "of the same or higher level). The heading line itself is kept — use " +
        "edit_document to change heading text.",
      inputSchema: {
        id: z.string().uuid(),
        heading: z.string().min(1),
        markdown: z.string(),
      },
    },
    async ({ id, heading, markdown }) =>
      editBody("replace_section", id, (md) => replaceSection(md, heading, markdown)),
  );

  server.registerTool(
    "append_section",
    {
      title: "Append section",
      description:
        "Append markdown to the end of a document. Block-scoped, so it merges " +
        "cleanly with concurrent human edits via the live collaborative document.",
      inputSchema: { id: z.string().uuid(), markdown: z.string().min(1) },
    },
    async ({ id, markdown }) => editBody("append_section", id, (md) => appendMarkdown(md, markdown)),
  );

  server.registerTool(
    "move_document",
    {
      title: "Move document",
      description:
        "Reparent a document. parentDocumentId null moves it to the collection root.",
      inputSchema: {
        id: z.string().uuid(),
        parentDocumentId: z.string().uuid().nullable(),
        position: z.number().optional(),
      },
    },
    async ({ id, parentDocumentId, position }) => {
      const doc = await documents.move(id, { parentDocumentId, position });
      if (doc) logAudit("move_document", doc);
      return writeResult(id, doc);
    },
  );

  server.registerTool(
    "archive_document",
    {
      title: "Archive document",
      description: "Archive a document (hidden from active listings, recoverable).",
      inputSchema: { id: z.string().uuid() },
    },
    async ({ id }) => {
      const doc = await documents.archive(id);
      if (doc) logAudit("archive_document", doc);
      return writeResult(id, doc);
    },
  );

  server.registerTool(
    "restore_document",
    {
      title: "Restore document",
      description: "Restore an archived document (and its subtree) to active use.",
      inputSchema: { id: z.string().uuid() },
    },
    async ({ id }) => {
      const doc = await documents.restore(id);
      if (doc) logAudit("restore_document", doc);
      return writeResult(id, doc);
    },
  );

  server.registerTool(
    "list_archived",
    {
      title: "List archived documents",
      description: "Archived subtree roots in a collection (restorable).",
      inputSchema: { collectionId: z.string().uuid() },
    },
    async ({ collectionId }) => json((await documents.listArchived(collectionId)).map(publicDoc)),
  );

  server.registerTool(
    "list_tags",
    {
      title: "List tags",
      description: "Every tag in use across documents you can read, with counts.",
      inputSchema: {},
    },
    async () => json(await documents.listTags()),
  );

  server.registerTool(
    "list_backlinks",
    {
      title: "List backlinks",
      description: "Documents that link to the given document (cross-references).",
      inputSchema: { id: z.string().uuid() },
    },
    async ({ id }) => {
      if (!(await documents.get(id))) return notFound("document");
      return json((await documents.backlinks(id)).map(publicDoc));
    },
  );

  server.registerTool(
    "list_members",
    {
      title: "List workspace members",
      description:
        "Members of a workspace with their @handle (the email local part) — " +
        "use handles to assign tasks (`- [ ] @handle …`) or mention people.",
      inputSchema: { workspaceId: z.string().uuid() },
    },
    async ({ workspaceId }) => {
      const members = await workspaces.members(workspaceId);
      return json(members.map((m) => ({ ...m, handle: m.email.split("@")[0] })));
    },
  );

  server.registerTool(
    "my_tasks",
    {
      title: "My tasks",
      description:
        "To-do items assigned to the user you act for (checkbox items " +
        "mentioning their @handle), each pointing at its document.",
      inputSchema: {},
    },
    async () => json(await documents.listMyTodos()),
  );

  server.registerTool(
    "list_comments",
    {
      title: "List comments",
      description:
        "All comment threads on a document — top-level comments and replies " +
        "(parentId), with author, human-vs-AI not distinguished here, and " +
        "resolved state. Commenting needs only read access.",
      inputSchema: { documentId: z.string().uuid() },
    },
    async ({ documentId }) => {
      if (!(await documents.get(documentId))) return notFound("document");
      return json(await comments.list(documentId));
    },
  );

  server.registerTool(
    "add_comment",
    {
      title: "Add comment",
      description:
        "Comment on a document, or reply to an existing top-level comment by " +
        "passing its id as parentId. Needs only read access to the document.",
      inputSchema: {
        documentId: z.string().uuid(),
        body: z.string().min(1).max(10_000),
        parentId: z.string().uuid().optional(),
      },
    },
    async ({ documentId, body, parentId }) => {
      const doc = await documents.get(documentId);
      if (!doc) return notFound("document");
      const comment = await comments.create({ documentId, body, parentId });
      logAudit("add_comment", doc);
      notify?.(documentId, "comments");
      if (identity) {
        void services.notifications
          .onCommentCreated({
            comment,
            workspaceId: doc.workspaceId,
            documentTitle: doc.title,
            actor: identity,
          })
          .catch((err) => console.error("comment notification failed", err));
      }
      return json(comment);
    },
  );

  server.registerTool(
    "resolve_comment",
    {
      title: "Resolve comment",
      description:
        "Mark a comment thread resolved (or reopen it with resolved=false).",
      inputSchema: { id: z.string().uuid(), resolved: z.boolean().optional() },
    },
    async ({ id, resolved }) => {
      const comment = await comments.setResolved(id, resolved ?? true);
      const doc = await documents.get(comment.documentId);
      logAudit(resolved === false ? "reopen_comment" : "resolve_comment", doc);
      notify?.(comment.documentId, "comments");
      if (identity && resolved !== false && doc && comment.authorId !== identity.userId) {
        void services.notifications
          .onCommentResolved({
            comment,
            workspaceId: doc.workspaceId,
            documentTitle: doc.title,
            actor: identity,
          })
          .catch((err) => console.error("resolve notification failed", err));
      }
      return json(comment);
    },
  );

  server.registerTool(
    "list_versions",
    {
      title: "List versions",
      description:
        "Point-in-time versions of a document (newest first), with the " +
        "sessions that edited between captures.",
      inputSchema: { documentId: z.string().uuid() },
    },
    async ({ documentId }) => {
      if (!(await documents.get(documentId))) return notFound("document");
      return json(await snapshots.list(documentId));
    },
  );

  server.registerTool(
    "read_version",
    {
      title: "Read version",
      description: "A past version's full markdown, by version id (from list_versions).",
      inputSchema: { id: z.string().uuid() },
    },
    async ({ id }) => {
      const snap = await snapshots.get(id);
      if (!snap) return notFound("version");
      return json({
        id,
        documentId: snap.documentId,
        createdAt: snap.createdAt,
        kind: snap.kind,
        markdown: jsonToMarkdown(stateToJSON(snap.ydocState)),
      });
    },
  );

  server.registerTool(
    "get_authors",
    {
      title: "Get authorship (blame)",
      description:
        "Who wrote what: the document's text in order, split into spans " +
        "attributed to the human or AI session that inserted them, plus a " +
        "contributor summary. This is the blame view the editor renders.",
      inputSchema: { id: z.string().uuid() },
    },
    async ({ id }) => {
      const doc = await documents.get(id);
      if (!doc) return notFound("document");
      if (!doc.ydocState) {
        // Legacy doc never opened since blame tracking: nothing to attribute.
        return json({ id: doc.id, title: doc.title, contributors: [], spans: [] });
      }
      const ydoc = new Y.Doc();
      Y.applyUpdate(ydoc, doc.ydocState);
      const authors = getAuthors(ydoc);
      const pmDoc = schema.nodeFromJSON(stateToJSON(doc.ydocState) as never);
      const size = pmDoc.content.size;
      const spans: Array<{ author: string; ai: boolean; at: string | null; text: string }> = [];
      for (const s of blameSpans(ydoc.getXmlFragment(COLLAB_FIELD))) {
        const a = authors.get(s.clientId) ?? UNKNOWN_AUTHOR;
        const text = pmDoc.textBetween(Math.min(s.from, size), Math.min(s.to, size), "\n", "");
        if (!text.trim()) continue; // pure structure (open/close tags)
        const last = spans[spans.length - 1];
        // Merge consecutive spans by the same identity so prose reads as runs.
        if (last && last.author === a.name && last.ai === a.ai) {
          last.text += text;
        } else {
          spans.push({
            author: a.name,
            ai: a.ai,
            at: a.at ? new Date(a.at).toISOString() : null,
            text,
          });
        }
      }
      const contributors = new Map<
        string,
        { userId: string; name: string; ai: boolean; lastEditAt: number }
      >();
      for (const a of authors.values()) {
        const key = `${a.userId}:${a.ai}`;
        const prev = contributors.get(key);
        if (!prev || a.at > prev.lastEditAt) {
          contributors.set(key, { userId: a.userId, name: a.name, ai: a.ai, lastEditAt: a.at });
        }
      }
      return json({
        id: doc.id,
        title: doc.title,
        contributors: [...contributors.values()].map((c) => ({
          ...c,
          lastEditAt: c.lastEditAt ? new Date(c.lastEditAt).toISOString() : null,
        })),
        spans,
      });
    },
  );

  return server;
}
