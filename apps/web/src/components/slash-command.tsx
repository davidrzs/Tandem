import { Extension, type Editor, type Range } from "@tiptap/core";
import { ReactRenderer } from "@tiptap/react";
import Suggestion, { type SuggestionOptions } from "@tiptap/suggestion";
import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useState,
  type ForwardedRef,
} from "react";
import tippy, { type Instance } from "tippy.js";

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
  { title: "Code block", hint: "```", run: (e, r) => e.chain().focus().deleteRange(r).toggleCodeBlock().run() },
  { title: "Quote", hint: ">", run: (e, r) => e.chain().focus().deleteRange(r).toggleBlockquote().run() },
  { title: "Divider", hint: "---", run: (e, r) => e.chain().focus().deleteRange(r).setHorizontalRule().run() },
];

interface MenuProps {
  items: SlashItem[];
  command: (item: SlashItem) => void;
}
export interface MenuHandle {
  onKeyDown: (e: KeyboardEvent) => boolean;
}

const SlashMenu = forwardRef(function SlashMenu(
  { items, command }: MenuProps,
  ref: ForwardedRef<MenuHandle>,
) {
  const [selected, setSelected] = useState(0);
  useEffect(() => setSelected(0), [items]);

  useImperativeHandle(ref, () => ({
    onKeyDown: (e) => {
      if (e.key === "ArrowUp") {
        setSelected((s) => (s + items.length - 1) % items.length);
        return true;
      }
      if (e.key === "ArrowDown") {
        setSelected((s) => (s + 1) % items.length);
        return true;
      }
      if (e.key === "Enter") {
        const item = items[selected];
        if (item) command(item);
        return true;
      }
      return false;
    },
  }));

  if (items.length === 0) return <div className="slash-menu">No matches</div>;
  return (
    <div className="slash-menu">
      {items.map((item, i) => (
        <button
          key={item.title}
          className={"slash-item" + (i === selected ? " selected" : "")}
          onMouseEnter={() => setSelected(i)}
          onClick={() => command(item)}
        >
          <span>{item.title}</span>
          <code>{item.hint}</code>
        </button>
      ))}
    </div>
  );
});

const suggestion: Omit<SuggestionOptions, "editor"> = {
  char: "/",
  items: ({ query }) =>
    ITEMS.filter((i) => i.title.toLowerCase().includes(query.toLowerCase())),
  command: ({ editor, range, props }) => (props as SlashItem).run(editor, range),
  render: () => {
    let component: ReactRenderer<MenuHandle, MenuProps>;
    let popup: Instance;
    return {
      onStart: (props) => {
        component = new ReactRenderer(SlashMenu, {
          props: { items: props.items as SlashItem[], command: props.command },
          editor: props.editor,
        });
        if (!props.clientRect) return;
        popup = tippy(document.body, {
          getReferenceClientRect: props.clientRect as () => DOMRect,
          appendTo: () => document.body,
          content: component.element,
          showOnCreate: true,
          interactive: true,
          trigger: "manual",
          placement: "bottom-start",
        });
      },
      onUpdate: (props) => {
        component.updateProps({ items: props.items as SlashItem[], command: props.command });
        if (props.clientRect) {
          popup?.setProps({ getReferenceClientRect: props.clientRect as () => DOMRect });
        }
      },
      onKeyDown: (props) => {
        if (props.event.key === "Escape") {
          popup?.hide();
          return true;
        }
        return component.ref?.onKeyDown(props.event) ?? false;
      },
      onExit: () => {
        popup?.destroy();
        component?.destroy();
      },
    };
  },
};

export const SlashCommand = Extension.create({
  name: "slashCommand",
  addProseMirrorPlugins() {
    return [Suggestion({ editor: this.editor, ...suggestion })];
  },
});
