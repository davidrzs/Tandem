import assert from "node:assert/strict";
import { test } from "node:test";
import { applyFoldChanges, deriveExpandedItems, diffExpandedItems, type FoldSnapshot } from "./folds.js";
import type { GroupId } from "./sidebarIndex.js";
import { sampleIndex } from "./testFixtures.js";

const snapshot = (s: { expanded?: string[]; collapsed?: string[]; groups?: GroupId[] }): FoldSnapshot => ({
  expandedCollections: new Set(s.expanded ?? []),
  collapsedDocs: new Set(s.collapsed ?? []),
  openGroups: new Set(s.groups ?? []),
});

test("apply persists each real flip and leaves groups session-only", () => {
  const { next, writes } = applyFoldChanges(snapshot({}), [
    { kind: "collection", id: "a", expanded: true },
    { kind: "doc", id: "p", expanded: false },
    { kind: "group", id: "archived:a", expanded: true },
  ]);
  assert.deepEqual(writes, [
    { kind: "collection", id: "a", expanded: true },
    { kind: "doc", id: "p", expanded: false },
  ]);
  assert.deepEqual([...next.expandedCollections], ["a"]);
  assert.deepEqual([...next.collapsedDocs], ["p"]);
  assert.deepEqual([...next.openGroups], ["archived:a"]);
});

test("apply is idempotent: a repeat returns the same snapshot and writes nothing", () => {
  const changes = [
    { kind: "collection", id: "a", expanded: true },
    { kind: "doc", id: "p", expanded: true },
  ] as const;
  const first = applyFoldChanges(snapshot({}), changes);
  assert.deepEqual(first.writes, [{ kind: "collection", id: "a", expanded: true }]);
  const second = applyFoldChanges(first.next, changes);
  assert.equal(second.next, first.next);
  assert.deepEqual(second.writes, []);
});

test("changes to one id in a batch coalesce to the last", () => {
  const s = snapshot({ collapsed: ["q"] });
  const { next, writes } = applyFoldChanges(s, [
    { kind: "doc", id: "p", expanded: false },
    { kind: "doc", id: "p", expanded: true },
    { kind: "doc", id: "q", expanded: true },
    { kind: "doc", id: "q", expanded: false },
    { kind: "collection", id: "a", expanded: true },
    { kind: "collection", id: "a", expanded: false },
  ]);
  assert.equal(next, s);
  assert.deepEqual(writes, []);
});

test("expandedItems covers folders inside expanded collections, hidden ones too", () => {
  const items = deriveExpandedItems(sampleIndex(), snapshot({ expanded: ["a"], collapsed: ["p"], groups: ["archived:a"] }));
  assert.deepEqual(items.sort(), ["a", "archived:a", "c1"]);
});

test("a collapsed collection contributes nothing", () => {
  assert.deepEqual(deriveExpandedItems(sampleIndex(), snapshot({ expanded: ["b"] })), ["b"]);
  assert.deepEqual(deriveExpandedItems(sampleIndex(), snapshot({ groups: ["archived:a"] })), []);
});

test("expandedItems is a new array on every call", () => {
  const index = sampleIndex();
  const s = snapshot({ expanded: ["a"] });
  assert.notEqual(deriveExpandedItems(index, s), deriveExpandedItems(index, s));
});

test("diff turns additions into expands and removals into collapses", () => {
  assert.deepEqual(diffExpandedItems(sampleIndex(), ["a", "p"], ["a", "c1", "trash:a"]), [
    { kind: "doc", id: "c1", expanded: true },
    { kind: "group", id: "trash:a", expanded: true },
    { kind: "doc", id: "p", expanded: false },
  ]);
});

test("diff ignores ids that cannot fold", () => {
  assert.deepEqual(diffExpandedItems(sampleIndex(), [], ["tandem:sidebar-root", "q", "x", "missing"]), []);
});

test("collapsing everything that is expanded leaves nothing expanded", () => {
  const index = sampleIndex();
  const s = snapshot({ expanded: ["a", "b"], groups: ["trash:a"] });
  const { next, writes } = applyFoldChanges(s, diffExpandedItems(index, deriveExpandedItems(index, s), []));
  assert.deepEqual(deriveExpandedItems(index, next), []);
  assert.deepEqual(
    writes.map((w) => `${w.kind}:${w.id}:${w.expanded}`).sort(),
    ["collection:a:false", "collection:b:false", "doc:c1:false", "doc:p:false"],
  );
});
