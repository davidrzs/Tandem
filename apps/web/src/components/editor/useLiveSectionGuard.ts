import type { Editor } from "@tiptap/core";
import type { Node } from "@tiptap/pm/model";
import type { Transaction } from "@tiptap/pm/state";
import { useEffect } from "react";
import { ySyncPluginKey } from "y-prosemirror";
import { useToast } from "../toast.js";

function liveSections(doc: Node): number {
  let count = 0;
  doc.descendants((node) => {
    if (node.type.name === "liveSection") count++;
  });
  return count;
}

/** On a template's page, toast when an edit removes a live section: every
 * page made from the template afterwards would miss it. The user's own edit
 * gets Undo; a collaborator's or agent's arrives through Yjs and doesn't. */
export function useLiveSectionGuard(editor: Editor | null, isTemplate: boolean): void {
  const toast = useToast();
  useEffect(() => {
    if (!editor || !isTemplate) return;
    const onTransaction = ({ transaction }: { transaction: Transaction }) => {
      if (!transaction.docChanged || liveSections(transaction.doc) >= liveSections(transaction.before)) return;
      const remote = (transaction.getMeta(ySyncPluginKey) as { isChangeOrigin?: boolean } | undefined)
        ?.isChangeOrigin;
      toast(
        "This template lost a live section",
        "danger",
        remote ? undefined : { label: "Undo", onClick: () => editor.commands.undo() },
      );
    };
    editor.on("transaction", onTransaction);
    return () => {
      editor.off("transaction", onTransaction);
    };
  }, [editor, isTemplate, toast]);
}
