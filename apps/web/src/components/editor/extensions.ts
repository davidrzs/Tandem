import type { HocuspocusProvider } from "@hocuspocus/provider";
import Collaboration from "@tiptap/extension-collaboration";
import CollaborationCursor from "@tiptap/extension-collaboration-cursor";
import Placeholder from "@tiptap/extension-placeholder";
import type { MutableRefObject } from "react";
import type * as Y from "yjs";
import { createBlameExtension } from "../blame.js";
import { createCommentsExtension, type CommentAnchor } from "../comments.js";
import { Find } from "../find.js";
import { ClientLiveSection } from "../live-section-node.js";
import { MarkdownPaste } from "../markdown-paste.js";
import { createMentionHighlight } from "../mention-highlight.js";
import { createMentionExtension, type MentionCandidate } from "../mention.js";
import { SlashCommand } from "../slash-command.js";
import { TaskListInputRule } from "../task-input-rule.js";
import { contentExtensions } from "./content-extensions.js";

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
    ...contentExtensions(ClientLiveSection.configure({ documentId: docId })),
    // A hint only while the document is empty — not on every blank line.
    Placeholder.configure({
      placeholder: ({ editor }) => (editor.isEmpty ? "Write, or type / for commands…" : ""),
    }),
    MarkdownPaste,
    Find,
    TaskListInputRule,
    Collaboration.configure({ document: ydoc, field: "default" }),
    CollaborationCursor.configure({ provider, user: me }),
    SlashCommand,
    createMentionExtension(() => membersRef.current, searchDocs),
    createMentionHighlight(() => membersRef.current),
    createBlameExtension(ydoc),
    createCommentsExtension(ydoc, () => anchorsRef.current, () => activeCommentRef.current),
  ];
}
