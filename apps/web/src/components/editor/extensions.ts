import type { HocuspocusProvider } from "@hocuspocus/provider";
import Collaboration from "@tiptap/extension-collaboration";
import CollaborationCursor from "@tiptap/extension-collaboration-cursor";
import Link from "@tiptap/extension-link";
import Placeholder from "@tiptap/extension-placeholder";
import Table from "@tiptap/extension-table";
import TableCell from "@tiptap/extension-table-cell";
import TableHeader from "@tiptap/extension-table-header";
import TableRow from "@tiptap/extension-table-row";
import TaskList from "@tiptap/extension-task-list";
import StarterKit from "@tiptap/starter-kit";
import { createLowlight, common } from "lowlight";
import { TaskItem, ToggleSummary, ToggleContent } from "@tandem/editor";
import type { MutableRefObject } from "react";
import type * as Y from "yjs";
import { createBlameExtension } from "../blame.js";
import { ClientCallout } from "../callout-node.js";
import { createCodeBlock } from "../code-block-node.js";
import { createCommentsExtension, type CommentAnchor } from "../comments.js";
import { Find } from "../find.js";
import { ClientImage } from "../image-node.js";
import { ClientLiveSection } from "../live-section-node.js";
import { MarkdownPaste } from "../markdown-paste.js";
import { createMathExtension } from "../math.js";
import { createMentionHighlight } from "../mention-highlight.js";
import { createMentionExtension, type MentionCandidate } from "../mention.js";
import { ClientPageRef } from "../page-ref.js";
import { SlashCommand } from "../slash-command.js";
import { TaskListInputRule } from "../task-input-rule.js";
import { ClientToggle } from "../toggle-node.js";

/** Shared lowlight instance (common languages) for code-block highlighting. */
const lowlight = createLowlight(common);

/** The TipTap extension list for the collaborative document editor. */
export function buildExtensions({
  docId,
  ydoc,
  provider,
  me,
  membersRef,
  searchDocs,
  anchorsRef,
  activeCommentRef,
}: {
  docId: string;
  ydoc: Y.Doc;
  provider: HocuspocusProvider;
  me: { name: string; color: string };
  membersRef: MutableRefObject<MentionCandidate[]>;
  searchDocs: Parameters<typeof createMentionExtension>[1];
  anchorsRef: MutableRefObject<CommentAnchor[]>;
  activeCommentRef: MutableRefObject<string | null>;
}) {
  return [
    // History is disabled — Collaboration manages undo via Yjs. Code blocks
    // come from CodeBlockLowlight (syntax highlighting) instead of StarterKit.
    StarterKit.configure({ history: false, codeBlock: false }),
    createCodeBlock(lowlight),
    Link.configure({ openOnClick: false }),
    // A hint only while the document is empty — not on every blank line.
    Placeholder.configure({
      placeholder: ({ editor }) => (editor.isEmpty ? "Write, or type / for commands…" : ""),
    }),
    MarkdownPaste,
    Find,
    ClientImage,
    TaskList,
    TaskItem,
    TaskListInputRule,
    ClientPageRef,
    ClientLiveSection.configure({ documentId: docId }),
    ClientCallout,
    ClientToggle,
    ToggleSummary,
    ToggleContent,
    Table.configure({ resizable: false }),
    TableRow,
    TableHeader,
    TableCell,
    createMathExtension(),
    Collaboration.configure({ document: ydoc, field: "default" }),
    CollaborationCursor.configure({ provider, user: me }),
    SlashCommand,
    createMentionExtension(() => membersRef.current, searchDocs),
    createMentionHighlight(() => membersRef.current),
    createBlameExtension(ydoc),
    createCommentsExtension(ydoc, () => anchorsRef.current, () => activeCommentRef.current),
  ];
}
