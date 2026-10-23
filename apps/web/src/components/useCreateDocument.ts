import { createElement, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import { trpc } from "../trpc.js";
import { TemplatePromptsDialog } from "./TemplateMenus.js";
import { localDay } from "./time.js";

/** Creates a page (optionally under a parent) and opens it. `templateId`
 * picks a template, null a blank page, and undefined the location's default
 * template (blank without one). A template with prompts asks for them in a
 * dialog first. Throws on failure; callers report the error. */
export function useCreateDocument(setDialog: (node: ReactNode) => void) {
  const utils = trpc.useUtils();
  const navigate = useNavigate();
  const instantiate = trpc.templates.instantiate.useMutation();
  return async (collectionId: string, parentDocumentId?: string, templateId?: string | null) => {
    // {{date}} is the user's calendar day, not the server's.
    const date = localDay();
    const request = { collectionId, parentDocumentId: parentDocumentId ?? null };
    // A blank page has no template, so no prompts to ask for first.
    const plan =
      templateId === null
        ? null
        : await instantiate.mutateAsync({ ...request, templateId, variables: { date }, dryRun: true });
    const create = async (answers: Record<string, string>) => {
      const { documentId } = await instantiate.mutateAsync({
        ...request,
        templateId: plan?.template?.id ?? null,
        variables: { date, ...answers },
      });
      await utils.documents.tree.invalidate({ collectionId });
      navigate(`/d/${documentId}`);
    };
    if (!plan?.template || plan.missing.length === 0) return create({});
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
