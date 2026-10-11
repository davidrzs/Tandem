import type { DocumentMeta, SearchHit } from "@tandem/core";
import { DocumentWriteDeniedError } from "@tandem/core";
import { MarkdownEditError } from "@tandem/editor";
import type { CollabWriter } from "../collab-writer.js";
import type { Services } from "../services.js";

/** Decoded-bytes cap for MCP uploads (REST allows 25MB; agents send small images). */
export const MCP_IMAGE_MAX_BYTES = 3 * 1024 * 1024;

export function json(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
}

export function toolError(message: string) {
  return { isError: true, content: [{ type: "text" as const, text: message }] };
}

export function notFound(what: string) {
  return toolError(`${what} not found`);
}

export const READ_ONLY_MESSAGE =
  "permission denied: this document is read-only for you (its collection does not grant you write access)";

export const DOCUMENT_LIST_FIELDS = [
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
export type DocumentListField = (typeof DOCUMENT_LIST_FIELDS)[number];
export const DEFAULT_DOCUMENT_LIST_FIELDS: DocumentListField[] = [
  "id",
  "title",
  "path",
  "tags",
  "updatedAt",
  "url",
];

export const RECENT_DOCUMENT_FIELDS = [
  "id",
  "title",
  "tags",
  "updatedAt",
  "url",
  "collectionId",
  "parentDocumentId",
] as const;
export type RecentDocumentField = (typeof RECENT_DOCUMENT_FIELDS)[number];
export const DEFAULT_RECENT_DOCUMENT_FIELDS: RecentDocumentField[] = [
  "id",
  "title",
  "tags",
  "updatedAt",
  "url",
];

export function encodeCursor(value: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

export function decodeCursor(value: string): Record<string, unknown> | null {
  try {
    const decoded: unknown = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    return decoded !== null && typeof decoded === "object" && !Array.isArray(decoded)
      ? (decoded as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

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

export type TreeDocumentNode = DocumentMeta & { children: TreeDocumentNode[] };
export type FlatDocumentNode = { document: DocumentMeta; path: string; depth: number };

/** Per-server tool context: services, host options, and the URL/shape/audit
 * helpers every tool group shares. */
export function createToolContext(
  services: Services,
  { publicUrl, writer, audit, notify, identity, uploads }: McpServerOptions,
) {
  const { documents, documentTree, documentQueries, collections, comments, workspaces, snapshots } =
    services;


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

  return {
    services,
    documents,
    documentTree,
    documentQueries,
    collections,
    comments,
    workspaces,
    snapshots,
    publicUrl,
    writer,
    audit,
    notify,
    identity,
    uploads,
    documentUrl,
    collectionUrl,
    commentUrl,
    publicDoc,
    readableSearchSnippet,
    explainSearchHit,
    flattenDocumentTree,
    listedDocument,
    recentDocument,
    publicCollection,
    publicComment,
    logAudit,
    editBody,
    writeResult,
    resolveWorkspace,
  };
}

export type ToolContext = ReturnType<typeof createToolContext>;
