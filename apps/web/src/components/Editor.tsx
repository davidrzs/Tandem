import { HocuspocusProvider } from "@hocuspocus/provider";
import Collaboration from "@tiptap/extension-collaboration";
import { EditorContent, useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { useCallback, useEffect, useRef, useState } from "react";
import * as Y from "yjs";
import { trpc } from "../trpc.js";
import { SlashCommand } from "./slash-command.js";

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

export function Editor({ docId, canEdit }: { docId: string; canEdit: boolean }) {
  const utils = trpc.useUtils();
  const doc = trpc.documents.get.useQuery({ id: docId });
  const update = trpc.documents.update.useMutation();

  // Stable Y.Doc for the editor binding (Editor is keyed by docId, so one per
  // open document). The provider lives in an effect so StrictMode's mount/
  // unmount/mount cycle recreates it cleanly instead of leaving it destroyed.
  const [ydoc] = useState(() => new Y.Doc());
  useEffect(() => {
    const provider = new HocuspocusProvider({
      url: collabUrl(),
      name: docId,
      token: "cookie", // real auth is the session cookie on the handshake
      document: ydoc,
    });
    return () => provider.destroy();
  }, [ydoc, docId]);

  const editor = useEditor({
    editable: canEdit,
    extensions: [
      // History is disabled — Collaboration manages undo via Yjs.
      StarterKit.configure({ history: false }),
      Collaboration.configure({ document: ydoc, field: "default" }),
      SlashCommand,
    ],
  });

  // Reflect access changes without recreating the editor (which would race
  // with typing and drop the Yjs binding).
  useEffect(() => {
    editor?.setEditable(canEdit);
  }, [editor, canEdit]);

  // Title is independent of the Yjs body; persist it via tRPC.
  const [title, setTitle] = useState("");
  const [saved, setSaved] = useState<"saved" | "saving">("saved");
  const titleLoaded = useRef(false);
  useEffect(() => {
    if (!titleLoaded.current && doc.data) {
      setTitle(doc.data.title);
      titleLoaded.current = true;
    }
  }, [doc.data]);

  const saveTitle = useDebounced((t: string) => {
    setSaved("saving");
    update.mutate(
      { id: docId, title: t },
      {
        onSuccess: () => {
          setSaved("saved");
          utils.documents.tree.invalidate();
        },
      },
    );
  }, 500);

  if (doc.isLoading) return <div className="empty">Loading…</div>;
  if (!doc.data) return <div className="empty">Document not found.</div>;

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
        <span className="save-state">
          {!canEdit ? "Read only" : saved === "saving" ? "Saving…" : "Synced"}
        </span>
      </div>
      <EditorContent className="prose" editor={editor} />
    </div>
  );
}
