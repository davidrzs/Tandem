import { HocuspocusProvider, type HocuspocusProviderConfiguration } from "@hocuspocus/provider";
import Collaboration from "@tiptap/extension-collaboration";
import CollaborationCursor from "@tiptap/extension-collaboration-cursor";
import Link from "@tiptap/extension-link";
import TaskItem from "@tiptap/extension-task-item";
import TaskList from "@tiptap/extension-task-list";
import { BubbleMenu, EditorContent, useEditor } from "@tiptap/react";
import type { EditorView } from "@tiptap/pm/view";
import StarterKit from "@tiptap/starter-kit";
import { getAuthors } from "@tandem/editor";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import * as Y from "yjs";
import { authClient } from "../auth-client.js";
import { trpc } from "../trpc.js";
import { authorLabel, blamePluginKey, createBlameExtension } from "./blame.js";
import {
  anchorRange,
  commentsPluginKey,
  createCommentsExtension,
  selectionAnchor,
  type CommentAnchor,
} from "./comments.js";
import { CommentsPanel, type CommentItem, type PendingComment } from "./CommentsPanel.js";
import { authorColor, authorKey } from "./colors.js";
import { ClientImage } from "./image-node.js";
import { Icon } from "./Icon.js";
import { createMentionExtension, type MentionCandidate } from "./mention.js";
import { SlashCommand } from "./slash-command.js";

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

/** A distinct author session that contributed content, for the blame legend. */
interface LegendAuthor {
  key: string;
  label: string;
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
  const update = trpc.documents.update.useMutation({
    onSuccess: () => utils.documents.tree.invalidate(),
  });
  const members = trpc.workspaces.members.useQuery(
    { workspaceId },
    { enabled: !!workspaceId },
  );

  // Members feed the @-mention autocomplete through a ref (they load async;
  // the extension is created once).
  const membersRef = useRef<MentionCandidate[]>([]);
  useEffect(() => {
    membersRef.current = (members.data ?? []).map((m) => ({
      kind: "user" as const,
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
  const [panelOpen, setPanelOpen] = useState(false);
  const [pending, setPending] = useState<PendingComment | null>(null);
  const [activeCommentId, setActiveCommentId] = useState<string | null>(null);
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
        // History is disabled — Collaboration manages undo via Yjs.
        StarterKit.configure({ history: false }),
        Link.configure({ openOnClick: false }),
        ClientImage,
        TaskList,
        TaskItem.configure({ nested: true }),
        Collaboration.configure({ document: ydoc, field: "default" }),
        CollaborationCursor.configure({ provider, user: me }),
        SlashCommand,
        createMentionExtension(() => membersRef.current, searchDocs),
        createBlameExtension(ydoc),
        createCommentsExtension(ydoc, () => anchorsRef.current, () => activeCommentRef.current),
      ],
      editorProps: {
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
    setPanelOpen(true);
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

  // --- blame view ---
  const [blameOn, setBlameOn] = useState(false);
  const [legend, setLegend] = useState<LegendAuthor[]>([]);
  const refreshLegend = useCallback(() => {
    const seen = new Map<string, LegendAuthor>();
    for (const info of getAuthors(ydoc).values()) {
      const key = authorKey(info.userId, info.ai);
      if (!seen.has(key)) seen.set(key, { key, label: authorLabel(info) });
    }
    setLegend([...seen.values()]);
  }, [ydoc]);

  useEffect(() => {
    if (!editor) return;
    editor.view.dispatch(
      editor.state.tr.setMeta(blamePluginKey, { enabled: blameOn }),
    );
    if (!blameOn) return;
    refreshLegend();
    // Recompute (debounced) whenever the Yjs doc changes — remote or local.
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onUpdate = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        refreshLegend();
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
  }, [editor, blameOn, ydoc, refreshLegend]);

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

  // Title is independent of the Yjs body; persist it via tRPC.
  const [title, setTitle] = useState("");
  const titleLoaded = useRef(false);
  useEffect(() => {
    if (!titleLoaded.current && doc.data) {
      setTitle(doc.data.title);
      titleLoaded.current = true;
    }
  }, [doc.data]);

  const saveTitle = useDebounced((t: string) => {
    update.mutate({ id: docId, title: t });
  }, 500);

  if (doc.isLoading) return <div className="empty">Loading…</div>;
  if (doc.error) return <div className="empty">Couldn't load this document: {doc.error.message}</div>;
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
          tippyOptions={{ placement: "top" }}
          shouldShow={({ state }) => !state.selection.empty}
        >
          <button className="bubble-btn" onClick={startComment}>
            <Icon name="comment" size={13} />
            Comment
          </button>
        </BubbleMenu>
      )}
      <div className={"editor" + (wide ? " wide" : "")}>
      <div className="editor-tools">
        {peers.length > 0 && (
          <span className="presence" title={peers.map((p) => p.name).join(", ")}>
            {peers.slice(0, 4).map((p) => (
              <span
                key={p.clientId}
                className="presence-dot"
                style={{ background: p.color }}
              >
                {p.name.slice(0, 1).toUpperCase()}
              </span>
            ))}
            {peers.length > 4 && <span className="presence-more">+{peers.length - 4}</span>}
          </span>
        )}
        <button
          className={"tool-btn" + (panelOpen ? " active" : "")}
          title="Show comments"
          onClick={() => setPanelOpen((o) => !o)}
        >
          Comments{openThreadCount > 0 ? ` (${openThreadCount})` : ""}
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
          title="Show who wrote each part"
          onClick={() => setBlameOn((b) => !b)}
        >
          <Icon name="pen" size={13} />
          Authors
        </button>
        {!canEdit && <span className="save-state">Read only</span>}
        <span className={`save-state status-${status.tone}`}>
          <span className="status-dot" /> {status.label}
        </span>
      </div>
      <input
        className="title-input"
        value={title}
        placeholder="Untitled"
        readOnly={!canEdit}
        onChange={(e) => {
          if (!canEdit) return;
          setTitle(e.target.value);
          saveTitle(e.target.value);
        }}
      />
      {blameOn && legend.length > 0 && (
        <div className="blame-legend">
          {legend.map((a) => (
            <span key={a.key} className="blame-legend-item">
              <span className="legend-dot" style={{ background: authorColor(a.key) }} />
              {a.label}
            </span>
          ))}
        </div>
      )}
      <div onMouseOver={onMouseOver} onMouseLeave={() => setHover(null)} onClick={onProseClick}>
        <EditorContent className="prose" editor={editor} />
      </div>
      {hover && (
        <div className="blame-card" style={{ left: hover.x, top: hover.y }}>
          <strong>{hover.label}</strong>
          <span className="blame-when">
            {hover.at > 0 ? new Date(hover.at).toLocaleString() : "before history"}
          </span>
        </div>
      )}
      </div>
      {panelOpen && (
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
            setPanelOpen(false);
            setPending(null);
          }}
        />
      )}
    </div>
  );
}
