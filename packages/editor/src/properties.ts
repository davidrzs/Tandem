import * as Y from "yjs";

/**
 * Page properties live in a root `Y.Map("properties")` of the document's
 * ydoc, one entry per field id. A scalar field is a plain `{ v }` object and
 * a cleared one is `{ v: null }`, so the map entry still records who cleared
 * it. A list field is a `Y.Array` whose elements each carry their own
 * author, so concurrent adds merge instead of overwriting each other.
 *
 * Every write is a per-field patch. Nothing here rewrites the whole map:
 * that loses concurrent edits (docs/plans/evidence/yaml-merge.md). The map
 * is client-writable, so reads return whatever is stored and the server
 * validates at its projection step.
 */
export const PROPERTIES_KEY = "properties";

/** The map as plain values by field id: a scalar field's value (null when
 * cleared), a list field's elements. Unvalidated. */
export type PropertiesJSON = Record<string, unknown>;

export type PropertyOp =
  | { op: "set"; field: string; value: unknown }
  | { op: "setList"; field: string; values: readonly unknown[] }
  | { op: "unset"; field: string }
  | { op: "add"; field: string; values: readonly unknown[] }
  | { op: "remove"; field: string; values: readonly unknown[] };

interface Slot {
  v: unknown;
}

function propertiesMap(doc: Y.Doc): Y.Map<unknown> {
  return doc.getMap<unknown>(PROPERTIES_KEY);
}

function isSlot(entry: unknown): entry is Slot {
  return (
    typeof entry === "object" &&
    entry !== null &&
    !Array.isArray(entry) &&
    !(entry instanceof Y.AbstractType) &&
    Object.keys(entry).length === 1 &&
    "v" in entry
  );
}

const keyOf = (value: unknown) => JSON.stringify(value);
const sameValue = (a: unknown, b: unknown) => keyOf(a) === keyOf(b);

/** Whether `current` already holds exactly the values in `target`, in any
 * order: setList writes nothing then. */
function sameElements(current: unknown, target: readonly unknown[]): boolean {
  if (!Array.isArray(current)) return false;
  const want = new Set(target.map(keyOf));
  const have = new Set(current.map(keyOf));
  return want.size === have.size && [...want].every((key) => have.has(key));
}

function entryValue(entry: unknown): unknown {
  if (entry instanceof Y.AbstractType) return entry.toJSON();
  if (isSlot(entry)) return entry.v;
  return entry;
}

/** Plain values of a live doc's properties map. */
export function propertiesToJSON(doc: Y.Doc): PropertiesJSON {
  const out: PropertiesJSON = {};
  propertiesMap(doc).forEach((entry, field) => {
    out[field] = entryValue(entry);
  });
  return out;
}

/** Plain values of a persisted state's properties map (versions, restore). */
export function stateProperties(state: Uint8Array): PropertiesJSON {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, state);
  return propertiesToJSON(doc);
}

/** The field's Y.Array, created in place when the entry holds anything else.
 * A stored scalar or array value becomes the list's first elements, so a
 * field whose kind changed to a list keeps its data. */
function listFor(map: Y.Map<unknown>, field: string): { list: Y.Array<unknown>; created: boolean } {
  const entry = map.get(field);
  if (entry instanceof Y.Array) return { list: entry, created: false };
  const previous = entryValue(entry);
  const seed = Array.isArray(previous) ? previous : previous == null ? [] : [previous];
  const list = new Y.Array<unknown>();
  map.set(field, list);
  if (seed.length > 0) list.push(seed);
  return { list, created: true };
}

function removeWhere(list: Y.Array<unknown>, drop: (value: unknown) => boolean): boolean {
  let removed = false;
  for (let i = list.length - 1; i >= 0; i--) {
    if (drop(list.get(i))) {
      list.delete(i, 1);
      removed = true;
    }
  }
  return removed;
}

function pushMissing(list: Y.Array<unknown>, values: readonly unknown[]): boolean {
  const seen = new Set(list.toArray().map(keyOf));
  const missing = values.filter((value) => {
    const key = keyOf(value);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  if (missing.length > 0) list.push(missing);
  return missing.length > 0;
}

function applyOp(map: Y.Map<unknown>, op: PropertyOp): boolean {
  const entry = map.get(op.field);
  switch (op.op) {
    case "set":
      if (isSlot(entry) && sameValue(entry.v, op.value)) return false;
      map.set(op.field, { v: op.value });
      return true;
    case "unset":
      if (entry === undefined) return false;
      if (entry instanceof Y.Array) {
        if (entry.length === 0) return false;
        entry.delete(0, entry.length);
        return true;
      }
      if (isSlot(entry) && entry.v === null) return false;
      map.set(op.field, { v: null });
      return true;
    case "setList": {
      const keep = new Set(op.values.map(keyOf));
      const { list, created } = listFor(map, op.field);
      const removed = removeWhere(list, (v) => !keep.has(keyOf(v)));
      const added = pushMissing(list, op.values);
      return created || removed || added;
    }
    case "add": {
      const { list, created } = listFor(map, op.field);
      return pushMissing(list, op.values) || created;
    }
    case "remove": {
      const drop = new Set(op.values.map(keyOf));
      if (!(entry instanceof Y.Array)) {
        const held = entryValue(entry);
        if (![held].flat().some((v) => v != null && drop.has(keyOf(v)))) return false;
      }
      return removeWhere(listFor(map, op.field).list, (v) => drop.has(keyOf(v)));
    }
  }
}

/** Apply a patch, one field at a time, in one transaction. Returns how many
 * ops changed something; ops that would leave a field as it is write
 * nothing. */
export function applyPropertyPatch(doc: Y.Doc, ops: readonly PropertyOp[]): number {
  const map = propertiesMap(doc);
  let changed = 0;
  doc.transact(() => {
    for (const op of ops) if (applyOp(map, op)) changed++;
  });
  return changed;
}

/** The patch that turns `from` into `to`, touching only fields that differ.
 * Absent, null and empty lists all mean "no value". */
export function diffProperties(from: PropertiesJSON, to: PropertiesJSON): PropertyOp[] {
  const ops: PropertyOp[] = [];
  for (const field of new Set([...Object.keys(from), ...Object.keys(to)])) {
    const [current, target] = [from[field], to[field]].map((value) =>
      value == null || (Array.isArray(value) && value.length === 0) ? null : value,
    );
    if (target === null) {
      if (current !== null) ops.push({ op: "unset", field });
    } else if (Array.isArray(target)) {
      if (!sameElements(current, target)) ops.push({ op: "setList", field, values: target });
    } else if (!sameValue(current, target)) {
      ops.push({ op: "set", field, value: target });
    }
  }
  return ops;
}

/** Who wrote each stored value: one entry per scalar field (a cleared field
 * shows its clearer with value null) and one per list element. */
export interface PropertyBlame {
  field: string;
  value: unknown;
  clientId: number;
}

interface MapInternals {
  _map: Map<string, Y.Item>;
}

interface ArrayInternals {
  _start: Y.Item | null;
}

export function propertyBlame(doc: Y.Doc): PropertyBlame[] {
  const map = propertiesMap(doc);
  const items = (map as unknown as MapInternals)._map;
  const out: PropertyBlame[] = [];
  map.forEach((entry, field) => {
    if (entry instanceof Y.Array) {
      let item = (entry as unknown as ArrayInternals)._start;
      while (item) {
        if (!item.deleted && item.countable) {
          for (const value of item.content.getContent()) {
            out.push({ field, value, clientId: item.id.client });
          }
        }
        item = item.right;
      }
      return;
    }
    const item = items.get(field);
    if (item) out.push({ field, value: entryValue(entry), clientId: item.id.client });
  });
  return out;
}
