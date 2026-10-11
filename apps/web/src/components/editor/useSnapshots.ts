import { useEffect, useState } from "react";
import { trpc } from "../../trpc.js";

/** Version snapshots for the history rail, plus the read-only preview. */
export function useSnapshots(docId: string, rail: null | "comments" | "history") {
  const utils = trpc.useUtils();
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

  return { versions, previewId, setPreviewId, preview, restore };
}
