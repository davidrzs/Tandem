import CodeBlockLowlight from "@tiptap/extension-code-block-lowlight";
import Link from "@tiptap/extension-link";
import Table from "@tiptap/extension-table";
import TableCell from "@tiptap/extension-table-cell";
import TableHeader from "@tiptap/extension-table-header";
import TableRow from "@tiptap/extension-table-row";
import TaskList from "@tiptap/extension-task-list";
import { EditorContent, useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { createLowlight, common } from "lowlight";
import { LiveSection, TaskItem } from "@tandem/editor";
import { ClientImage } from "./image-node.js";
import { createMathExtension } from "./math.js";
import { ClientPageRef } from "./page-ref.js";

const lowlight = createLowlight(common);

/**
 * A read-only render of a document version's ProseMirror JSON. Same node set as
 * the live editor (tables/code/math/page-refs render identically) but without
 * collaboration, blame, comments, or editing affordances.
 */
export function SnapshotPreview({ contentJson }: { contentJson: unknown }) {
  const editor = useEditor(
    {
      editable: false,
      content: contentJson as object,
      extensions: [
        StarterKit.configure({ history: false, codeBlock: false }),
        CodeBlockLowlight.configure({ lowlight }),
        Link.configure({ openOnClick: false }),
        ClientImage,
        TaskList,
        TaskItem,
        ClientPageRef,
        LiveSection,
        Table.configure({ resizable: false }),
        TableRow,
        TableHeader,
        TableCell,
        createMathExtension(),
      ],
    },
    [contentJson],
  );

  return <EditorContent className="prose" editor={editor} />;
}
