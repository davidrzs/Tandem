import type { ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import { friendlyError } from "../../errors.js";
import { trpc } from "../../trpc.js";
import { ConfirmDialog, PromptDialog } from "../Modal.js";
import { useToast } from "../toast.js";
import type { MovePlan } from "./drop.js";
import { revealChanges } from "./folds.js";
import type { Collection } from "./types.js";
import type { Folds } from "./useFoldState.js";
import { useCreateDocument } from "../useCreateDocument.js";

export interface DocRef {
  id: string;
  collectionId: string;
  title: string;
}

export interface SidebarActions {
  newDoc(collectionId: string, parentDocumentId?: string): Promise<void>;
  /** Doc moves toast with Undo; collection moves don't (as before). */
  move(plan: MovePlan): Promise<void>;
  retryTree(collectionId: string): void;
  renameCollection(c: Collection): void;
  shareCollection(c: Collection): void;
  exportCollection(c: Collection): void;
  deleteCollection(c: Collection): void;
  duplicateDoc(d: DocRef): Promise<void>;
  archiveDoc(d: DocRef, wasActive: boolean): Promise<void>;
  deleteDoc(d: DocRef, wasActive: boolean): Promise<void>;
  restoreArchived(d: DocRef): Promise<void>;
  trashArchived(d: DocRef): Promise<void>;
  restoreTrashed(d: DocRef): Promise<void>;
  purgeTrashed(d: DocRef): void;
}

const titleOf = (d: DocRef) => d.title || "Untitled";

/** Every sidebar mutation with its refresh, toast and undo. Rows call verbs
 * and never import trpc. */
export function useSidebarActions({
  folds,
  onError,
  setDialog,
  onShareCollection,
}: {
  folds: Folds;
  onError: (msg: string) => void;
  setDialog: (node: ReactNode) => void;
  onShareCollection: (id: string) => void;
}): SidebarActions {
  const utils = trpc.useUtils();
  const navigate = useNavigate();
  const toast = useToast();
  const createDocument = useCreateDocument();
  const moveDoc = trpc.documents.move.useMutation();
  const duplicate = trpc.documents.duplicate.useMutation();
  const archive = trpc.documents.archive.useMutation();
  const restore = trpc.documents.restore.useMutation();
  const softDelete = trpc.documents.delete.useMutation();
  const restoreFromTrash = trpc.documents.restoreFromTrash.useMutation();
  const purge = trpc.documents.purge.useMutation();
  const renameCollection = trpc.collections.update.useMutation();
  const deleteCollection = trpc.collections.delete.useMutation();
  const moveCollection = trpc.collections.move.useMutation();

  const closeDialog = () => setDialog(null);

  /** Runs a mutation, then refreshes every list it can touch; failures land in
   * the sidebar's error line instead of an unhandled rejection. */
  const run = async (collectionId: string, fn: () => Promise<unknown>) => {
    try {
      await fn();
      await Promise.all([
        utils.documents.tree.invalidate({ collectionId }),
        utils.documents.listArchived.invalidate({ collectionId }),
        utils.documents.listTrash.invalidate({ collectionId }),
        utils.documents.getTrashed.invalidate(),
        // Archive/restore change a document's archivedAt; a stale getMeta would
        // render the doc page without its archived banner (or with a stale one).
        utils.documents.getMeta.invalidate(),
      ]);
    } catch (e) {
      onError(friendlyError(e));
    }
  };

  const updateCollections = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
      await utils.collections.list.invalidate();
    } catch (e) {
      onError(friendlyError(e));
    }
  };

  return {
    newDoc: async (collectionId: string, parentDocumentId?: string) => {
      folds.apply([
        { kind: "collection", id: collectionId, expanded: true },
        ...(parentDocumentId ? revealChanges([parentDocumentId]) : []),
      ]);
      try {
        await createDocument(collectionId, parentDocumentId);
      } catch (e) {
        onError(friendlyError(e));
      }
    },

    move: (plan: MovePlan) => {
      if (plan.kind === "collection") {
        return updateCollections(() => moveCollection.mutateAsync({ id: plan.id, position: plan.position }));
      }
      // Nesting into a folded folder unfolds it so the drop stays visible.
      if (plan.reveal) folds.apply(revealChanges([plan.reveal]));
      return run(plan.collectionId, async () => {
        await moveDoc.mutateAsync({ id: plan.id, ...plan.to });
        toast(`Moved "${titleOf(plan)}"`, "ok", {
          label: "Undo",
          onClick: () => void run(plan.collectionId, () => moveDoc.mutateAsync({ id: plan.id, ...plan.from })),
        });
      });
    },

    retryTree: (collectionId: string) => void utils.documents.tree.refetch({ collectionId }),

    renameCollection: (c: Collection) =>
      setDialog(
        <PromptDialog
          title="Rename collection"
          label="Name"
          submitLabel="Rename"
          initialValue={c.name}
          onClose={closeDialog}
          onSubmit={(name) => void updateCollections(() => renameCollection.mutateAsync({ id: c.id, name }))}
        />,
      ),

    shareCollection: (c: Collection) => onShareCollection(c.id),

    exportCollection: (c: Collection) => {
      window.location.href = `/api/export?collection=${c.id}`;
    },

    deleteCollection: (c: Collection) =>
      setDialog(
        <ConfirmDialog
          title="Delete collection"
          body={`"${c.name}" and every document in it will be deleted. Only a workspace owner or admin can do this.`}
          confirmLabel="Delete collection"
          onClose={closeDialog}
          onConfirm={() =>
            void updateCollections(async () => {
              await deleteCollection.mutateAsync({ id: c.id });
              navigate("/");
            })
          }
        />,
      ),

    duplicateDoc: (d: DocRef) =>
      run(d.collectionId, async () => {
        const created = await duplicate.mutateAsync({ id: d.id });
        toast("Duplicated");
        navigate(`/d/${created.id}`);
      }),

    archiveDoc: (d: DocRef, wasActive: boolean) =>
      run(d.collectionId, async () => {
        await archive.mutateAsync({ id: d.id });
        toast(`Archived "${titleOf(d)}"`, "ok", {
          label: "Undo",
          onClick: () =>
            void run(d.collectionId, async () => {
              await restore.mutateAsync({ id: d.id });
              if (wasActive) navigate(`/d/${d.id}`);
            }),
        });
        if (wasActive) navigate("/");
      }),

    // Reversible (trash + Undo), so no confirmation step.
    deleteDoc: (d: DocRef, wasActive: boolean) =>
      run(d.collectionId, async () => {
        await softDelete.mutateAsync({ id: d.id });
        toast(`Moved "${titleOf(d)}" to trash`, "ok", {
          label: "Undo",
          onClick: () =>
            void run(d.collectionId, async () => {
              await restoreFromTrash.mutateAsync({ id: d.id });
              if (wasActive) navigate(`/d/${d.id}`);
            }),
        });
        if (wasActive) navigate("/");
      }),

    restoreArchived: (d: DocRef) =>
      run(d.collectionId, async () => {
        await restore.mutateAsync({ id: d.id });
        toast(`Restored "${titleOf(d)}"`);
      }),

    trashArchived: (d: DocRef) =>
      run(d.collectionId, async () => {
        await softDelete.mutateAsync({ id: d.id });
        toast(`Moved "${titleOf(d)}" to trash`, "ok", {
          label: "Undo",
          onClick: () => void run(d.collectionId, () => restoreFromTrash.mutateAsync({ id: d.id })),
        });
      }),

    restoreTrashed: (d: DocRef) =>
      run(d.collectionId, async () => {
        await restoreFromTrash.mutateAsync({ id: d.id });
        toast(`Restored "${titleOf(d)}"`);
      }),

    purgeTrashed: (d: DocRef) =>
      setDialog(
        <ConfirmDialog
          title="Delete forever"
          body={`"${titleOf(d)}" and the sub-documents deleted with it will be gone for good. This can't be undone.`}
          confirmLabel="Delete forever"
          onClose={closeDialog}
          onConfirm={() => void run(d.collectionId, () => purge.mutateAsync({ id: d.id }))}
        />,
      ),
  };
}
