import assert from "node:assert/strict";
import { test } from "node:test";
import {
  appendMarkdown,
  insertAfterHeading,
  MarkdownEditError,
  replaceSection,
  replaceText,
  scanTaskItems,
} from "./markdown-ops.js";

const doc = [
  "# Guide",
  "",
  "Intro paragraph.",
  "",
  "## Setup",
  "",
  "Run the installer.",
  "",
  "```bash",
  "# not a heading",
  "echo done",
  "```",
  "",
  "## Usage",
  "",
  "Call the API.",
  "",
  "### Advanced",
  "",
  "Tune the flags.",
].join("\n");

test("replaceText replaces a unique match", () => {
  const out = replaceText(doc, "Run the installer.", "Run `make install`.");
  assert.ok(out.includes("Run `make install`."));
  assert.ok(!out.includes("Run the installer."));
});

test("replaceText rejects missing and ambiguous targets", () => {
  assert.throws(() => replaceText(doc, "no such text", "x"), MarkdownEditError);
  assert.throws(() => replaceText("a b a", "a", "c"), /appears 2 times/);
  assert.equal(replaceText("a b a", "a", "c", true), "c b c");
  assert.throws(() => replaceText(doc, "", "x"), /must not be empty/);
  assert.throws(() => replaceText(doc, "same", "same"), /identical/);
});

test("insertAfterHeading inserts right below the heading", () => {
  const out = insertAfterHeading(doc, "Setup", "> Prerequisite: Node 20.");
  const lines = out.split("\n");
  const i = lines.indexOf("## Setup");
  assert.equal(lines[i + 1], "");
  assert.equal(lines[i + 2], "> Prerequisite: Node 20.");
  assert.ok(out.includes("Run the installer."), "existing content retained");
});

test("headings accept the # prefix form", () => {
  const out = insertAfterHeading(doc, "## Setup", "note");
  assert.ok(out.includes("note"));
});

test("unknown heading lists the available ones", () => {
  assert.throws(
    () => insertAfterHeading(doc, "Missing", "x"),
    /Headings in this document: "Guide", "Setup", "Usage", "Advanced"/,
  );
});

test("headings inside code fences are ignored", () => {
  assert.throws(() => insertAfterHeading(doc, "not a heading", "x"), MarkdownEditError);
});

test("replaceSection replaces up to the next same-level heading", () => {
  const out = replaceSection(doc, "Setup", "New setup body.");
  assert.ok(out.includes("## Setup\n\nNew setup body.\n\n## Usage"));
  assert.ok(!out.includes("Run the installer."));
  assert.ok(!out.includes("echo done"), "fenced block inside the section replaced too");
  assert.ok(out.includes("Call the API."), "next section untouched");
});

test("replaceSection keeps subsections within scope", () => {
  const out = replaceSection(doc, "Usage", "Just this.");
  assert.ok(!out.includes("### Advanced"), "subsection belongs to the section");
  assert.ok(!out.includes("Tune the flags."));
  assert.ok(out.includes("## Usage\n\nJust this."));
});

test("replaceSection at end of document", () => {
  const out = replaceSection(doc, "Advanced", "Rewritten tail.");
  assert.ok(out.trimEnd().endsWith("Rewritten tail."));
});

test("duplicate headings are rejected", () => {
  const dup = "## A\n\none\n\n## A\n\ntwo";
  assert.throws(() => replaceSection(dup, "A", "x"), /appears 2 times/);
});

test("appendMarkdown appends as a new block", () => {
  assert.equal(appendMarkdown("Body.", "Tail."), "Body.\n\nTail.");
  assert.equal(appendMarkdown("", "Only."), "Only.");
  assert.equal(appendMarkdown("Body.\n\n", "Tail."), "Body.\n\nTail.");
});

test("scanTaskItems finds tasks, states, and mentions outside fences", () => {
  const md = [
    "# Plan",
    "",
    "- [ ] @alice ship the thing",
    "- [x] @bob@corp.com review, cc @alice",
    "- regular bullet",
    "",
    "```",
    "- [ ] @carol not a real task",
    "```",
    "",
    "  - [ ] nested unassigned task",
  ].join("\n");
  const tasks = scanTaskItems(md);
  assert.equal(tasks.length, 3);
  assert.deepEqual(tasks[0], {
    line: 2,
    done: false,
    text: "@alice ship the thing",
    mentions: ["alice"],
  });
  assert.equal(tasks[1]!.done, true);
  assert.deepEqual(tasks[1]!.mentions, ["bob@corp.com", "alice"]);
  assert.deepEqual(tasks[2]!.mentions, []);
});
