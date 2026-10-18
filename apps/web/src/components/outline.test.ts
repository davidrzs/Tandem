import assert from "node:assert/strict";
import { test } from "node:test";
import { nextSort, outlineRows, type DocumentNode, type OutlineRow, type OutlineView } from "./outline.js";

const doc = (id: string, title: string, updatedAt: string, children: DocumentNode[] = []): DocumentNode => ({
  id,
  title,
  updatedAt,
  children,
});

const tree: DocumentNode[] = [
  doc("research", "Research", "2026-10-03", [
    doc("findings", "Findings", "2026-10-05", [doc("evidence", "Evidence", "2026-10-01")]),
    doc("archive", "Archive", "2026-10-09"),
  ]),
  doc("notes", "notes", "2026-10-07"),
  doc("blank", "", "2026-10-02", [doc("draft", "Draft", "2026-10-04")]),
];

const view = (v: Partial<OutlineView>): OutlineView => ({ expanded: new Set(), sort: null, filter: "", ...v });
const shape = (rows: OutlineRow[]) =>
  rows.map((r) => `${"  ".repeat(r.depth)}${r.node.id} ${r.hasChildren ? (r.expanded ? "-" : "+") : "."} ${r.descendants}`);

test("only top-level rows show until a row is expanded, in position order", () => {
  assert.deepEqual(shape(outlineRows(tree, view({}))), ["research + 3", "notes . 0", "blank + 1"]);
  assert.deepEqual(shape(outlineRows(tree, view({ expanded: new Set(["research", "findings"]) }))), [
    "research - 3",
    "  findings - 1",
    "    evidence . 0",
    "  archive . 0",
    "notes . 0",
    "blank + 1",
  ]);
});

test("an expanded row under a collapsed ancestor stays hidden, and a leaf never reads as expanded", () => {
  assert.deepEqual(shape(outlineRows(tree, view({ expanded: new Set(["findings", "notes"]) }))), [
    "research + 3",
    "notes . 0",
    "blank + 1",
  ]);
});

test("sorting reorders each sibling group and keeps children under their parent", () => {
  const expanded = new Set(["research", "findings", "blank"]);
  assert.deepEqual(shape(outlineRows(tree, view({ expanded, sort: { key: "name", dir: "asc" } }))), [
    "notes . 0",
    "research - 3",
    "  archive . 0",
    "  findings - 1",
    "    evidence . 0",
    "blank - 1",
    "  draft . 0",
  ]);
  assert.deepEqual(shape(outlineRows(tree, view({ expanded, sort: { key: "updated", dir: "desc" } }))), [
    "notes . 0",
    "research - 3",
    "  archive . 0",
    "  findings - 1",
    "    evidence . 0",
    "blank - 1",
    "  draft . 0",
  ]);
  assert.deepEqual(shape(outlineRows(tree, view({ expanded, sort: { key: "updated", dir: "asc" } }))), [
    "blank - 1",
    "  draft . 0",
    "research - 3",
    "  findings - 1",
    "    evidence . 0",
    "  archive . 0",
    "notes . 0",
  ]);
  assert.deepEqual(shape(outlineRows(tree, view({ sort: { key: "pages", dir: "desc" } }))), [
    "research + 3",
    "blank + 1",
    "notes . 0",
  ]);
});

test("the filter keeps case-insensitive title matches plus their ancestors, opened", () => {
  assert.deepEqual(shape(outlineRows(tree, view({ filter: " EVID " }))), [
    "research - 3",
    "  findings - 1",
    "    evidence . 0",
  ]);
});

test("a matching parent without matching children stays closed while filtering, whatever was expanded", () => {
  assert.deepEqual(shape(outlineRows(tree, view({ filter: "find", expanded: new Set(["findings"]) }))), [
    "research - 3",
    "  findings + 1",
  ]);
});

test("untitled documents match and sort as Untitled", () => {
  assert.deepEqual(shape(outlineRows(tree, view({ filter: "untitled" }))), ["blank + 1"]);
});

test("a filter that matches nothing leaves no rows", () => {
  assert.deepEqual(shape(outlineRows(tree, view({ filter: "zzz" }))), []);
  assert.deepEqual(shape(outlineRows(tree, view({ filter: "draft" }))), ["blank - 1", "  draft . 0"]);
});

test("a header click starts a column in its natural direction and flips the active one", () => {
  assert.deepEqual(nextSort(null, "name"), { key: "name", dir: "asc" });
  assert.deepEqual(nextSort(null, "updated"), { key: "updated", dir: "desc" });
  assert.deepEqual(nextSort({ key: "updated", dir: "desc" }, "updated"), { key: "updated", dir: "asc" });
  assert.deepEqual(nextSort({ key: "name", dir: "desc" }, "pages"), { key: "pages", dir: "desc" });
});
