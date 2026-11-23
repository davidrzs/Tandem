import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { test } from "node:test";
import { getSchema } from "@tiptap/core";
import { LiveSection, schema } from "@tandem/editor";

// The node views import stylesheets (KaTeX); Node can't load CSS, and the
// schema doesn't need it.
registerHooks({
  load: (url, context, next) =>
    url.endsWith(".css") ? { format: "module", source: "", shortCircuit: true } : next(url, context),
});
const { contentExtensions } = await import("./content-extensions.js");

// A read-only render (version preview, live-section embed) that lacks a node
// type rejects the whole document and shows it blank. Every node and mark the
// stored documents can contain must be known to the shared content set.
test("read-only editors know every node and mark of the document schema", () => {
  const readOnly = getSchema(contentExtensions(LiveSection));
  const missingNodes = Object.keys(schema.nodes).filter((n) => !readOnly.nodes[n]);
  const missingMarks = Object.keys(schema.marks).filter((m) => !readOnly.marks[m]);
  assert.deepEqual(missingNodes, []);
  assert.deepEqual(missingMarks, []);
});
