import type { AuthorInfo, PropertyBlame } from "@tandem/editor";
import type { RouterOutputs } from "@tandem/server/trpc";
import { authorLabel } from "./blame.js";

/** A field definition as the app reads it (`types.fields`). */
export type Field = RouterOutputs["types"]["fields"][number];
export type FieldKind = Field["kind"];
type FieldShape = Pick<Field, "id" | "key" | "kind" | "options" | "retired">;

/** A problem the server found with a stored value (`documents.properties`):
 * a value that doesn't fit its field, a retired option, a retired field. */
export type PropertyIssue = RouterOutputs["documents"]["properties"]["issues"][number];

/** A per-field patch for `documents.setProperties`, by field key (by id for
 * a retired field). */
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

export const isListKind = (kind: FieldKind) => kind === "text_list" || kind === "multi_select" || kind === "doc_list";

export const isEmptyValue = (raw: unknown) =>
  raw == null || raw === "" || (Array.isArray(raw) && raw.length === 0);

/** A stored value as a list: list fields hold arrays, but a value stored
 * before a kind change may still be a scalar. */
export const listValues = (raw: unknown): unknown[] => (Array.isArray(raw) ? raw : raw == null ? [] : [raw]);

export const optionLabel = (field: Pick<Field, "options">, id: unknown) =>
  field.options.find((o) => o.id === id)?.label ?? String(id);

/** A stored value as its field reads it today: a field that stopped being a
 * select still holds option ids, which read as the options' labels (as the
 * server's projection reads them). */
export function heldValue(field: Pick<Field, "kind" | "options">, raw: unknown): unknown {
  if (field.kind === "select" || field.kind === "multi_select" || field.options.length === 0) return raw;
  const label = (v: unknown) => (typeof v === "string" ? (field.options.find((o) => o.id === v)?.label ?? v) : v);
  return Array.isArray(raw) ? raw.map(label) : label(raw);
}

/** The messages of a field's issues that still describe its value: issues
 * come from the page's last save, so one about a value since replaced is
 * stale. A list issue names the offending elements, still there if each is. */
export function issueMessages(
  issues: ReadonlyArray<Pick<PropertyIssue, "fieldId" | "message" | "value">>,
  fieldId: string,
  held: unknown,
): string[] {
  const heldItems = new Set((Array.isArray(held) ? held : [held]).map((v) => JSON.stringify(v)));
  return issues
    .filter(
      (i) =>
        i.fieldId === fieldId &&
        (JSON.stringify(i.value) === JSON.stringify(held) ||
          (Array.isArray(i.value) && Array.isArray(held) && i.value.every((v) => heldItems.has(JSON.stringify(v))))),
    )
    .map((i) => i.message);
}

/** A link value as an href, or null unless it is an http(s) URL: the live
 * map is writable by any collaborator, so a stored value may be anything. */
export function safeHref(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const { protocol } = new URL(value);
    return protocol === "http:" || protocol === "https:" ? value : null;
  } catch {
    return null;
  }
}

/** A retired field goes by its id: its key is free for a new field to take. */
export function patchFor(field: FieldShape, edit: PropertyEdit): PropertyPatch {
  const name = field.retired ? field.id : field.key;
  switch (edit.op) {
    case "set":
      return { set: { [name]: edit.value } };
    case "clear":
      return { unset: [name] };
    case "add":
      return { add: { [name]: [edit.value] } };
    case "remove":
      return { remove: { [name]: [edit.value] } };
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

/** The edit a date or date-time input means once committed, or null to keep
 * the stored value: an input with one part cleared reads as "" just like an
 * emptied one (`incomplete` tells them apart), and only an emptied one clears. */
export function editFromDateInput(kind: FieldKind, text: string, incomplete: boolean): PropertyEdit | null {
  if (incomplete) return null;
  if (text === "") return { op: "clear" };
  const value = kind === "datetime" ? datetimeFromInput(text) : text;
  return value ? { op: "set", value } : null;
}

/** A plain decimal number: what a person means by one, unlike the rest of
 * what `Number()` reads (`0x1F`, `0b11`, `0o7`, `Infinity`). */
const DECIMAL = /^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i;

/** The edit a typed-in text value means for a text, url or number field:
 * blank clears, and a number or link that doesn't fit is an error naming the
 * field by its label. */
export function editFromText(field: Pick<Field, "kind" | "label">, text: string): PropertyEdit | { error: string } {
  const trimmed = text.trim();
  if (trimmed === "") return { op: "clear" };
  if (field.kind === "number") {
    const n = Number(trimmed);
    return DECIMAL.test(trimmed) && Number.isFinite(n)
      ? { op: "set", value: n }
      : { error: `${field.label} takes a number.` };
  }
  if (field.kind === "url" && !safeHref(trimmed)) {
    return { error: `${field.label} takes a link that starts with http:// or https://.` };
  }
  return { op: "set", value: field.kind === "text" ? text : trimmed };
}

/** A save error as the panel shows it: the server names a field by its key
 * (agents write by key), a person knows it by its label. */
export function labelledError(field: Pick<Field, "key" | "label">, message: string): string {
  return message.startsWith(`${field.key}: `) ? `${field.label}: ${message.slice(field.key.length + 2)}` : message;
}

export interface FormatOptions {
  locale?: string;
  timeZone?: string;
  /** Title of a referenced page, when known; null when the reader can't see it. */
  titleOf?: (id: string) => string | null | undefined;
}

/** How a page reference reads: its title, or "Restricted page" when the
 * reader can't see it. */
export const pageLabel = (title: string | null | undefined) =>
  title === null ? "Restricted page" : title || "Untitled";

/** A stored value as one line of text (the collapsed summary, table cells). */
export function formatValue(field: Pick<Field, "kind" | "options">, raw: unknown, opts: FormatOptions = {}): string {
  if (isEmptyValue(raw)) return "";
  const page = (id: unknown) => pageLabel(opts.titleOf?.(String(id)));
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
    case "text_list":
      return listValues(raw).map(String).join(", ");
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

/** A template as the app reads it (`templates.list`), with its type and
 * defaults by field id. */
export type TemplateInfo = RouterOutputs["templates"]["list"][number];
export type TemplateDefault = TemplateInfo["defaults"][string];
type DefaultExpression = Exclude<TemplateDefault["kind"], "value">;
/** A default as `templates.setFieldDefault` takes it. */
export type DefaultInput =
  | { kind: "value"; value: string | number | boolean | string[] }
  | { kind: DefaultExpression };

/** The expressions a template field can default to, as the panel words
 * them. The server checks the same fit when one is saved. */
export const EXPRESSION_CHOICES: ReadonlyArray<{
  kind: DefaultExpression;
  label: string;
  fits: (kind: FieldKind) => boolean;
}> = [
  { kind: "today", label: "Today", fits: (kind) => kind === "date" },
  { kind: "now", label: "Now", fits: (kind) => kind === "datetime" },
  { kind: "me", label: "The creator's name", fits: (kind) => kind === "text" },
  { kind: "from_previous_sibling", label: "Same as the previous page", fits: (kind) => kind !== "json" },
];

/** The literal default a widget's edit makes of the current one; null
 * clears it (an emptied list included). */
export function literalDefault(current: unknown, edit: PropertyEdit): DefaultInput | null {
  const list = listValues(current).map(String);
  switch (edit.op) {
    case "clear":
      return null;
    case "set": {
      const v = edit.value;
      return { kind: "value", value: typeof v === "number" || typeof v === "boolean" ? v : String(v) };
    }
    case "add":
      return { kind: "value", value: list.includes(String(edit.value)) ? list : [...list, String(edit.value)] };
    case "remove": {
      const left = list.filter((v) => v !== String(edit.value));
      return left.length > 0 ? { kind: "value", value: left } : null;
    }
  }
}

/** A default as one line of text, for people who can't edit it. */
export function describeDefault(
  field: Pick<Field, "kind" | "options">,
  def: TemplateDefault | undefined,
  opts: FormatOptions = {},
): string {
  if (!def) return "No default";
  if (def.kind === "value") return formatValue(field, def.value, opts);
  return EXPRESSION_CHOICES.find((c) => c.kind === def.kind)!.label;
}

/** Kinds a Contents table cell can show as text; page references would need
 * a title lookup per cell. */
const COLUMN_KINDS: Record<FieldKind, boolean> = {
  text: true,
  text_list: true,
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
    case "text_list":
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
