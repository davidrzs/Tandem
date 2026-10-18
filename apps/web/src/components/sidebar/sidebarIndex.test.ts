import assert from "node:assert/strict";
import { test } from "node:test";
import { ROOT_ID, ancestorPath, buildSidebarIndex, isFolderNode, nodeLabel } from "./sidebarIndex.js";
import { collection, doc, ready, sampleIndex, sampleInput } from "./testFixtures.js";

test("collections list root docs in server order, then Archived, then Trash", () => {
  const { nodes } = sampleIndex();
  assert.deepEqual(nodes.get(ROOT_ID)?.childIds, ["a", "b", "r"]);
  assert.deepEqual(nodes.get("a")?.childIds, ["p", "q", "archived:a", "trash:a"]);
  assert.deepEqual(nodes.get("p")?.childIds, ["c1", "c2"]);
  assert.deepEqual(nodes.get("archived:a")?.childIds, ["x"]);
  assert.deepEqual(nodes.get("trash:a")?.childIds, ["t"]);
});

test("doc nodes carry their server parent: null at the collection root", () => {
  const { nodes } = sampleIndex();
  const p = nodes.get("p");
  const g = nodes.get("g");
  assert.equal(p?.kind === "doc" && p.parentDocumentId, null);
  assert.equal(g?.kind === "doc" && g.parentDocumentId, "c1");
  assert.equal(g?.kind === "doc" && g.collectionId, "a");
});

test("load state follows the tree query; collapsed collections are idle", () => {
  const input = sampleInput();
  const index = buildSidebarIndex({
    ...input,
    trees: new Map([
      ...input.trees,
      ["b", { status: "pending", data: undefined }],
      ["r", { status: "error", data: undefined }],
    ]),
  });
  const load = (id: string) => {
    const n = index.nodes.get(id);
    return n?.kind === "collection" ? n.load : null;
  };
  assert.deepEqual(["a", "b", "r"].map(load), ["ready", "loading", "error"]);
  const collapsed = sampleIndex().nodes.get("b");
  assert.equal(collapsed?.kind === "collection" && collapsed.load, "idle");
});

test("a doc listed twice keeps its first position, so the index stays a tree", () => {
  const index = buildSidebarIndex({
    collections: [collection("a", 1)],
    trees: new Map([["a", ready([doc("p", 1, [doc("dup", 1)]), doc("dup", 2)])]]),
    archived: new Map(),
    trash: new Map(),
  });
  assert.deepEqual(index.nodes.get("a")?.childIds, ["p"]);
  assert.deepEqual(index.nodes.get("p")?.childIds, ["dup"]);
});

test("labels name what the row shows", () => {
  const { nodes } = sampleIndex();
  assert.deepEqual(
    ["a", "p", "archived:a", "trash:a", "t"].map((id) => nodeLabel(nodes.get(id)!)),
    ["A", "p", "Archived (1)", "Trash (1)", "Untitled"],
  );
});

test("only collections, groups and docs with children fold", () => {
  const { nodes } = sampleIndex();
  assert.deepEqual(
    ["a", "archived:a", "p", "q", "x", "t"].map((id) => isFolderNode(nodes.get(id)!)),
    [true, true, true, false, false, false],
  );
});

test("every build returns a new index", () => {
  const input = sampleInput();
  assert.notEqual(buildSidebarIndex(input), buildSidebarIndex(input));
});

test("ancestorPath lists the parent chain outermost first", () => {
  const tree = [doc("p", 1, [doc("c1", 1, [doc("g", 1)])]), doc("q", 2)];
  assert.deepEqual(ancestorPath(tree, "g"), ["p", "c1"]);
  assert.deepEqual(ancestorPath(tree, "q"), []);
  assert.equal(ancestorPath(tree, "missing"), null);
});
