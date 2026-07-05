import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { DocumentWriteDeniedError, type DocumentMeta } from "@tandem/core";
import {
  appendMarkdown,
  insertAfterHeading,
  MarkdownEditError,
  replaceSection,
  replaceText,
} from "@tandem/editor";
import type { CollabWriter } from "./collab-writer.js";
import type { Services } from "./services.js";

/** Compact, machine-friendly document shape (drops binary/search internals). */
function publicDoc(d: DocumentMeta & { rank?: number }) {
  return {
    id: d.id,
    title: d.title,
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
): McpServer {
  const { documents, collections } = services;
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
   * path: the live collab doc when in-process (HTTP server), else the
   * persisted Yjs state (stdio). Maps permission/target failures to clean
   * tool errors instead of fake success.
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
        "Create a new collection. workspaceId is required when the server isn't " +
        "scoped to a single user (e.g. the local stdio server with multiple workspaces).",
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
        "Full-text search over document titles and bodies. Optionally scope to a collection.",
      inputSchema: {
        query: z.string().min(1),
        collectionId: z.string().uuid().optional(),
        limit: z.number().int().min(1).max(100).optional(),
      },
    },
    async ({ query, collectionId, limit }) => {
      const hits = await documents.search(query, { collectionId, limit });
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
    "update_document",
    {
      title: "Rename document",
      description:
        "Set a document's title. Body edits use the targeted edit tools " +
        "(edit_document, insert_after_heading, replace_section, append_section) " +
        "so that only what actually changed is attributed to this agent.",
      inputSchema: {
        id: z.string().uuid(),
        title: z.string(),
      },
    },
    async ({ id, title }) => {
      const doc = await documents.update(id, { title });
      if (doc) logAudit("rename_document", doc);
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

  return server;
}
