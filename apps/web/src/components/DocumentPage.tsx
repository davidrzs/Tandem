import { useNavigate, useParams } from "react-router-dom";
import { useAppContext } from "../App.js";
import { trpc } from "../trpc.js";
import { Editor } from "./Editor.js";

export function DocumentPage() {
  const { docId } = useParams<{ docId: string }>();
  const { collections } = useAppContext();
  const utils = trpc.useUtils();
  const navigate = useNavigate();
  const meta = trpc.documents.getMeta.useQuery({ id: docId! }, { enabled: !!docId });
  const restore = trpc.documents.restore.useMutation({
    onSuccess: async () => {
      await Promise.all([
        utils.documents.getMeta.invalidate({ id: docId! }),
        utils.documents.tree.invalidate(),
        utils.documents.listArchived.invalidate(),
      ]);
    },
  });

  if (!docId) return null;
  if (meta.isLoading) return <div className="empty">Loading…</div>;
  if (meta.error) {
    return (
      <div className="error-panel">
        <h2>Couldn't load this document</h2>
        <p className="error-detail">{meta.error.message}</p>
        <button className="btn" onClick={() => void meta.refetch()}>
          Retry
        </button>
      </div>
    );
  }
  if (!meta.data) {
    return (
      <div className="empty">
        Document not found, or you don't have access to it.{" "}
        <button className="btn" onClick={() => navigate("/")}>
          Go home
        </button>
      </div>
    );
  }

  const collection = collections.find((c) => c.id === meta.data!.collectionId);
  const archived = !!meta.data.archivedAt;
  const canEdit = (collection?.writable ?? false) && !archived;

  return (
    <>
      {archived && (
        <div className="archived-banner">
          This document is archived — it's hidden from the sidebar and search.
          {collection?.writable && (
            <button
              className="btn"
              disabled={restore.isPending}
              onClick={() => restore.mutate({ id: docId })}
            >
              {restore.isPending ? "Restoring…" : "Restore"}
            </button>
          )}
        </div>
      )}
      <Editor
        key={docId}
        docId={docId}
        canEdit={canEdit}
        workspaceId={meta.data.workspaceId}
      />
    </>
  );
}
