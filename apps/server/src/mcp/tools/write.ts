import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { documentCreateShape, documentMoveShape, nameSchema, propertyPatchShape } from "@tandem/core";
import { frontMatterError, json, type ToolContext } from "../shared.js";

/** Document creation. */
export function registerCreateTools(server: McpServer, ctx: ToolContext): void {
  const { services, documents, publicDoc, publicProperties, logAudit } = ctx;

  server.registerTool(
    "create_document",
    {
      title: "Create document",
      description:
        "Create a document in a collection. Body is markdown without YAML front " +
        "matter; parentDocumentId nests it. type (name or id, see list_types) makes " +
        "it a page of that type; properties sets initial values by field key, as " +
        "set_properties' set does. Returns its absolute canonical url.",
      inputSchema: {
        ...documentCreateShape,
        type: nameSchema.optional(),
        properties: propertyPatchShape.set,
      },
    },
    async ({ type, properties, ...args }) => {
      const rejected = frontMatterError(args.markdown);
      if (rejected) return rejected;
      const planned = await services.types.planCreate(args.collectionId, { type, properties });
      const doc = await documents.create({ ...args, typeId: planned.typeId, properties: planned.ops });
      logAudit("create_document", doc);
      if (!type && !properties) return json(publicDoc(doc));
      return json({ ...publicDoc(doc), ...publicProperties(await services.types.view(doc.id)) });
    },
  );
}

/** Reparenting, archiving, and restoring. */
export function registerLifecycleTools(server: McpServer, ctx: ToolContext): void {
  const { documentTree, logAudit, writeResult } = ctx;

  server.registerTool(
    "move_document",
    {
      title: "Move document",
      description:
        "Reparent a document. parentDocumentId null moves it to the collection root.",
      inputSchema: documentMoveShape,
    },
    async ({ id, parentDocumentId, position }) => {
      const doc = await documentTree.move(id, { parentDocumentId, position });
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
      const doc = await documentTree.archive(id);
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
      const doc = await documentTree.restore(id);
      if (doc) logAudit("restore_document", doc);
      return writeResult(id, doc);
    },
  );
}
