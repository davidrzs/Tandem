import assert from "node:assert/strict";
import { test } from "node:test";
import {
  aiMarks,
  datetimeFromInput,
  datetimeToInput,
  editFromText,
  formatValue,
  keyFromLabel,
  patchFor,
  propertyColumns,
  summaryText,
  type Field,
} from "./properties.js";

const field = (key: string, kind: Field["kind"], extra: Partial<Field> = {}): Field => ({
  id: `fld_${key}`,
  workspaceId: "ws",
  typeId: "type_meeting",
  key,
  label: key[0]!.toUpperCase() + key.slice(1),
  kind,
  position: 0,
  options: [],
  retired: false,
  aliases: [],
  typeName: "Meeting",
  ...extra,
});
const status = field("status", "select", {
  options: [
    { id: "opt_open", label: "Open" },
    { id: "opt_done", label: "Done" },
  ],
});
const topics = field("topics", "multi_select", {
  options: [
    { id: "opt_budget", label: "Budget" },
    { id: "opt_hiring", label: "Hiring" },
  ],
});

test("each widget edit becomes one patch op on the field's key", () => {
  assert.deepEqual(patchFor(status, { op: "set", value: "opt_done" }), { set: { status: "opt_done" } });
  assert.deepEqual(patchFor(status, { op: "clear" }), { unset: ["status"] });
  assert.deepEqual(patchFor(topics, { op: "add", value: "opt_hiring" }), { add: { topics: ["opt_hiring"] } });
  assert.deepEqual(patchFor(topics, { op: "remove", value: "opt_budget" }), {
    remove: { topics: ["opt_budget"] },
  });
});

test("typed text: blank clears, numbers parse, an unparsable number is no edit, urls trim, text keeps spaces", () => {
  assert.deepEqual(editFromText("number", " 42.5 "), { op: "set", value: 42.5 });
  assert.equal(editFromText("number", "4 2"), null);
  assert.deepEqual(editFromText("number", "  "), { op: "clear" });
  assert.deepEqual(editFromText("url", " https://example.com "), { op: "set", value: "https://example.com" });
  assert.deepEqual(editFromText("text", " Weekly sync "), { op: "set", value: " Weekly sync " });
});

test("a datetime-local value round-trips through the stored UTC instant in the reader's zone", () => {
  process.env.TZ = "America/New_York";
  assert.equal(datetimeFromInput("2026-10-22T14:30"), "2026-10-22T18:30:00.000Z");
  assert.equal(datetimeToInput("2026-10-22T18:30:00.000Z"), "2026-10-22T14:30");
  assert.equal(datetimeFromInput(""), null);
  assert.equal(datetimeToInput(null), "");
});

test("stored values format for reading: labels, dates, checkboxes, page titles", () => {
  const opts = { locale: "en-US", timeZone: "UTC", titleOf: (id: string) => ({ d1: "Q3 plan" })[id] };
  assert.equal(formatValue(status, "opt_open", opts), "Open");
  assert.equal(formatValue(topics, ["opt_budget", "opt_hiring"], opts), "Budget, Hiring");
  assert.equal(formatValue(field("due", "date"), "2026-10-22", opts), "Oct 22, 2026");
  assert.equal(formatValue(field("starts", "datetime"), "2026-10-22T18:30:00.000Z", opts), "Oct 22, 2026, 6:30 PM");
  assert.equal(formatValue(field("done", "checkbox"), false, opts), "No");
  assert.equal(formatValue(field("cost", "number"), 1250, opts), "1,250");
  assert.equal(formatValue(field("notes", "doc_list"), ["d1", "d2"], opts), "Q3 plan, Untitled");
  assert.equal(formatValue(field("raw", "json"), { a: [1] }, opts), '{"a":[1]}');
  assert.equal(formatValue(status, null, opts), "");
});

test("the collapsed summary lists set fields in order, or says none are set", () => {
  const due = field("due", "date");
  assert.equal(
    summaryText([status, due, topics], { fld_status: "opt_done", fld_topics: [] , fld_due: "2026-10-22" }, { locale: "en-US" }),
    "Status: Done · Due: Oct 22, 2026",
  );
  assert.equal(summaryText([status, due], {}), "No values yet");
});

test("AI marks keep only agent-written values, labelled with the agent", () => {
  const authors = new Map([
    [1, { userId: "u1", name: "David", ai: false, at: 1 }],
    [2, { userId: "u1", name: "David", ai: true, at: 2, agent: "Claude" }],
  ]);
  const marks = aiMarks(
    [
      { field: "fld_status", value: "opt_done", clientId: 2 },
      { field: "fld_topics", value: "opt_budget", clientId: 1 },
      { field: "fld_topics", value: "opt_hiring", clientId: 2 },
      { field: "fld_due", value: null, clientId: 2 },
    ],
    authors,
  );
  assert.deepEqual(marks, {
    fld_status: [{ value: "opt_done", label: "David's AI (Claude)", agent: "Claude" }],
    fld_topics: [{ value: "opt_hiring", label: "David's AI (Claude)", agent: "Claude" }],
  });
});

test("property columns: the shared type's first three table-friendly fields, none for a mix", () => {
  const fields = [
    status,
    field("notes", "doc_list"),
    field("due", "date"),
    field("old", "text", { retired: true }),
    topics,
    field("cost", "number"),
    field("other", "text", { typeId: "type_paper" }),
  ];
  const typed = [{ typeId: "type_meeting" }, { typeId: "type_meeting" }];
  assert.deepEqual(propertyColumns(typed, fields).map((f) => f.key), ["status", "due", "topics"]);
  assert.deepEqual(propertyColumns([...typed, { typeId: null }], fields), []);
  assert.deepEqual(propertyColumns([], fields), []);
});

test("a typed field label becomes a key", () => {
  assert.equal(keyFromLabel("  Due date / Time "), "due_date_time");
});
