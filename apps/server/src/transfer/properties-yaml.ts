import { isListKind, parseFieldInput, type FieldView, type TypeService } from "@tandem/core";
import { FIELD_KINDS, type FieldKind } from "@tandem/db";
import { diffProperties, type PropertyOp } from "@tandem/editor";
import { z } from "zod";
import { isReservedKey, TANDEM_ID_KEY, TANDEM_TYPE_KEY } from "./markdown-zip.js";

/**
 * Page properties in a markdown zip. YAML exists only here: export writes a
 * page's values as front matter a person can read and edit in any editor
 * (option labels, `"[[Title]]"` for pages) and describes the fields in a
 * sidecar; import turns front matter back into per-field patches, reading
 * the sidecar when the zip has one and otherwise inferring one kind per key
 * across the whole vault (Obsidian's rule: one type per property name).
 */

export const SIDECAR_PATH = "_tandem/fields.json";

const sidecarSchema = z.object({
  version: z.literal(1),
  types: z.array(z.object({ id: z.string(), name: z.string().trim().min(1) })),
  fields: z.array(
    z.object({
      id: z.string(),
      key: z.string().trim().min(1),
      label: z.string(),
      kind: z.enum(FIELD_KINDS),
      /** The type's name; null for an ad-hoc field. */
      type: z.string().nullable(),
      options: z.array(z.object({ id: z.string(), label: z.string() })),
    }),
  ),
});
export type FieldsSidecar = z.infer<typeof sidecarSchema>;
type SidecarField = FieldsSidecar["fields"][number];

/** A live field as `TypeService.listFields` returns it. */
export type WorkspaceField = FieldView & { typeName: string | null };

export function buildSidecar(types: Array<{ id: string; name: string }>, fields: WorkspaceField[]): FieldsSidecar {
  return {
    version: 1,
    types: types.map((t) => ({ id: t.id, name: t.name })),
    fields: fields.map((f) => ({
      id: f.id,
      key: f.key,
      label: f.label,
      kind: f.kind,
      type: f.typeName,
      options: f.options.filter((o) => !o.retired).map((o) => ({ id: o.id, label: o.label })),
    })),
  };
}

/** The sidecar, or null when the file isn't one. */
export function parseSidecar(text: string): FieldsSidecar | null {
  try {
    const parsed = sidecarSchema.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// export
// ---------------------------------------------------------------------------

function displayValue(field: FieldView, stored: unknown, titleOf: (docId: string) => string | null): unknown {
  const label = (id: unknown) => field.options.find((o) => o.id === id)?.label;
  const link = (id: unknown) => {
    const title = titleOf(String(id));
    return title === null ? undefined : `[[${title.trim() || "Untitled"}]]`;
  };
  const each = (display: (value: unknown) => unknown) => {
    const out = [stored].flat().map(display).filter((v) => v !== undefined);
    return out.length > 0 ? out : undefined;
  };
  switch (field.kind) {
    case "select":
      return label(stored);
    case "multi_select":
      return each(label);
    case "doc":
      return link(stored);
    case "doc_list":
      return each(link);
    default:
      return stored;
  }
}

/**
 * A page's front matter: its `tandem-id`, its `tandem-type`, its type's
 * fields in order, its other fields alphabetically, then its tags. Every
 * page of a workspace with fields carries its id, so re-importing the
 * export updates those pages instead of copying the untyped ones; a
 * workspace without fields exports only tags, the same bytes as before
 * properties existed. Fields with a reserved key (`tags`, `tandem-id`, ...)
 * are left out; the caller reports them.
 */
export function exportFrontMatter(
  page: {
    id: string;
    typeId: string | null;
    typeName: string | null;
    tags: string[];
    /** The validated projection: option ids, document ids. */
    properties: Record<string, unknown>;
  },
  fields: readonly WorkspaceField[],
  titleOf: (docId: string) => string | null,
): Record<string, unknown> {
  const own = fields.filter((f) => page.typeId !== null && f.typeId === page.typeId);
  const others = fields
    .filter((f) => !own.includes(f) && f.id in page.properties)
    .sort((a, b) => a.key.localeCompare(b.key));
  const values: Record<string, unknown> = {};
  for (const f of [...own, ...others]) {
    if (isReservedKey(f.key) || !(f.id in page.properties)) continue;
    const value = displayValue(f, page.properties[f.id], titleOf);
    if (value !== undefined) values[f.key] = value;
  }
  const typed = page.typeName !== null || fields.length > 0;
  return {
    ...(typed ? { [TANDEM_ID_KEY]: page.id } : {}),
    ...(page.typeName ? { [TANDEM_TYPE_KEY]: page.typeName } : {}),
    ...values,
    ...(page.tags.length > 0 ? { tags: page.tags } : {}),
  };
}

// ---------------------------------------------------------------------------
// import: inference
// ---------------------------------------------------------------------------

const LINK = /^\[\[([^\]]+)\]\]$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const DATETIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})?$/;

const isEmpty = (value: unknown) =>
  value == null || value === "" || (Array.isArray(value) && value.length === 0);

function scalarKind(value: unknown): FieldKind {
  if (typeof value === "boolean") return "checkbox";
  if (typeof value === "number") return Number.isFinite(value) ? "number" : "text";
  if (typeof value !== "string") return "json";
  const s = value.trim();
  if (LINK.test(s)) return "doc";
  if (DATE.test(s) && !Number.isNaN(Date.parse(s))) return "date";
  if (DATETIME.test(s) && !Number.isNaN(Date.parse(s))) return "datetime";
  return "text";
}

/** The kind one YAML value asks for, or null when it holds nothing. */
function valueKind(value: unknown): FieldKind | null {
  if (!Array.isArray(value)) return isEmpty(value) ? null : scalarKind(value);
  const kinds = new Set(value.filter((v) => !isEmpty(v)).map(scalarKind));
  if (kinds.size === 0) return null;
  if (kinds.has("json")) return "json";
  if (kinds.has("doc")) return kinds.size === 1 ? "doc_list" : "json";
  return "multi_select";
}

// Pairs that hold the same values: a single page or label next to lists of
// them, a date next to date-times.
const JOINS: Array<[FieldKind, FieldKind, FieldKind]> = [
  ["doc", "doc_list", "doc_list"],
  ["text", "multi_select", "multi_select"],
  ["date", "datetime", "datetime"],
];

export interface InferredField {
  /** The key as the first note spelled it. */
  key: string;
  kind: FieldKind;
  /** Option labels for a multi_select, in first-seen order. */
  options: string[];
  /** The kinds the notes disagreed on, when no kind holds them all. */
  mixed: FieldKind[] | null;
}

/** One kind per key (matched case-insensitively) across every note. Values
 * that disagree become text, or json when some of them are lists or maps,
 * so nothing is lost. */
export function inferFields(notes: Iterable<Record<string, unknown>>): Map<string, InferredField> {
  const seen = new Map<string, { key: string; kinds: Set<FieldKind>; labels: Map<string, string> }>();
  for (const properties of notes) {
    for (const [key, value] of Object.entries(properties)) {
      const k = key.trim().toLowerCase();
      let entry = seen.get(k);
      if (!entry) seen.set(k, (entry = { key: key.trim(), kinds: new Set(), labels: new Map() }));
      const kind = valueKind(value);
      if (!kind) continue;
      entry.kinds.add(kind);
      if (kind === "text" || kind === "multi_select") {
        for (const label of [value].flat().map((v) => String(v).trim())) {
          if (label && !entry.labels.has(label.toLowerCase())) entry.labels.set(label.toLowerCase(), label);
        }
      }
    }
  }
  const out = new Map<string, InferredField>();
  for (const [k, { key, kinds, labels }] of seen) {
    const all = [...kinds];
    const join = all.length === 2 ? JOINS.find(([a, b]) => kinds.has(a) && kinds.has(b)) : undefined;
    const mixed = all.length > 1 && !join;
    const kind = join
      ? join[2]
      : mixed
        ? all.some((c) => c === "json" || isListKind(c))
          ? "json"
          : "text"
        : (all[0] ?? "text");
    out.set(k, { key, kind, options: kind === "multi_select" ? [...labels.values()] : [], mixed: mixed ? all : null });
  }
  return out;
}

// ---------------------------------------------------------------------------
// import: values
// ---------------------------------------------------------------------------

type ImportField = Pick<FieldView, "id" | "key" | "kind" | "options">;

/** `[[Note]]`, `[[Note|alias]]` and `[[Note#Heading]]` all name Note. */
function linkTarget(value: string): string | null {
  const m = LINK.exec(value.trim());
  return m ? m[1]!.split("|")[0]!.split("#")[0]!.trim() : null;
}

function selectLabels(raw: unknown): string[] {
  return [raw]
    .flat()
    .filter((v) => typeof v === "string" || typeof v === "number" || typeof v === "boolean")
    .map((v) => String(v).trim())
    .filter(Boolean);
}

/** A front-matter value in its stored form for `field` (option ids, page
 * ids, ISO dates), or null when nothing in it fits; `problems` says what
 * was left out. */
export function importValue(
  field: ImportField,
  raw: unknown,
  resolveLink: (title: string) => string | null,
): { value: unknown; problems: string[] } {
  if (field.kind === "json") return { value: isEmpty(raw) ? null : raw, problems: [] };
  const list = isListKind(field.kind);
  const items = [raw].flat().filter((v) => !isEmpty(v));
  if (!list && items.length > 1) return { value: null, problems: ["expected one value, not a list"] };
  const values: unknown[] = [];
  const problems: string[] = [];
  for (const item of items) {
    let input = item;
    if (field.kind === "doc" || field.kind === "doc_list") {
      const target = typeof item === "string" ? linkTarget(item) : null;
      if (target !== null) {
        input = resolveLink(target);
        if (!input) {
          problems.push(`unresolved link [[${target}]]`);
          continue;
        }
      }
    } else if (field.kind === "select" || field.kind === "multi_select") {
      input = selectLabels(item)[0] ?? item;
    } else if (field.kind === "datetime" && typeof item === "string" && DATE.test(item.trim())) {
      // A date among date-times is that day's start in UTC, so it keeps its day.
      input = `${item.trim()}T00:00:00Z`;
    }
    const parsed = parseFieldInput({ ...field, retiredAt: null }, input);
    if ("error" in parsed) problems.push(`${JSON.stringify(item)}: ${parsed.error}`);
    else if (!values.includes(parsed.value)) values.push(parsed.value);
  }
  return { value: list ? (values.length > 0 ? values : null) : (values[0] ?? null), problems };
}

// ---------------------------------------------------------------------------
// import: fields
// ---------------------------------------------------------------------------

const errorText = (err: unknown) => (err instanceof Error ? err.message : "error");

/** What an import reaches outside the field registry through. */
export interface ImportIO {
  /** The ids among its input the importer can open: readable, live and not
   * templates, the same pages an export can name. */
  visiblePages(ids: string[]): Promise<string[]>;
  warn(message: string): void;
  /** Record a definition the import made, as the matching tRPC route does. */
  audit(action: string, detail: string): Promise<void>;
}

/**
 * The workspace's fields as one import sees them. A front-matter key maps
 * to the field the sidecar names by id when it exists here, else (by key or
 * old key) to the page type's field, a field the page already holds, or an
 * ad-hoc field; when none matches, the import defines one with the kind the
 * sidecar or the vault gives it. Defining fields and types needs a
 * workspace owner or admin; otherwise the values are reported, not
 * imported.
 */
export class ImportFields {
  private readonly typeIds = new Map<string, Promise<string | null>>();
  private readonly created = new Map<string, Promise<FieldView | null>>();
  private readonly optionsDenied = new Set<string>();

  private constructor(
    private readonly service: TypeService,
    private readonly workspaceId: string,
    private readonly types: Array<{ id: string; name: string }>,
    private readonly fields: FieldView[],
    private readonly sidecar: FieldsSidecar | null,
    private readonly inferred: Map<string, InferredField>,
    private readonly io: ImportIO,
  ) {}

  static async load(
    service: TypeService,
    workspaceId: string,
    sidecar: FieldsSidecar | null,
    notes: Iterable<Record<string, unknown>>,
    io: ImportIO,
  ): Promise<ImportFields> {
    const [types, fields] = await Promise.all([service.listTypes(workspaceId), service.listFields(workspaceId)]);
    return new ImportFields(
      service,
      workspaceId,
      types.map((t) => ({ id: t.id, name: t.name })),
      fields,
      sidecar,
      inferFields(notes),
      io,
    );
  }

  /** The type a `tandem-type` names: this workspace's by name, else made
   * from the sidecar with its fields in order. */
  typeId(name: string): Promise<string | null> {
    const k = name.toLowerCase();
    let found = this.typeIds.get(k);
    if (!found) this.typeIds.set(k, (found = this.resolveType(name)));
    return found;
  }

  private async resolveType(name: string): Promise<string | null> {
    const k = name.toLowerCase();
    const known = this.types.find((t) => t.name.toLowerCase() === k);
    if (known) return known.id;
    const described = this.sidecar?.types.find((t) => t.name.toLowerCase() === k);
    if (!described) {
      this.io.warn(`Imported pages of type "${name}" without a type: this workspace has no such type.`);
      return null;
    }
    let typeId: string;
    try {
      typeId = (await this.service.createType(this.workspaceId, described.name)).id;
    } catch (err) {
      this.io.warn(`Couldn't add the type "${described.name}" (${errorText(err)}), so its pages have no type.`);
      return null;
    }
    await this.io.audit("define_type", `type "${described.name}"`);
    this.types.push({ id: typeId, name: described.name });
    for (const f of this.sidecar!.fields.filter((f) => f.type?.toLowerCase() === k)) {
      await this.define(f.key, f, typeId);
    }
    return typeId;
  }

  private async fieldFor(
    page: { typeId: string | null; held: ReadonlySet<string> },
    key: string,
    define: boolean,
  ): Promise<FieldView | null> {
    const k = key.trim().toLowerCase();
    const typeName = this.types.find((t) => t.id === page.typeId)?.name.toLowerCase() ?? null;
    const named = this.sidecar?.fields.filter((f) => f.key.toLowerCase() === k) ?? [];
    const described =
      named.find((f) => (f.type?.toLowerCase() ?? null) === typeName) ?? named.find((f) => f.type === null) ?? named[0];
    const byId = described && this.fields.find((f) => f.id === described.id);
    if (byId) return byId;
    const tiers = [
      this.fields.filter((f) => page.typeId !== null && f.typeId === page.typeId),
      this.fields.filter((f) => page.held.has(f.id)),
      this.fields.filter((f) => f.typeId === null),
    ];
    for (const tier of tiers) {
      const match =
        tier.find((f) => f.key.toLowerCase() === k) ??
        tier.find((f) => f.aliases.some((a) => a.toLowerCase() === k));
      if (match) return match;
    }
    if (!define) return null;
    const inType = described?.type != null && described.type.toLowerCase() === typeName;
    return this.define(key.trim(), described ?? null, inType ? page.typeId : null);
  }

  private define(key: string, described: SidecarField | null, typeId: string | null): Promise<FieldView | null> {
    const cacheKey = `${typeId}|${key.toLowerCase()}`;
    let field = this.created.get(cacheKey);
    if (!field) this.created.set(cacheKey, (field = this.createField(key, described, typeId)));
    return field;
  }

  private async createField(key: string, described: SidecarField | null, typeId: string | null) {
    const inferred = this.inferred.get(key.toLowerCase());
    const kind = described?.kind ?? inferred?.kind ?? "text";
    let field: FieldView;
    try {
      field = await this.service.createField({
        workspaceId: this.workspaceId,
        typeId,
        key: described?.key ?? inferred?.key ?? key,
        label: described?.label,
        kind,
        options: described ? described.options.map((o) => o.label) : inferred?.options,
      });
    } catch (err) {
      this.io.warn(`Couldn't add the field "${key}" (${errorText(err)}), so its values weren't imported.`);
      return null;
    }
    this.fields.push(field);
    await this.io.audit("define_field", `field "${field.key}" (${field.kind})`);
    if (!described && inferred?.mixed) {
      this.io.warn(
        `"${field.key}" holds different kinds of values across notes (${inferred.mixed.join(", ")}), so it became a ${kind} field.`,
      );
    }
    return field;
  }

  /** The field with an option for every label `raw` uses; options are only
   * ever added. */
  private async withOptions(field: FieldView, raw: unknown): Promise<FieldView> {
    if (field.kind !== "select" && field.kind !== "multi_select") return field;
    if (this.optionsDenied.has(field.id)) return field;
    const known = new Set(field.options.map((o) => o.label.toLowerCase()));
    const missing = selectLabels(raw).filter((label) => !known.has(label.toLowerCase()));
    if (missing.length === 0) return field;
    let updated: FieldView;
    try {
      updated = await this.service.addOptions(field.id, missing);
    } catch (err) {
      this.optionsDenied.add(field.id);
      this.io.warn(`Couldn't add options to "${field.key}" (${errorText(err)}).`);
      return field;
    }
    const added = updated.options.filter((o) => !field.options.some((f) => f.id === o.id));
    if (added.length > 0) {
      await this.io.audit(
        "update_field",
        `field "${updated.key}": options; options ${added.map((o) => `added "${o.label}"`).join(", ")}`,
      );
    }
    this.fields[this.fields.indexOf(field)] = updated;
    return updated;
  }

  /**
   * The per-field patch that gives a page the values in its front matter.
   * A page already in the workspace (`current`, its projection) is diffed
   * against the fields an export writes: a key deleted from the file clears
   * its field, a field the file never could name is left alone, and so is a
   * field whose value couldn't be read. References to pages the export
   * couldn't name (unreadable, archived, trashed, templates) stay: the file
   * never showed them, so leaving them out of it removes nothing.
   */
  async patch(
    page: { typeId: string | null; current: Record<string, unknown> | null },
    values: Record<string, unknown>,
    resolveLink: (title: string) => string | null,
    where: string,
  ): Promise<PropertyOp[]> {
    const held = new Set(Object.keys(page.current ?? {}));
    const target: Record<string, unknown> = {};
    const keep = new Set<string>();
    for (const [key, raw] of Object.entries(values)) {
      const found = await this.fieldFor({ typeId: page.typeId, held }, key, !isEmpty(raw));
      if (!found) continue;
      const field = await this.withOptions(found, raw);
      const { value, problems } = importValue(field, raw, resolveLink);
      for (const problem of problems) this.io.warn(`${where}: ${key}: ${problem}`);
      if (page.current && problems.length > 0) keep.add(field.id);
      else if (value !== null) target[field.id] = value;
    }
    const current = Object.fromEntries(
      Object.entries(page.current ?? {}).filter(
        ([id]) => !keep.has(id) && this.fields.some((f) => f.id === id && !isReservedKey(f.key)),
      ),
    );
    await this.keepHiddenPages(current, target);
    return diffProperties(current, target);
  }

  private async keepHiddenPages(current: Record<string, unknown>, target: Record<string, unknown>): Promise<void> {
    const refs = new Map<string, string[]>();
    for (const [id, value] of Object.entries(current)) {
      const kind = this.fields.find((f) => f.id === id)?.kind;
      if (kind === "doc" && typeof value === "string") refs.set(id, [value]);
      if (kind === "doc_list" && Array.isArray(value)) {
        refs.set(id, value.filter((v): v is string => typeof v === "string"));
      }
    }
    const ids = [...new Set([...refs.values()].flat())];
    if (ids.length === 0) return;
    const visible = new Set(await this.io.visiblePages(ids));
    for (const [id, pageIds] of refs) {
      const hidden = pageIds.filter((p) => !visible.has(p));
      if (hidden.length === 0) continue;
      if (this.fields.find((f) => f.id === id)?.kind === "doc") {
        target[id] ??= hidden[0];
        continue;
      }
      const listed = Array.isArray(target[id]) ? (target[id] as unknown[]) : [];
      target[id] = [...listed, ...hidden.filter((p) => !listed.includes(p))];
    }
  }
}
