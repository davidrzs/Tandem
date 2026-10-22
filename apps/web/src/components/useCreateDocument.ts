import { createElement, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import { trpc } from "../trpc.js";
import { TemplatePromptsDialog } from "./TemplateMenus.js";

/** Creates a page (optionally under a parent) and opens it. `templateId`
 * picks a template, null a blank page, and undefined the location's default
 * template (blank without one). A template with prompts asks for them in a
 * dialog first. Throws on failure; callers report the error. */
export function useCreateDocument(setDialog: (node: ReactNode) => void) {
  const utils = trpc.useUtils();
  const navigate = useNavigate();
  const instantiate = trpc.templates.instantiate.useMutation();
  return async (collectionId: string, parentDocumentId?: string, templateId?: string | null) => {
    const now = new Date();
    // {{date}} is the user's calendar day, not the server's.
    const date = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
    const request = { collectionId, parentDocumentId: parentDocumentId ?? null };
    const plan = await instantiate.mutateAsync({ ...request, templateId, variables: { date }, dryRun: true });
    const create = async (answers: Record<string, string>) => {
      const { documentId } = await instantiate.mutateAsync({
        ...request,
        templateId: plan.template?.id ?? null,
        variables: { date, ...answers },
      });
      await utils.documents.tree.invalidate({ collectionId });
      navigate(`/d/${documentId}`);
    };
    if (!plan.template || plan.missing.length === 0) return create({});
    const template = plan.template;
    await new Promise<void>((resolve, reject) => {
      setDialog(
        createElement(TemplatePromptsDialog, {
          name: template.name,
          prompts: plan.missing,
          onClose: () => {
            setDialog(null);
            resolve();
          },
          onSubmit: (answers) => {
            setDialog(null);
            create(answers).then(resolve, reject);
          },
        }),
      );
    });
  };
}
