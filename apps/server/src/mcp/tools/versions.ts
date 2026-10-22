import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as Y from "yjs";
import { z } from "zod";
import {
  blameSpans,
  COLLAB_FIELD,
  getAuthors,
  jsonToMarkdown,
  schema,
  stateToJSON,
  UNKNOWN_AUTHOR,
} from "@tandem/editor";
import { json, notFound, type ToolContext } from "../shared.js";

/** Version history and authorship. */
export function registerVersionTools(server: McpServer, ctx: ToolContext): void {
  const { documents, snapshots } = ctx;

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
      const spans: Array<{
        author: string;
        ai: boolean;
        agent?: string;
        at: string | null;
        text: string;
      }> = [];
      for (const s of blameSpans(ydoc.getXmlFragment(COLLAB_FIELD))) {
        const a = authors.get(s.clientId) ?? UNKNOWN_AUTHOR;
        const text = pmDoc.textBetween(Math.min(s.from, size), Math.min(s.to, size), "\n", "");
        if (!text.trim()) continue; // pure structure (open/close tags)
        const last = spans[spans.length - 1];
        // Merge consecutive spans by the same identity so prose reads as runs.
        if (last && last.author === a.name && last.ai === a.ai && last.agent === a.agent) {
          last.text += text;
        } else {
          spans.push({
            author: a.name,
            ai: a.ai,
            ...(a.agent ? { agent: a.agent } : {}),
            at: a.at ? new Date(a.at).toISOString() : null,
            text,
          });
        }
      }
      const contributors = new Map<
        string,
        { userId: string; name: string; ai: boolean; agent?: string; lastEditAt: number }
      >();
      for (const a of authors.values()) {
        const key = `${a.userId}:${a.ai}:${a.agent ?? ""}`;
        const prev = contributors.get(key);
        if (!prev || a.at > prev.lastEditAt) {
          contributors.set(key, {
            userId: a.userId,
            name: a.name,
            ai: a.ai,
            ...(a.agent ? { agent: a.agent } : {}),
            lastEditAt: a.at,
          });
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
}
