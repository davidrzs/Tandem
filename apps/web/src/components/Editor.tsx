import { HocuspocusProvider, type HocuspocusProviderConfiguration } from "@hocuspocus/provider";
import Collaboration from "@tiptap/extension-collaboration";
import CollaborationCursor from "@tiptap/extension-collaboration-cursor";
import Link from "@tiptap/extension-link";
import Placeholder from "@tiptap/extension-placeholder";
import Table from "@tiptap/extension-table";
import TableCell from "@tiptap/extension-table-cell";
import TableHeader from "@tiptap/extension-table-header";
import TableRow from "@tiptap/extension-table-row";
import TaskItem from "@tiptap/extension-task-item";
import TaskList from "@tiptap/extension-task-list";
import { BubbleMenu, EditorContent, useEditor } from "@tiptap/react";
import type { EditorView } from "@tiptap/pm/view";
import StarterKit from "@tiptap/starter-kit";
import { createLowlight, common } from "lowlight";
import { getAuthors, ToggleSummary, ToggleContent } from "@tandem/editor";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link as RouterLink, useNavigate } from "react-router-dom";
import * as Y from "yjs";
import { authClient } from "../auth-client.js";
import { trpc } from "../trpc.js";
import { authorLabel, blamePluginKey, createBlameExtension } from "./blame.js";
import { Breadcrumbs } from "./Breadcrumbs.js";
import { RowMenu } from "./Modal.js";
import { useToast } from "./toast.js";
import {
  anchorRange,
  commentsPluginKey,
  createCommentsExtension,
  selectionAnchor,
  type CommentAnchor,
} from "./comments.js";
import { CommentsPanel, type CommentItem, type PendingComment } from "./CommentsPanel.js";
import { HistoryPanel, type HistorySession } from "./HistoryPanel.js";
import { SnapshotPreview } from "./SnapshotPreview.js";
import { TocRail } from "./TocRail.js";
import { authorColor, authorKey } from "./colors.js";
import { ClientImage } from "./image-node.js";
import { ClientCallout } from "./callout-node.js";
import { ClientToggle } from "./toggle-node.js";
import { createCodeBlock } from "./code-block-node.js";
import { Find } from "./find.js";
import { FindBar } from "./FindBar.js";
import { Icon } from "./Icon.js";
import { createMentionExtension, type MentionCandidate } from "./mention.js";
import { createMentionHighlight, mentionHighlightKey } from "./mention-highlight.js";
import { ClientPageRef } from "./page-ref.js";
import { timeAgo } from "./time.js";
import { SlashCommand } from "./slash-command.js";
import { TaskListInputRule } from "./task-input-rule.js";
import { createMathExtension } from "./math.js";
import { TagBar } from "./TagBar.js";
import { useAppContext } from "../App.js";
import { friendlyError } from "../errors.js";

/** Shared lowlight instance (common languages) for code-block highlighting. */
const lowlight = createLowlight(common);

/** Upload a pasted/dropped image and insert it at the current selection. */
async function uploadAndInsert(view: EditorView, file: File, docId: string) {
  const body = new FormData();
  body.append("file", file);
  const res = await fetch(`/api/images?documentId=${docId}`, {
    method: "POST",
    body,
    credentials: "include",
  });
  if (!res.ok) return;
  const { url } = (await res.json()) as { url: string };
  const node = view.state.schema.nodes.image!.create({ src: url });
  view.dispatch(view.state.tr.replaceSelectionWith(node).scrollIntoView());
}

function imageFiles(list: FileList | null | undefined): File[] {
  return Array.from(list ?? []).filter((f) => f.type.startsWith("image/"));
}

function useDebounced<A extends unknown[]>(fn: (...args: A) => void, delay: number) {
  const ref = useRef(fn);
  ref.current = fn;
  const timer = useRef<ReturnType<typeof setTimeout>>();
  return useCallback(
    (...args: A) => {
      clearTimeout(timer.current);
      timer.current = setTimeout(() => ref.current(...args), delay);
    },
    [delay],
  );
}

function collabUrl(): string {
  const proto = window.location.protocol === "https:" ? "wss" : "ws";
  return `${proto}://${window.location.host}/collab`;
}

type ConnectionState = "connecting" | "live" | "offline";

interface PresencePeer {
  clientId: number;
  name: string;
  color: string;
}

export function Editor({
  docId,
  canEdit,
  workspaceId,
}: {
  docId: string;
  canEdit: boolean;
  workspaceId: string;
}) {
  const utils = trpc.useUtils();
  const utilsRef = useRef(utils);
  utilsRef.current = utils;
  const session = authClient.useSession();
  // Metadata only — the body arrives over Yjs, so we don't fetch it here.
  const doc = trpc.documents.getMeta.useQuery({ id: docId });
  const tagOptions = trpc.documents.listTags.useQuery();
  const update = trpc.documents.update.useMutation({
    onSuccess: () => {
      void utils.documents.tree.invalidate();
      // Anything showing this doc's title (page-reference chips, headers)
      // re-reads it after a rename; tag edits refresh the autocomplete pool.
      void utils.documents.getMeta.invalidate({ id: docId });
      void utils.documents.listTags.invalidate();
    },
  });
  const members = trpc.workspaces.members.useQuery(
    { workspaceId },
    { enabled: !!workspaceId },
  );
  const { openSearch } = useAppContext();

  // Members feed the @-mention autocomplete through a ref (they load async;
  // the extension is created once).
  const membersRef = useRef<MentionCandidate[]>([]);
  useEffect(() => {
    membersRef.current = (members.data ?? []).map((m) => ({
      kind: "user" as const,
      userId: m.userId,
      handle: m.email.split("@")[0]!,
      name: m.name,
      email: m.email,
    }));
  }, [members.data]);

  // Stable Y.Doc + provider for the editor binding (Editor is keyed by docId).
  // Both are created once; the effect below only manages the connection so
  // StrictMode's mount/unmount/mount cycle doesn't destroy the provider the
  // editor extensions hold on to.
  const [ydoc] = useState(() => new Y.Doc());
  const [connection, setConnection] = useState<ConnectionState>("connecting");
  const [synced, setSynced] = useState(false);
  const [provider] = useState(
    () =>
      new HocuspocusProvider({
        url: collabUrl(),
        name: docId,
        token: "cookie", // real auth is the session cookie on the handshake
        document: ydoc,
        // autoConnect is a (managed) websocket option the provider forwards at
        // runtime; the narrower provider config type just doesn't declare it.
        autoConnect: false,
        onStatus: ({ status }) =>
          setConnection(
            status === "connected" ? "live" : status === "connecting" ? "connecting" : "offline",
          ),
        onSynced: () => setSynced(true),
        // Server pushes data-free pings on the doc's channel (e.g. someone
        // commented); refetch through our own RLS-scoped queries.
        onStateless: ({ payload }: { payload: string }) => {
          try {
            const message = JSON.parse(payload) as { topic?: string };
            if (message.topic === "comments") {
              void utilsRef.current.comments.list.invalidate({ documentId: docId });
            } else if (message.topic === "snapshots") {
              void utilsRef.current.documents.listSnapshots.invalidate({ documentId: docId });
            } else if (message.topic === "meta") {
              // Someone renamed the doc (the title lives outside the CRDT).
              void utilsRef.current.documents.getMeta.invalidate({ id: docId });
              void utilsRef.current.documents.tree.invalidate();
            }
          } catch {
            // Unknown payloads are ignored.
          }
        },
      } as HocuspocusProviderConfiguration),
  );
  const destroyTimer = useRef<ReturnType<typeof setTimeout>>();
  useEffect(() => {
    clearTimeout(destroyTimer.current);
    void provider.connect();
    return () => {
      provider.disconnect();
      // Real unmount destroys the provider (and its managed socket) a tick
      // later; StrictMode's immediate remount cancels this and reconnects.
      destroyTimer.current = setTimeout(() => provider.destroy(), 0);
    };
  }, [provider]);

  const user = session.data?.user;
  const me = useMemo(
    () => ({
      name: user?.name ?? "Anonymous",
      color: authorColor(authorKey(user?.id ?? "anon", false)),
    }),
    [user?.id, user?.name],
  );

  const navigate = useNavigate();
  const toast = useToast();

  // --- document actions (the "…" menu) ---
  const favorites = trpc.favorites.list.useQuery();
  const isFavorite = (favorites.data ?? []).some((f) => f.id === docId);
  const favAdd = trpc.favorites.add.useMutation({
    onSuccess: () => {
      void utils.favorites.list.invalidate();
      toast("Added to favorites");
    },
  });
  const favRemove = trpc.favorites.remove.useMutation({
    onSuccess: () => {
      void utils.favorites.list.invalidate();
      toast("Removed from favorites");
    },
  });
  const duplicate = trpc.documents.duplicate.useMutation({
    onSuccess: (created) => {
      void utils.documents.tree.invalidate();
      toast("Duplicated");
      navigate(`/d/${created.id}`);
    },
    onError: (e) => toast(friendlyError(e, "Couldn't duplicate this document."), "danger"),
  });
  const copyDocLink = () => {
    void navigator.clipboard
      .writeText(`${window.location.origin}/d/${docId}`)
      .then(() => toast("Link copied"));
  };
  const downloadMarkdown = async () => {
    try {
      const { title: t, markdown } = await utils.documents.getMarkdown.fetch({ id: docId });
      const blob = new Blob([markdown], { type: "text/markdown" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `${(t || "untitled").replace(/[^\w.-]+/g, "_")}.md`;
      a.click();
      URL.revokeObjectURL(a.href);
    } catch {
      toast("Couldn't export this document.", "danger");
    }
  };

  // "@" can link other pages: search titles/bodies as the user types.
  const searchDocs = useCallback(
    (query: string) =>
      utils.documents.search
        .fetch({ query, limit: 5 })
        .then((hits) =>
          hits.map((h) => ({ kind: "doc" as const, id: h.id, title: h.title })),
        ),
    [utils],
  );

  // --- cross-references: who links here ---
  const backlinks = trpc.documents.backlinks.useQuery({ id: docId });

  // --- comments ---
  const commentsQuery = trpc.comments.list.useQuery({ documentId: docId });
  const commentItems: CommentItem[] = useMemo(
    () => commentsQuery.data ?? [],
    [commentsQuery.data],
  );
  const createComment = trpc.comments.create.useMutation({
    onSuccess: () => utils.comments.list.invalidate({ documentId: docId }),
  });
  const resolveComment = trpc.comments.setResolved.useMutation({
    onSuccess: () => utils.comments.list.invalidate({ documentId: docId }),
  });
  const deleteComment = trpc.comments.delete.useMutation({
    onSuccess: () => utils.comments.list.invalidate({ documentId: docId }),
  });
  const [rail, setRail] = useState<null | "comments" | "history">(null);
  const [pending, setPending] = useState<PendingComment | null>(null);
  const [activeCommentId, setActiveCommentId] = useState<string | null>(null);
  // Find-in-document; the editor keymap opens it through a ref because
  // editorProps are captured once at editor creation.
  const [findOpen, setFindOpen] = useState(false);
  const openFindRef = useRef<() => void>();
  openFindRef.current = () => setFindOpen(true);
  // Link bubble state: null = closed, string = draft href being edited.
  const [linkDraft, setLinkDraft] = useState<string | null>(null);
  // The decoration plugin reads anchors/active through refs (created once).
  const anchorsRef = useRef<CommentAnchor[]>([]);
  const activeCommentRef = useRef<string | null>(null);
  activeCommentRef.current = activeCommentId;
  useEffect(() => {
    anchorsRef.current = commentItems
      .filter((c) => !c.parentId && !c.resolvedAt && c.anchor && c.head)
      .map((c) => ({ id: c.id, anchor: c.anchor!, head: c.head! }));
  }, [commentItems]);

  const editor = useEditor(
    {
      editable: canEdit,
      extensions: [
        // History is disabled — Collaboration manages undo via Yjs. Code blocks
        // come from CodeBlockLowlight (syntax highlighting) instead of StarterKit.
        StarterKit.configure({ history: false, codeBlock: false }),
        createCodeBlock(lowlight),
        Link.configure({ openOnClick: false }),
        // A hint only while the document is empty — not on every blank line.
        Placeholder.configure({
          placeholder: ({ editor }) => (editor.isEmpty ? "Write, or type / for commands…" : ""),
        }),
        Find,
        ClientImage,
        TaskList,
        TaskItem.configure({ nested: true }),
        TaskListInputRule,
        ClientPageRef,
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
      ],
      editorProps: {
        handleKeyDown(_view, event) {
          // Mod+F finds within the document (the browser's find can't see
          // into collapsed toggles or track live edits).
          if ((event.metaKey || event.ctrlKey) && !event.shiftKey && event.key.toLowerCase() === "f") {
            event.preventDefault();
            openFindRef.current?.();
            return true;
          }
          return false;
        },
        handlePaste(view, event) {
          const files = imageFiles(event.clipboardData?.files);
          if (!view.editable || files.length === 0) return false;
          event.preventDefault();
          files.forEach((f) => void uploadAndInsert(view, f, docId));
          return true;
        },
        handleDrop(view, event) {
          const files = imageFiles((event as DragEvent).dataTransfer?.files);
          if (!view.editable || files.length === 0) return false;
          event.preventDefault();
          files.forEach((f) => void uploadAndInsert(view, f, docId));
          return true;
        },
      },
    },
    [provider],
  );

  // Reflect access changes without recreating the editor (which would race
  // with typing and drop the Yjs binding).
  useEffect(() => {
    editor?.setEditable(canEdit);
  }, [editor, canEdit]);

  // Keep the presence caret's identity current.
  useEffect(() => {
    if (editor && user) editor.commands.updateUser(me);
  }, [editor, me, user]);

  // --- presence: who else is looking at this document ---
  const [peers, setPeers] = useState<PresencePeer[]>([]);
  useEffect(() => {
    const awareness = provider.awareness;
    if (!awareness) return;
    const refresh = () => {
      const states = [...awareness.getStates().entries()]
        .filter(([clientId]) => clientId !== awareness.clientID)
        .flatMap(([clientId, state]) => {
          const u = (state as { user?: { name?: string; color?: string } }).user;
          return u ? [{ clientId, name: u.name ?? "?", color: u.color ?? "#888" }] : [];
        });
      setPeers(states);
    };
    refresh();
    awareness.on("change", refresh);
    return () => awareness.off("change", refresh);
  }, [provider]);

  // Members load after the editor mounts; redraw mention tints when they do.
  useEffect(() => {
    if (!editor || !members.data) return;
    editor.view.dispatch(editor.state.tr.setMeta(mentionHighlightKey, true));
  }, [editor, members.data]);

  // Redraw comment highlights when threads or the focused thread change.
  useEffect(() => {
    if (!editor) return;
    editor.view.dispatch(editor.state.tr.setMeta(commentsPluginKey, { recompute: true }));
  }, [editor, commentItems, activeCommentId]);

  const startComment = useCallback(() => {
    if (!editor) return;
    const anchors = selectionAnchor(editor.state);
    if (!anchors) return;
    const { from, to } = editor.state.selection;
    const quote = editor.state.doc.textBetween(from, to, " ").slice(0, 160);
    setPending({ ...anchors, quote });
    setRail("comments");
  }, [editor]);

  const jumpToComment = useCallback(
    (comment: CommentItem) => {
      setActiveCommentId(comment.id);
      if (!editor || !comment.anchor || !comment.head) return;
      const range = anchorRange(editor.state, ydoc, comment.anchor, comment.head);
      if (!range) return;
      editor.chain().setTextSelection(range).scrollIntoView().run();
    },
    [editor, ydoc],
  );

  const openThreadCount = commentItems.filter((c) => !c.parentId && !c.resolvedAt).length;

  // --- reading width preference ---
  const [wide, setWide] = useState(() => localStorage.getItem("tandem.wide") === "1");
  useEffect(() => {
    localStorage.setItem("tandem.wide", wide ? "1" : "0");
  }, [wide]);

  // --- history / blame view ---
  const blameOn = rail === "history";
  const [onlySession, setOnlySession] = useState<number | null>(null);
  const [sessions, setSessions] = useState<HistorySession[]>([]);
  const refreshSessions = useCallback(() => {
    const list: HistorySession[] = [...getAuthors(ydoc).entries()].map(
      ([clientId, info]) => ({
        clientId,
        key: authorKey(info.userId, info.ai),
        label: authorLabel(info),
        ai: info.ai,
        at: info.at,
      }),
    );
    list.sort((a, b) => b.at - a.at);
    setSessions(list.slice(0, 50));
  }, [ydoc]);

  useEffect(() => {
    if (!editor) return;
    editor.view.dispatch(
      editor.state.tr.setMeta(blamePluginKey, { enabled: blameOn, only: onlySession }),
    );
    if (!blameOn) return;
    refreshSessions();
    // Recompute (debounced) whenever the Yjs doc changes — remote or local.
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onUpdate = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        refreshSessions();
        editor.view.dispatch(
          editor.state.tr.setMeta(blamePluginKey, { recompute: true }),
        );
      }, 150);
    };
    ydoc.on("update", onUpdate);
    return () => {
      clearTimeout(timer);
      ydoc.off("update", onUpdate);
    };
  }, [editor, blameOn, onlySession, ydoc, refreshSessions]);

  // --- version snapshots + preview ---
  const versions = trpc.documents.listSnapshots.useQuery(
    { documentId: docId },
    { enabled: rail === "history" },
  );
  const [previewId, setPreviewId] = useState<string | null>(null);
  const preview = trpc.documents.getSnapshot.useQuery(
    { id: previewId! },
    { enabled: !!previewId },
  );
  const restore = trpc.documents.restoreSnapshot.useMutation({
    onSuccess: () => {
      setPreviewId(null);
      void utils.documents.listSnapshots.invalidate({ documentId: docId });
    },
  });
  // Leaving the history rail exits any preview.
  useEffect(() => {
    if (rail !== "history") setPreviewId(null);
  }, [rail]);

  // Blame hover card (delegated — decorations carry data attributes).
  const [hover, setHover] = useState<{
    x: number;
    y: number;
    label: string;
    at: number;
  } | null>(null);
  const onProseClick = useCallback(
    (e: React.MouseEvent) => {
      const link = (e.target as HTMLElement).closest?.("a[href]");
      if (!(link instanceof HTMLAnchorElement)) return;
      if (canEdit && !(e.metaKey || e.ctrlKey)) return;
      e.preventDefault();
      const href = link.getAttribute("href") ?? "";
      if (href.startsWith("/")) navigate(href);
      else window.open(href, "_blank", "noopener");
    },
    [canEdit, navigate],
  );

  const onMouseOver = useCallback((e: React.MouseEvent) => {
    const el = (e.target as HTMLElement).closest?.("[data-blame-label]");
    if (!(el instanceof HTMLElement)) {
      setHover(null);
      return;
    }
    const rect = el.getBoundingClientRect();
    setHover({
      x: rect.left,
      y: rect.bottom + 6,
      label: el.dataset.blameLabel ?? "Unknown",
      at: Number(el.dataset.blameAt ?? 0),
    });
  }, []);

  // Title is independent of the Yjs body; persist it via tRPC. A collaborator's
  // rename arrives as a refetched getMeta (via the "meta" ping): adopt it unless
  // this input is focused or holds unsaved local edits — then local wins
  // (last-writer, like the save itself).
  const [title, setTitle] = useState("");
  const titleLoaded = useRef(false);
  const titleDirty = useRef(false);
  const titleInputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!doc.data) return;
    if (!titleLoaded.current) {
      setTitle(doc.data.title);
      titleLoaded.current = true;
    } else if (!titleDirty.current && document.activeElement !== titleInputRef.current) {
      setTitle(doc.data.title);
    }
  }, [doc.data]);

  const saveTitle = useDebounced((t: string) => {
    update.mutate(
      { id: docId, title: t },
      { onSuccess: () => (titleDirty.current = false) },
    );
  }, 500);

  if (doc.isLoading) return <div className="empty">Loading…</div>;
  if (doc.error)
    return <div className="empty">{friendlyError(doc.error, "Couldn't load this document.")}</div>;
  if (!doc.data) return <div className="empty">Document not found, or you don't have access to it.</div>;

  const status: { label: string; tone: string } = !synced
    ? { label: "Connecting…", tone: "wait" }
    : connection === "live"
      ? update.isPending
        ? { label: "Saving…", tone: "wait" }
        : { label: "Live", tone: "ok" }
      : connection === "connecting"
        ? { label: "Reconnecting…", tone: "wait" }
        : { label: "Offline", tone: "bad" };

  return (
    <div className="doc-shell">
      {editor && (
        <BubbleMenu
          editor={editor}
          pluginKey="formatMenu"
          tippyOptions={{ placement: "top", onHidden: () => setLinkDraft(null) }}
          shouldShow={({ editor, state }) =>
            previewId === null &&
            !editor.isActive("table") &&
            (!state.selection.empty || (canEdit && editor.isActive("link")))
          }
        >
          {linkDraft !== null && canEdit ? (
            <form
              className="bubble-group"
              onSubmit={(e) => {
                e.preventDefault();
                const href = linkDraft.trim();
                if (href) {
                  editor.chain().focus().extendMarkRange("link").setLink({ href }).run();
                } else {
                  editor.chain().focus().extendMarkRange("link").unsetLink().run();
                }
                setLinkDraft(null);
              }}
            >
              <input
                className="bubble-input"
                value={linkDraft}
                placeholder="https://…"
                autoFocus
                onChange={(e) => setLinkDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Escape") {
                    e.preventDefault();
                    setLinkDraft(null);
                    editor.chain().focus().run();
                  }
                }}
              />
              <button className="bubble-btn" type="submit">
                Apply
              </button>
              {editor.isActive("link") && (
                <button
                  className="bubble-btn danger"
                  type="button"
                  onClick={() => {
                    editor.chain().focus().extendMarkRange("link").unsetLink().run();
                    setLinkDraft(null);
                  }}
                >
                  Remove
                </button>
              )}
            </form>
          ) : (
            <div className="bubble-group">
              {canEdit && !editor.isActive("codeBlock") && (
                <>
                  <button
                    className={"bubble-btn" + (editor.isActive("bold") ? " active" : "")}
                    title="Bold (Mod+B)"
                    aria-label="Bold"
                    onClick={() => editor.chain().focus().toggleBold().run()}
                  >
                    <strong>B</strong>
                  </button>
                  <button
                    className={"bubble-btn" + (editor.isActive("italic") ? " active" : "")}
                    title="Italic (Mod+I)"
                    aria-label="Italic"
                    onClick={() => editor.chain().focus().toggleItalic().run()}
                  >
                    <em>I</em>
                  </button>
                  <button
                    className={"bubble-btn" + (editor.isActive("strike") ? " active" : "")}
                    title="Strikethrough"
                    aria-label="Strikethrough"
                    onClick={() => editor.chain().focus().toggleStrike().run()}
                  >
                    <s>S</s>
                  </button>
                  <button
                    className={"bubble-btn" + (editor.isActive("code") ? " active" : "")}
                    title="Inline code"
                    aria-label="Inline code"
                    onClick={() => editor.chain().focus().toggleCode().run()}
                  >
                    <code>{"<>"}</code>
                  </button>
                  <button
                    className={"bubble-btn" + (editor.isActive("link") ? " active" : "")}
                    title={editor.isActive("link") ? "Edit link" : "Add link"}
                    aria-label={editor.isActive("link") ? "Edit link" : "Add link"}
                    onClick={() =>
                      setLinkDraft(String(editor.getAttributes("link").href ?? ""))
                    }
                  >
                    Link
                  </button>
                </>
              )}
              {!editor.state.selection.empty && (
                <>
                  {canEdit && <span className="bubble-divider" />}
                  <button className="bubble-btn" onClick={startComment}>
                    <Icon name="comment" size={13} />
                    Comment
                  </button>
                </>
              )}
            </div>
          )}
        </BubbleMenu>
      )}
      {editor && canEdit && (
        <BubbleMenu
          editor={editor}
          pluginKey="tableMenu"
          tippyOptions={{ placement: "top" }}
          shouldShow={({ editor }) => previewId === null && editor.isActive("table")}
        >
          <div className="bubble-group">
            <button className="bubble-btn" title="Insert row below" onClick={() => editor.chain().focus().addRowAfter().run()}>+ Row</button>
            <button className="bubble-btn" title="Insert column right" onClick={() => editor.chain().focus().addColumnAfter().run()}>+ Col</button>
            <button className="bubble-btn" title="Delete row" onClick={() => editor.chain().focus().deleteRow().run()}>− Row</button>
            <button className="bubble-btn" title="Delete column" onClick={() => editor.chain().focus().deleteColumn().run()}>− Col</button>
            <button className="bubble-btn danger" title="Delete table" onClick={() => editor.chain().focus().deleteTable().run()}>Delete</button>
          </div>
        </BubbleMenu>
      )}
      <TocRail editor={editor} hidden={rail !== null || previewId !== null || wide} />
      <div className={"editor" + (wide ? " wide" : "")}>
      {findOpen && editor && (
        <FindBar
          editor={editor}
          onClose={() => {
            setFindOpen(false);
            editor.commands.focus();
          }}
        />
      )}
      <div className="editor-tools">
        {!canEdit && <span className="save-state">Read only</span>}
        <span className={`save-state status-${status.tone}`}>
          <span className="status-dot" /> {status.label}
        </span>
        <button
          className={"tool-btn" + (rail === "comments" ? " active" : "")}
          title="Show comments"
          onClick={() => setRail((r) => (r === "comments" ? null : "comments"))}
        >
          <Icon name="comment" size={15} />
          Comments{openThreadCount > 0 ? ` (${openThreadCount})` : ""}
        </button>
        <button
          className={"tool-btn" + (findOpen ? " active" : "")}
          title="Find in document (Mod+F)"
          onClick={() => setFindOpen((f) => !f)}
        >
          <Icon name="search" size={15} />
          Find
        </button>
        <button
          className={"tool-btn" + (wide ? " active" : "")}
          title="Toggle full-width layout"
          onClick={() => setWide((w) => !w)}
        >
          Full width
        </button>
        <button
          className={"tool-btn" + (blameOn ? " active" : "")}
          title="Edit history: who wrote each part, and when"
          onClick={() => {
            setOnlySession(null);
            setRail((r) => (r === "history" ? null : "history"));
          }}
        >
          <Icon name="restore" size={15} />
          History
        </button>
        <RowMenu
          title="Document actions"
          items={[
            {
              label: isFavorite ? "Remove from favorites" : "Add to favorites",
              icon: "star" as const,
              onClick: () =>
                isFavorite
                  ? favRemove.mutate({ documentId: docId })
                  : favAdd.mutate({ documentId: docId }),
            },
            { label: "Copy link", icon: "share" as const, onClick: copyDocLink },
            ...(canEdit
              ? [
                  {
                    label: "Duplicate",
                    icon: "page" as const,
                    onClick: () => duplicate.mutate({ id: docId }),
                  },
                ]
              : []),
            {
              label: "Download markdown",
              icon: "download" as const,
              onClick: () => void downloadMarkdown(),
            },
            { label: "Print", icon: "page" as const, onClick: () => window.print() },
          ]}
        />
        {peers.length > 0 && (
          <>
            <span className="tool-divider" />
            <span className="presence" title={peers.map((p) => p.name).join(", ")}>
              <span className="presence-stack">
                {peers.slice(0, 4).map((p) => (
                  <span
                    key={p.clientId}
                    className="presence-avatar"
                    style={{ background: p.color }}
                  >
                    {p.name.slice(0, 1).toUpperCase()}
                  </span>
                ))}
                {peers.length > 4 && <span className="presence-more">+{peers.length - 4}</span>}
              </span>
              <span className="presence-count">
                <span className="live-dot" />
                {peers.length} editing
              </span>
            </span>
          </>
        )}
      </div>
      <Breadcrumbs docId={docId} collectionId={doc.data.collectionId} />
      <input
        ref={titleInputRef}
        className="title-input"
        value={title}
        placeholder="Untitled"
        readOnly={!canEdit}
        onChange={(e) => {
          if (!canEdit) return;
          titleDirty.current = true;
          setTitle(e.target.value);
          saveTitle(e.target.value);
        }}
      />
      <div
        className="doc-meta"
        title={`Created ${new Date(doc.data.createdAt).toLocaleString()}`}
      >
        Updated {timeAgo(doc.data.updatedAt)}
      </div>
      <TagBar
        tags={doc.data.tags}
        canEdit={canEdit}
        suggestions={tagOptions.data ?? []}
        onChange={(tags) => update.mutate({ id: docId, tags })}
        onTagClick={(tag) => openSearch(`#${tag} `)}
      />
      {previewId !== null && (
        <div className="preview-banner">
          <span>
            Viewing the version from{" "}
            {preview.data ? new Date(preview.data.createdAt).toLocaleString() : "…"}
          </span>
          <span className="preview-actions">
            {canEdit && (
              <button
                className="btn primary"
                disabled={restore.isPending || !preview.data}
                onClick={() => restore.mutate({ id: previewId })}
              >
                {restore.isPending ? "Restoring…" : "Restore this version"}
              </button>
            )}
            <button className="btn" onClick={() => setPreviewId(null)}>
              Back to now
            </button>
          </span>
        </div>
      )}
      {/* Keep the live editor mounted (its collaboration binding survives) but
          hidden while previewing a version. */}
      <div
        className={previewId !== null ? "hidden-editor" : ""}
        onMouseOver={onMouseOver}
        onMouseLeave={() => setHover(null)}
        onClick={onProseClick}
      >
        <EditorContent className="prose" editor={editor} />
      </div>
      {previewId !== null &&
        (preview.data ? (
          <SnapshotPreview key={previewId} contentJson={preview.data.contentJson} />
        ) : (
          <div className="empty">Loading version…</div>
        ))}
      {(backlinks.data?.length ?? 0) > 0 && (
        <div className="backlinks">
          <h3>Linked from</h3>
          {backlinks.data!.map((d) => (
            <RouterLink key={d.id} className="backlink" to={`/d/${d.id}`}>
              <Icon name="page" size={13} />
              {d.title || "Untitled"}
            </RouterLink>
          ))}
        </div>
      )}
      {hover && (
        <div className="blame-card" style={{ left: hover.x, top: hover.y }}>
          <strong>{hover.label}</strong>
          <span className="blame-when">
            {hover.at > 0 ? new Date(hover.at).toLocaleString() : "before history"}
          </span>
        </div>
      )}
      </div>
      {rail === "history" && (
        <HistoryPanel
          sessions={sessions}
          only={onlySession}
          onSelect={setOnlySession}
          versions={versions.data ?? []}
          previewingId={previewId}
          onPreview={(id) => setPreviewId((cur) => (cur === id ? null : id))}
          onClose={() => setRail(null)}
        />
      )}
      {rail === "comments" && (
        <CommentsPanel
          comments={commentItems}
          pending={pending}
          meId={user?.id ?? null}
          canEdit={canEdit}
          activeId={activeCommentId}
          onSubmit={(body) => {
            const anchors = pending;
            setPending(null);
            void createComment.mutateAsync({
              documentId: docId,
              body,
              ...(anchors ? { anchor: anchors.anchor, head: anchors.head } : {}),
            });
          }}
          onCancelPending={() => setPending(null)}
          onReply={(parentId, body) =>
            void createComment.mutateAsync({ documentId: docId, body, parentId })
          }
          onResolve={(id, resolved) => void resolveComment.mutateAsync({ id, resolved })}
          onDelete={(id) => void deleteComment.mutateAsync({ id })}
          onJumpTo={jumpToComment}
          onClose={() => {
            setRail(null);
            setPending(null);
          }}
        />
      )}
    </div>
  );
}
