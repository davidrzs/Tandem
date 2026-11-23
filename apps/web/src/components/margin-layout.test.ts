import assert from "node:assert/strict";
import { test } from "node:test";
import { layoutMargin } from "./margin-layout.js";

const tops = (m: Map<string, number>) => Object.fromEntries(m);

test("cards with room sit at their anchors", () => {
  const out = layoutMargin(
    [
      { key: "a", y: 0, h: 40 },
      { key: "b", y: 100, h: 40 },
    ],
    null,
  );
  assert.deepEqual(tops(out), { a: 0, b: 100 });
});

test("without an active card, crowded cards flow down in document order", () => {
  const out = layoutMargin(
    [
      { key: "b", y: 10, h: 50 },
      { key: "a", y: 0, h: 50 },
      { key: "c", y: 20, h: 50 },
    ],
    null,
    10,
  );
  assert.deepEqual(tops(out), { a: 0, b: 60, c: 120 });
});

test("the active card holds its anchor and pushes neighbours both ways", () => {
  const out = layoutMargin(
    [
      { key: "a", y: 0, h: 50 },
      { key: "b", y: 20, h: 50 },
      { key: "c", y: 40, h: 50 },
    ],
    "b",
    10,
  );
  assert.deepEqual(tops(out), { a: -40, b: 20, c: 80 });
});

test("an unknown active key falls back to flowing from the first card", () => {
  const out = layoutMargin([{ key: "a", y: 5, h: 10 }], "gone");
  assert.deepEqual(tops(out), { a: 5 });
});

test("no cards, no tops", () => {
  assert.equal(layoutMargin([], "a").size, 0);
});
