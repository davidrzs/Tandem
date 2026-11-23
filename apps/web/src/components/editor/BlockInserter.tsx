import type { Editor } from "@tiptap/react";
import { type RefObject, useEffect, useState } from "react";
import { Icon } from "../Icon.js";

/** Blocks whose empty paragraphs are not a place to start a new block. */
const NO_INSERT_INSIDE = new Set(["tableCell", "tableHeader", "listItem", "taskItem", "toggleSummary"]);

/** Where the caret's empty line sits within `frame`, or null when the caret
 * is not on an empty paragraph the reader could turn into a block. */
function emptyLineTop(editor: Editor, frame: HTMLElement): number | null {
  const { state, view } = editor;
  const sel = state.selection;
  if (!editor.isEditable || !sel.empty || !view.hasFocus()) return null;
  const { $from } = sel;
  if ($from.parent.type.name !== "paragraph" || $from.parent.content.size > 0) return null;
  for (let d = $from.depth - 1; d > 0; d--) {
    if (NO_INSERT_INSIDE.has($from.node(d).type.name)) return null;
  }
  const line = view.coordsAtPos(sel.from);
  return (line.top + line.bottom) / 2 - frame.getBoundingClientRect().top;
}

/** A "+" in the left margin of the empty line under the caret. It opens the
 * slash menu, so it offers exactly what typing "/" does. */
export function BlockInserter({ editor, frame }: { editor: Editor; frame: RefObject<HTMLElement> }) {
  const [top, setTop] = useState<number | null>(null);

  useEffect(() => {
    const update = () => setTop(frame.current ? emptyLineTop(editor, frame.current) : null);
    const events = ["selectionUpdate", "transaction", "focus", "blur"] as const;
    for (const e of events) editor.on(e, update);
    window.addEventListener("resize", update);
    return () => {
      for (const e of events) editor.off(e, update);
      window.removeEventListener("resize", update);
    };
  }, [editor, frame]);

  if (top === null) return null;
  return (
    <button
      type="button"
      className="block-inserter"
      style={{ top }}
      aria-label="Insert block"
      title="Insert a block (or type /)"
      tabIndex={-1}
      // Keep the editor focused: a blur would hide the button mid-click.
      onMouseDown={(e) => e.preventDefault()}
      onClick={() => editor.chain().focus().insertContent("/").run()}
    >
      <Icon name="plus" size={16} />
    </button>
  );
}
