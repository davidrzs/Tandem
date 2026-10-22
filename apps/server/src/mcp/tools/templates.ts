import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { templateVariablesSchema } from "@tandem/core";
import { json, type ToolContext } from "../shared.js";

/** Template listing and instantiation. */
export function registerTemplateTools(server: McpServer, ctx: ToolContext): void {
  const { services, publicDoc, documentUrl, logAudit } = ctx;

  server.registerTool(
    "list_templates",
    {
      title: "List templates",
      description:
        "List page templates. A template is an ordinary document (read or edit it " +
        "with the document tools at its url); its child pages are copied with it. " +
        "Templates never appear in search, backlinks, recent documents or tasks.",
      inputSchema: { workspaceId: z.string().uuid().optional() },
    },
    async ({ workspaceId }) =>
      json(
        (await services.templates.list(workspaceId)).map((t) => ({ ...t, url: documentUrl(t.id) })),
      ),
  );

  server.registerTool(
    "create_from_template",
    {
      title: "Create from template",
      description:
        "Create a page (plus up to 3 levels of the template's child pages) from a " +
        "template. Omit templateId to use the default template of the target folder " +
        "or collection, as the app's + New does; with no default the page is blank. " +
        "Built-in variables {{date}} (YYYY-MM-DD), {{title}}, {{me}} and {{parent}} " +
        "are filled in; any other {{name}} is a prompt answered through variables " +
        "(a variable also overrides a built-in). Unanswered prompts become empty and " +
        "are listed in missing. dryRun returns the expanded pages and creates nothing.",
      inputSchema: {
        templateId: z.string().uuid().optional(),
        collectionId: z.string().uuid(),
        parentId: z.string().uuid().optional(),
        variables: templateVariablesSchema.optional(),
        dryRun: z.boolean().optional(),
      },
    },
    async ({ templateId, collectionId, parentId, variables, dryRun }) => {
      const { document, ...plan } = await services.templates.instantiate({
        templateId,
        collectionId,
        parentDocumentId: parentId ?? null,
        variables,
        dryRun,
      });
      if (document) {
        logAudit(
          "create_from_template",
          document,
          plan.template
            ? `"${document.title}" from template "${plan.template.name}" (version ${plan.template.version})`
            : `"${document.title}" (blank)`,
        );
      }
      return json({ ...plan, document: document ? publicDoc(document) : null });
    },
  );
}
