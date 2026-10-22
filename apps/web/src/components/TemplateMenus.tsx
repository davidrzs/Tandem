import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { useState, type FormEvent } from "react";
import { trpc } from "../trpc.js";
import { Icon } from "./Icon.js";
import { Modal } from "./Modal.js";

/** The ▾ beside a "new page" button: Blank, or any template, with the
 * location's default marked. Hidden until the workspace has a template. */
export function NewPageMenu({
  workspaceId,
  collectionId,
  parentDocumentId,
  className,
  onPick,
}: {
  workspaceId: string;
  collectionId: string;
  parentDocumentId?: string;
  className: string;
  /** A template's document id, or null for a blank page. */
  onPick: (templateId: string | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const templates = trpc.templates.list.useQuery({ workspaceId });
  const defaultId = trpc.templates.defaultFor.useQuery(
    { collectionId, parentDocumentId: parentDocumentId ?? null },
    { enabled: open },
  );
  if (!templates.data?.length) return null;
  return (
    <DropdownMenu.Root modal={false} open={open} onOpenChange={setOpen}>
      <DropdownMenu.Trigger asChild>
        {/* Inside a sidebar row <Link>: mark the click handled so the row
            doesn't navigate; Radix opens on pointerdown, unaffected. */}
        <button
          type="button"
          className={className}
          tabIndex={-1}
          title="New from template"
          aria-label="New from template"
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
          }}
          onPointerDown={(e) => e.stopPropagation()}
        >
          <Icon name="chevron" size={12} className="chevron-down" />
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          className="menu-pop"
          align="end"
          sideOffset={4}
          onClick={(e) => e.stopPropagation()}
        >
          <DropdownMenu.Item className="menu-item" onSelect={() => onPick(null)}>
            <Icon name="page" />
            Blank page
          </DropdownMenu.Item>
          {templates.data.map((t) => (
            <DropdownMenu.Item key={t.id} className="menu-item" onSelect={() => onPick(t.id)}>
              <Icon name="page" />
              {t.name}
              {t.id === defaultId.data && <span className="menu-note">default</span>}
            </DropdownMenu.Item>
          ))}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

/** Asks for a template's `{{prompt}}` values before the page is created. */
export function TemplatePromptsDialog({
  name,
  prompts,
  onSubmit,
  onClose,
}: {
  name: string;
  prompts: string[];
  onSubmit: (values: Record<string, string>) => void;
  onClose: () => void;
}) {
  const [values, setValues] = useState<Record<string, string>>({});
  const submit = (e: FormEvent) => {
    e.preventDefault();
    onSubmit(Object.fromEntries(prompts.map((p) => [p, values[p]?.trim() ?? ""])));
  };
  return (
    <Modal title={`New page from ${name}`} onClose={onClose}>
      <form className="dialog-form" onSubmit={submit}>
        {prompts.map((prompt, i) => (
          <label className="field" key={prompt}>
            <span>{prompt}</span>
            <input
              autoFocus={i === 0}
              value={values[prompt] ?? ""}
              onChange={(e) => setValues((prev) => ({ ...prev, [prompt]: e.target.value }))}
            />
          </label>
        ))}
        <div className="dialog-actions">
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn primary">
            Create page
          </button>
        </div>
      </form>
    </Modal>
  );
}

/** Picks the template new pages under a folder or collection start from. */
export function DefaultTemplateDialog({
  place,
  templates,
  initial,
  onSubmit,
  onClose,
}: {
  place: string;
  templates: { id: string; name: string }[];
  initial: string | null;
  onSubmit: (templateId: string | null) => void;
  onClose: () => void;
}) {
  const [value, setValue] = useState(initial ?? "");
  const submit = (e: FormEvent) => {
    e.preventDefault();
    onClose();
    onSubmit(value || null);
  };
  return (
    <Modal title="Default template" onClose={onClose}>
      <form className="dialog-form" onSubmit={submit}>
        <label className="field">
          <span>New pages in {place} start from</span>
          <select value={value} onChange={(e) => setValue(e.target.value)}>
            <option value="">A blank page</option>
            {templates.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
        </label>
        {templates.length === 0 && (
          <p className="dialog-body">Use “Save as template” on a page to add a template.</p>
        )}
        <div className="dialog-actions">
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn primary">
            Save
          </button>
        </div>
      </form>
    </Modal>
  );
}
