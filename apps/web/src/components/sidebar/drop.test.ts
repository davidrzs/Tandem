import assert from "node:assert/strict";
import { test } from "node:test";
import { canDragNode, planDrop, positionBetween } from "./drop.js";
import { ROOT_ID, buildSidebarIndex } from "./sidebarIndex.js";
import { collection, doc, ready, sampleIndex, sampleInput } from "./testFixtures.js";

const index = sampleIndex();
const into = (targetId: string) => ({ kind: "into", targetId }) as const;
const between = (parentId: string, i: number) => ({ kind: "between", parentId, index: i }) as const;

test("positionBetween takes the midpoint, or steps one past a lone neighbour", () => {
  assert.deepEqual(
    [positionBetween(1, 2), positionBetween(3, undefined), positionBetween(undefined, 3), positionBetween(undefined, undefined)],
    [1.5, 4, 2, undefined],
  );
});

test("into a doc appends there, unfolds it, and remembers where Undo goes", () => {
  assert.deepEqual(planDrop(index, "q", into("c2")), {
    kind: "doc",
    id: "q",
    collectionId: "a",
    title: "q",
    to: { parentDocumentId: "c2" },
    from: { parentDocumentId: null, position: 2 },
    reveal: "c2",
  });
});

test("into its own collection moves a doc to the top level", () => {
  const plan = planDrop(index, "g", into("a"));
  assert.deepEqual(plan?.kind === "doc" && plan.to, { parentDocumentId: null });
  assert.deepEqual(plan?.kind === "doc" && plan.from, { parentDocumentId: "c1", position: 1 });
});

test("a doc can't leave its collection or land on itself, its descendants or non-doc rows", () => {
  assert.deepEqual(
    [into("b"), into("c1"), into("g"), into("archived:a"), into("x"), into("t"), into(ROOT_ID)].map((slot) =>
      planDrop(index, "c1", slot),
    ),
    [null, null, null, null, null, null, null],
  );
  assert.deepEqual(
    [between("g", 0), between("b", 0), between(ROOT_ID, 0), between("archived:a", 0)].map((slot) =>
      planDrop(index, "c1", slot),
    ),
    [null, null, null, null],
  );
});

test("into its current parent stays legal, appending at the end", () => {
  const plan = planDrop(index, "c1", into("p"));
  assert.deepEqual(plan?.kind === "doc" && plan.to, { parentDocumentId: "p" });
});

test("between docs lands on the midpoint of the new neighbours", () => {
  const plan = planDrop(index, "q", between("p", 1));
  assert.deepEqual(plan?.kind === "doc" && plan.to, { parentDocumentId: "p", position: 1.5 });
  const top = planDrop(index, "c2", between("a", 0));
  assert.deepEqual(top?.kind === "doc" && top.to, { parentDocumentId: null, position: 0 });
  const end = planDrop(index, "c2", between("a", 2));
  assert.deepEqual(end?.kind === "doc" && end.to, { parentDocumentId: null, position: 3 });
});

test("a doc never lands below the Archived/Trash rows", () => {
  assert.equal(planDrop(index, "c2", between("a", 3)), null);
});

test("dropping a doc back into its own slot is no move", () => {
  assert.equal(planDrop(index, "q", between("a", 1)), null);
  assert.equal(planDrop(index, "c1", between("p", 0)), null);
  assert.notEqual(planDrop(index, "c1", between("p", 1)), null);
});

test("readers can't drag or drop", () => {
  const ro = buildSidebarIndex({
    collections: [collection("r", 1, false)],
    trees: new Map([["r", ready([doc("d1", 1), doc("d2", 2)])]]),
    archived: new Map(),
    trash: new Map(),
  });
  assert.equal(canDragNode(ro.nodes.get("d1")!), false);
  assert.equal(canDragNode(ro.nodes.get("r")!), false);
  assert.equal(planDrop(ro, "d1", into("d2")), null);
  assert.equal(planDrop(ro, "r", into(ROOT_ID)), null);
  assert.deepEqual(
    ["q", "a", "archived:a", "x", "t"].map((id) => canDragNode(index.nodes.get(id)!)),
    [true, true, false, false, false],
  );
});

test("collections reorder between collections at the midpoint", () => {
  assert.deepEqual(planDrop(index, "a", between(ROOT_ID, 1)), { kind: "collection", id: "a", position: 2.5 });
  assert.deepEqual(planDrop(index, "b", between(ROOT_ID, 0)), { kind: "collection", id: "b", position: 0 });
  assert.equal(planDrop(index, "a", between(ROOT_ID, 0)), null);
});

test("into the root moves a collection to the end, even when it is already there", () => {
  assert.deepEqual(planDrop(index, "a", into(ROOT_ID)), { kind: "collection", id: "a", position: 4 });
  const input = sampleInput();
  const two = buildSidebarIndex({ ...input, collections: input.collections.slice(0, 2) });
  assert.deepEqual(planDrop(two, "b", into(ROOT_ID)), { kind: "collection", id: "b", position: 2 });
});

test("collections never nest", () => {
  assert.equal(planDrop(index, "a", into("b")), null);
  assert.equal(planDrop(index, "a", into("p")), null);
  assert.equal(planDrop(index, "a", between("b", 0)), null);
});
