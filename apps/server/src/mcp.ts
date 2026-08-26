import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as Y from "yjs";
import { z } from "zod";
import {
  DocumentWriteDeniedError,
  type DocumentMeta,
  NotFoundError,
  type SearchHit,
} from "@tandem/core";
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
import {
  imageMarkdown,
  isAllowedImageMime,
  mintImageUploadToken,
  saveImageBytes,
} from "./images.js";
import type { Services } from "./services.js";

/** Decoded-bytes cap for MCP uploads (REST allows 25MB; agents send small images). */
export const MCP_IMAGE_MAX_BYTES = 8 * 1024 * 1024;
/** JSON-RPC body ceiling for POST /mcp: base64 of the cap (~4/3) + envelope headroom. */
export const MCP_BODY_LIMIT = 12 * 1024 * 1024;

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

const DOCUMENT_LIST_FIELDS = [
  "id",
  "title",
  "path",
  "tags",
  "updatedAt",
  "url",
  "collectionId",
  "parentDocumentId",
  "position",
  "depth",
] as const;
type DocumentListField = (typeof DOCUMENT_LIST_FIELDS)[number];
const DEFAULT_DOCUMENT_LIST_FIELDS: DocumentListField[] = [
  "id",
  "title",
  "path",
  "tags",
  "updatedAt",
  "url",
];

const RECENT_DOCUMENT_FIELDS = [
  "id",
  "title",
  "tags",
  "updatedAt",
  "url",
  "collectionId",
  "parentDocumentId",
] as const;
type RecentDocumentField = (typeof RECENT_DOCUMENT_FIELDS)[number];
const DEFAULT_RECENT_DOCUMENT_FIELDS: RecentDocumentField[] = [
  "id",
  "title",
  "tags",
  "updatedAt",
  "url",
];

function encodeCursor(value: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function decodeCursor(value: string): Record<string, unknown> | null {
  try {
    const decoded: unknown = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    return decoded !== null && typeof decoded === "object" && !Array.isArray(decoded)
      ? (decoded as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

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
  target: { documentId: string | null; sessionId: number | null },
) => void;

export type McpServerOptions = {
  /** Public browser origin used for absolute, user-facing entity URLs. */
  publicUrl: string;
  writer?: CollabWriter;
  audit?: AuditHook;
  notify?: (documentId: string, topic: "comments" | "snapshots" | "meta") => void;
  /** Who the agent acts for — used for inbox notifications it produces. */
  identity?: { userId: string; name: string; ai: boolean };
  /** Enables request_image_upload with a short-lived token. */
  uploads?: { secret: string };
};

export function createMcpServer(
  services: Services,
  { publicUrl, writer, audit, notify, identity, uploads }: McpServerOptions,
): McpServer {
  const { documents, collections, comments, workspaces, snapshots } = services;
  const server = new McpServer({ name: "tandem", version: "0.1.0" });

  // Canonical routes contain immutable ids only. Titles, slugs, nesting, and
  // collection placement may all change without invalidating a shared link.
  const documentUrl = (id: string) => new URL(`/d/${encodeURIComponent(id)}`, publicUrl).href;
  const collectionUrl = (id: string) => new URL(`/c/${encodeURIComponent(id)}`, publicUrl).href;
  const commentUrl = (documentId: string, commentId: string) => {
    const url = new URL(`/d/${encodeURIComponent(documentId)}`, publicUrl);
    url.searchParams.set("comment", commentId);
    return url.href;
  };

  /** Compact, machine-friendly document shape (drops binary/search internals). */
  const publicDoc = (d: DocumentMeta & { rank?: number }) => ({
    id: d.id,
    title: d.title,
    tags: d.tags,
    collectionId: d.collectionId,
    parentDocumentId: d.parentDocumentId,
    position: d.position,
    archivedAt: d.archivedAt,
    updatedAt: d.updatedAt,
    ...(d.rank !== undefined ? { rank: d.rank } : {}),
    url: documentUrl(d.id),
  });
  const readableSearchSnippet = (snippet: string) =>
    snippet.replaceAll("\x02", "**").replaceAll("\x03", "**");
  const explainSearchHit = (hit: SearchHit): string => {
    const coverage = `${hit.matchedTerms.length}/${hit.totalTerms}`;
    switch (hit.matchKind) {
      case "tag":
        return "Matched the exact tag filter";
      case "title_phrase":
        return `Title phrase matched; ${coverage} query terms matched`;
      case "phrase":
        return `Document phrase matched; ${coverage} query terms matched`;
      case "all_terms":
        return `All ${hit.totalTerms} query terms matched`;
      case "partial_terms":
        return `${coverage} query terms matched: ${hit.matchedTerms.join(", ")}`;
      case "fuzzy_title":
        return `Title approximately matched: ${hit.fuzzyTitleTerms.join(", ")}`;
    }
  };
  type TreeDocumentNode = DocumentMeta & { children: TreeDocumentNode[] };
  type FlatDocumentNode = { document: DocumentMeta; path: string; depth: number };
  const flattenDocumentTree = (
    nodes: TreeDocumentNode[],
    parentPath: string[] = [],
  ): FlatDocumentNode[] => {
    const flat: FlatDocumentNode[] = [];
    for (const { children, ...document } of nodes) {
      const pathParts = [...parentPath, document.title || "Untitled"];
      flat.push({ document, path: pathParts.join(" / "), depth: pathParts.length });
      flat.push(...flattenDocumentTree(children, pathParts));
    }
    return flat;
  };
  const listedDocument = (entry: FlatDocumentNode, fields: DocumentListField[]) => {
    const { document, path, depth } = entry;
    const values: Record<DocumentListField, unknown> = {
      id: document.id,
      title: document.title,
      path,
      tags: document.tags,
      updatedAt: document.updatedAt,
      url: documentUrl(document.id),
      collectionId: document.collectionId,
      parentDocumentId: document.parentDocumentId,
      position: document.position,
      depth,
    };
    return Object.fromEntries(fields.map((field) => [field, values[field]]));
  };
  const recentDocument = (document: DocumentMeta, fields: RecentDocumentField[]) => {
    const values: Record<RecentDocumentField, unknown> = {
      id: document.id,
      title: document.title,
      tags: document.tags,
      updatedAt: document.updatedAt,
      url: documentUrl(document.id),
      collectionId: document.collectionId,
      parentDocumentId: document.parentDocumentId,
    };
    return Object.fromEntries(fields.map((field) => [field, values[field]]));
  };
  const publicCollection = <T extends { id: string }>(collection: T) => ({
    ...collection,
    url: collectionUrl(collection.id),
  });
  const publicComment = <T extends { id: string; documentId: string }>(comment: T) => ({
    ...comment,
    url: commentUrl(comment.documentId, comment.id),
  });

  /** Record a successful write for the workspace's audit trail. */
  const logAudit = (
    action: string,
    target?: { id?: string; workspaceId: string | null; title?: string | null } | null,
    detail?: string,
    sessionId?: number | null,
  ) => {
    audit?.(
      action,
      detail ?? (target?.title ? `"${target.title}"` : ""),
      target?.workspaceId ?? null,
      { documentId: target?.id ?? null, sessionId: sessionId ?? null },
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
    let sessionId: number | null = null;
    try {
      if (writer) sessionId = await writer.transform(id, transform);
      else await documents.editBody(id, transform);
    } catch (err) {
      if (err instanceof DocumentWriteDeniedError) return toolError(READ_ONLY_MESSAGE);
      if (err instanceof MarkdownEditError) return toolError(err.message);
      throw err;
    }
    const doc = await documents.get(id);
    if (!doc) return notFound("document");
    logAudit(action, doc, undefined, sessionId);
    return json(publicDoc(doc));
  }

  /** A null row from an RLS-scoped write on an existing doc = access denied. */
  async function writeResult(id: string, row: DocumentMeta | null) {
    if (row) return json(publicDoc(row));
    return (await documents.get(id)) ? toolError(READ_ONLY_MESSAGE) : notFound("document");
  }

  /** Resolve the upload target workspace: validate a given id against the
   * actor's memberships, or default when they belong to exactly one. */
  async function resolveWorkspace(
    workspaceId: string | undefined,
  ): Promise<{ id: string } | { error: ReturnType<typeof toolError> }> {
    const mine = await workspaces.listMine();
    if (workspaceId) {
      return mine.some((w) => w.id === workspaceId)
        ? { id: workspaceId }
        : { error: notFound("workspace") };
    }
    if (mine.length === 0) return { error: toolError("no workspace available") };
    if (mine.length > 1) {
      return {
        error: toolError("workspaceId is required: you belong to more than one workspace"),
      };
    }
    return { id: mine[0]!.id };
  }

  server.registerTool(
    "list_collections",
    {
      title: "List collections",
      description:
        "List all collections (top-level groupings of documents). Each result " +
        "includes an absolute canonical url that can be shown to the user.",
      inputSchema: {},
    },
    async () => json((await collections.list()).map(publicCollection)),
  );

  server.registerTool(
    "create_collection",
    {
      title: "Create collection",
      description:
        "Create a new collection. workspaceId is required when you belong to " +
        "more than one workspace. Returns its absolute canonical url.",
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
      return json(publicCollection(collection));
    },
  );

  server.registerTool(
    "list_documents",
    {
      title: "List documents",
      description:
        "List a bounded, flat page of documents in tree order. Defaults to " +
        "top-level orientation only (depth 1), 25 results, and the compact " +
        "fields id/title/path/tags/updatedAt/url. Increase depth to include " +
        "descendants, or pass parentDocumentId to list one document's subtree " +
        "(the depth parameter then counts from that document, while path and the " +
        "depth field stay collection-relative). Use nextCursor to continue a " +
        "large result.",
      inputSchema: {
        collectionId: z.string().uuid(),
        parentDocumentId: z.string().uuid().optional(),
        depth: z.number().int().min(1).max(20).optional(),
        limit: z.number().int().min(1).max(100).optional(),
        cursor: z.string().min(1).optional(),
        updated_after: z.string().datetime({ offset: true }).optional(),
        fields: z.array(z.enum(DOCUMENT_LIST_FIELDS)).min(1).max(10).optional(),
      },
    },
    async ({ collectionId, parentDocumentId, depth, limit, cursor, updated_after, fields }) => {
      const pageDepth = depth ?? 1;
      const pageLimit = limit ?? 25;
      const normalizedAfter = updated_after ? new Date(updated_after).toISOString() : null;
      let offset = 0;
      if (cursor) {
        const decoded = decodeCursor(cursor);
        if (
          decoded?.kind !== "documents" ||
          decoded.collectionId !== collectionId ||
          decoded.parentDocumentId !== (parentDocumentId ?? null) ||
          decoded.depth !== pageDepth ||
          decoded.updatedAfter !== normalizedAfter ||
          !Number.isSafeInteger(decoded.offset) ||
          (decoded.offset as number) < 0
        ) {
          return toolError("invalid cursor for these list_documents parameters");
        }
        offset = decoded.offset as number;
      }

      let entries: FlatDocumentNode[];
      if (parentDocumentId) {
        const sub = await documents.subtree(parentDocumentId, pageDepth).catch((error: unknown) => {
          if (error instanceof NotFoundError) return null;
          throw error;
        });
        if (!sub || sub.root.collectionId !== collectionId) return notFound("document");
        entries = flattenDocumentTree(sub.nodes, sub.ancestry);
      } else {
        entries = flattenDocumentTree(await documents.tree(collectionId, pageDepth));
      }
      const updatedAfterDate = normalizedAfter ? new Date(normalizedAfter) : null;
      const matching = entries.filter(
        ({ document }) =>
          !updatedAfterDate || document.updatedAt.getTime() > updatedAfterDate.getTime(),
      );
      const page = matching.slice(offset, offset + pageLimit);
      const nextOffset = offset + page.length;
      const hasMore = nextOffset < matching.length;
      return json({
        documents: page.map((entry) =>
          listedDocument(
            entry,
            (fields as DocumentListField[] | undefined) ?? DEFAULT_DOCUMENT_LIST_FIELDS,
          ),
        ),
        nextCursor: hasMore
          ? encodeCursor({
              kind: "documents",
              collectionId,
              parentDocumentId: parentDocumentId ?? null,
              depth: pageDepth,
              updatedAfter: normalizedAfter,
              offset: nextOffset,
            })
          : null,
        hasMore,
      });
    },
  );

  server.registerTool(
    "get_document",
    {
      title: "Get document",
      description:
        "Fetch a single document's markdown content, metadata, and absolute " +
        "canonical url by id.",
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
        "Broad keyword search over document titles and bodies. Results matching an " +
        "exact phrase or every term rank above partial matches; title typos are " +
        "tolerated. Each hit explains which terms matched (match.matchedTerms of " +
        "match.totalTerms — drop low-overlap hits yourself when precision matters), " +
        "and includes its collection, breadcrumb path, last update, snippet, and " +
        "absolute canonical url. Ranking is lexical: a document that merely quotes " +
        "the query (a backlog of example searches, notes about a query) outranks the " +
        "documents that answer it, so pass excludeDocumentIds for the document you " +
        "are working from and excludeTags for documents tagged as meta. Optionally " +
        "scope to a collection, or filter/browse by an exact tag (pass an empty query " +
        "with a tag to list everything carrying that tag). Retry with fewer or " +
        "alternative keywords when no results are returned.",
      inputSchema: {
        query: z.string(),
        collectionId: z.string().uuid().optional(),
        limit: z.number().int().min(1).max(100).optional(),
        tag: z.string().optional(),
        excludeDocumentIds: z.array(z.string().uuid()).max(50).optional(),
        excludeTags: z.array(z.string().min(1)).max(20).optional(),
      },
    },
    async ({ query, collectionId, limit, tag, excludeDocumentIds, excludeTags }) => {
      const hits = await documents.search(query, {
        collectionId,
        limit,
        tag,
        excludeIds: excludeDocumentIds,
        excludeTags,
      });
      return json(
        hits.map((hit) => ({
          ...publicDoc(hit),
          collectionName: hit.collectionName,
          path: hit.path,
          snippet: readableSearchSnippet(hit.snippet),
          match: {
            kind: hit.matchKind,
            matchedTerms: hit.matchedTerms,
            fuzzyTitleTerms: hit.fuzzyTitleTerms,
            totalTerms: hit.totalTerms,
            explanation: explainSearchHit(hit),
          },
        })),
      );
    },
  );

  server.registerTool(
    "recent_documents",
    {
      title: "Recent documents",
      description:
        "List recently updated active documents across accessible collections, " +
        "newest first. Optionally scope to one collection or to updates after " +
        "an ISO 8601 instant; use nextCursor to continue.",
      inputSchema: {
        collectionId: z.string().uuid().optional(),
        updated_after: z.string().datetime({ offset: true }).optional(),
        limit: z.number().int().min(1).max(100).optional(),
        cursor: z.string().min(1).optional(),
        fields: z.array(z.enum(RECENT_DOCUMENT_FIELDS)).min(1).max(7).optional(),
      },
    },
    async ({ collectionId, updated_after, limit, cursor, fields }) => {
      const pageLimit = limit ?? 20;
      const normalizedAfter = updated_after ? new Date(updated_after).toISOString() : null;
      let before: { updatedAt: Date; id: string } | undefined;
      if (cursor) {
        const decoded = decodeCursor(cursor);
        const cursorDate =
          typeof decoded?.updatedAt === "string" ? new Date(decoded.updatedAt) : null;
        const cursorId = z.string().uuid().safeParse(decoded?.id);
        if (
          decoded?.kind !== "recent" ||
          decoded.collectionId !== (collectionId ?? null) ||
          decoded.updatedAfter !== normalizedAfter ||
          !cursorId.success ||
          !cursorDate ||
          Number.isNaN(cursorDate.getTime())
        ) {
          return toolError("invalid cursor for these recent_documents parameters");
        }
        before = { updatedAt: cursorDate, id: cursorId.data };
      }
      const rows = await documents.recent({
        collectionId,
        updatedAfter: normalizedAfter ? new Date(normalizedAfter) : undefined,
        before,
        limit: pageLimit + 1,
      });
      const hasMore = rows.length > pageLimit;
      const page = rows.slice(0, pageLimit);
      const last = page.at(-1);
      return json({
        documents: page.map((document) =>
          recentDocument(
            document,
            (fields as RecentDocumentField[] | undefined) ?? DEFAULT_RECENT_DOCUMENT_FIELDS,
          ),
        ),
        nextCursor:
          hasMore && last
            ? encodeCursor({
                kind: "recent",
                collectionId: collectionId ?? null,
                updatedAfter: normalizedAfter,
                updatedAt: last.updatedAt.toISOString(),
                id: last.id,
              })
            : null,
        hasMore,
      });
    },
  );

  server.registerTool(
    "create_document",
    {
      title: "Create document",
      description:
        "Create a document in a collection. Body is markdown; parentDocumentId " +
        "nests it. Returns its absolute canonical url.",
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
        "Upload a SMALL image (base64) and get back a markdown snippet " +
        "`![alt](/api/images/<id>)` to embed with create_document or the edit " +
        "tools. Images are private to workspace members. Raster formats only " +
        "(no SVG); max 8MB decoded. workspaceId is required when you belong " +
        "to more than one workspace. For anything beyond a small icon — or a " +
        "file already on disk — use request_image_upload instead of inlining " +
        "base64.",
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
        return toolError("image exceeds 8MB — use request_image_upload for large files");
      }
      const ws = await resolveWorkspace(workspaceId);
      if ("error" in ws) return ws.error;
      const id = await saveImageBytes(services, {
        workspaceId: ws.id,
        uploadedBy: actor.userId,
        mime,
        bytes,
      });
      logAudit("upload_image", { workspaceId: ws.id, title: null }, `${mime}, ${bytes.length} bytes`);
      const url = `/api/images/${id}`;
      return json({
        id,
        url,
        markdown: imageMarkdown(alt, url),
        mime,
        size: bytes.length,
      });
    },
  );

  // Only advertised when the host wired up token minting (the HTTP server
  // does); otherwise the tool would be listed but always fail.
  if (uploads) {
    server.registerTool(
      "request_image_upload",
      {
        title: "Request an image upload URL",
        description:
          "Get a short-lived URL for uploading an image WITHOUT inlining " +
          "base64 — prefer this over upload_image whenever the file lives on " +
          "disk or is bigger than a small icon. Give the alt text HERE, not in " +
          "the upload; then POST the bytes within 15 minutes as multipart " +
          "field `file`, passing the returned token as a bearer header: " +
          '`curl -sf -H "Authorization: Bearer <token>" -F "file=@shot.png" ' +
          '"<uploadUrl>"` (the `example` field comes ready to run). The ' +
          "upload's JSON response matches upload_image ({ id, url, markdown }); " +
          "embed the markdown with the edit tools. Request one URL per image. " +
          "Raster formats only (no SVG); max 25MB. workspaceId is required " +
          "when you belong to more than one workspace.",
        inputSchema: {
          alt: z.string().max(500).optional(),
          workspaceId: z.string().uuid().optional(),
        },
      },
      async ({ alt, workspaceId }) => {
        const actor = services.actor;
        if (actor.kind !== "user") return toolError("image upload requires a user identity");
        const ws = await resolveWorkspace(workspaceId);
        if ("error" in ws) return ws.error;
        const { token, expiresAt } = mintImageUploadToken(uploads.secret, {
          userId: actor.userId,
          workspaceId: ws.id,
          alt,
        });
        const uploadUrl = new URL("/api/images/upload", publicUrl).toString();
        return json({
          uploadUrl,
          token,
          expiresAt,
          example: `curl -sf -H "Authorization: Bearer ${token}" -F "file=@<path>" "${uploadUrl}"`,
        });
      },
    );
  }

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
    async () =>
      json(
        (await documents.listMyTodos()).map((task) => ({
          ...task,
          url: documentUrl(task.documentId),
        })),
      ),
  );

  server.registerTool(
    "list_comments",
    {
      title: "List comments",
      description:
        "All comment threads on a document — top-level comments and replies " +
        "(parentId), with author, human-vs-AI not distinguished here, and " +
        "resolved state. Each comment includes an absolute canonical url that " +
        "opens its thread. Commenting needs only read access.",
      inputSchema: { documentId: z.string().uuid() },
    },
    async ({ documentId }) => {
      if (!(await documents.get(documentId))) return notFound("document");
      return json((await comments.list(documentId)).map(publicComment));
    },
  );

  server.registerTool(
    "add_comment",
    {
      title: "Add comment",
      description:
        "Comment on a document, or reply to an existing top-level comment by " +
        "passing its id as parentId. The body is Markdown (raw HTML is " +
        "escaped, images are not rendered). Returns an absolute canonical url " +
        "that opens the comment thread. Needs only read access to the document.",
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
      return json(publicComment(comment));
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
      return json(publicComment(comment));
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
