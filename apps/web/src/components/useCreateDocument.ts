import { useNavigate } from "react-router-dom";
import { trpc } from "../trpc.js";

/** Creates an untitled document (optionally under a parent), refreshes its
 * collection tree and opens it. Throws on failure; callers report the error. */
export function useCreateDocument() {
  const utils = trpc.useUtils();
  const navigate = useNavigate();
  const create = trpc.documents.create.useMutation();
  return async (collectionId: string, parentDocumentId?: string) => {
    const doc = await create.mutateAsync({
      collectionId,
      title: "",
      ...(parentDocumentId ? { parentDocumentId } : {}),
    });
    await utils.documents.tree.invalidate({ collectionId });
    navigate(`/d/${doc.id}`);
  };
}
