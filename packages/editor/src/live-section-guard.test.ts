import assert from "node:assert/strict";
import { test } from "node:test";
import type { Node } from "@tiptap/pm/model";
import { EditorState, NodeSelection, TextSelection, type Selection, type Transaction } from "@tiptap/pm/state";
import type { EditorView } from "@tiptap/pm/view";
import { liveSectionGuard } from "./live-section-guard.js";
import { markdownToNode, nodeToMarkdown } from "./markdown.js";
import { schema } from "./schema.js";

const guard = liveSectionGuard();

function editor(doc: Node, select: (doc: Node) => Selection) {
  const view = {
    state: EditorState.create({ doc, selection: select(doc), plugins: [guard] }),
    dispatch(tr: Transaction) {
      view.state = view.state.apply(tr);
    },
  };
  return {
    view,
    key: (key: string) => guard.props.handleKeyDown!.call(guard, view as unknown as EditorView, { key } as never),
    type: (text: string) => {
      const { from, to } = view.state.selection;
      return guard.props.handleTextInput!.call(guard, view as unknown as EditorView, from, to, text, () => view.state.tr);
    },
    markdown: () => nodeToMarkdown(view.state.doc),
    selected: () => {
      const sel = view.state.selection;
      return sel instanceof NodeSelection ? `${sel.node.type.name}@${sel.from}` : `text@${sel.from}-${sel.to}`;
    },
  };
}

const MD = "Intro\n\n<!-- live-section: open_tasks_here -->\n\nAfter";
// "Intro" spans 0-7, the section 7-8, "After" 8-15.

test("typing over a selected live section writes a paragraph after it", () => {
  const e = editor(markdownToNode(MD), (doc) => NodeSelection.create(doc, 7));
  assert.equal(e.type("x"), true);
  assert.equal(e.markdown(), "Intro\n\n<!-- live-section: open_tasks_here -->\n\nx\n\nAfter");
  assert.equal(e.selected(), "text@10-10");
});

test("typing elsewhere is left to the editor", () => {
  const e = editor(markdownToNode(MD), (doc) => TextSelection.create(doc, 3));
  assert.equal(e.type("x"), false);
  assert.equal(e.markdown(), MD);
});

test("Backspace after a live section and Delete before it select it, deleting nothing", () => {
  const back = editor(markdownToNode(MD), (doc) => TextSelection.create(doc, 9));
  assert.equal(back.key("Backspace"), true);
  assert.deepEqual([back.markdown(), back.selected()], [MD, "liveSection@7"]);

  const forward = editor(markdownToNode(MD), (doc) => TextSelection.create(doc, 6));
  assert.equal(forward.key("Delete"), true);
  assert.deepEqual([forward.markdown(), forward.selected()], [MD, "liveSection@7"]);

  const inside = editor(markdownToNode(MD), (doc) => TextSelection.create(doc, 10));
  assert.equal(inside.key("Backspace"), false);
});

test("Backspace in an empty paragraph after a live section removes the paragraph and selects the section", () => {
  const doc = schema.node("doc", null, [
    schema.node("liveSection", { query: "open_tasks_here" }),
    schema.node("paragraph"),
    schema.node("paragraph", null, schema.text("Next")),
  ]);
  const e = editor(doc, (d) => TextSelection.create(d, 2));
  assert.equal(e.key("Backspace"), true);
  assert.deepEqual([e.markdown(), e.selected()], ["<!-- live-section: open_tasks_here -->\n\nNext", "liveSection@0"]);
});
