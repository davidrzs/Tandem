import { useNavigate } from "react-router-dom";
import { friendlyError } from "../../errors.js";
import { trpc } from "../../trpc.js";
import { useToast } from "../toast.js";

/** Mutations and helpers behind the document's "…" menu. */
export function useDocActions(docId: string) {
  const utils = trpc.useUtils();
  const navigate = useNavigate();
  const toast = useToast();
  const favorites = trpc.favorites.list.useQuery();
  const isFavorite = (favorites.data ?? []).some((f) => f.id === docId);
  const favAdd = trpc.favorites.add.useMutation({
    onSuccess: () => {
      void utils.favorites.list.invalidate();
      toast("Added to favorites");
    },
  });
  const favRemove = trpc.favorites.remove.useMutation({
    onSuccess: () => {
      void utils.favorites.list.invalidate();
      toast("Removed from favorites");
    },
  });
  const duplicate = trpc.documents.duplicate.useMutation({
    onSuccess: (created) => {
      void utils.documents.tree.invalidate();
      toast("Duplicated");
      navigate(`/d/${created.id}`);
    },
    onError: (e) => toast(friendlyError(e, "Couldn't duplicate this document."), "danger"),
  });
  const copyDocLink = () => {
    void navigator.clipboard
      .writeText(`${window.location.origin}/d/${docId}`)
      .then(() => toast("Link copied"));
  };
  const downloadMarkdown = async () => {
    try {
      const { title: t, markdown } = await utils.documents.getMarkdown.fetch({ id: docId });
      const blob = new Blob([markdown], { type: "text/markdown" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `${(t || "untitled").replace(/[^\w.-]+/g, "_")}.md`;
      a.click();
      URL.revokeObjectURL(a.href);
    } catch {
      toast("Couldn't export this document.", "danger");
    }
  };

  return { isFavorite, favAdd, favRemove, duplicate, copyDocLink, downloadMarkdown };
}
