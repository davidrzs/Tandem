import type { AuthorInfo, PropertyBlame } from "@tandem/editor";
import type { RouterOutputs } from "@tandem/server/trpc";
import { authorLabel } from "./blame.js";

/** A field definition as the app reads it (`types.fields`). */
export type Field = RouterOutputs["types"]["fields"][number];
export type FieldKind = Field["kind"];
type FieldShape = Pick<Field, "id" | "key" | "kind" | "options">;

/** A per-field patch for `documents.setProperties`, by field key. */
export interface PropertyPatch {
  set?: Record<string, unknown>;
  unset?: string[];
  add?: Record<string, unknown[]>;
  remove?: Record<string, unknown[]>;
}

/** What a widget asks for: one change to one field. */
export type PropertyEdit =
  | { op: "set"; value: unknown }
  | { op: "clear" }
  | { op: "add"; value: unknown }
  | { op: "remove"; value: unknown };

export const isListKind = (kind: FieldKind) => kind === "multi_select" || kind === "doc_list";

export const isEmptyValue = (raw: unknown) =>
  raw == null || raw === "" || (Array.isArray(raw) && raw.length === 0);

/** A stored value as a list: list fields hold arrays, but a value stored
 * before a kind change may still be a scalar. */
export const listValues = (raw: unknown): unknown[] => (Array.isArray(raw) ? raw : raw == null ? [] : [raw]);

export const optionLabel = (field: Pick<Field, "options">, id: unknown) =>
  field.options.find((o) => o.id === id)?.label ?? String(id);

export function patchFor(field: FieldShape, edit: PropertyEdit): PropertyPatch {
  switch (edit.op) {
    case "set":
      return { set: { [field.key]: edit.value } };
    case "clear":
      return { unset: [field.key] };
    case "add":
      return { add: { [field.key]: [edit.value] } };
    case "remove":
      return { remove: { [field.key]: [edit.value] } };
  }
}

/** A `datetime-local` input's value as the stored UTC instant, or null. */
export function datetimeFromInput(text: string): string | null {
  const at = new Date(text);
  return text && !Number.isNaN(at.getTime()) ? at.toISOString() : null;
}

/** A stored UTC instant as a `datetime-local` input's value, in local time. */
export function datetimeToInput(iso: unknown): string {
  if (typeof iso !== "string") return "";
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}T${pad(at.getHours())}:${pad(at.getMinutes())}`;
}

/** The edit a typed-in text value means for a text, url or number field:
 * blank clears, and a number that doesn't parse is no edit at all. */
export function editFromText(kind: FieldKind, text: string): PropertyEdit | null {
  const trimmed = text.trim();
  if (trimmed === "") return { op: "clear" };
  if (kind === "number") {
    const n = Number(trimmed);
    return Number.isFinite(n) ? { op: "set", value: n } : null;
  }
  return { op: "set", value: kind === "text" ? text : trimmed };
}

export interface FormatOptions {
  locale?: string;
  timeZone?: string;
  /** Title of a referenced page, when known. */
  titleOf?: (id: string) => string | undefined;
}

/** A stored value as one line of text (the collapsed summary, table cells). */
export function formatValue(field: Pick<Field, "kind" | "options">, raw: unknown, opts: FormatOptions = {}): string {
  if (isEmptyValue(raw)) return "";
  const page = (id: unknown) => opts.titleOf?.(String(id)) || "Untitled";
  switch (field.kind) {
    case "number":
      return typeof raw === "number" ? raw.toLocaleString(opts.locale) : String(raw);
    case "checkbox":
      return raw === true ? "Yes" : "No";
    case "date": {
      const at = new Date(`${String(raw)}T00:00:00Z`);
      return Number.isNaN(at.getTime())
        ? String(raw)
        : at.toLocaleDateString(opts.locale, { dateStyle: "medium", timeZone: "UTC" });
    }
    case "datetime": {
      const at = new Date(String(raw));
      return Number.isNaN(at.getTime())
        ? String(raw)
        : at.toLocaleString(opts.locale, { dateStyle: "medium", timeStyle: "short", timeZone: opts.timeZone });
    }
    case "select":
      return optionLabel(field, raw);
    case "multi_select":
      return listValues(raw).map((id) => optionLabel(field, id)).join(", ");
    case "doc":
      return page(raw);
    case "doc_list":
      return listValues(raw).map(page).join(", ");
    case "json":
      return JSON.stringify(raw);
    default:
      return String(raw);
  }
}

/** The collapsed panel's one line: each set field as "Label: value". */
export function summaryText(
  fields: Array<Pick<Field, "id" | "label" | "kind" | "options">>,
  values: Record<string, unknown>,
  opts: FormatOptions = {},
): string {
  const parts = fields
    .filter((f) => !isEmptyValue(values[f.id]))
    .map((f) => `${f.label}: ${formatValue(f, values[f.id], opts)}`);
  return parts.length > 0 ? parts.join(" · ") : "No values yet";
}

/** Kinds a Contents table cell can show as text; page references would need
 * a title lookup per cell. */
const COLUMN_KINDS: Record<FieldKind, boolean> = {
  text: true,
  number: true,
  checkbox: true,
  date: true,
  datetime: true,
  select: true,
  multi_select: true,
  url: true,
  doc: false,
  doc_list: false,
  json: false,
};

/** The property columns for listed pages: the first `max` table-friendly
 * fields of the type every page shares, none when they don't share one. */
export function propertyColumns<F extends Pick<Field, "typeId" | "kind" | "retired">>(
  pages: ReadonlyArray<{ typeId: string | null }>,
  fields: readonly F[],
  max = 3,
): F[] {
  const typeId = pages[0]?.typeId ?? null;
  if (typeId === null || pages.some((p) => p.typeId !== typeId)) return [];
  return fields.filter((f) => f.typeId === typeId && !f.retired && COLUMN_KINDS[f.kind]).slice(0, max);
}

/** How a value orders in a sorted column, or null when it has none. Options
 * order as the field lists them, so a status reads in its own sequence. */
export function sortValue(field: Pick<Field, "kind" | "options">, raw: unknown): string | number | null {
  if (isEmptyValue(raw)) return null;
  switch (field.kind) {
    case "number":
      return typeof raw === "number" ? raw : null;
    case "checkbox":
      return raw === true ? 1 : 0;
    case "select": {
      const index = field.options.findIndex((o) => o.id === raw);
      return index < 0 ? field.options.length : index;
    }
    case "multi_select":
      return formatValue(field, raw);
    default:
      return typeof raw === "string" ? raw : null;
  }
}

/** Who an AI-written value belongs to, for the panel's marker. */
export interface AiMark {
  value: unknown;
  /** "David's AI (Claude)". */
  label: string;
  agent: string | null;
}

/** AI-written values by field id: the current writer of each scalar and of
 * each list element, kept only when that writer was an agent. */
export function aiMarks(
  blame: readonly PropertyBlame[],
  authors: ReadonlyMap<number, AuthorInfo>,
): Record<string, AiMark[]> {
  const out: Record<string, AiMark[]> = {};
  for (const { field, value, clientId } of blame) {
    const info = authors.get(clientId);
    if (!info?.ai || value == null) continue;
    (out[field] ??= []).push({ value, label: authorLabel(info), agent: info.agent ?? null });
  }
  return out;
}

/** The mark on one displayed value (a scalar, or one list element). */
export const markFor = (marks: readonly AiMark[] | undefined, value: unknown) =>
  marks?.find((m) => JSON.stringify(m.value) === JSON.stringify(value)) ?? null;

/** A field key from a label a person typed: lowercase words joined by "_". */
export const keyFromLabel = (label: string) =>
  label
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "_")
    .replace(/^_+|_+$/g, "");
