import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { DocumentMeta } from "@realtime/core";
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

function notFound(what: string) {
  return { isError: true, content: [{ type: "text" as const, text: `${what} not found` }] };
}

/**
 * Build the MCP server exposing the wiki content. Every tool delegates to the
 * shared core services — no document logic lives here.
 */
export function createMcpServer(services: Services, writer?: CollabWriter): McpServer {
  const { documents, collections } = services;
  const server = new McpServer({ name: "realtime-wiki", version: "0.1.0" });

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
    async (args) => json(await collections.create(args)),
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
      return json(hits.map(publicDoc));
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
    async (args) => json(publicDoc(await documents.create(args))),
  );

  server.registerTool(
    "update_document",
    {
      title: "Update document",
      description:
        "Update a document's title and/or markdown body. Replaces the whole body. " +
        "Body edits funnel through the live collaborative document.",
      inputSchema: {
        id: z.string().uuid(),
        title: z.string().optional(),
        markdown: z.string().optional(),
      },
    },
    async ({ id, title, markdown }) => {
      if (!(await documents.get(id))) return notFound("document");
      if (title !== undefined) await documents.update(id, { title });
      if (markdown !== undefined) {
        // Through the live Y.Doc (one write path) when in-process; else DB.
        if (writer) await writer.replaceBody(id, markdown);
        else await documents.update(id, { markdown });
      }
      return json(publicDoc((await documents.get(id))!));
    },
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
    async ({ id, markdown }) => {
      const existing = await documents.get(id);
      if (!existing) return notFound("document");
      if (writer) {
        await writer.appendSection(id, markdown);
      } else {
        const body = existing.contentMd ? `${existing.contentMd}\n\n${markdown}` : markdown;
        await documents.update(id, { markdown: body });
      }
      return json(publicDoc((await documents.get(id))!));
    },
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
      if (!doc) return notFound("document");
      return json(publicDoc(doc));
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
      if (!doc) return notFound("document");
      return json(publicDoc(doc));
    },
  );

  return server;
}
