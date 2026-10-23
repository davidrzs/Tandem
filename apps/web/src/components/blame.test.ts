import assert from "node:assert/strict";
import { test } from "node:test";
import { authorLabel } from "./blame.js";

test("an agent stamp names the agent after the owner's AI", () => {
  assert.equal(
    authorLabel({ userId: "u1", name: "David", ai: true, agent: "Claude" }),
    "David's AI (Claude)",
  );
});

test("a stamp without an agent keeps the plain AI label", () => {
  assert.equal(authorLabel({ userId: "u1", name: "David", ai: true }), "David's AI");
});

test("a human stamp shows the name alone", () => {
  assert.equal(authorLabel({ userId: "u1", name: "David", ai: false }), "David");
});

test("the local system agent keeps its stored name", () => {
  assert.equal(authorLabel({ userId: "system", name: "System", ai: true }), "System");
});
