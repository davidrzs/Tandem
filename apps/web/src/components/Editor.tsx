import { HocuspocusProvider, type HocuspocusProviderConfiguration } from "@hocuspocus/provider";
import Collaboration from "@tiptap/extension-collaboration";
import CollaborationCursor from "@tiptap/extension-collaboration-cursor";
import Link from "@tiptap/extension-link";
import TaskItem from "@tiptap/extension-task-item";
import TaskList from "@tiptap/extension-task-list";
import { EditorContent, useEditor } from "@tiptap/react";
import type { EditorView } from "@tiptap/pm/view";
import StarterKit from "@tiptap/starter-kit";
import { getAuthors, type AuthorInfo } from "@tandem/editor";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as Y from "yjs";
import { authClient } from "../auth-client.js";
import { trpc } from "../trpc.js";
import { blamePluginKey, createBlameExtension } from "./blame.js";
import { authorColor, authorKey } from "./colors.js";
import { ClientImage } from "./image-node.js";
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
  name: string;
  ai: boolean;
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

  const editor = useEditor(
    {
      editable: canEdit,
      extensions: [
        // History is disabled — Collaboration manages undo via Yjs.
        StarterKit.configure({ history: false }),
        Link,
        ClientImage,
        TaskList,
        TaskItem.configure({ nested: true }),
        Collaboration.configure({ document: ydoc, field: "default" }),
        CollaborationCursor.configure({ provider, user: me }),
        SlashCommand,
        createMentionExtension(() => membersRef.current),
        createBlameExtension(ydoc),
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

  // --- blame view ---
  const [blameOn, setBlameOn] = useState(false);
  const [legend, setLegend] = useState<LegendAuthor[]>([]);
  const refreshLegend = useCallback(() => {
    const seen = new Map<string, LegendAuthor>();
    for (const info of getAuthors(ydoc).values()) {
      const key = authorKey(info.userId, info.ai);
      if (!seen.has(key)) {
        seen.set(key, { key, name: info.name || "Unknown", ai: info.ai });
      }
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
    name: string;
    ai: boolean;
    at: number;
  } | null>(null);
  const onMouseOver = useCallback((e: React.MouseEvent) => {
    const el = (e.target as HTMLElement).closest?.("[data-blame-name]");
    if (!(el instanceof HTMLElement)) {
      setHover(null);
      return;
    }
    const rect = el.getBoundingClientRect();
    setHover({
      x: rect.left,
      y: rect.bottom + 6,
      name: el.dataset.blameName ?? "Unknown",
      ai: el.dataset.blameAi === "1",
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
    <div className="editor">
      <div className="editor-header">
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
            className={"tool-btn" + (blameOn ? " active" : "")}
            title="Show who wrote each part"
            onClick={() => setBlameOn((b) => !b)}
          >
            Authors
          </button>
          {!canEdit && <span className="save-state">Read only</span>}
          <span className={`save-state status-${status.tone}`}>
            <span className="status-dot" /> {status.label}
          </span>
        </div>
      </div>
      {blameOn && legend.length > 0 && (
        <div className="blame-legend">
          {legend.map((a) => (
            <span key={a.key} className="blame-legend-item">
              <span className="legend-dot" style={{ background: authorColor(a.key) }} />
              {a.name}
              {a.ai && <span className="ai-tag">AI</span>}
            </span>
          ))}
        </div>
      )}
      <div onMouseOver={onMouseOver} onMouseLeave={() => setHover(null)}>
        <EditorContent className="prose" editor={editor} />
      </div>
      {hover && (
        <div className="blame-card" style={{ left: hover.x, top: hover.y }}>
          <strong>{hover.name}</strong>
          {hover.ai && <span className="ai-tag">AI</span>}
          <span className="blame-when">
            {hover.at > 0 ? new Date(hover.at).toLocaleString() : "before history"}
          </span>
        </div>
      )}
    </div>
  );
}
