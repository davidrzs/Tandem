import { BubbleMenu, EditorContent, useEditor, useEditorState } from "@tiptap/react";
import type { EditorView } from "@tiptap/pm/view";
import { Selection } from "@tiptap/pm/state";
import type { Editor as TiptapEditor } from "@tiptap/react";
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link as RouterLink, useNavigate, useSearchParams } from "react-router-dom";
import { authClient } from "../auth-client.js";
import { trpc } from "../trpc.js";
import { Breadcrumbs } from "./Breadcrumbs.js";
import { RowMenu } from "./Modal.js";
import { CommentsPanel } from "./CommentsPanel.js";
import { MarginComments } from "./MarginComments.js";
import { HistoryPanel } from "./HistoryPanel.js";
import { ReadOnlyDoc } from "./ReadOnlyDoc.js";
import { TocRail } from "./TocRail.js";
import { authorColor, authorKey } from "./colors.js";
import { FindBar } from "./FindBar.js";
import { Icon } from "./Icon.js";
import { MOD as MOD_LABEL } from "./keys.js";
import { RollingNumber } from "./motion.js";
import type { MentionCandidate } from "./mention.js";
import { mentionHighlightKey } from "./mention-highlight.js";
import { timeAgo } from "./time.js";
import { TagBar } from "./TagBar.js";
import { SubPages } from "./DocOutline.js";
import { PropertiesPanel, TemplateDefaultsPanel, TypeMenu } from "./PropertiesPanel.js";
import { useAppContext } from "../App.js";
import { friendlyError } from "../errors.js";
import { BlockInserter } from "./editor/BlockInserter.js";
import { buildExtensions } from "./editor/extensions.js";
import { useBlame } from "./editor/useBlame.js";
import { useCollabDoc } from "./editor/useCollabDoc.js";
import { useCommentNavigation, useComments } from "./editor/useComments.js";
import { useDocActions } from "./editor/useDocActions.js";
import { usePresence } from "./editor/usePresence.js";
import { useSnapshots } from "./editor/useSnapshots.js";
import { useTitleEditor } from "./editor/useTitleEditor.js";
import { useLiveSectionGuard } from "./editor/useLiveSectionGuard.js";

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

/** Room a margin comment needs to the right of the text: gap, card, edge. */
const MARGIN_NEEDS = 36 + 248 + 20;

/** Put the caret at the start or end of `editor` and focus it now. TipTap's
 * focus command waits a frame, and keys typed meanwhile land in the editor
 * being left. */
function focusAt(editor: TiptapEditor, where: "start" | "end"): boolean {
  const { state, view } = editor;
  const selection = where === "start" ? Selection.atStart(state.doc) : Selection.atEnd(state.doc);
  view.dispatch(state.tr.setSelection(selection).scrollIntoView());
  view.focus();
  return true;
}

function imageFiles(list: FileList | null | undefined): File[] {
  return Array.from(list ?? []).filter((f) => f.type.startsWith("image/"));
}

export function Editor({
  docId,
  canEdit,
  workspaceId,
  notice = null,
}: {
  docId: string;
  canEdit: boolean;
  workspaceId: string;
  /** Status note (archived, template) shown at the top of the column. */
  notice?: ReactNode;
}) {
  const utils = trpc.useUtils();
  const session = authClient.useSession();
  const [searchParams] = useSearchParams();
  const commentTarget = searchParams.get("comment");
  const historyTarget = searchParams.get("history");
  const taskTarget = searchParams.get("task");
  // Metadata only — the body arrives over Yjs, so we don't fetch it here.
  const doc = trpc.documents.getMeta.useQuery({ id: docId });
  const tagOptions = trpc.documents.listTags.useQuery();
  // Tags only: the title is edited in the doc itself (useTitleEditor).
  const update = trpc.documents.update.useMutation({
    onSuccess: () => {
      void utils.documents.getMeta.invalidate({ id: docId });
      void utils.documents.listTags.invalidate();
    },
  });
  const members = trpc.workspaces.members.useQuery(
    { workspaceId },
    { enabled: !!workspaceId },
  );
  const { openSearch, sidebarCollapsed, toggleSidebar, openShare } = useAppContext();

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

  const uid = session.data?.user.id;
  const { ydoc, provider, connection, synced, persisted } = useCollabDoc(docId, uid, canEdit);

  const user = session.data?.user;
  const me = useMemo(
    () => ({
      name: user?.name ?? "Anonymous",
      color: authorColor(authorKey(user?.id ?? "anon", false)),
    }),
    [user?.id, user?.name],
  );

  const navigate = useNavigate();

  // --- document actions (the "…" menu) ---
  const { isFavorite, favAdd, favRemove, duplicate, copyDocLink, downloadMarkdown } =
    useDocActions(docId);

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
  const [rail, setRail] = useState<null | "comments" | "history">(null);
  const {
    commentItems,
    createComment,
    resolveComment,
    deleteComment,
    pending,
    setPending,
    activeCommentId,
    setActiveCommentId,
    anchorsRef,
    activeCommentRef,
  } = useComments(docId);
  // Find-in-document; the editor keymap opens it through a ref because
  // editorProps are captured once at editor creation.
  const [findOpen, setFindOpen] = useState(false);
  const openFindRef = useRef<() => void>();
  // Moves the caret from the body up into the title; false when it can't.
  const focusTitleRef = useRef<() => boolean>();
  openFindRef.current = () => setFindOpen(true);
  // Link bubble state: null = closed, string = draft href being edited.
  const [linkDraft, setLinkDraft] = useState<string | null>(null);

  // Read once, when the editor is created for this provider (useEditor's deps
  // below); building them on every render was wasted work.
  const extensions = useMemo(
    () =>
      buildExtensions({
        docId,
        ydoc,
        provider,
        me,
        membersRef,
        searchDocs,
        anchorsRef,
        activeCommentRef,
      }),
    [provider],
  );
  const editor = useEditor(
    {
      editable: canEdit,
      extensions,
      // Typing must not re-render the whole page (properties, tags, sub-pages,
      // comments). The pieces that follow the selection subscribe on their
      // own: the format bubble below, the contents rail, the block inserter.
      shouldRerenderOnTransaction: false,
      editorProps: {
        // A document body, as opposed to the title editor above it.
        attributes: { class: "doc-body" },
        handleKeyDown(view, event) {
          // The title is the line above the body: ArrowUp on the first line,
          // and ArrowLeft or Backspace at the very start, move up into it.
          const { selection } = view.state;
          const { $from } = selection;
          const inFirstBlock = selection.empty && $from.depth >= 1 && $from.before(1) === 0;
          const atStart = inFirstBlock && $from.depth === 1 && $from.parentOffset === 0;
          if (
            (event.key === "ArrowUp" && inFirstBlock && view.endOfTextblock("up")) ||
            (event.key === "ArrowLeft" && atStart) ||
            (event.key === "Backspace" && atStart && $from.parent.type.name === "paragraph")
          ) {
            if (focusTitleRef.current?.()) {
              event.preventDefault();
              return true;
            }
          }
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

  // What the format bubble shows; re-renders only when one of these changes.
  const format = useEditorState({
    editor,
    selector: ({ editor: e }) =>
      e
        ? {
            bold: e.isActive("bold"),
            italic: e.isActive("italic"),
            strike: e.isActive("strike"),
            code: e.isActive("code"),
            link: e.isActive("link"),
            codeBlock: e.isActive("codeBlock"),
            hasSelection: !e.state.selection.empty,
          }
        : null,
  });

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
  const peers = usePresence(provider);

  const pageMounted = !!doc.data;
  const docPageRef = useRef<HTMLDivElement>(null);
  const proseFrameRef = useRef<HTMLDivElement>(null);
  const [marginRoom, setMarginRoom] = useState(false);
  useEffect(() => {
    const frame = proseFrameRef.current;
    const main = frame?.closest(".main");
    if (!frame || !main) return;
    const check = () =>
      setMarginRoom(
        main.getBoundingClientRect().right - frame.getBoundingClientRect().right >= MARGIN_NEEDS,
      );
    const observer = new ResizeObserver(check);
    observer.observe(main);
    observer.observe(frame);
    check();
    return () => observer.disconnect();
  }, [pageMounted]);

  // While the reader types, the header steps back; moving the pointer brings
  // it back. A class toggle, not state: keystrokes must not re-render this.
  useEffect(() => {
    const page = docPageRef.current;
    if (!editor || !page) return;
    const dom = editor.view.dom;
    const onKey = (e: KeyboardEvent) => {
      if (!e.metaKey && !e.ctrlKey && !e.altKey) page.classList.add("is-typing");
    };
    const onMove = () => page.classList.remove("is-typing");
    dom.addEventListener("keydown", onKey);
    window.addEventListener("mousemove", onMove, { passive: true });
    return () => {
      dom.removeEventListener("keydown", onKey);
      window.removeEventListener("mousemove", onMove);
    };
  }, [editor, pageMounted]);

  // Members load after the editor mounts; redraw mention tints when they do.
  useEffect(() => {
    if (!editor || !members.data) return;
    editor.view.dispatch(editor.state.tr.setMeta(mentionHighlightKey, true));
  }, [editor, members.data]);
  // Open threads sit in the page's right margin when it has room for them and
  // no panel is using that side; otherwise they live in the comments panel.
  const inMarginRef = useRef(false);
  const inMargin = useCallback(() => inMarginRef.current, []);
  const { startComment, jumpToComment } = useCommentNavigation({
    editor,
    ydoc,
    synced,
    commentTarget,
    commentItems,
    activeCommentId,
    setPending,
    setActiveCommentId,
    setRail,
    inMargin,
  });

  const handledTaskTarget = useRef<string | null>(null);
  useEffect(() => {
    if (!taskTarget || !editor || !synced || handledTaskTarget.current === taskTarget) return;
    const selectTask = () => {
      let matchFrom = -1;
      let matchTo = -1;
      editor.state.doc.descendants((node, pos) => {
        if (matchFrom >= 0 || node.type.name !== "taskItem") return;
        if (node.textContent.trim() === taskTarget.trim()) {
          // taskItem -> paragraph -> text: two positions enter the inline
          // content. Select only its text, not the surrounding list structure.
          matchFrom = pos + 2;
          matchTo = Math.min(pos + node.nodeSize - 2, matchFrom + node.textContent.length);
        }
      });
      if (matchFrom < 0) return false;
      handledTaskTarget.current = taskTarget;
      // Focus as well: ProseMirror only writes the browser selection for a
      // focused view, so without it the jump lands but shows nothing.
      editor
        .chain()
        .setTextSelection({ from: matchFrom, to: matchTo })
        .focus()
        .scrollIntoView()
        .run();
      return true;
    };
    // The CRDT body reaches ProseMirror after the provider reports "synced",
    // so a link opened cold has nothing to match on the first pass.
    if (selectTask()) return;
    const onUpdate = () => {
      if (selectTask()) editor.off("update", onUpdate);
    };
    editor.on("update", onUpdate);
    return () => {
      editor.off("update", onUpdate);
    };
  }, [editor, synced, taskTarget]);

  const openThreadCount = commentItems.filter((c) => !c.parentId && !c.resolvedAt).length;

  // --- history / blame view ---
  const { blameOn, onlySession, setOnlySession, sessions, hover, setHover, onMouseOver } =
    useBlame({ editor, ydoc, rail, setRail, historyTarget });

  // --- version snapshots + preview ---
  const { versions, previewId, setPreviewId, preview, restore } = useSnapshots(docId, rail);
  const marginMode = marginRoom && rail === null && previewId === null;
  inMarginRef.current = marginMode;
  const submitPending = (body: string) => {
    const anchors = pending;
    setPending(null);
    void createComment
      .mutateAsync({
        documentId: docId,
        body,
        ...(anchors ? { anchor: anchors.anchor, head: anchors.head } : {}),
      })
      .then((c) => setActiveCommentId(c.id));
  };

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

  // The title lives in the doc next to the body (title.ts).
  const { titleEditor, title: liveTitle } = useTitleEditor({
    ydoc,
    canEdit,
    synced,
    fallback: doc.data?.title ?? "",
    onExit: () => editor && focusAt(editor, "start"),
  });
  focusTitleRef.current = () => (titleEditor?.isEditable ? focusAt(titleEditor, "end") : false);
  const title = liveTitle ?? doc.data?.title ?? "";
  // The sidebar reads the stored title, which follows the live one when the
  // doc is next stored (a couple of seconds). Show the live one there now,
  // and again after every refetch that still brings the stored one.
  const collectionId = doc.data?.collectionId;
  const tree = trpc.documents.tree.useQuery({ collectionId: collectionId ?? "" }, { enabled: !!collectionId });
  useEffect(() => {
    if (liveTitle === null || !collectionId || !tree.data) return;
    type Node = { id: string; title: string; children: Node[] };
    // Only the path to this page is copied; other rows keep their identity.
    const retitle = (nodes: Node[]): Node[] => {
      let changed = false;
      const next = nodes.map((n) => {
        const out =
          n.id === docId
            ? n.title === liveTitle ? n : { ...n, title: liveTitle }
            : (() => {
                const children = retitle(n.children);
                return children === n.children ? n : { ...n, children };
              })();
        if (out !== n) changed = true;
        return out;
      });
      return changed ? next : nodes;
    };
    utils.documents.tree.setData({ collectionId }, (nodes) => nodes && (retitle(nodes) as typeof nodes));
  }, [liveTitle, collectionId, docId, utils, tree.data]);
  const [propertiesOpen, setPropertiesOpen] = useState(false);
  const myRole = members.data?.find((m) => m.userId === uid)?.role;
  const canDefine = myRole === "owner" || myRole === "admin";
  const templates = trpc.templates.list.useQuery({ workspaceId });
  const template = templates.data?.find((t) => t.id === docId) ?? null;
  useLiveSectionGuard(editor, template !== null);
  if (doc.isLoading) return <div className="empty"><span className="shimmer">Loading…</span></div>;
  if (doc.error)
    return <div className="empty">{friendlyError(doc.error, "Couldn't load this document.")}</div>;
  if (!doc.data) return <div className="empty">Document not found, or you don't have access to it.</div>;

  const status: { label: string; tone: string } =
    connection === "live"
      ? !synced
        ? { label: "Connecting…", tone: "wait" }
        : update.isPending
          ? { label: "Saving…", tone: "wait" }
          : { label: "Live", tone: "ok" }
      : connection === "connecting"
        ? { label: synced ? "Reconnecting…" : "Connecting…", tone: "wait" }
        : persisted
          ? { label: "Offline · saved on this device", tone: "wait" }
          : { label: "Offline", tone: "bad" };

  return (
    <div className="doc-page" ref={docPageRef}>
      <div className="doc-bar">
        <button type="button"
          className="tool-btn icon-only sidebar-toggle"
          aria-label={sidebarCollapsed ? "Show sidebar" : "Hide sidebar"}
          aria-expanded={!sidebarCollapsed}
          title={`${sidebarCollapsed ? "Show" : "Hide"} sidebar (${MOD_LABEL}+\\)`}
          onClick={toggleSidebar}
        >
          <Icon name="sidebar" size={16} />
        </button>
        <Breadcrumbs docId={docId} collectionId={doc.data.collectionId} currentTitle={title} />
        {doc.data.origin?.templateName && (
          <span className="doc-origin" title={`Created from the template "${doc.data.origin.templateName}"`}>
            From template {doc.data.origin.templateName}
          </span>
        )}
        <div className="doc-bar-actions">
          {!canEdit && <span className="save-state">Read only</span>}
          {/* All well is a quiet dot; only trouble earns words. */}
          <span
            className={`save-state status-${status.tone}`}
            title={status.tone === "ok" ? "Live: changes save as you type" : undefined}
          >
            <span className="status-dot" />
            {status.tone === "ok" ? <span className="sr-only">{status.label}</span> : ` ${status.label}`}
          </span>
          <span className="tool-divider" />
          {canEdit && (
            <TypeMenu
              docId={docId}
              workspaceId={workspaceId}
              collectionId={doc.data.collectionId}
              typeId={template ? template.typeId : doc.data.typeId}
              templateId={template?.id ?? null}
              canDefine={canDefine}
              onAttached={() => setPropertiesOpen(true)}
            />
          )}
          <button type="button"
            className={"tool-btn" + (openThreadCount > 0 ? "" : " icon-only") + (rail === "comments" ? " active" : "")}
            aria-label={openThreadCount > 0 ? `Comments (${openThreadCount})` : "Comments"}
            title="All comments, including resolved"
            onClick={() => setRail((r) => (r === "comments" ? null : "comments"))}
          >
            <Icon name="comment" size={16} />
            {openThreadCount > 0 && <RollingNumber value={openThreadCount} />}
          </button>
          <button type="button"
            className={"tool-btn icon-only" + (findOpen ? " active" : "")}
            aria-label="Find"
            title={`Find in document (${MOD_LABEL}+F)`}
            onClick={() => setFindOpen((f) => !f)}
          >
            <Icon name="search" size={16} />
          </button>
          <button type="button"
            className={"tool-btn icon-only" + (blameOn ? " active" : "")}
            aria-label="History"
            title="Edit history: who wrote each part, and when"
            onClick={() => {
              setOnlySession(null);
              setRail((r) => (r === "history" ? null : "history"));
            }}
          >
            <Icon name="restore" size={16} />
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
              <span
                className="presence"
                title={`${peers.map((p) => p.name).join(", ")} ${peers.length === 1 ? "is" : "are"} here`}
              >
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
                <span className="sr-only">{peers.length} editing</span>
              </span>
            </>
          )}
          <button type="button"
            className="btn primary share-btn"
            title="Pages share with their collection"
            onClick={() => openShare(doc.data!.collectionId)}
          >
            Share
          </button>
        </div>
      </div>
    <div className="doc-shell">
      {editor && (
        <BubbleMenu
          editor={editor}
          pluginKey="formatMenu"
          tippyOptions={{ placement: "top", onHidden: () => setLinkDraft(null) }}
          shouldShow={({ editor, state }) =>
            previewId === null &&
            !editor.isActive("table") &&
            !editor.isActive("liveSection") &&
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
              {format?.link && (
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
              {canEdit && !format?.codeBlock && (
                <>
                  <button type="button"
                    className={"bubble-btn" + (format?.bold ? " active" : "")}
                    title="Bold (Mod+B)"
                    aria-label="Bold"
                    onClick={() => editor.chain().focus().toggleBold().run()}
                  >
                    <strong>B</strong>
                  </button>
                  <button type="button"
                    className={"bubble-btn" + (format?.italic ? " active" : "")}
                    title="Italic (Mod+I)"
                    aria-label="Italic"
                    onClick={() => editor.chain().focus().toggleItalic().run()}
                  >
                    <em>I</em>
                  </button>
                  <button type="button"
                    className={"bubble-btn" + (format?.strike ? " active" : "")}
                    title="Strikethrough"
                    aria-label="Strikethrough"
                    onClick={() => editor.chain().focus().toggleStrike().run()}
                  >
                    <s>S</s>
                  </button>
                  <button type="button"
                    className={"bubble-btn" + (format?.code ? " active" : "")}
                    title="Inline code"
                    aria-label="Inline code"
                    onClick={() => editor.chain().focus().toggleCode().run()}
                  >
                    <code>{"<>"}</code>
                  </button>
                  <button type="button"
                    className={"bubble-btn" + (format?.link ? " active" : "")}
                    title={format?.link ? "Edit link" : "Add link"}
                    aria-label={format?.link ? "Edit link" : "Add link"}
                    onClick={() =>
                      setLinkDraft(String(editor.getAttributes("link").href ?? ""))
                    }
                  >
                    Link
                  </button>
                </>
              )}
              {format?.hasSelection && (
                <>
                  {canEdit && <span className="bubble-divider" />}
                  <button type="button" className="bubble-btn" onClick={startComment}>
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
            <button type="button" className="bubble-btn" title="Insert row below" onClick={() => editor.chain().focus().addRowAfter().run()}>+ Row</button>
            <button type="button" className="bubble-btn" title="Insert column right" onClick={() => editor.chain().focus().addColumnAfter().run()}>+ Col</button>
            <button type="button" className="bubble-btn" title="Delete row" onClick={() => editor.chain().focus().deleteRow().run()}>− Row</button>
            <button type="button" className="bubble-btn" title="Delete column" onClick={() => editor.chain().focus().deleteColumn().run()}>− Col</button>
            <button type="button" className="bubble-btn danger" title="Delete table" onClick={() => editor.chain().focus().deleteTable().run()}>Delete</button>
          </div>
        </BubbleMenu>
      )}
      <TocRail editor={editor} hidden={rail !== null || previewId !== null} />
      <div className="editor">
      {findOpen && editor && (
        <FindBar
          editor={editor}
          onClose={() => {
            setFindOpen(false);
            editor.commands.focus();
          }}
        />
      )}
      {notice}
      <EditorContent editor={titleEditor} className="title-editor" />
      <div
        className="doc-meta"
        title={`Created ${new Date(doc.data.createdAt).toLocaleString()}`}
      >
        Updated {timeAgo(doc.data.updatedAt)}
      </div>
      <TagBar
        tags={doc.data.tags}
        canEdit={canEdit}
        suggestions={tagOptions.data?.map((t) => t.tag) ?? []}
        onChange={(tags) => update.mutate({ id: docId, tags })}
        onTagClick={(tag) => openSearch(`#${tag} `)}
      />
      {template ? (
        <TemplateDefaultsPanel
          template={template}
          workspaceId={workspaceId}
          canDefine={canDefine}
          searchDocs={searchDocs}
        />
      ) : (
        <PropertiesPanel
          docId={docId}
          workspaceId={workspaceId}
          ydoc={ydoc}
          typeId={doc.data.typeId}
          canEdit={canEdit}
          canDefine={canDefine}
          open={propertiesOpen}
          onOpenChange={setPropertiesOpen}
          searchDocs={searchDocs}
          synced={synced}
          disconnected={connection === "offline"}
        />
      )}
      <SubPages docId={docId} collectionId={doc.data.collectionId} canEdit={canEdit} />
      {previewId !== null && (
        <div className="preview-banner">
          <span>
            Viewing the version from{" "}
            {preview.data ? new Date(preview.data.createdAt).toLocaleString() : "…"}
          </span>
          <span className="preview-actions">
            {canEdit && (
              <button type="button"
                className="btn primary"
                disabled={restore.isPending || !preview.data}
                onClick={() => restore.mutate({ id: previewId })}
              >
                {restore.isPending ? "Restoring…" : "Restore this version"}
              </button>
            )}
            <button type="button" className="btn" onClick={() => setPreviewId(null)}>
              Back to now
            </button>
          </span>
        </div>
      )}
      {/* Keep the live editor mounted (its collaboration binding survives) but
          hidden while previewing a version. */}
      {/* biome-ignore lint/a11y/useKeyWithMouseEvents: the blame hover card is a pointer affordance; keyboard users read authorship in the History rail */}
      <div
        ref={proseFrameRef}
        className={"prose-frame" + (previewId !== null ? " hidden-editor" : "")}
        onMouseOver={onMouseOver}
        onMouseLeave={() => setHover(null)}
        onClick={onProseClick}
      >
        <EditorContent className="prose" editor={editor} />
        {editor && canEdit && <BlockInserter editor={editor} frame={proseFrameRef} />}
        {editor && marginMode && (
          <MarginComments
            editor={editor}
            ydoc={ydoc}
            frame={proseFrameRef}
            comments={commentItems}
            pending={pending}
            activeId={activeCommentId}
            meId={user?.id ?? null}
            canEdit={canEdit}
            onOpen={jumpToComment}
            onSubmit={submitPending}
            onCancelPending={() => setPending(null)}
            onReply={(parentId, body) =>
              void createComment.mutateAsync({ documentId: docId, body, parentId })
            }
            onResolve={(id, resolved) => resolveComment.mutateAsync({ id, resolved })}
            onDelete={(id) => void deleteComment.mutateAsync({ id })}
          />
        )}
      </div>
      {previewId !== null &&
        (preview.data ? (
          <ReadOnlyDoc key={previewId} contentJson={preview.data.contentJson} />
        ) : (
          <div className="empty"><span className="shimmer">Loading version…</span></div>
        ))}
      {(backlinks.data?.length ?? 0) > 0 && (
        <div className="backlinks">
          <h3>Linked from</h3>
          {backlinks.data!.map((d) => {
            const fields = d.via.flatMap((v) => (v.kind === "property" ? [v.label] : []));
            return (
              <RouterLink key={d.id} className="backlink" to={`/d/${d.id}`}>
                <Icon name="page" size={13} />
                {d.title || "Untitled"}
                {fields.length > 0 && <span className="backlink-via">via {fields.join(", ")}</span>}
              </RouterLink>
            );
          })}
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
          onSubmit={submitPending}
          onCancelPending={() => setPending(null)}
          onReply={(parentId, body) =>
            void createComment.mutateAsync({ documentId: docId, body, parentId })
          }
          onResolve={(id, resolved) => resolveComment.mutateAsync({ id, resolved })}
          onDelete={(id) => void deleteComment.mutateAsync({ id })}
          onJumpTo={jumpToComment}
          onClose={() => {
            setRail(null);
            setPending(null);
          }}
        />
      )}
    </div>
    </div>
  );
}
