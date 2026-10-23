import { and, eq, isNull, sql } from "drizzle-orm";
import {
  collections,
  documents,
  documentTypes,
  templates,
  typeFields,
  type Actor,
  type Database,
  type FieldKind,
  type TemplateDefault,
} from "@tandem/db";
import type { AuthorInfo } from "@tandem/editor";
import { NotFoundError } from "../errors.js";
import { insertDocument } from "./documents.js";
import { normalizeDefault } from "./template-defaults.js";
import { assertCanDefine, shortId } from "./types.js";

interface StarterType {
  name: string;
  fields: Array<{ key: string; label: string; kind: FieldKind; options?: string[] }>;
}

interface StarterTemplate {
  name: string;
  type: string;
  title: string;
  markdown: string;
  /** By field key; literals as a person would type them (option labels). */
  defaults: Record<string, TemplateDefault>;
  /** Child pages, each with the template new pages under it start from. */
  children: Array<{ title: string; defaultTemplate: string }>;
}

/** Aliases are free text: a multi_select would need an admin for every new alias. */
export const STARTER_TYPES: readonly StarterType[] = [
  {
    name: "Meeting",
    fields: [
      { key: "date", label: "Date", kind: "date" },
      { key: "attendees", label: "Attendees", kind: "doc_list" },
      { key: "status", label: "Status", kind: "select", options: ["Planned", "Done"] },
    ],
  },
  {
    name: "Project",
    fields: [
      { key: "status", label: "Status", kind: "select", options: ["Idea", "Active", "Paused", "Killed"] },
      { key: "next_review", label: "Next review", kind: "date" },
      { key: "next_action", label: "Next action", kind: "text" },
    ],
  },
  {
    name: "Person",
    fields: [
      { key: "email", label: "Email", kind: "text" },
      { key: "affiliation", label: "Affiliation", kind: "text" },
      { key: "aliases", label: "Aliases", kind: "text" },
    ],
  },
];

/** In creation order: a child's default template is created before it. */
export const STARTER_TEMPLATES: readonly StarterTemplate[] = [
  {
    name: "Meeting",
    type: "Meeting",
    title: "Meeting {{date}}",
    markdown:
      "<!-- live-section: open_from_last_time -->\n\n<!-- live-section: since_last_meeting -->\n\n## Agenda\n\n## Notes\n\n## Decisions\n\n## Actions\n",
    defaults: {
      date: { kind: "today" },
      attendees: { kind: "from_previous_sibling" },
      status: { kind: "value", value: "Planned" },
    },
    children: [],
  },
  {
    name: "Project",
    type: "Project",
    title: "New project",
    markdown: "## Overview\n\n## Next steps\n\n<!-- live-section: open_tasks_here -->\n",
    defaults: { status: { kind: "value", value: "Idea" } },
    children: [{ title: "Meetings", defaultTemplate: "Meeting" }],
  },
  { name: "Person", type: "Person", title: "New person", markdown: "", defaults: {}, children: [] },
];

/** What a run added, by name; empty when everything was already there. */
export interface StarterKitResult {
  types: string[];
  templates: string[];
}

/**
 * Add the starter types and templates, keeping whatever already exists: a
 * type with a starter name is reused and only gains missing fields (by key),
 * and a template with a starter name is left alone. So a second run, or one
 * after a crash, converges on the same workspace. Runs in the caller's
 * transaction; the lock keeps two concurrent runs from both adding.
 */
export async function seedStarterKit(
  db: Database,
  actor: Actor,
  author: AuthorInfo,
  workspaceId: string,
  collectionId: string,
): Promise<StarterKitResult> {
  await assertCanDefine(db, actor, workspaceId);
  const [col] = await db
    .select({ workspaceId: collections.workspaceId })
    .from(collections)
    .where(and(eq(collections.id, collectionId), isNull(collections.deletedAt)));
  if (col?.workspaceId !== workspaceId) throw new NotFoundError("collection not found");
  await db.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`starter-kit:${workspaceId}`}))`);

  const createdBy = actor.kind === "user" ? actor.userId : "system";
  const added: StarterKitResult = { types: [], templates: [] };
  const typed = new Map<string, { typeId: string; fields: Array<typeof typeFields.$inferSelect> }>();
  for (const spec of STARTER_TYPES) {
    let [type] = await db
      .select({ id: documentTypes.id })
      .from(documentTypes)
      .where(and(eq(documentTypes.workspaceId, workspaceId), sql`lower(${documentTypes.name}) = lower(${spec.name})`));
    if (!type) {
      [type] = await db
        .insert(documentTypes)
        .values({ workspaceId, name: spec.name, createdBy })
        .returning({ id: documentTypes.id });
      added.types.push(spec.name);
    }
    const fields = await db
      .select()
      .from(typeFields)
      .where(and(eq(typeFields.typeId, type!.id), isNull(typeFields.retiredAt)));
    let position = Math.max(0, ...fields.map((f) => f.position));
    for (const field of spec.fields) {
      if (fields.some((f) => f.key.toLowerCase() === field.key)) continue;
      const [row] = await db
        .insert(typeFields)
        .values({
          id: shortId("f"),
          workspaceId,
          typeId: type!.id,
          key: field.key,
          label: field.label,
          kind: field.kind,
          position: ++position,
          options: (field.options ?? []).map((label) => ({ id: shortId("o"), label })),
          createdBy,
        })
        .returning();
      fields.push(row!);
    }
    typed.set(spec.name, { typeId: type!.id, fields });
  }

  const existing = await db
    .select({ id: templates.documentId, name: templates.name })
    .from(templates)
    .innerJoin(documents, eq(documents.id, templates.documentId))
    .where(and(eq(templates.workspaceId, workspaceId), isNull(documents.deletedAt), isNull(documents.archivedAt)));
  const templateIds = new Map(existing.map((t) => [t.name.toLowerCase(), t.id]));
  for (const spec of STARTER_TEMPLATES) {
    if (templateIds.has(spec.name.toLowerCase())) continue;
    const { typeId, fields } = typed.get(spec.type)!;
    const defaults: Record<string, TemplateDefault> = {};
    for (const [key, input] of Object.entries(spec.defaults)) {
      const field = fields.find((f) => f.key.toLowerCase() === key);
      // A reused field of another kind keeps no default rather than failing the kit.
      const normalized = field ? normalizeDefault(field, input) : null;
      if (field && normalized && "value" in normalized && normalized.value) defaults[field.id] = normalized.value;
    }
    const doc = await insertDocument(db, { collectionId, title: spec.title, markdown: spec.markdown }, author);
    await db
      .insert(templates)
      .values({ documentId: doc.id, workspaceId, name: spec.name, createdBy, defaultTypeId: typeId, defaults });
    for (const child of spec.children) {
      await insertDocument(
        db,
        {
          collectionId,
          parentDocumentId: doc.id,
          title: child.title,
          defaultTemplateId: templateIds.get(child.defaultTemplate.toLowerCase()) ?? null,
        },
        author,
      );
    }
    templateIds.set(spec.name.toLowerCase(), doc.id);
    added.templates.push(spec.name);
  }
  return added;
}
