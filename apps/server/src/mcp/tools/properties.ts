import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { DocumentWriteDeniedError, nameSchema, propertyPatchShape, type FieldView } from "@tandem/core";
import { json, notFound, READ_ONLY_MESSAGE, toolError, type ToolContext } from "../shared.js";

const publicField = (f: FieldView) => ({
  key: f.key,
  label: f.label,
  kind: f.kind,
  ...(f.options.some((o) => !o.retired)
    ? { options: f.options.filter((o) => !o.retired).map((o) => o.label) }
    : {}),
  ...(f.aliases.length > 0 ? { aliases: f.aliases } : {}),
  id: f.id,
});

/** Page types, their fields, and per-field property writes. */
export function registerPropertyTools(server: McpServer, ctx: ToolContext): void {
  const { services, documents, writer, publicProperties, documentUrl, logAudit, resolveWorkspace } = ctx;

  server.registerTool(
    "list_types",
    {
      title: "List types",
      description:
        "Page types (Meeting, Project, ...) with their fields in order. A page has at " +
        "most one type; its fields are the properties set_properties accepts for it.",
      inputSchema: { workspaceId: z.string().uuid().optional() },
    },
    async ({ workspaceId }) => {
      const ws = await resolveWorkspace(workspaceId);
      if ("error" in ws) return ws.error;
      const types = await services.types.listTypes(ws.id);
      return json(types.map((t) => ({ id: t.id, name: t.name, fields: t.fields.map(publicField) })));
    },
  );

  server.registerTool(
    "list_fields",
    {
      title: "List fields",
      description:
        "Every property field: each type's, and the ad-hoc fields (type null) any " +
        "page can hold. Keys and option labels match case-insensitively in " +
        "set_properties; aliases are old keys that still work. Only a workspace " +
        "owner or admin can define fields.",
      inputSchema: {
        workspaceId: z.string().uuid().optional(),
        type: nameSchema.optional().describe("Only this type's fields (name or id)."),
      },
    },
    async ({ workspaceId, type }) => {
      const ws = await resolveWorkspace(workspaceId);
      if ("error" in ws) return ws.error;
      const wanted = type?.trim().toLowerCase();
      const fields = (await services.types.listFields(ws.id)).filter(
        (f) => !wanted || f.typeId === type || f.typeName?.toLowerCase() === wanted,
      );
      return json(fields.map((f) => ({ ...publicField(f), type: f.typeName })));
    },
  );

  server.registerTool(
    "set_properties",
    {
      title: "Set properties",
      description:
        "Change a page's properties with a patch by field key; fields you leave out " +
        "keep their values. set replaces a value (a list field takes the whole list; " +
        "null clears), unset clears, add and remove change list fields. Select values " +
        "are option labels; page references are ids or urls. An unknown key is an " +
        "error listing the fields the page can take. Returns the committed properties.",
      inputSchema: { id: z.string().uuid(), ...propertyPatchShape },
    },
    async ({ id, ...patch }) => {
      if (!(await documents.get(id))) return notFound("document");
      const ops = await services.types.planPatch(id, patch);
      let sessionId: number | null = null;
      try {
        if (writer) sessionId = await writer.setProperties(id, ops);
        else await documents.editProperties(id, ops);
      } catch (err) {
        if (err instanceof DocumentWriteDeniedError) return toolError(READ_ONLY_MESSAGE);
        throw err;
      }
      const doc = await documents.get(id);
      if (!doc) return notFound("document");
      const keys = [
        ...Object.keys(patch.set ?? {}),
        ...(patch.unset ?? []),
        ...Object.keys(patch.add ?? {}),
        ...Object.keys(patch.remove ?? {}),
      ];
      if (ops.length > 0) logAudit("set_properties", doc, `"${doc.title}": ${keys.join(", ")}`, sessionId);
      return json({ id, url: documentUrl(id), ...publicProperties(await services.types.view(id)) });
    },
  );
}
