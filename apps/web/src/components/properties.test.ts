import assert from "node:assert/strict";
import { test } from "node:test";
import {
  aiMarks,
  datetimeFromInput,
  datetimeToInput,
  describeDefault,
  editFromText,
  EXPRESSION_CHOICES,
  formatValue,
  keyFromLabel,
  literalDefault,
  patchFor,
  propertyColumns,
  safeHref,
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

test("a link value becomes an href only when it is an http(s) URL", () => {
  assert.equal(safeHref("https://example.com/a?b=1"), "https://example.com/a?b=1");
  assert.equal(safeHref("http://example.com"), "http://example.com");
  assert.equal(safeHref("javascript:alert(1)"), null);
  assert.equal(safeHref(" JavaScript:alert(1)"), null);
  assert.equal(safeHref("data:text/html,<script>alert(1)</script>"), null);
  assert.equal(safeHref("/d/123"), null);
  assert.equal(safeHref("example.com"), null);
  assert.equal(safeHref(42), null);
});

test("a datetime-local value round-trips through the stored UTC instant in the reader's zone", () => {
  process.env.TZ = "America/New_York";
  assert.equal(datetimeFromInput("2026-10-22T14:30"), "2026-10-22T18:30:00.000Z");
  assert.equal(datetimeToInput("2026-10-22T18:30:00.000Z"), "2026-10-22T14:30");
  assert.equal(datetimeFromInput(""), null);
  assert.equal(datetimeToInput(null), "");
});

test("stored values format for reading: labels, dates, checkboxes, page titles, restricted pages", () => {
  const titles: Record<string, string | null> = { d1: "Q3 plan", d2: "", d3: null };
  const opts = { locale: "en-US", timeZone: "UTC", titleOf: (id: string) => titles[id] };
  assert.equal(formatValue(status, "opt_open", opts), "Open");
  assert.equal(formatValue(topics, ["opt_budget", "opt_hiring"], opts), "Budget, Hiring");
  assert.equal(formatValue(field("due", "date"), "2026-10-22", opts), "Oct 22, 2026");
  assert.equal(formatValue(field("starts", "datetime"), "2026-10-22T18:30:00.000Z", opts), "Oct 22, 2026, 6:30 PM");
  assert.equal(formatValue(field("done", "checkbox"), false, opts), "No");
  assert.equal(formatValue(field("cost", "number"), 1250, opts), "1,250");
  assert.equal(formatValue(field("notes", "doc_list"), ["d1", "d2", "d3", "d4"], opts), "Q3 plan, Untitled, Restricted page, Untitled");
  assert.equal(formatValue(field("owner", "doc"), "d3", opts), "Restricted page");
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

test("template defaults: a widget edit becomes the new literal, an emptied list clears it", () => {
  assert.deepEqual(literalDefault(undefined, { op: "set", value: "opt_done" }), { kind: "value", value: "opt_done" });
  assert.deepEqual(literalDefault(undefined, { op: "set", value: 3 }), { kind: "value", value: 3 });
  assert.deepEqual(literalDefault(["opt_budget"], { op: "add", value: "opt_hiring" }), {
    kind: "value",
    value: ["opt_budget", "opt_hiring"],
  });
  assert.deepEqual(literalDefault(["opt_budget"], { op: "add", value: "opt_budget" }), {
    kind: "value",
    value: ["opt_budget"],
  });
  assert.equal(literalDefault(["opt_budget"], { op: "remove", value: "opt_budget" }), null);
  assert.equal(literalDefault("opt_done", { op: "clear" }), null);
});

test("template defaults: each kind is offered only the expressions that fit it, and defaults read as text", () => {
  const offered = (kind: Field["kind"]) => EXPRESSION_CHOICES.filter((c) => c.fits(kind)).map((c) => c.kind);
  assert.deepEqual(offered("date"), ["today", "from_previous_sibling"]);
  assert.deepEqual(offered("datetime"), ["now", "from_previous_sibling"]);
  assert.deepEqual(offered("text"), ["me", "from_previous_sibling"]);
  assert.deepEqual(offered("doc_list"), ["from_previous_sibling"]);
  assert.deepEqual(offered("json"), []);
  assert.equal(describeDefault(status, { kind: "value", value: "opt_done" }), "Done");
  assert.equal(describeDefault(topics, { kind: "from_previous_sibling" }), "Same as the previous page");
  assert.equal(describeDefault(status, undefined), "No default");
});
