import { Node } from "@tiptap/core";
import Collaboration from "@tiptap/extension-collaboration";
import Placeholder from "@tiptap/extension-placeholder";
import { useEditor } from "@tiptap/react";
import { TITLE_FIELD, titleOf } from "@tandem/editor";
import { useEffect, useRef, useState } from "react";
import type * as Y from "yjs";

// One paragraph of unmarked text: the shape title.ts reads and seeds.
const TitleDoc = Node.create({ name: "doc", topNode: true, content: "paragraph" });
const TitleParagraph = Node.create({
  name: "paragraph",
  content: "text*",
  marks: "",
  parseHTML: () => [{ tag: "p" }],
  renderHTML: () => ["p", 0],
});
const TitleText = Node.create({ name: "text", group: "inline" });

/**
 * The page title as the first line of the page: a small editor bound to the
 * Y.Doc's title fragment, so collaborators co-edit it live, offline edits
 * merge and blame covers it, like the body. The server projects it to
 * `documents.title` when it stores the doc.
 *
 * `fallback` is the stored title, shown greyed while the doc holds none yet
 * (before the first sync of a page whose title the server still has to seed).
 * Typing then would merge with the seed into the title twice, so the editor
 * stays read-only until the doc has synced or already holds a title.
 */
export function useTitleEditor({
  ydoc,
  canEdit,
  synced,
  fallback,
  onExit,
}: {
  ydoc: Y.Doc;
  canEdit: boolean;
  synced: boolean;
  fallback: string;
  /** Leave the title for the body (Enter, or ArrowDown on the last line). */
  onExit: () => void;
}) {
  const [title, setTitle] = useState<string | null>(() => titleOf(ydoc));
  useEffect(() => {
    const read = () => setTitle(titleOf(ydoc));
    read();
    ydoc.on("update", read);
    return () => ydoc.off("update", read);
  }, [ydoc]);

  // The editor is built once per doc; these change under it.
  const exitRef = useRef(onExit);
  exitRef.current = onExit;
  const placeholderRef = useRef("Untitled");
  placeholderRef.current = (title === null && fallback) || "Untitled";

  const editor = useEditor(
    {
      editable: false,
      extensions: [
        TitleDoc,
        TitleParagraph,
        TitleText,
        Placeholder.configure({ placeholder: () => placeholderRef.current }),
        Collaboration.configure({ document: ydoc, field: TITLE_FIELD }),
      ],
      editorProps: {
        attributes: { class: "title-input", role: "textbox", "aria-label": "Title" },
        handleKeyDown(view, event) {
          if (event.key === "Enter" && !event.isComposing) {
            event.preventDefault();
            exitRef.current();
            return true;
          }
          if (event.key === "ArrowDown" && view.endOfTextblock("down")) {
            event.preventDefault();
            exitRef.current();
            return true;
          }
          return false;
        },
        // A title is one line of text: pasted lines join, nothing else lands.
        handlePaste(view, event) {
          const text = event.clipboardData?.getData("text/plain") ?? "";
          if (view.editable && text) view.dispatch(view.state.tr.insertText(text.replace(/\s*[\r\n]+\s*/g, " ")));
          return true;
        },
        handleDrop: () => true,
      },
    },
    [ydoc],
  );

  const writable = canEdit && (synced || title !== null);
  useEffect(() => {
    if (editor && editor.isEditable !== writable) editor.setEditable(writable);
  }, [editor, writable]);

  return { titleEditor: editor, title };
}
