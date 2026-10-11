import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { json, notFound, type ToolContext } from "../shared.js";

/** Comment threads. */
export function registerCommentTools(server: McpServer, ctx: ToolContext): void {
  const { services, documents, comments, notify, identity, publicComment, logAudit } = ctx;

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
}
