import { trpc } from "../trpc.js";

/** Create a document and land in it. Shared by Home and the ⌘K palette so
 * both refresh the same caches, including the first-run existence check. */
export function useCreateDocument(
  workspaceId: string | null,
  onCreated: (documentId: string) => void,
) {
  const utils = trpc.useUtils();
  return trpc.documents.create.useMutation({
    onSuccess: async (doc) => {
      await Promise.all([
        utils.documents.tree.invalidate(),
        workspaceId
          ? utils.documents.hasAny.invalidate({ workspaceId })
          : Promise.resolve(),
      ]);
      onCreated(doc.id);
    },
  });
}
