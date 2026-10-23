import type { DefaultExpression, FieldKind, TemplateDefault } from "@tandem/db";
import type { PropertyOp } from "@tandem/editor";
import { isListKind, parseFieldInput, type FieldDef } from "./types.js";

/** What the expressions read when a page is created. */
export interface DefaultContext {
  /** The creator's calendar day, YYYY-MM-DD (the same day `{{date}}` names). */
  today: string;
  now: Date;
  /** The creator's display name. */
  me: string;
  /** Stored values of the previous sibling page, or null when there is none. */
  previous: Readonly<Record<string, unknown>> | null;
}

/** Each expression: the field kinds it can fill and the value it yields. */
export const EXPRESSIONS: Record<
  DefaultExpression,
  { fits: (kind: FieldKind) => boolean; value: (ctx: DefaultContext, fieldId: string) => unknown }
> = {
  today: { fits: (kind) => kind === "date", value: (ctx) => ctx.today },
  now: { fits: (kind) => kind === "datetime", value: (ctx) => ctx.now.toISOString() },
  me: { fits: (kind) => kind === "text", value: (ctx) => ctx.me },
  from_previous_sibling: { fits: (kind) => kind !== "json", value: (ctx, fieldId) => ctx.previous?.[fieldId] },
};

/** The stored values `raw` holds for `field`, or why one doesn't fit. A list
 * field takes a list (or one value), a scalar one value; empty is []. */
function fieldValues(field: FieldDef, raw: unknown): { values: unknown[] } | { error: string } {
  if (raw == null || raw === "") return { values: [] };
  const inputs = isListKind(field.kind) ? [raw].flat() : [raw];
  const values: unknown[] = [];
  for (const input of inputs) {
    const parsed = parseFieldInput(field, input);
    if ("error" in parsed) return { error: `${field.key}: ${parsed.error}` };
    if (!values.some((v) => JSON.stringify(v) === JSON.stringify(parsed.value))) values.push(parsed.value);
  }
  return { values };
}

/** A default as a template stores it: a literal parsed to its stored form
 * (labels to option ids, page urls to ids), null when it is empty. */
export function normalizeDefault(
  field: FieldDef,
  input: TemplateDefault,
): { value: TemplateDefault | null } | { error: string } {
  if (field.kind === "json") return { error: `${field.key} is read-only (imported data)` };
  if (input.kind !== "value") {
    return EXPRESSIONS[input.kind].fits(field.kind)
      ? { value: { kind: input.kind } }
      : { error: `${field.key} is a ${field.kind} field and can't default to ${input.kind}` };
  }
  const parsed = fieldValues(field, input.value);
  if ("error" in parsed) return parsed;
  if (parsed.values.length === 0) return { value: null };
  return { value: { kind: "value", value: isListKind(field.kind) ? parsed.values : parsed.values[0] } };
}

/**
 * The first values of a new page of a type: one op per live field. A list
 * field always gets its list (empty without a default), as attaching a type
 * does, so later adds never race to create it. A default that no longer fits
 * its field (the kind changed, the previous page had nothing) writes nothing.
 */
export function evaluateDefaults(
  fields: readonly FieldDef[],
  defaults: Readonly<Record<string, TemplateDefault>>,
  ctx: DefaultContext,
): PropertyOp[] {
  const ops: PropertyOp[] = [];
  for (const field of fields) {
    if (field.retiredAt || field.kind === "json") continue;
    const def = defaults[field.id];
    const raw =
      def === undefined
        ? undefined
        : def.kind === "value"
          ? def.value
          : EXPRESSIONS[def.kind].fits(field.kind)
            ? EXPRESSIONS[def.kind].value(ctx, field.id)
            : undefined;
    const parsed = fieldValues(field, raw);
    const values = "error" in parsed ? [] : parsed.values;
    if (isListKind(field.kind)) ops.push({ op: "setList", field: field.id, values });
    else if (values.length > 0) ops.push({ op: "set", field: field.id, value: values[0] });
  }
  return ops;
}
