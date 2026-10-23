import { randomBytes } from "node:crypto";
import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import {
  collections,
  documents,
  documentTypes,
  fieldKeyAliases,
  runAsActor,
  SYSTEM,
  typeFields,
  workspaceMembers,
  type Actor,
  type Database,
  type DocumentType,
  type FieldKind,
  type FieldOption,
  type PropertyIssue,
  type TypeField,
} from "@tandem/db";
import type { PropertiesJSON, PropertyOp } from "@tandem/editor";
import { ForbiddenError, InvalidInputError, NotFoundError } from "../errors.js";
import type { PropertyPatchInput } from "../inputs.js";

/**
 * Types, fields and property values. A page's values live in its ydoc
 * (see @tandem/editor properties.ts), keyed by field id; this module owns
 * what those ids mean: the field registry, how an agent's or the app's input
 * becomes a per-field patch, and the projection that validates whatever the
 * map holds into `documents.properties`. The map is client-writable, so the
 * projection trusts nothing in it.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DOC_URL = /\/d\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:[/?#]|$)/i;
const DATETIME_INPUT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})?$/;
const DATETIME_STORED = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const TEXT_MAX = 10_000;

/** The parts of a field row the value rules read. */
export type FieldDef = Pick<TypeField, "id" | "key" | "kind" | "options" | "retiredAt">;

interface KindSpec {
  /** A list holds several values (a Y.Array in the ydoc); `any` is json. */
  shape: "scalar" | "list" | "any";
  /** Why a stored value (one element of a list) is invalid, or null. */
  invalid(value: unknown, field: FieldDef): string | null;
  /** Lenient input mapped to the stored form; the result is then checked. */
  coerce(input: unknown, field: FieldDef): unknown;
  /** Searchable text of a valid value. */
  text(value: unknown, field: FieldDef): string;
}

function optionFor(input: unknown, field: FieldDef): unknown {
  if (typeof input !== "string") return input;
  const wanted = input.trim().toLowerCase();
  const byLabel = (o: FieldOption) => o.label.toLowerCase() === wanted;
  const match =
    field.options.find((o) => o.id === input) ??
    field.options.find((o) => !o.retired && byLabel(o)) ??
    field.options.find(byLabel);
  return match?.id ?? input;
}

function refFor(input: unknown): unknown {
  if (typeof input === "object" && input !== null && "id" in input) return refFor(input.id);
  if (typeof input !== "string") return input;
  return input.match(DOC_URL)?.[1] ?? input.trim();
}

const SELECT: KindSpec = {
  shape: "scalar",
  invalid: (v, f) => (f.options.some((o) => o.id === v) ? null : `${JSON.stringify(v)} is not an option`),
  coerce: optionFor,
  text: (v, f) => f.options.find((o) => o.id === v)?.label ?? "",
};

const DOC: KindSpec = {
  shape: "scalar",
  invalid: (v) => (typeof v === "string" && UUID.test(v) ? null : "expected a document id"),
  coerce: refFor,
  text: () => "",
};

const KINDS: Record<FieldKind, KindSpec> = {
  text: {
    shape: "scalar",
    invalid: (v) =>
      typeof v !== "string"
        ? "expected text"
        : v.length > TEXT_MAX
          ? `text is longer than ${TEXT_MAX} characters`
          : null,
    coerce: (v) => (typeof v === "number" || typeof v === "boolean" ? String(v) : v),
    text: (v) => String(v),
  },
  number: {
    shape: "scalar",
    invalid: (v) => (typeof v === "number" && Number.isFinite(v) ? null : "expected a number"),
    coerce: (v) => (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v)) ? Number(v) : v),
    text: (v) => String(v),
  },
  checkbox: {
    shape: "scalar",
    invalid: (v) => (typeof v === "boolean" ? null : "expected true or false"),
    coerce: (v) => {
      const s = typeof v === "string" ? v.trim().toLowerCase() : v;
      return s === "true" || s === "yes" ? true : s === "false" || s === "no" ? false : v;
    },
    text: () => "",
  },
  date: {
    shape: "scalar",
    invalid: (v) =>
      typeof v === "string" &&
      /^\d{4}-\d{2}-\d{2}$/.test(v) &&
      !Number.isNaN(Date.parse(`${v}T00:00:00Z`)) &&
      new Date(`${v}T00:00:00Z`).toISOString().startsWith(v)
        ? null
        : "expected a date (YYYY-MM-DD)",
    coerce: (v) => (typeof v === "string" ? v.trim() : v),
    text: (v) => String(v),
  },
  datetime: {
    shape: "scalar",
    invalid: (v) =>
      typeof v === "string" && DATETIME_STORED.test(v) && !Number.isNaN(Date.parse(v))
        ? null
        : "expected a date and time (ISO 8601)",
    // A time without a zone is read as UTC.
    coerce: (v) => {
      if (typeof v !== "string" || !DATETIME_INPUT.test(v.trim())) return v;
      const s = v.trim();
      const at = new Date(/(Z|[+-]\d{2}:\d{2})$/.test(s) ? s : `${s}Z`);
      return Number.isNaN(at.getTime()) ? v : at.toISOString();
    },
    text: (v) => String(v),
  },
  select: SELECT,
  multi_select: { ...SELECT, shape: "list" },
  url: {
    shape: "scalar",
    invalid: (v) => {
      if (typeof v !== "string" || v.length > TEXT_MAX) return "expected a URL";
      try {
        return ["http:", "https:"].includes(new URL(v).protocol) ? null : "expected an http(s) URL";
      } catch {
        return "expected a URL";
      }
    },
    coerce: (v) => (typeof v === "string" ? v.trim() : v),
    text: (v) => String(v),
  },
  doc: DOC,
  doc_list: { ...DOC, shape: "list" },
  json: { shape: "any", invalid: () => null, coerce: (v) => v, text: () => "" },
};

export const isListKind = (kind: FieldKind) => KINDS[kind].shape === "list";

/** Lenient input (an option label, a page url, a date-time without a zone)
 * mapped to the stored form of one value, or why it doesn't fit the field. */
export function parseFieldInput(field: FieldDef, input: unknown): { value: unknown } | { error: string } {
  const spec = KINDS[field.kind];
  const value = spec.coerce(input, field);
  const error = spec.invalid(value, field);
  return error === null ? { value } : { error };
}

export interface PropertyProjection {
  /** Valid values by field id: option ids, document ids, ISO dates. */
  properties: Record<string, unknown>;
  propertyIssues: PropertyIssue[];
  propertiesText: string;
}

/** Lists are client-writable, so the projection bounds the work one save
 * can cost. */
const MAX_LIST_VALUES = 1000;

function distinct(values: readonly unknown[]): unknown[] {
  const seen = new Set<string>();
  return values.filter((v) => {
    const key = JSON.stringify(v);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Validate and normalize a properties map against the field registry.
 * Absent, null, "" and [] mean "no value". A value that fails its kind is
 * left out of `properties` and reported; values of retired fields and
 * retired options are kept and reported. */
export function projectProperties(
  json: PropertiesJSON,
  fields: ReadonlyMap<string, FieldDef>,
): PropertyProjection {
  const properties: Record<string, unknown> = {};
  const propertyIssues: PropertyIssue[] = [];
  const text: string[] = [];
  const issue = (fieldId: string, code: PropertyIssue["code"], message: string, value: unknown) =>
    propertyIssues.push({ fieldId, code, message, value });

  for (const [fieldId, raw] of Object.entries(json)) {
    if (raw == null || raw === "" || (Array.isArray(raw) && raw.length === 0)) continue;
    const field = fields.get(fieldId);
    if (!field) {
      issue(fieldId, "unknown_field", "no field has this id", raw);
      continue;
    }
    const spec = KINDS[field.kind];
    if (spec.shape !== "any" && (spec.shape === "list") !== Array.isArray(raw)) {
      issue(fieldId, "invalid_value", spec.shape === "list" ? "expected a list" : "expected one value", raw);
      continue;
    }
    let values = spec.shape === "list" && Array.isArray(raw) ? distinct(raw) : [raw];
    if (values.length > MAX_LIST_VALUES) {
      issue(
        fieldId,
        "invalid_value",
        `holds more than ${MAX_LIST_VALUES} values; kept the first ${MAX_LIST_VALUES}`,
        values.length,
      );
      values = values.slice(0, MAX_LIST_VALUES);
    }
    const valid = values.filter((v) => spec.invalid(v, field) === null);
    const bad = values.filter((v) => spec.invalid(v, field) !== null);
    if (bad.length > 0) {
      issue(fieldId, "invalid_value", spec.invalid(bad[0], field)!, spec.shape === "list" ? bad : raw);
    }
    if (valid.length === 0) continue;
    properties[fieldId] = spec.shape === "list" ? valid : valid[0];
    text.push(...valid.map((v) => spec.text(v, field)).filter(Boolean));
    if (field.retiredAt) issue(fieldId, "retired_field", `${field.key} is retired`, properties[fieldId]);
    const retired = valid.filter((v) => field.options.some((o) => o.id === v && o.retired));
    if (retired.length > 0) {
      issue(fieldId, "retired_option", "holds a retired option", spec.shape === "list" ? retired : retired[0]);
    }
  }
  return { properties, propertyIssues, propertiesText: text.join("\n") };
}

/** The projection columns for a properties map, reading only the fields it
 * names. Runs inside the caller's (actor-scoped) transaction. */
export async function projectionColumns(
  db: Database,
  workspaceId: string,
  json: PropertiesJSON,
): Promise<PropertyProjection> {
  const ids = Object.keys(json);
  const rows =
    ids.length === 0
      ? []
      : await db
          .select()
          .from(typeFields)
          .where(and(eq(typeFields.workspaceId, workspaceId), inArray(typeFields.id, ids)));
  return projectProperties(json, new Map(rows.map((f) => [f.id, f])));
}

export interface FieldView {
  id: string;
  workspaceId: string;
  typeId: string | null;
  key: string;
  label: string;
  kind: FieldKind;
  position: number;
  options: FieldOption[];
  retired: boolean;
  /** Keys this field had before a rename. */
  aliases: string[];
}

export interface TypeWithFields {
  id: string;
  workspaceId: string;
  name: string;
  fields: FieldView[];
}

export type DocumentRef = { id: string; title: string | null };

/** A page's properties as the app and agents read them. */
export interface PropertyView {
  type: { id: string; name: string } | null;
  /** The type's live fields in order, then any other field holding a value. */
  fields: FieldView[];
  /** Display values by field id: option labels, `{id, title}` for pages. */
  values: Record<string, unknown>;
  issues: Array<PropertyIssue & { key: string | null }>;
}

export interface CreateFieldInput {
  workspaceId: string;
  /** Null defines an ad-hoc workspace field, usable on any page. */
  typeId: string | null;
  key: string;
  label?: string;
  kind: FieldKind;
  /** Option labels for select kinds. */
  options?: string[];
}

export interface UpdateFieldInput {
  key?: string;
  label?: string;
  kind?: FieldKind;
  position?: number;
  /** The full option list: listed ids keep their id (relabelled), entries
   * without an id are new, and existing options left out are retired. */
  options?: Array<{ id?: string; label: string }>;
}

export const shortId = (prefix: string) =>
  `${prefix}_${[...randomBytes(10)].map((b) => "abcdefghijklmnopqrstuvwxyz0123456789"[b % 36]).join("")}`;

/** Types, fields, template defaults and the starter kit are defined by a
 * workspace owner or admin (operator default 3). System actors pass. */
export async function assertCanDefine(db: Database, actor: Actor, workspaceId: string): Promise<void> {
  if (actor.kind !== "user") return;
  const [m] = await db
    .select({ role: workspaceMembers.role })
    .from(workspaceMembers)
    .where(and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.userId, actor.userId)));
  if (m?.role !== "owner" && m?.role !== "admin") {
    throw new ForbiddenError("only a workspace owner or admin can define types and fields");
  }
}

/** Page references must name live pages of the workspace. */
export async function assertPagesExist(db: Database, workspaceId: string, ids: readonly string[]): Promise<void> {
  if (ids.length === 0) return;
  const found = await db
    .select({ id: documents.id })
    .from(documents)
    .where(and(inArray(documents.id, [...ids]), eq(documents.workspaceId, workspaceId), isNull(documents.deletedAt)));
  const missing = ids.find((id) => !found.some((d) => d.id === id));
  if (missing) throw new InvalidInputError(`document ${missing} not found`);
}

interface Registry {
  types: DocumentType[];
  fields: TypeField[];
  aliases: Array<{ key: string; fieldId: string }>;
}

function fieldView(f: TypeField, registry: Registry): FieldView {
  return {
    id: f.id,
    workspaceId: f.workspaceId,
    typeId: f.typeId,
    key: f.key,
    label: f.label,
    kind: f.kind,
    position: f.position,
    options: f.options,
    retired: f.retiredAt !== null,
    aliases: registry.aliases.filter((a) => a.fieldId === f.id).map((a) => a.key),
  };
}

function describeField(f: TypeField): string {
  const live = f.options.filter((o) => !o.retired).map((o) => o.label);
  return `${f.key} (${f.kind}${live.length > 0 ? `: ${live.join(", ")}` : ""})`;
}

export class TypeService {
  constructor(
    private readonly db: Database,
    private readonly actor: Actor = SYSTEM,
  ) {}

  private exec<T>(fn: (db: Database) => Promise<T>): Promise<T> {
    return runAsActor(this.db, this.actor, fn);
  }

  private actorId(): string {
    return this.actor.kind === "user" ? this.actor.userId : "system";
  }

  private assertAdmin(db: Database, workspaceId: string): Promise<void> {
    return assertCanDefine(db, this.actor, workspaceId);
  }

  private async registry(db: Database, workspaceId: string): Promise<Registry> {
    const [types, fields, aliases] = await Promise.all([
      db.select().from(documentTypes).where(eq(documentTypes.workspaceId, workspaceId)).orderBy(asc(documentTypes.name)),
      db
        .select()
        .from(typeFields)
        .where(eq(typeFields.workspaceId, workspaceId))
        .orderBy(asc(typeFields.position), asc(typeFields.key)),
      db
        .select({ key: fieldKeyAliases.key, fieldId: fieldKeyAliases.fieldId })
        .from(fieldKeyAliases)
        .where(eq(fieldKeyAliases.workspaceId, workspaceId)),
    ]);
    return { types, fields, aliases };
  }

  /** Types with their live fields, in field order. Any member may read them. */
  async listTypes(workspaceId: string): Promise<TypeWithFields[]> {
    return this.exec(async (db) => {
      const registry = await this.registry(db, workspaceId);
      return registry.types.map((t) => ({
        id: t.id,
        workspaceId: t.workspaceId,
        name: t.name,
        fields: registry.fields
          .filter((f) => f.typeId === t.id && !f.retiredAt)
          .map((f) => fieldView(f, registry)),
      }));
    });
  }

  /** Every live field: each type's in order (types by name), then the
   * ad-hoc ones (typeId null). */
  async listFields(workspaceId: string): Promise<Array<FieldView & { typeName: string | null }>> {
    return this.exec(async (db) => {
      const registry = await this.registry(db, workspaceId);
      return [...registry.types.map((t) => t.id), null].flatMap((typeId) =>
        registry.fields
          .filter((f) => f.typeId === typeId && !f.retiredAt)
          .map((f) => ({
            ...fieldView(f, registry),
            typeName: registry.types.find((t) => t.id === f.typeId)?.name ?? null,
          })),
      );
    });
  }

  /** One field as the actor can read it, retired or not. */
  async getField(id: string): Promise<FieldView> {
    return this.exec(async (db) => fieldView(await this.fieldRow(db, id), { types: [], fields: [], aliases: [] }));
  }

  async createType(workspaceId: string, name: string): Promise<DocumentType> {
    return this.exec(async (db) => {
      await this.assertAdmin(db, workspaceId);
      await this.assertTypeNameFree(db, workspaceId, name);
      const [row] = await db
        .insert(documentTypes)
        .values({ workspaceId, name: name.trim(), createdBy: this.actorId() })
        .returning();
      return row!;
    });
  }

  private async assertTypeNameFree(db: Database, workspaceId: string, name: string, except?: string) {
    const [clash] = await db
      .select({ id: documentTypes.id })
      .from(documentTypes)
      .where(
        and(
          eq(documentTypes.workspaceId, workspaceId),
          sql`lower(${documentTypes.name}) = lower(${name.trim()})`,
        ),
      );
    if (clash && clash.id !== except) throw new InvalidInputError(`a type named "${name.trim()}" already exists`);
  }

  private async typeRow(db: Database, id: string): Promise<DocumentType> {
    const [row] = await db.select().from(documentTypes).where(eq(documentTypes.id, id));
    if (!row) throw new NotFoundError("type not found");
    return row;
  }

  async renameType(id: string, name: string): Promise<DocumentType> {
    return this.exec(async (db) => {
      const type = await this.typeRow(db, id);
      await this.assertAdmin(db, type.workspaceId);
      await this.assertTypeNameFree(db, type.workspaceId, name, id);
      const [row] = await db
        .update(documentTypes)
        .set({ name: name.trim(), updatedAt: new Date() })
        .where(eq(documentTypes.id, id))
        .returning();
      return row!;
    });
  }

  /** Delete a type. Pages of that type become untyped; its fields are
   * retired (kept, so stored values stay readable), never deleted. */
  async deleteType(id: string): Promise<DocumentType> {
    return this.exec(async (db) => {
      const type = await this.typeRow(db, id);
      await this.assertAdmin(db, type.workspaceId);
      await db
        .update(typeFields)
        .set({ retiredAt: new Date(), updatedAt: new Date() })
        .where(and(eq(typeFields.typeId, id), isNull(typeFields.retiredAt)));
      await db.delete(documentTypes).where(eq(documentTypes.id, id));
      return type;
    });
  }

  private async assertKeyFree(
    db: Database,
    workspaceId: string,
    typeId: string | null,
    key: string,
    except?: string,
  ): Promise<void> {
    const [clash] = await db
      .select({ id: typeFields.id })
      .from(typeFields)
      .where(
        and(
          eq(typeFields.workspaceId, workspaceId),
          typeId ? eq(typeFields.typeId, typeId) : isNull(typeFields.typeId),
          isNull(typeFields.retiredAt),
          sql`lower(${typeFields.key}) = lower(${key})`,
        ),
      );
    if (clash && clash.id !== except) throw new InvalidInputError(`a field "${key}" already exists here`);
  }

  async createField(input: CreateFieldInput): Promise<FieldView> {
    const key = input.key.trim();
    if (!key) throw new InvalidInputError("a field needs a key");
    return this.exec(async (db) => {
      await this.assertAdmin(db, input.workspaceId);
      if (input.typeId) {
        const type = await this.typeRow(db, input.typeId);
        if (type.workspaceId !== input.workspaceId) throw new NotFoundError("type not found");
      }
      await this.assertKeyFree(db, input.workspaceId, input.typeId, key);
      const [last] = await db
        .select({ position: sql<number | null>`max(${typeFields.position})` })
        .from(typeFields)
        .where(
          and(
            eq(typeFields.workspaceId, input.workspaceId),
            input.typeId ? eq(typeFields.typeId, input.typeId) : isNull(typeFields.typeId),
          ),
        );
      const [row] = await db
        .insert(typeFields)
        .values({
          id: shortId("f"),
          workspaceId: input.workspaceId,
          typeId: input.typeId,
          key,
          label: input.label?.trim() || key,
          kind: input.kind,
          position: Number(last?.position ?? 0) + 1,
          options: (input.options ?? []).map((label) => ({ id: shortId("o"), label: label.trim() })),
          createdBy: this.actorId(),
        })
        .returning();
      return fieldView(row!, { types: [], fields: [], aliases: [] });
    });
  }

  private async fieldRow(db: Database, id: string): Promise<TypeField> {
    const [row] = await db.select().from(typeFields).where(eq(typeFields.id, id));
    if (!row) throw new NotFoundError("field not found");
    return row;
  }

  /** The field, locked for the rest of the transaction so concurrent edits
   * to its options queue instead of overwriting each other. The admin check
   * comes first: RLS hides rows a non-admin can't update from FOR UPDATE. */
  private async fieldForEdit(db: Database, id: string): Promise<TypeField> {
    await this.assertAdmin(db, (await this.fieldRow(db, id)).workspaceId);
    const [row] = await db.select().from(typeFields).where(eq(typeFields.id, id)).for("update");
    if (!row) throw new NotFoundError("field not found");
    return row;
  }

  /** Give a select field an option for each label it lacks (matched
   * case-insensitively against live options). Only ever appends, so options
   * added or relabelled since the caller read the field survive. */
  async addOptions(id: string, labels: readonly string[]): Promise<FieldView> {
    return this.exec(async (db) => {
      const field = await this.fieldForEdit(db, id);
      const known = new Set(field.options.filter((o) => !o.retired).map((o) => o.label.toLowerCase()));
      const added: FieldOption[] = [];
      for (const label of labels.map((l) => l.trim()).filter(Boolean)) {
        if (known.has(label.toLowerCase())) continue;
        known.add(label.toLowerCase());
        added.push({ id: shortId("o"), label });
      }
      const [row] =
        added.length === 0
          ? [field]
          : await db
              .update(typeFields)
              .set({ options: [...field.options, ...added], updatedAt: new Date() })
              .where(eq(typeFields.id, id))
              .returning();
      const aliases = await db
        .select({ key: fieldKeyAliases.key, fieldId: fieldKeyAliases.fieldId })
        .from(fieldKeyAliases)
        .where(eq(fieldKeyAliases.fieldId, id));
      return fieldView(row!, { types: [], fields: [], aliases });
    });
  }

  /** Change a field's definition. Documents are never rewritten: a renamed
   * key stays usable as an alias, and values that no longer fit a changed
   * kind show up as issues. */
  async updateField(id: string, patch: UpdateFieldInput): Promise<FieldView> {
    return this.exec(async (db) => {
      const field = await this.fieldForEdit(db, id);
      const set: Partial<typeof typeFields.$inferInsert> = { updatedAt: new Date() };
      const key = patch.key?.trim();
      if (key && key !== field.key) {
        await this.assertKeyFree(db, field.workspaceId, field.typeId, key, id);
        set.key = key;
        await db
          .insert(fieldKeyAliases)
          .values({ workspaceId: field.workspaceId, key: field.key, fieldId: id })
          .onConflictDoNothing();
      }
      if (patch.label !== undefined) set.label = patch.label.trim() || (key ?? field.key);
      if (patch.kind !== undefined) set.kind = patch.kind;
      if (patch.position !== undefined) set.position = patch.position;
      if (patch.options !== undefined) {
        const options = patch.options;
        if (options.some((o) => o.id && !field.options.some((f) => f.id === o.id))) {
          throw new InvalidInputError("unknown option id");
        }
        set.options = [
          ...field.options.map((o) => {
            const kept = options.find((p) => p.id === o.id);
            return kept ? { id: o.id, label: kept.label.trim() } : { ...o, retired: true };
          }),
          ...options.filter((o) => !o.id).map((o) => ({ id: shortId("o"), label: o.label.trim() })),
        ];
      }
      const [row] = await db.update(typeFields).set(set).where(eq(typeFields.id, id)).returning();
      const aliases = await db
        .select({ key: fieldKeyAliases.key, fieldId: fieldKeyAliases.fieldId })
        .from(fieldKeyAliases)
        .where(eq(fieldKeyAliases.fieldId, id));
      return fieldView(row!, { types: [], fields: [], aliases });
    });
  }

  /** Retire a field: it stops being offered and its key is free again, but
   * stored values stay readable (reported as retired). */
  async retireField(id: string): Promise<FieldView> {
    return this.exec(async (db) => {
      const field = await this.fieldRow(db, id);
      await this.assertAdmin(db, field.workspaceId);
      const [row] = await db
        .update(typeFields)
        .set({ retiredAt: new Date(), updatedAt: new Date() })
        .where(eq(typeFields.id, id))
        .returning();
      return fieldView(row!, { types: [], fields: [], aliases: [] });
    });
  }

  /** Attach a type to a page, or detach it with null. Detaching keeps every
   * value: values belong to fields, not to the type. Needs write access to
   * the page; returns false when the actor can't write it. */
  async setDocumentType(documentId: string, typeId: string | null): Promise<boolean> {
    return this.exec(async (db) => {
      const [doc] = await db
        .select({ workspaceId: documents.workspaceId })
        .from(documents)
        .where(and(eq(documents.id, documentId), isNull(documents.deletedAt)));
      if (!doc) throw new NotFoundError("document not found");
      if (typeId) {
        const type = await this.typeRow(db, typeId);
        if (type.workspaceId !== doc.workspaceId) throw new NotFoundError("type not found");
      }
      const rows = await db
        .update(documents)
        .set({ typeId, updatedAt: new Date() })
        .where(and(eq(documents.id, documentId), isNull(documents.deletedAt)))
        .returning({ id: documents.id });
      return rows.length > 0;
    });
  }

  /** A page's properties for display. */
  async view(documentId: string): Promise<PropertyView> {
    return this.exec(async (db) => {
      const [doc] = await db
        .select({
          workspaceId: documents.workspaceId,
          typeId: documents.typeId,
          properties: documents.properties,
          propertyIssues: documents.propertyIssues,
        })
        .from(documents)
        .where(and(eq(documents.id, documentId), isNull(documents.deletedAt)));
      if (!doc) throw new NotFoundError("document not found");
      return this.buildView(db, doc.workspaceId, doc.typeId, doc.properties, doc.propertyIssues);
    });
  }

  /** Properties of a past version (a raw map from its ydoc state), shown
   * against today's field definitions. */
  async viewState(workspaceId: string, json: PropertiesJSON): Promise<PropertyView> {
    return this.exec(async (db) => {
      const projected = await projectionColumns(db, workspaceId, json);
      return this.buildView(db, workspaceId, null, projected.properties, projected.propertyIssues);
    });
  }

  private async buildView(
    db: Database,
    workspaceId: string,
    typeId: string | null,
    properties: Record<string, unknown>,
    issues: PropertyIssue[],
  ): Promise<PropertyView> {
    const registry = await this.registry(db, workspaceId);
    const type = registry.types.find((t) => t.id === typeId) ?? null;
    const byId = new Map(registry.fields.map((f) => [f.id, f]));
    const fields = [
      ...registry.fields.filter((f) => type && f.typeId === type.id && !f.retiredAt),
      ...registry.fields
        .filter((f) => f.id in properties && !(type && f.typeId === type.id && !f.retiredAt))
        .sort((a, b) => a.key.localeCompare(b.key)),
    ];
    // The projection can predate a kind change, so values are read as lists
    // or scalars by today's kind without trusting their shape.
    const refIds = fields
      .filter((f) => f.kind === "doc" || f.kind === "doc_list")
      .flatMap((f) => [properties[f.id]].flat())
      .filter((v): v is string => typeof v === "string" && UUID.test(v));
    const titles = new Map(
      refIds.length === 0
        ? []
        : (
            await db
              .select({ id: documents.id, title: documents.title })
              .from(documents)
              .where(and(inArray(documents.id, refIds), isNull(documents.deletedAt)))
          ).map((d) => [d.id, d.title]),
    );
    const ref = (id: unknown): DocumentRef => ({ id: String(id), title: titles.get(String(id)) ?? null });
    const label = (f: TypeField, id: unknown) => f.options.find((o) => o.id === id)?.label ?? String(id);
    const values: Record<string, unknown> = {};
    for (const f of fields) {
      if (!(f.id in properties)) continue;
      const v = properties[f.id];
      values[f.id] =
        f.kind === "select"
          ? label(f, v)
          : f.kind === "multi_select"
            ? [v].flat().map((id) => label(f, id))
            : f.kind === "doc"
              ? ref(v)
              : f.kind === "doc_list"
                ? [v].flat().map(ref)
                : v;
    }
    return {
      type: type ? { id: type.id, name: type.name } : null,
      fields: fields.map((f) => fieldView(f, registry)),
      values,
      issues: issues.map((i) => ({ ...i, key: byId.get(i.fieldId)?.key ?? null })),
    };
  }

  /**
   * Turn a patch by field key into per-field ops for one page. Keys and
   * option labels match case-insensitively. A key resolves first among the
   * page type's fields, then fields the page already holds, then the ad-hoc
   * fields; old keys of renamed fields work too. Unknown keys are an error
   * that lists the fields the page can take: only an owner or admin defines
   * fields.
   */
  async planPatch(documentId: string, patch: PropertyPatchInput): Promise<PropertyOp[]> {
    return this.exec(async (db) => {
      const [doc] = await db
        .select({
          workspaceId: documents.workspaceId,
          typeId: documents.typeId,
          properties: documents.properties,
          propertyIssues: documents.propertyIssues,
        })
        .from(documents)
        .where(and(eq(documents.id, documentId), isNull(documents.deletedAt)));
      if (!doc) throw new NotFoundError("document not found");
      const held = new Set([...Object.keys(doc.properties), ...doc.propertyIssues.map((i) => i.fieldId)]);
      return this.toOps(db, doc.workspaceId, doc.typeId, held, patch);
    });
  }

  /** Resolve `create_document`'s type (name or id) and initial values for a
   * new page in `collectionId`. */
  async planCreate(
    collectionId: string,
    input: { type?: string; properties?: Record<string, unknown> },
  ): Promise<{ typeId: string | null; ops: PropertyOp[] }> {
    if (!input.type && !input.properties) return { typeId: null, ops: [] };
    return this.exec(async (db) => {
      const [col] = await db
        .select({ workspaceId: collections.workspaceId })
        .from(collections)
        .where(eq(collections.id, collectionId));
      if (!col) throw new NotFoundError("collection not found");
      let typeId: string | null = null;
      if (input.type) {
        const wanted = input.type.trim().toLowerCase();
        const types = await db
          .select()
          .from(documentTypes)
          .where(eq(documentTypes.workspaceId, col.workspaceId));
        const type = types.find((t) => t.id === input.type || t.name.toLowerCase() === wanted);
        if (!type) {
          throw new InvalidInputError(
            `unknown type "${input.type}". Types: ${types.map((t) => t.name).join(", ") || "none defined"}`,
          );
        }
        typeId = type.id;
      }
      const ops = await this.toOps(db, col.workspaceId, typeId, new Set(), { set: input.properties });
      return { typeId, ops };
    });
  }

  private async toOps(
    db: Database,
    workspaceId: string,
    typeId: string | null,
    held: ReadonlySet<string>,
    patch: PropertyPatchInput,
  ): Promise<PropertyOp[]> {
    const registry = await this.registry(db, workspaceId);
    const live = (f: TypeField) => !f.retiredAt;
    const tiers = [
      registry.fields.filter((f) => typeId !== null && f.typeId === typeId && live(f)),
      registry.fields.filter((f) => held.has(f.id)),
      registry.fields.filter((f) => f.typeId === null && live(f)),
    ];
    const resolve = (key: string): TypeField => {
      const k = key.trim().toLowerCase();
      for (const tier of tiers) {
        const byKey = tier.filter((f) => f.key.toLowerCase() === k);
        const matches =
          byKey.length > 0
            ? byKey
            : tier.filter((f) => registry.aliases.some((a) => a.fieldId === f.id && a.key.toLowerCase() === k));
        if (matches.length === 1) return matches[0]!;
        if (matches.length > 1) {
          throw new InvalidInputError(
            `"${key}" is ambiguous on this page: ${matches.map((f) => `${f.key} (${f.id})`).join(", ")}`,
          );
        }
      }
      const offered = [...new Map(tiers.flat().filter(live).map((f) => [f.id, f])).values()];
      throw new InvalidInputError(
        `unknown field "${key}". Fields this page can take: ${
          offered.map(describeField).join("; ") || "none"
        }. Only a workspace owner or admin can define new fields.`,
      );
    };

    const ops: PropertyOp[] = [];
    const refs: string[] = [];
    const parse = (field: TypeField, input: unknown): unknown => {
      const parsed = parseFieldInput(field, input);
      if ("error" in parsed) {
        const options = field.options.filter((o) => !o.retired).map((o) => o.label);
        throw new InvalidInputError(
          `${field.key}: ${parsed.error}${options.length > 0 ? `. Options: ${options.join(", ")}` : ""}`,
        );
      }
      if (field.kind === "doc" || field.kind === "doc_list") refs.push(parsed.value as string);
      return parsed.value;
    };
    const writable = (key: string, clearing: boolean): TypeField => {
      const field = resolve(key);
      if (field.kind === "json") throw new InvalidInputError(`${field.key} is read-only (imported data)`);
      if (field.retiredAt && !clearing) throw new InvalidInputError(`${field.key} is retired`);
      return field;
    };
    const listOf = (field: TypeField, verb: string): void => {
      if (!isListKind(field.kind)) {
        throw new InvalidInputError(`${field.key} holds one value: use set, not ${verb}`);
      }
    };

    for (const [key, input] of Object.entries(patch.set ?? {})) {
      const field = writable(key, input == null);
      const empty = input == null || input === "" || (Array.isArray(input) && input.length === 0);
      if (empty) ops.push({ op: "unset", field: field.id });
      else if (isListKind(field.kind)) {
        ops.push({ op: "setList", field: field.id, values: [input].flat().map((v) => parse(field, v)) });
      } else ops.push({ op: "set", field: field.id, value: parse(field, input) });
    }
    for (const key of patch.unset ?? []) ops.push({ op: "unset", field: writable(key, true).id });
    for (const [key, input] of Object.entries(patch.add ?? {})) {
      const field = writable(key, false);
      listOf(field, "add");
      ops.push({ op: "add", field: field.id, values: [input].flat().map((v) => parse(field, v)) });
    }
    for (const [key, input] of Object.entries(patch.remove ?? {})) {
      const field = writable(key, true);
      listOf(field, "remove");
      ops.push({
        op: "remove",
        field: field.id,
        values: [input].flat().map((v) => KINDS[field.kind].coerce(v, field)),
      });
    }
    const touched = ops.map((o) => o.field);
    const twice = touched.find((f, i) => touched.indexOf(f) !== i);
    if (twice) {
      throw new InvalidInputError(`${registry.fields.find((f) => f.id === twice)?.key} is changed twice in one patch`);
    }
    await assertPagesExist(db, workspaceId, refs);
    return ops;
  }
}
