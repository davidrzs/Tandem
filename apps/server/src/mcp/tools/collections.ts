import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { descriptionSchema, nameSchema } from "@tandem/core";
import { json, type ToolContext } from "../shared.js";

/** Collection listing and creation. */
export function registerCollectionTools(server: McpServer, ctx: ToolContext): void {
  const { collections, publicCollection, logAudit } = ctx;

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
        name: nameSchema,
        slug: nameSchema,
        description: descriptionSchema.optional(),
        workspaceId: z.string().uuid().optional(),
      },
    },
    async (args) => {
      const collection = await collections.create(args);
      logAudit("create_collection", { workspaceId: collection.workspaceId, title: collection.name });
      return json(publicCollection(collection));
    },
  );
}
