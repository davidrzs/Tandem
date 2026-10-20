import assert from "node:assert/strict";
import { test } from "node:test";
import type { FoldWrite } from "./folds.js";
import { createFoldStore } from "./useFoldState.js";

const storeWith = (local: { expanded?: string[]; collapsed?: string[] }) => {
  const store = createFoldStore({
    expandedCollections: new Set(local.expanded ?? []),
    collapsedDocs: new Set(local.collapsed ?? []),
    openGroups: new Set(["archived:a"]),
  });
  const writes: FoldWrite[] = [];
  store.setPersist((w) => writes.push(w));
  const state = () => {
    const s = store.get();
    return { expanded: [...s.expandedCollections], collapsed: [...s.collapsedDocs], groups: [...s.openGroups] };
  };
  return { store, writes, state };
};

test("server fold state replaces local state without writing back", () => {
  const { store, writes, state } = storeWith({ expanded: ["a", "b"], collapsed: ["p"] });
  store.reconcile({ expandedCollections: ["c"], collapsedDocs: ["q"] }, null);
  assert.deepEqual(state(), { expanded: ["c"], collapsed: ["q"], groups: ["archived:a"] });
  assert.deepEqual(writes, []);
});

test("an empty server adopts local-only state server-side and keeps it", () => {
  const { store, writes, state } = storeWith({ expanded: ["a", "b"], collapsed: ["p"] });
  store.reconcile({ expandedCollections: [], collapsedDocs: [] }, "c");
  assert.deepEqual(writes, [
    { kind: "collection", id: "a", expanded: true },
    { kind: "collection", id: "b", expanded: true },
  ]);
  assert.deepEqual(state(), { expanded: ["a", "b"], collapsed: ["p"], groups: ["archived:a"] });
});

test("an empty server with no local state leaves only the active collection open", () => {
  const { store, writes, state } = storeWith({});
  store.reconcile({ expandedCollections: [], collapsedDocs: [] }, "a");
  assert.deepEqual(state(), { expanded: ["a"], collapsed: [], groups: ["archived:a"] });
  assert.deepEqual(writes, []);
});

test("the active collection stays open even when the server has it folded", () => {
  const { store, state } = storeWith({ expanded: ["a"] });
  store.reconcile({ expandedCollections: ["b"], collapsedDocs: ["p"] }, "a");
  assert.deepEqual(state(), { expanded: ["b", "a"], collapsed: ["p"], groups: ["archived:a"] });
});

test("apply persists each flip and notifies subscribers", () => {
  const { store, writes, state } = storeWith({ expanded: ["a"] });
  let notified = 0;
  store.subscribe(() => notified++);
  store.apply([
    { kind: "collection", id: "a", expanded: false },
    { kind: "doc", id: "p", expanded: false },
  ]);
  store.apply([{ kind: "doc", id: "p", expanded: false }]);
  assert.deepEqual(state(), { expanded: [], collapsed: ["p"], groups: ["archived:a"] });
  assert.deepEqual(writes, [
    { kind: "collection", id: "a", expanded: false },
    { kind: "doc", id: "p", expanded: false },
  ]);
  assert.equal(notified, 1);
});
