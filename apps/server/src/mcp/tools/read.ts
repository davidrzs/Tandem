import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { documentSearchShape, NotFoundError, tagSchema } from "@tandem/core";
import {
  type DocumentListField,
  type RecentDocumentField,
  type FlatDocumentNode,
  json,
  toolError,
  notFound,
  encodeCursor,
  decodeCursor,
  DOCUMENT_LIST_FIELDS,
  DEFAULT_DOCUMENT_LIST_FIELDS,
  RECENT_DOCUMENT_FIELDS,
  DEFAULT_RECENT_DOCUMENT_FIELDS,
  type ToolContext,
} from "../shared.js";

/** Document listing, reading, and search. */
export function registerReadTools(server: McpServer, ctx: ToolContext): void {
  const {
    services,
    documents,
    documentTree,
    documentQueries,
    publicDoc,
    publicProperties,
    readableSearchSnippet,
    explainSearchHit,
    flattenDocumentTree,
    listedDocument,
    recentDocument,
  } = ctx;

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
        const sub = await documentTree.subtree(parentDocumentId, pageDepth).catch((error: unknown) => {
          if (error instanceof NotFoundError) return null;
          throw error;
        });
        if (!sub || sub.root.collectionId !== collectionId) return notFound("document");
        entries = flattenDocumentTree(sub.nodes, sub.ancestry);
      } else {
        entries = flattenDocumentTree(await documentTree.tree(collectionId, pageDepth));
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
        "canonical url by id, plus its type and properties beside the markdown " +
        "(display values keyed by field; page references as {id, title, url}) " +
        "and any stored values that fail their field as property_issues.",
      inputSchema: { id: z.string().uuid() },
    },
    async ({ id }) => {
      const doc = await documents.get(id);
      if (!doc) return notFound("document");
      return json({
        ...publicDoc(doc),
        ...publicProperties(await services.types.view(id)),
        markdown: documents.toMarkdown(doc),
      });
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
        ...documentSearchShape,
        excludeDocumentIds: z.array(z.string().uuid()).max(50).optional(),
        excludeTags: z.array(tagSchema.min(1)).max(20).optional(),
      },
    },
    async ({ query, collectionId, limit, tag, excludeDocumentIds, excludeTags }) => {
      const hits = await documentQueries.search(query, {
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
      const rows = await documentQueries.recent({
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
}

/** Archive, tag, backlink, member, and task listings. */
export function registerDiscoveryTools(server: McpServer, ctx: ToolContext): void {
  const { documents, documentTree, documentQueries, workspaces, documentUrl, publicDoc } = ctx;

  server.registerTool(
    "list_archived",
    {
      title: "List archived documents",
      description: "Archived subtree roots in a collection (restorable).",
      inputSchema: { collectionId: z.string().uuid() },
    },
    async ({ collectionId }) => json((await documentTree.listArchived(collectionId)).map(publicDoc)),
  );

  server.registerTool(
    "list_tags",
    {
      title: "List tags",
      description: "Every tag in use across documents you can read, with counts.",
      inputSchema: {},
    },
    async () => json(await documentQueries.listTags()),
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
      return json((await documentQueries.backlinks(id)).map(publicDoc));
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
        (await documentQueries.listMyTodos()).map((task) => ({
          ...task,
          url: documentUrl(task.documentId),
        })),
      ),
  );

  server.registerTool(
    "open_tasks",
    {
      title: "Open tasks",
      description:
        "Unchecked task items, each with its document and a stable blockId. " +
        "Give exactly one of: documentId (that page), subtreeOf (that page and " +
        "everything under it), or previousSiblingOf (the page before it in its " +
        "series: same parent and type, ordered by the type's first date, e.g. " +
        "the previous meeting).",
      inputSchema: {
        documentId: z.string().uuid().optional(),
        subtreeOf: z.string().uuid().optional(),
        previousSiblingOf: z.string().uuid().optional(),
      },
    },
    async ({ documentId, subtreeOf, previousSiblingOf }) => {
      const given = [documentId, subtreeOf, previousSiblingOf].filter((id) => id !== undefined);
      if (given.length !== 1) {
        return toolError("give exactly one of documentId, subtreeOf or previousSiblingOf");
      }
      const scope = documentId
        ? { documentId }
        : subtreeOf
          ? { subtreeOf }
          : { previousSiblingOf: previousSiblingOf! };
      try {
        const tasks = await documentQueries.openTasks(scope);
        return json(tasks.map((task) => ({ ...task, url: documentUrl(task.documentId) })));
      } catch (error) {
        if (error instanceof NotFoundError) return notFound("document");
        throw error;
      }
    },
  );
}
