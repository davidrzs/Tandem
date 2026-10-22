import assert from "node:assert/strict";
import { test } from "node:test";
import { parseFrontMatter } from "./markdown-zip.js";
import { importValue, inferFields, parseSidecar } from "./properties-yaml.js";

const vault = [
  [
    "---",
    "rating: 3",
    "done: true",
    "due: 2026-10-01",
    'version: "1.10"',
    'answer: "no"',
    "shipped: no",
    "meta:",
    "  owner: ana",
    "people:",
    '  - "[[Bo]]"',
    '  - "[[Cy|Cyrus]]"',
    'lead: "[[Bo]]"',
    "mixed: 5",
    "labels: [x, y]",
    "when: 2026-10-01",
    "---",
    "Body",
  ].join("\n"),
  [
    "---",
    "Rating: 4.5",
    "done: false",
    "due: 2026-10-02",
    'version: "2.0"',
    "answer: yes",
    "people: []",
    'lead: ["[[Ana]]"]',
    "mixed: five",
    "labels: z",
    "when: 2026-10-01T09:30",
    "blank:",
    "---",
    "Body",
  ].join("\n"),
];

test("inferFields gives each key one kind across the vault, the way Obsidian does", () => {
  const inferred = inferFields(vault.map((md) => parseFrontMatter(md).properties));
  assert.deepEqual(Object.fromEntries(inferred), {
    rating: { key: "rating", kind: "number", options: [], mixed: null },
    done: { key: "done", kind: "checkbox", options: [], mixed: null },
    due: { key: "due", kind: "date", options: [], mixed: null },
    version: { key: "version", kind: "text", options: [], mixed: null },
    answer: { key: "answer", kind: "text", options: [], mixed: null },
    shipped: { key: "shipped", kind: "text", options: [], mixed: null },
    meta: { key: "meta", kind: "json", options: [], mixed: null },
    people: { key: "people", kind: "doc_list", options: [], mixed: null },
    lead: { key: "lead", kind: "doc_list", options: [], mixed: null },
    mixed: { key: "mixed", kind: "text", options: [], mixed: ["number", "text"] },
    labels: { key: "labels", kind: "multi_select", options: ["x", "y", "z"], mixed: null },
    when: { key: "when", kind: "datetime", options: [], mixed: null },
    blank: { key: "blank", kind: "text", options: [], mixed: null },
  });
});

test("inferFields keeps disagreeing lists and maps as json", () => {
  const inferred = inferFields([{ spec: ["a", "b"] }, { spec: 3 }, { spec: { nested: true } }]);
  assert.deepEqual(inferred.get("spec"), {
    key: "spec",
    kind: "json",
    options: [],
    mixed: ["multi_select", "number", "json"],
  });
});

test("importValue stores option ids and page ids, and reports what doesn't fit", () => {
  const status = {
    id: "f1",
    key: "status",
    kind: "multi_select" as const,
    options: [
      { id: "o1", label: "Todo" },
      { id: "o2", label: "Done" },
    ],
  };
  assert.deepEqual(importValue(status, ["done", "Todo", "Later"], () => null), {
    value: ["o2", "o1"],
    problems: ['"Later": "Later" is not an option'],
  });

  const pages: Record<string, string> = { bo: "11111111-1111-4111-8111-111111111111" };
  const people = { id: "f2", key: "people", kind: "doc_list" as const, options: [] };
  assert.deepEqual(
    importValue(people, ["[[Bo|Bob]]", "[[Bo#Intro]]", "[[Nobody]]"], (t) => pages[t.toLowerCase()] ?? null),
    { value: ["11111111-1111-4111-8111-111111111111"], problems: ["unresolved link [[Nobody]]"] },
  );
  const due = { id: "f3", key: "due", kind: "date" as const, options: [] };
  assert.deepEqual(importValue(due, "2026-13-45", () => null), {
    value: null,
    problems: ['"2026-13-45": expected a date (YYYY-MM-DD)'],
  });
  assert.deepEqual(importValue(due, ["2026-01-02", "2026-01-03"], () => null), {
    value: null,
    problems: ["expected one value, not a list"],
  });
  const when = { id: "f4", key: "when", kind: "datetime" as const, options: [] };
  assert.deepEqual(importValue(when, "2026-10-01T09:30", () => null), {
    value: "2026-10-01T09:30:00.000Z",
    problems: [],
  });
});

test("parseSidecar reads a fields file and refuses anything else", () => {
  const sidecar = {
    version: 1,
    types: [{ id: "t1", name: "Meeting" }],
    fields: [{ id: "f1", key: "status", label: "Status", kind: "select", type: "Meeting", options: [{ id: "o1", label: "Done" }] }],
  };
  assert.deepEqual(parseSidecar(JSON.stringify(sidecar)), sidecar);
  assert.equal(parseSidecar(JSON.stringify({ ...sidecar, version: 2 })), null);
  assert.equal(parseSidecar("{not json"), null);
});
