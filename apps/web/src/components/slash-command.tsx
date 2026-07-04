import { Extension, type Editor, type Range } from "@tiptap/core";
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
  { title: "Quote", hint: ">", run: (e, r) => e.chain().focus().deleteRange(r).toggleBlockquote().run() },
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
