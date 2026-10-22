import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { documentUpdateShape, markdownSchema, titleSchema } from "@tandem/core";
import { appendMarkdown, insertAfterHeading, replaceSection, replaceText } from "@tandem/editor";
import { frontMatterError, toolError, type ToolContext } from "../shared.js";

/** Metadata updates and targeted body edits. */
export function registerEditTools(server: McpServer, ctx: ToolContext): void {
  const { documents, notify, logAudit, editBody, writeResult } = ctx;

  server.registerTool(
    "update_document",
    {
      title: "Update document metadata",
      description:
        "Set a document's title and/or tags (labels for organization and search). " +
        "Body edits use the targeted edit tools (edit_document, " +
        "insert_after_heading, replace_section, append_section) so that only what " +
        "actually changed is attributed to this agent.",
      inputSchema: documentUpdateShape,
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
        old_string: markdownSchema.min(1),
        new_string: markdownSchema,
        replace_all: z.boolean().optional(),
      },
    },
    async ({ id, old_string, new_string, replace_all }) =>
      frontMatterError(new_string) ??
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
        heading: titleSchema.min(1),
        markdown: markdownSchema.min(1),
      },
    },
    async ({ id, heading, markdown }) =>
      frontMatterError(markdown) ??
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
        heading: titleSchema.min(1),
        markdown: markdownSchema,
      },
    },
    async ({ id, heading, markdown }) =>
      frontMatterError(markdown) ??
      editBody("replace_section", id, (md) => replaceSection(md, heading, markdown)),
  );

  server.registerTool(
    "append_section",
    {
      title: "Append section",
      description:
        "Append markdown to the end of a document. Block-scoped, so it merges " +
        "cleanly with concurrent human edits via the live collaborative document.",
      inputSchema: { id: z.string().uuid(), markdown: markdownSchema.min(1) },
    },
    async ({ id, markdown }) =>
      frontMatterError(markdown) ?? editBody("append_section", id, (md) => appendMarkdown(md, markdown)),
  );
}
