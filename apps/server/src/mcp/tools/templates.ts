import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { templateVariablesSchema, type TemplateSummary, type TypeWithFields } from "@tandem/core";
import { json, type ToolContext } from "../shared.js";

/** Template listing and instantiation. */
export function registerTemplateTools(server: McpServer, ctx: ToolContext): void {
  const { services, publicDoc, publicProperties, documentUrl, logAudit } = ctx;

  /** A template's type and defaults as agents read them: field keys, option
   * labels, and expressions by name. */
  const publicTemplate = (t: TemplateSummary, types: readonly TypeWithFields[]) => {
    const type = types.find((ty) => ty.id === t.typeId);
    const defaults: Record<string, unknown> = {};
    for (const field of type?.fields ?? []) {
      const d = t.defaults[field.id];
      if (!d) continue;
      const label = (id: unknown) => field.options.find((o) => o.id === id)?.label ?? id;
      defaults[field.key] =
        d.kind !== "value"
          ? d.kind
          : { value: Array.isArray(d.value) ? d.value.map(label) : label(d.value) };
    }
    return {
      ...t,
      type: type ? { id: type.id, name: type.name } : null,
      defaults,
      url: documentUrl(t.id),
    };
  };

  server.registerTool(
    "list_templates",
    {
      title: "List templates",
      description:
        "List page templates. A template is an ordinary document (read or edit it " +
        "with the document tools at its url); its child pages are copied with it. " +
        "A template may give new pages a type and default values by field key: " +
        '{"value": ...} is a literal, "today" and "now" the moment of creation, "me" ' +
        'the creator\'s name, and "from_previous_sibling" the same field on the latest ' +
        "page of the type under the same parent (by its date field, else newest). " +
        "Templates never appear in search, backlinks, recent documents or tasks.",
      inputSchema: { workspaceId: z.string().uuid().optional() },
    },
    async ({ workspaceId }) => {
      const list = await services.templates.list(workspaceId);
      const types = new Map<string, TypeWithFields[]>();
      for (const id of new Set(list.map((t) => t.workspaceId))) types.set(id, await services.types.listTypes(id));
      return json(list.map((t) => publicTemplate(t, types.get(t.workspaceId)!)));
    },
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
        "are listed in missing. A typed template gives the page its type and default " +
        "values (the date default follows {{date}}); the returned document carries " +
        "the committed properties. dryRun returns the expanded pages and creates nothing.",
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
      const template = plan.template
        ? publicTemplate(plan.template, await services.types.listTypes(plan.template.workspaceId))
        : null;
      return json({
        ...plan,
        template,
        document: document
          ? { ...publicDoc(document), ...publicProperties(await services.types.view(document.id)) }
          : null,
      });
    },
  );
}
