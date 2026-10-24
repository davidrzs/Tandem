import { BubbleMenu, EditorContent, useEditor } from "@tiptap/react";
import type { EditorView } from "@tiptap/pm/view";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link as RouterLink, useNavigate, useSearchParams } from "react-router-dom";
import { authClient } from "../auth-client.js";
import { trpc } from "../trpc.js";
import { Breadcrumbs } from "./Breadcrumbs.js";
import { RowMenu } from "./Modal.js";
import { CommentsPanel } from "./CommentsPanel.js";
import { HistoryPanel } from "./HistoryPanel.js";
import { ReadOnlyDoc } from "./ReadOnlyDoc.js";
import { TocRail } from "./TocRail.js";
import { authorColor, authorKey } from "./colors.js";
import { FindBar } from "./FindBar.js";
import { Icon } from "./Icon.js";
import type { MentionCandidate } from "./mention.js";
import { mentionHighlightKey } from "./mention-highlight.js";
import { timeAgo } from "./time.js";
import { TagBar } from "./TagBar.js";
import { SubPages } from "./DocOutline.js";
import { PropertiesPanel, TemplateDefaultsPanel, TypeMenu } from "./PropertiesPanel.js";
import { useAppContext } from "../App.js";
import { friendlyError } from "../errors.js";
import { buildExtensions } from "./editor/extensions.js";
import { useBlame } from "./editor/useBlame.js";
import { useCollabDoc } from "./editor/useCollabDoc.js";
import { useCommentNavigation, useComments } from "./editor/useComments.js";
import { useDocActions } from "./editor/useDocActions.js";
import { usePresence } from "./editor/usePresence.js";
import { useSnapshots } from "./editor/useSnapshots.js";
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
  const [searchParams] = useSearchParams();
  const commentTarget = searchParams.get("comment");
  const historyTarget = searchParams.get("history");
  const taskTarget = searchParams.get("task");
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
  openFindRef.current = () => setFindOpen(true);
  // Link bubble state: null = closed, string = draft href being edited.
  const [linkDraft, setLinkDraft] = useState<string | null>(null);

  const editor = useEditor(
    {
      editable: canEdit,
      extensions: buildExtensions({
        docId,
        ydoc,
        provider,
        me,
        membersRef,
        searchDocs,
        anchorsRef,
        activeCommentRef,
      }),
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
  const peers = usePresence(provider);

  // Members load after the editor mounts; redraw mention tints when they do.
  useEffect(() => {
    if (!editor || !members.data) return;
    editor.view.dispatch(editor.state.tr.setMeta(mentionHighlightKey, true));
  }, [editor, members.data]);
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

  // Title is independent of the Yjs body; persist it via tRPC. A collaborator's
  // rename arrives as a refetched getMeta (via the "meta" ping): adopt it unless
  // this input is focused or holds unsaved local edits — then local wins
  // (last-writer, like the save itself).
  const [title, setTitle] = useState("");
  const titleLoaded = useRef(false);
  const titleDirty = useRef(false);
  const titleInputRef = useRef<HTMLInputElement>(null);
  const [propertiesOpen, setPropertiesOpen] = useState(false);
  const myRole = members.data?.find((m) => m.userId === uid)?.role;
  const canDefine = myRole === "owner" || myRole === "admin";
  const templates = trpc.templates.list.useQuery({ workspaceId });
  const template = templates.data?.find((t) => t.id === docId) ?? null;
  useLiveSectionGuard(editor, template !== null);
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
    <div className="doc-page">
      <div className="doc-bar">
        <Breadcrumbs docId={docId} collectionId={doc.data.collectionId} currentTitle={title} />
        {doc.data.origin?.templateName && (
          <span className="doc-origin" title={`Created from the template "${doc.data.origin.templateName}"`}>
            From template {doc.data.origin.templateName}
          </span>
        )}
        <div className="doc-bar-actions">
          {!canEdit && <span className="save-state">Read only</span>}
          <span className={`save-state status-${status.tone}`}>
            <span className="status-dot" /> {status.label}
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
            className={"tool-btn" + (rail === "comments" ? " active" : "")}
            title="Show comments"
            onClick={() => setRail((r) => (r === "comments" ? null : "comments"))}
          >
            <Icon name="comment" size={15} />
            Comments{openThreadCount > 0 ? ` (${openThreadCount})` : ""}
          </button>
          <button type="button"
            className={"tool-btn" + (findOpen ? " active" : "")}
            title="Find in document (Mod+F)"
            onClick={() => setFindOpen((f) => !f)}
          >
            <Icon name="search" size={15} />
            Find
          </button>
          <button type="button"
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
                  <button type="button"
                    className={"bubble-btn" + (editor.isActive("bold") ? " active" : "")}
                    title="Bold (Mod+B)"
                    aria-label="Bold"
                    onClick={() => editor.chain().focus().toggleBold().run()}
                  >
                    <strong>B</strong>
                  </button>
                  <button type="button"
                    className={"bubble-btn" + (editor.isActive("italic") ? " active" : "")}
                    title="Italic (Mod+I)"
                    aria-label="Italic"
                    onClick={() => editor.chain().focus().toggleItalic().run()}
                  >
                    <em>I</em>
                  </button>
                  <button type="button"
                    className={"bubble-btn" + (editor.isActive("strike") ? " active" : "")}
                    title="Strikethrough"
                    aria-label="Strikethrough"
                    onClick={() => editor.chain().focus().toggleStrike().run()}
                  >
                    <s>S</s>
                  </button>
                  <button type="button"
                    className={"bubble-btn" + (editor.isActive("code") ? " active" : "")}
                    title="Inline code"
                    aria-label="Inline code"
                    onClick={() => editor.chain().focus().toggleCode().run()}
                  >
                    <code>{"<>"}</code>
                  </button>
                  <button type="button"
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
        className={previewId !== null ? "hidden-editor" : ""}
        onMouseOver={onMouseOver}
        onMouseLeave={() => setHover(null)}
        onClick={onProseClick}
      >
        <EditorContent className="prose" editor={editor} />
      </div>
      {previewId !== null &&
        (preview.data ? (
          <ReadOnlyDoc key={previewId} contentJson={preview.data.contentJson} />
        ) : (
          <div className="empty">Loading version…</div>
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
    </div>
  );
}
