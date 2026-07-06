import { Extension, type Editor, type Range } from "@tiptap/core";
import { TextSelection } from "@tiptap/pm/state";
import Suggestion from "@tiptap/suggestion";
import { suggestionRender } from "./suggestion-menu.js";

interface SlashItem {
  title: string;
  hint: string;
  run: (editor: Editor, range: Range) => void;
}

const ITEMS: SlashItem[] = [
  { title: "Heading 1", hint: "#", run: (e, r) => e.chain().focus().deleteRange(r).setNode("heading", { level: 1 }).run() },
  { title: "Heading 2", hint: "##", run: (e, r) => e.chain().focus().deleteRange(r).setNode("heading", { level: 2 }).run() },
  { title: "Heading 3", hint: "###", run: (e, r) => e.chain().focus().deleteRange(r).setNode("heading", { level: 3 }).run() },
  { title: "Bullet list", hint: "-", run: (e, r) => e.chain().focus().deleteRange(r).toggleBulletList().run() },
  { title: "Numbered list", hint: "1.", run: (e, r) => e.chain().focus().deleteRange(r).toggleOrderedList().run() },
  { title: "To-do list", hint: "[ ]", run: (e, r) => e.chain().focus().deleteRange(r).toggleTaskList().run() },
  { title: "Code block", hint: "```", run: (e, r) => e.chain().focus().deleteRange(r).toggleCodeBlock().run() },
  { title: "Table", hint: "▦", run: (e, r) => e.chain().focus().deleteRange(r).insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run() },
  { title: "Quote", hint: ">", run: (e, r) => e.chain().focus().deleteRange(r).toggleBlockquote().run() },
  { title: "Callout", hint: "[!]", run: (e, r) => e.chain().focus().deleteRange(r).wrapIn("callout", { type: "note" }).run() },
  {
    title: "Toggle",
    hint: "▸",
    run: (e, r) => {
      e
        .chain()
        .focus()
        .deleteRange(r)
        .insertContent({
          type: "toggle",
          content: [
            { type: "toggleSummary" },
            { type: "toggleContent", content: [{ type: "paragraph" }] },
          ],
        })
        .run();
      // Land the caret inside the new toggle's summary so you can type the title.
      let target: number | null = null;
      e.state.doc.descendants((node, pos) => {
        if (target !== null) return false;
        if (node.type.name === "toggleSummary" && pos >= r.from - 2) target = pos + 1;
        return target === null;
      });
      if (target !== null) {
        e.view.dispatch(e.state.tr.setSelection(TextSelection.create(e.state.doc, target)));
      }
    },
  },
  { title: "Divider", hint: "---", run: (e, r) => e.chain().focus().deleteRange(r).setHorizontalRule().run() },
];

export const SlashCommand = Extension.create({
  name: "slashCommand",
  addProseMirrorPlugins() {
    return [
      Suggestion({
        editor: this.editor,
        char: "/",
        items: ({ query }) =>
          ITEMS.filter((i) => i.title.toLowerCase().includes(query.toLowerCase())),
        command: ({ editor, range, props }) => (props as SlashItem).run(editor, range),
        render: suggestionRender<SlashItem>(
          (item) => (
            <>
              <span>{item.title}</span>
              <code>{item.hint}</code>
            </>
          ),
          (item) => item.title,
        ),
      }),
    ];
  },
});
