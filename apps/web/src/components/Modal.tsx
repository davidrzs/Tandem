import * as Dialog from "@radix-ui/react-dialog";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { Icon, type IconName } from "./Icon.js";

/**
 * Dialog and menu chrome on Radix primitives: focus trapping, keyboard
 * navigation, dismissal, and collision-aware positioning come from the
 * library; only the skin (classes below) is ours.
 */

export function Modal({
  title,
  onClose,
  children,
  wide,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  wide?: boolean;
}) {
  return (
    <Dialog.Root open onOpenChange={(open) => !open && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="modal-overlay" />
        <Dialog.Content className={"modal" + (wide ? " wide" : "")} aria-describedby={undefined}>
          <div className="modal-head">
            <Dialog.Title asChild>
              <h2>{title}</h2>
            </Dialog.Title>
            <Dialog.Close asChild>
              <button className="modal-close" title="Close" aria-label="Close">
                <Icon name="close" />
              </button>
            </Dialog.Close>
          </div>
          {children}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/** Small centered dialog asking for one name/value. Replaces window.prompt. */
export function PromptDialog({
  title,
  label,
  submitLabel,
  initialValue = "",
  placeholder,
  onSubmit,
  onClose,
}: {
  title: string;
  label: string;
  submitLabel: string;
  initialValue?: string;
  placeholder?: string;
  onSubmit: (value: string) => void;
  onClose: () => void;
}) {
  const [value, setValue] = useState(initialValue);
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => inputRef.current?.focus(), []);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const trimmed = value.trim();
    if (!trimmed) return;
    onClose();
    onSubmit(trimmed);
  };

  return (
    <Modal title={title} onClose={onClose}>
      <form className="dialog-form" onSubmit={submit}>
        <label className="field">
          <span>{label}</span>
          <input
            ref={inputRef}
            value={value}
            placeholder={placeholder}
            onChange={(e) => setValue(e.target.value)}
          />
        </label>
        <div className="dialog-actions">
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn primary" disabled={!value.trim()}>
            {submitLabel}
          </button>
        </div>
      </form>
    </Modal>
  );
}

/** Confirmation for destructive actions. Replaces window.confirm. */
export function ConfirmDialog({
  title,
  body,
  confirmLabel,
  onConfirm,
  onClose,
}: {
  title: string;
  body: string;
  confirmLabel: string;
  onConfirm: () => void;
  onClose: () => void;
}) {
  return (
    <Modal title={title} onClose={onClose}>
      <p className="dialog-body">{body}</p>
      <div className="dialog-actions">
        <button className="btn" onClick={onClose} autoFocus>
          Cancel
        </button>
        <button
          className="btn danger"
          onClick={() => {
            onClose();
            onConfirm();
          }}
        >
          {confirmLabel}
        </button>
      </div>
    </Modal>
  );
}

export interface MenuItem {
  label: string;
  icon?: IconName;
  danger?: boolean;
  onClick: () => void;
}

/** Row-level "…" dropdown. Rendered in a portal with real menu semantics;
 * clicks never leak into the row/link underneath. */
export function RowMenu({
  items,
  title = "More actions",
}: {
  items: MenuItem[];
  title?: string;
}) {
  return (
    <DropdownMenu.Root modal={false}>
      <DropdownMenu.Trigger asChild>
        {/* preventDefault marks the event handled so an enclosing router
            <Link> skips navigation; Radix toggles on pointerdown, unaffected. */}
        <button
          className="row-action"
          title={title}
          aria-label={title}
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
          }}
          onPointerDown={(e) => e.stopPropagation()}
        >
          <Icon name="dots" />
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        {/* Portal contents still bubble through the REACT tree into the row's
            <Link>; stop clicks here (after items handled them) — but never
            preventDefault, which would cancel Radix's own select handling. */}
        <DropdownMenu.Content
          className="menu-pop"
          align="end"
          sideOffset={4}
          onClick={(e) => e.stopPropagation()}
        >
          {items.map((item) => (
            <DropdownMenu.Item
              key={item.label}
              className={"menu-item" + (item.danger ? " danger" : "")}
              onSelect={item.onClick}
            >
              {item.icon && <Icon name={item.icon} />}
              {item.label}
            </DropdownMenu.Item>
          ))}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
