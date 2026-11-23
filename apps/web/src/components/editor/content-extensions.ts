import Link from "@tiptap/extension-link";
import Table from "@tiptap/extension-table";
import TableCell from "@tiptap/extension-table-cell";
import TableHeader from "@tiptap/extension-table-header";
import TableRow from "@tiptap/extension-table-row";
import TaskList from "@tiptap/extension-task-list";
import type { AnyExtension } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { createLowlight, common } from "lowlight";
import { TaskItem, ToggleContent, ToggleSummary } from "@tandem/editor";
import { ClientCallout } from "../callout-node.js";
import { createCodeBlock } from "../code-block-node.js";
import { ClientImage } from "../image-node.js";
import { createMathExtension } from "../math.js";
import { ClientPageRef } from "../page-ref.js";
import { ClientToggle } from "../toggle-node.js";

/** One lowlight instance (common languages) for every editor on the page. */
const lowlight = createLowlight(common);

/**
 * The node and mark set a document is made of, shared by the live editor and
 * every read-only render (version previews, live-section embeds). Keeping one
 * list matters: a node type missing from a read-only editor makes TipTap
 * reject the whole document and render it blank.
 */
export function contentExtensions(liveSection: AnyExtension): AnyExtension[] {
  return [
    // History is off everywhere: the live editor undoes through Yjs, and
    // read-only renders have nothing to undo. Code blocks come from
    // createCodeBlock (syntax highlighting) instead of StarterKit.
    StarterKit.configure({ history: false, codeBlock: false }),
    createCodeBlock(lowlight),
    Link.configure({ openOnClick: false }),
    ClientImage,
    TaskList,
    TaskItem,
    ClientPageRef,
    liveSection,
    ClientCallout,
    ClientToggle,
    ToggleSummary,
    ToggleContent,
    Table.configure({ resizable: false }),
    TableRow,
    TableHeader,
    TableCell,
    createMathExtension(),
  ];
}
