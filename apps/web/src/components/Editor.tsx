import { EditorContent, useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { useCallback, useEffect, useRef, useState } from "react";
import { Markdown } from "tiptap-markdown";
import { trpc } from "../trpc.js";

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

export function Editor({ docId }: { docId: string }) {
  const utils = trpc.useUtils();
  const doc = trpc.documents.get.useQuery({ id: docId });
  const update = trpc.documents.update.useMutation();

  const [title, setTitle] = useState("");
  const [saved, setSaved] = useState<"saved" | "saving">("saved");
  const loaded = useRef(false);

  const editor = useEditor({
    extensions: [StarterKit, Markdown.configure({ html: false })],
    content: "",
  });

  // Hydrate once when the document loads.
  useEffect(() => {
    if (!editor || !doc.data || loaded.current) return;
    setTitle(doc.data.title);
    editor.commands.setContent(doc.data.contentMd, false);
    loaded.current = true;
  }, [editor, doc.data]);

  const save = useCallback(
    (patch: { title?: string; markdown?: string }) => {
      setSaved("saving");
      update.mutate(
        { id: docId, ...patch },
        {
          onSuccess: () => {
            setSaved("saved");
            // Title changes affect the sidebar label.
            if (patch.title !== undefined) utils.documents.tree.invalidate();
          },
        },
      );
    },
    [docId, update, utils],
  );

  const debouncedSaveBody = useDebounced(
    (markdown: string) => save({ markdown }),
    700,
  );
  const debouncedSaveTitle = useDebounced((t: string) => save({ title: t }), 500);

  // Persist body edits.
  useEffect(() => {
    if (!editor) return;
    const handler = () => {
      if (!loaded.current) return;
      debouncedSaveBody(editor.storage.markdown.getMarkdown());
    };
    editor.on("update", handler);
    return () => {
      editor.off("update", handler);
    };
  }, [editor, debouncedSaveBody]);

  if (doc.isLoading) return <div className="empty">Loading…</div>;
  if (!doc.data) return <div className="empty">Document not found.</div>;

  return (
    <div className="editor">
      <div className="editor-header">
        <input
          className="title-input"
          value={title}
          placeholder="Untitled"
          onChange={(e) => {
            setTitle(e.target.value);
            debouncedSaveTitle(e.target.value);
          }}
        />
        <span className="save-state">{saved === "saving" ? "Saving…" : "Saved"}</span>
      </div>
      <EditorContent className="prose" editor={editor} />
    </div>
  );
}
