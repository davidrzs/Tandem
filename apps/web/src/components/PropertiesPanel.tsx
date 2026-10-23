import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { getAuthors, propertiesToJSON, propertyBlame, PROPERTIES_KEY } from "@tandem/editor";
import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ComponentProps,
  type FocusEvent,
  type FormEvent,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { Link } from "react-router-dom";
import type * as Y from "yjs";
import { friendlyError } from "../errors.js";
import { trpc } from "../trpc.js";
import { Icon } from "./Icon.js";
import type { DocCandidate } from "./mention.js";
import { ConfirmDialog, Modal, PromptDialog } from "./Modal.js";
import {
  aiMarks,
  datetimeToInput,
  describeDefault,
  editFromDateInput,
  editFromText,
  EXPRESSION_CHOICES,
  formatValue,
  isEmptyValue,
  isListKind,
  keyFromLabel,
  labelledError,
  listValues,
  literalDefault,
  markFor,
  optionLabel,
  pageLabel,
  patchFor,
  safeHref,
  summaryText,
  type AiMark,
  type Field,
  type FieldKind,
  type PropertyEdit,
  type DefaultInput,
  type TemplateDefault,
  type TemplateInfo,
  type FormatOptions,
} from "./properties.js";
import { useToast } from "./toast.js";

type SearchDocs = (query: string) => Promise<DocCandidate[]>;
type TitleOf = NonNullable<FormatOptions["titleOf"]>;
/** Saves one edit; resolves false when it failed (the error is already shown). */
type OnEdit = (edit: PropertyEdit) => Promise<boolean>;
/** A scalar widget's control: its id, and its name when no <label> points at it. */
type Control = { id: string; "aria-label"?: string };

const KIND_LABELS: Record<Exclude<FieldKind, "json">, string> = {
  text: "Text",
  number: "Number",
  checkbox: "Checkbox",
  date: "Date",
  datetime: "Date and time",
  select: "Select",
  multi_select: "Multi-select",
  url: "Link",
  doc: "Page",
  doc_list: "Pages",
};

/** The page's raw property values and AI marks, re-read whenever the live
 * map changes: local echoes, other people, and agents alike. */
function useLiveProperties(ydoc: Y.Doc) {
  const read = () => ({
    values: propertiesToJSON(ydoc),
    marks: aiMarks(propertyBlame(ydoc), getAuthors(ydoc)),
  });
  const [state, setState] = useState(read);
  useEffect(() => {
    const map = ydoc.getMap(PROPERTIES_KEY);
    const update = () => setState(read());
    update();
    map.observeDeep(update);
    return () => map.unobserveDeep(update);
  }, [ydoc]);
  return state;
}

/** Current titles of the pages that doc and doc_list values point at: null
 * once the server says the reader can't see one, undefined while loading. */
function usePageTitles(ids: string[]): TitleOf {
  const metas = trpc.useQueries((t) => ids.map((id) => t.documents.getMeta({ id }, { staleTime: 30_000 })));
  const titles = new Map(ids.flatMap((id, i) => (metas[i]?.isSuccess ? [[id, metas[i].data?.title ?? null] as const] : [])));
  return (id) => titles.get(id);
}

const FOCUSABLE = "a[href], button:not(:disabled), input:not(:disabled), select:not(:disabled)";

/** Where a control sits: its field's row, and its place among the
 * focusable controls of that row and of the whole panel. */
interface Place {
  el: HTMLElement;
  row: HTMLElement | null;
  inRow: number;
  inPanel: number;
}

function placeOf(el: HTMLElement, root: HTMLElement): Place {
  const row = el.closest<HTMLElement>("[data-field]");
  return {
    el,
    row,
    inRow: row ? [...row.querySelectorAll(FOCUSABLE)].indexOf(el) : -1,
    inPanel: [...root.querySelectorAll(FOCUSABLE)].indexOf(el),
  };
}

/** Keeps keyboard focus in a panel when the focused control goes away (a
 * removed chip, a picker replaced by the page it picked, an Add control out
 * of options, a removed field): focus moves to the control that now sits
 * where it was, in its field's row while the row is there. Spread the result
 * on the panel's root. */
function useFocusKeeper() {
  const ref = useRef<HTMLElement>(null);
  const last = useRef<Place | null>(null);
  useLayoutEffect(() => {
    const seen = last.current;
    if (!seen || !ref.current) return;
    if (seen.el.isConnected) {
      last.current = placeOf(seen.el, ref.current);
      return;
    }
    last.current = null;
    if (document.activeElement && document.activeElement !== document.body) return;
    const inRow = seen.row?.isConnected ? [...seen.row.querySelectorAll<HTMLElement>(FOCUSABLE)] : [];
    const [list, index] =
      inRow.length > 0 ? [inRow, seen.inRow] : [[...ref.current.querySelectorAll<HTMLElement>(FOCUSABLE)], seen.inPanel];
    list[Math.min(index, list.length - 1)]?.focus();
  });
  return {
    ref,
    onFocus: (e: FocusEvent<HTMLElement>) => {
      last.current = placeOf(e.target, e.currentTarget);
    },
    onBlur: (e: FocusEvent<HTMLElement>) => {
      const el = e.target;
      // Removing the focused control blurs it too; only a control still on
      // the page was left on purpose.
      setTimeout(() => {
        if (last.current?.el === el && el.isConnected && document.activeElement !== el) last.current = null;
      });
    },
  };
}

/**
 * The page's properties under its title: a one-line summary that opens into
 * one row per field. Values render from the live ydoc map; every change is
 * a per-field patch the server applies on the live doc, so the browser never
 * writes the map itself.
 */
export function PropertiesPanel({
  docId,
  workspaceId,
  ydoc,
  typeId,
  canEdit,
  canDefine,
  open,
  onOpenChange,
  searchDocs,
  synced,
}: {
  docId: string;
  workspaceId: string;
  ydoc: Y.Doc;
  typeId: string | null;
  canEdit: boolean;
  canDefine: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  searchDocs: SearchDocs;
  /** The live doc has caught up; until then its map may be empty or stale. */
  synced: boolean;
}) {
  const toast = useToast();
  const { values, marks } = useLiveProperties(ydoc);
  const fields = trpc.types.fields.useQuery({ workspaceId });
  const types = trpc.types.list.useQuery({ workspaceId });
  const setProperties = trpc.documents.setProperties.useMutation();
  // Ad-hoc fields added here stay visible until they hold a value.
  const [added, setAdded] = useState<string[]>([]);
  const [dialog, setDialog] = useState<ReactNode>(null);
  const bodyId = useId();
  const focusKeeper = useFocusKeeper();

  const all = fields.data ?? [];
  const typed = typeId ? all.filter((f) => f.typeId === typeId) : [];
  const shown = [
    ...typed,
    ...all.filter((f) => f.typeId !== typeId && (!isEmptyValue(values[f.id]) || added.includes(f.id))),
  ];
  const refIds = shown
    .filter((f) => f.kind === "doc" || f.kind === "doc_list")
    .flatMap((f) => listValues(values[f.id]))
    .filter((v): v is string => typeof v === "string");
  const titleOf = usePageTitles([...new Set(refIds)]);
  const typeName = types.data?.find((t) => t.id === typeId)?.name ?? null;

  if (!fields.data || !types.data || (!typeId && shown.length === 0)) return null;

  const write = (field: Field, edit: PropertyEdit) =>
    setProperties.mutateAsync({ id: docId, ...patchFor(field, edit) }).then(
      () => true,
      (e) => {
        toast(labelledError(field, friendlyError(e, "Couldn't save that value.")), "danger");
        return false;
      },
    );

  return (
    <section {...focusKeeper} className={"props-panel" + (open ? " open" : "")} aria-label="Properties">
      <button
        type="button"
        className="props-summary"
        aria-expanded={open}
        aria-controls={bodyId}
        onClick={() => onOpenChange(!open)}
      >
        <Icon name="chevron" size={12} className={"twist" + (open ? " open" : "")} />
        <span className="props-type">{typeName ?? "Properties"}</span>
        {!open && synced && (
          <span className="props-summary-text">{summaryText(shown, values, { titleOf })}</span>
        )}
      </button>
      {open && (
        <div className="props-body" id={bodyId}>
          {shown.length === 0 && <p className="props-empty">{typeName} has no fields yet.</p>}
          {shown.map((field) => (
            <PropertyRow
              key={field.id}
              field={field}
              raw={values[field.id]}
              marks={marks[field.id]}
              canEdit={canEdit}
              titleOf={titleOf}
              searchDocs={searchDocs}
              onEdit={(edit) => write(field, edit)}
            />
          ))}
          {canDefine && (
            <button
              type="button"
              className="props-add"
              onClick={() =>
                setDialog(
                  <AddFieldDialog
                    workspaceId={workspaceId}
                    typeId={typeId}
                    typeName={typeName}
                    onAdded={(id) => setAdded((prev) => [...prev, id])}
                    onClose={() => setDialog(null)}
                  />,
                )
              }
            >
              <Icon name="plus" size={13} /> Add field
            </button>
          )}
        </div>
      )}
      {dialog}
    </section>
  );
}

/**
 * On a template page, in place of the page's own properties: the type pages
 * made from it get and each field's default, a value or an expression.
 * Owners and admins edit them; everyone else reads them.
 */
export function TemplateDefaultsPanel({
  template,
  workspaceId,
  canDefine,
  searchDocs,
}: {
  template: TemplateInfo;
  workspaceId: string;
  canDefine: boolean;
  searchDocs: SearchDocs;
}) {
  const utils = trpc.useUtils();
  const toast = useToast();
  const fields = trpc.types.fields.useQuery({ workspaceId });
  const types = trpc.types.list.useQuery({ workspaceId });
  const setDefault = trpc.templates.setFieldDefault.useMutation({
    // Returned so a save resolves only once the reloaded list holds the new default.
    onSuccess: () => utils.templates.list.invalidate(),
  });
  // Fields switched to "A value" whose value isn't chosen yet.
  const [choosing, setChoosing] = useState<string[]>([]);
  const focusKeeper = useFocusKeeper();
  const type = types.data?.find((t) => t.id === template.typeId) ?? null;
  const typed = type ? (fields.data ?? []).filter((f) => f.typeId === type.id) : [];
  const refIds = typed
    .filter((f) => f.kind === "doc" || f.kind === "doc_list")
    .flatMap((f) => {
      const d = template.defaults[f.id];
      return d?.kind === "value" ? listValues(d.value).map(String) : [];
    });
  const titleOf = usePageTitles([...new Set(refIds)]);

  if (!fields.data || !types.data || (!type && !canDefine)) return null;

  const save = (field: Field, next: DefaultInput | null) => {
    // An expression or "No default" leaves "A value" at once; a literal leaves it once it's there to show.
    if (next?.kind !== "value") setChoosing((prev) => prev.filter((id) => id !== field.id));
    return setDefault.mutateAsync({ templateId: template.id, fieldId: field.id, default: next }).then(
      () => {
        setChoosing((prev) => prev.filter((id) => id !== field.id));
        return true;
      },
      (e) => {
        toast(labelledError(field, friendlyError(e, "Couldn't save that default.")), "danger");
        return false;
      },
    );
  };

  return (
    <section {...focusKeeper} className="props-panel open" aria-label="Template defaults">
      <div className="props-summary props-heading">
        <span className="props-type">Defaults for new pages</span>
        <span className="props-summary-text">
          {type ? `Pages made from this template are ${type.name} pages.` : "Pages made from this template have no type."}
        </span>
      </div>
      <div className="props-body">
        {!type && <p className="props-empty">Pick a type in the Type menu to give new pages a type and default values.</p>}
        {type && typed.length === 0 && <p className="props-empty">{type.name} has no fields yet.</p>}
        {typed.map((field) => (
          <TemplateDefaultRow
            key={field.id}
            field={field}
            value={template.defaults[field.id]}
            choosing={choosing.includes(field.id)}
            canDefine={canDefine}
            titleOf={titleOf}
            searchDocs={searchDocs}
            onChoose={() => setChoosing((prev) => [...prev, field.id])}
            onSave={(next) => save(field, next)}
          />
        ))}
      </div>
    </section>
  );
}

function TemplateDefaultRow({
  field,
  value,
  choosing,
  canDefine,
  titleOf,
  searchDocs,
  onChoose,
  onSave,
}: {
  field: Field;
  value: TemplateDefault | undefined;
  choosing: boolean;
  canDefine: boolean;
  titleOf: TitleOf;
  searchDocs: SearchDocs;
  onChoose: () => void;
  onSave: (next: DefaultInput | null) => Promise<boolean>;
}) {
  const inputId = useId();
  const [picked, pickMode] = usePicked<string>(value?.kind ?? "", (next) => {
    const choice = EXPRESSION_CHOICES.find((c) => c.kind === next);
    return onSave(choice ? { kind: choice.kind } : null);
  });
  const mode = choosing ? "value" : picked;
  return (
    <div className="props-row" data-field={field.key}>
      <label className="props-label" htmlFor={canDefine ? `${inputId}-mode` : undefined}>
        {field.label}
      </label>
      <div className="props-value">
        {canDefine ? (
          <>
            <CommitSelect
              id={`${inputId}-mode`}
              className="prop-input"
              aria-label={`Default for ${field.label}`}
              value={mode}
              onCommit={(next) => (next === "value" ? onChoose() : pickMode(next))}
              commitOnBlur
            >
              <option value="">No default</option>
              {field.kind !== "json" && <option value="value">A value</option>}
              {EXPRESSION_CHOICES.filter((c) => c.fits(field.kind)).map((c) => (
                <option key={c.kind} value={c.kind}>
                  {c.label}
                </option>
              ))}
            </CommitSelect>
            {mode === "value" && (
              <Widget
                field={field}
                raw={value?.kind === "value" ? value.value : undefined}
                marks={undefined}
                inputId={inputId}
                ariaLabel={`${field.label} default value`}
                titleOf={titleOf}
                searchDocs={searchDocs}
                onEdit={(edit) => onSave(literalDefault(value?.kind === "value" ? value.value : undefined, edit))}
              />
            )}
          </>
        ) : (
          <span>{describeDefault(field, value, { titleOf })}</span>
        )}
      </div>
    </div>
  );
}

function AiBadge({ mark }: { mark: AiMark | null }) {
  if (!mark) return null;
  return (
    <span className="prop-ai" title={`Set by ${mark.label}`} data-ai-label={mark.label}>
      AI{mark.agent ? ` · ${mark.agent}` : ""}
      <span className="sr-only">, set by {mark.label}</span>
    </span>
  );
}

function PropertyRow({
  field,
  raw,
  marks,
  canEdit,
  titleOf,
  searchDocs,
  onEdit,
}: {
  field: Field;
  raw: unknown;
  marks: AiMark[] | undefined;
  canEdit: boolean;
  titleOf: TitleOf;
  searchDocs: SearchDocs;
  onEdit: OnEdit;
}) {
  const inputId = useId();
  const labelId = `${inputId}-label`;
  const list = isListKind(field.kind);
  const editable = canEdit && field.kind !== "json";
  // Chips plus a picker are several controls, so they share a labelled group.
  const grouped = list || field.kind === "doc";
  return (
    <div className="props-row" data-field={field.key}>
      <label className="props-label" id={labelId} htmlFor={editable && !grouped ? inputId : undefined}>
        {field.label}
      </label>
      <div className="props-value" {...(grouped ? { role: "group", "aria-labelledby": labelId } : {})}>
        {editable ? (
          <Widget
            field={field}
            raw={raw}
            marks={marks}
            inputId={inputId}
            titleOf={titleOf}
            searchDocs={searchDocs}
            onEdit={onEdit}
          />
        ) : (
          <ReadValue field={field} raw={raw} marks={marks} titleOf={titleOf} />
        )}
        {!list && !isEmptyValue(raw) && <AiBadge mark={markFor(marks, raw)} />}
      </div>
    </div>
  );
}

function PageLink({ id, titleOf }: { id: string; titleOf: TitleOf }) {
  const title = titleOf(id);
  if (title === null) {
    return (
      <span className="page-ref restricted">
        <Icon name="page" size={12} />
        {pageLabel(title)}
      </span>
    );
  }
  return (
    <Link to={`/d/${id}`} className="page-ref">
      <Icon name="page" size={12} />
      {pageLabel(title)}
    </Link>
  );
}

function ReadValue({
  field,
  raw,
  marks,
  titleOf,
}: {
  field: Field;
  raw: unknown;
  marks: AiMark[] | undefined;
  titleOf: TitleOf;
}) {
  if (isEmptyValue(raw)) return <span className="props-placeholder">Empty</span>;
  if (field.kind === "json") return <code className="prop-json">{JSON.stringify(raw)}</code>;
  const href = field.kind === "url" ? safeHref(raw) : null;
  if (href) {
    return (
      <a href={href} target="_blank" rel="noreferrer" className="prop-url">
        {href}
      </a>
    );
  }
  if (field.kind === "doc" || field.kind === "doc_list") {
    return (
      <>
        {listValues(raw).map((id) => (
          <span className="prop-chip" key={String(id)}>
            <PageLink id={String(id)} titleOf={titleOf} />
            {field.kind === "doc_list" && <AiBadge mark={markFor(marks, id)} />}
          </span>
        ))}
      </>
    );
  }
  if (field.kind === "multi_select") {
    return (
      <>
        {listValues(raw).map((id) => (
          <span className="prop-chip" key={String(id)}>
            {optionLabel(field, id)}
            <AiBadge mark={markFor(marks, id)} />
          </span>
        ))}
      </>
    );
  }
  return <span>{formatValue(field, raw, { titleOf })}</span>;
}

function Widget({
  field,
  raw,
  marks,
  inputId,
  ariaLabel,
  titleOf,
  searchDocs,
  onEdit,
}: {
  field: Field;
  raw: unknown;
  marks: AiMark[] | undefined;
  inputId: string;
  /** Names the control when no <label> points at it. */
  ariaLabel?: string;
  titleOf: TitleOf;
  searchDocs: SearchDocs;
  onEdit: OnEdit;
}) {
  const control = { id: inputId, "aria-label": ariaLabel };
  switch (field.kind) {
    case "text":
    case "url":
    case "number":
      return <TextWidget field={field} raw={raw} control={control} onEdit={onEdit} />;
    case "checkbox":
      return <CheckboxWidget raw={raw} control={control} onEdit={onEdit} />;
    case "date":
    case "datetime":
      return <DateWidget field={field} raw={raw} control={control} onEdit={onEdit} />;
    case "select":
      return <SelectWidget field={field} raw={raw} control={control} onEdit={onEdit} />;
    case "multi_select": {
      const chosen = listValues(raw);
      const left = field.options.filter((o) => !o.retired && !chosen.includes(o.id));
      return (
        <>
          {chosen.map((id) => (
            <span className="prop-chip" key={String(id)}>
              {optionLabel(field, id)}
              <AiBadge mark={markFor(marks, id)} />
              <button
                type="button"
                className="tag-remove"
                aria-label={`Remove ${optionLabel(field, id)}`}
                onClick={() => onEdit({ op: "remove", value: id })}
              >
                <Icon name="close" size={10} />
              </button>
            </span>
          ))}
          {left.length > 0 && (
            <CommitSelect
              className="prop-input prop-add-option"
              aria-label={`Add ${field.label}`}
              value=""
              onCommit={(value) => value && onEdit({ op: "add", value })}
              commitOnBlur={false}
            >
              <option value="">{chosen.length === 0 ? "Empty" : "Add…"}</option>
              {left.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.label}
                </option>
              ))}
            </CommitSelect>
          )}
        </>
      );
    }
    case "doc":
    case "doc_list": {
      const ids = listValues(raw).map(String);
      const many = field.kind === "doc_list";
      return (
        <>
          {ids.map((id) => (
            <span className="prop-chip" key={id}>
              <PageLink id={id} titleOf={titleOf} />
              {many && <AiBadge mark={markFor(marks, id)} />}
              <button
                type="button"
                className="tag-remove"
                aria-label={`Remove ${pageLabel(titleOf(id))}`}
                onClick={() => onEdit(many ? { op: "remove", value: id } : { op: "clear" })}
              >
                <Icon name="close" size={10} />
              </button>
            </span>
          ))}
          {(many || ids.length === 0) && (
            <DocPicker
              label={many ? `Add a page to ${field.label}` : field.label}
              search={searchDocs}
              onPick={(id) => onEdit({ op: many ? "add" : "set", value: id })}
            />
          )}
        </>
      );
    }
    case "json":
      return null;
  }
}

/** Text, link and number fields: edit freely, save on blur or Enter, revert
 * on Escape. */
function TextWidget({
  field,
  raw,
  control,
  onEdit,
}: {
  field: Field;
  raw: unknown;
  control: Control;
  onEdit: OnEdit;
}) {
  const toast = useToast();
  const stored = raw == null ? "" : String(raw);
  const [draft, setDraft] = useState<string | null>(null);
  const commit = () => {
    if (draft === null) return;
    setDraft(null);
    if (draft === stored) return;
    const edit = editFromText(field, draft);
    if ("error" in edit) toast(edit.error, "danger");
    else onEdit(edit);
  };
  const href = field.kind === "url" ? safeHref(stored) : null;
  return (
    <>
      <input
        {...control}
        type={field.kind === "url" ? "url" : "text"}
        inputMode={field.kind === "number" ? "decimal" : undefined}
        className="prop-input prop-text"
        placeholder="Empty"
        value={draft ?? stored}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") e.currentTarget.blur();
          if (e.key === "Escape") setDraft(null);
        }}
      />
      {href && draft === null && (
        <a href={href} target="_blank" rel="noreferrer" className="prop-open" aria-label={`Open ${field.label}`}>
          <Icon name="share" size={12} />
        </a>
      )}
    </>
  );
}

/** The value a person just picked, shown until the stored copy moves on (the
 * save echoing back) or the save fails, so the control doesn't snap back to
 * the old value while the write is in flight. */
function usePicked<T>(stored: T, save: (value: T) => Promise<boolean>): [T, (value: T) => void] {
  const [picked, setPicked] = useState<{ value: T; over: T } | null>(null);
  if (picked && !Object.is(picked.over, stored)) setPicked(null);
  const pick = (value: T) => {
    setPicked({ value, over: stored });
    void save(value).then((saved) => {
      if (!saved) setPicked((p) => (p && Object.is(p.value, value) ? null : p));
    });
  };
  return [picked && Object.is(picked.over, stored) ? picked.value : stored, pick];
}

function CheckboxWidget({ raw, control, onEdit }: { raw: unknown; control: Control; onEdit: OnEdit }) {
  const [checked, pick] = usePicked(raw === true, (value) => onEdit({ op: "set", value }));
  return (
    <input
      {...control}
      type="checkbox"
      className="prop-checkbox"
      checked={checked}
      onChange={(e) => pick(e.target.checked)}
    />
  );
}

/** A native select that saves a pick made with the mouse or Enter, not each
 * value it passes while browsing with the keyboard (with its list closed,
 * arrow keys and type-ahead change the value at once on Windows and Linux):
 * those stay a draft until Enter, or blur when `commitOnBlur`, and Escape
 * drops them. */
function CommitSelect({
  value,
  onCommit,
  commitOnBlur,
  ...props
}: Omit<ComponentProps<"select">, "value" | "onChange" | "onKeyDown" | "onBlur"> & {
  value: string;
  onCommit: (value: string) => void;
  commitOnBlur: boolean;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  // Set by a key for the change event its default action fires, if any; a
  // pick from the open list comes later.
  const browsing = useRef(false);
  const commit = () => {
    if (draft === null) return;
    setDraft(null);
    if (draft !== value) onCommit(draft);
  };
  return (
    <select
      {...props}
      value={draft ?? value}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          commit();
        } else if (e.key === "Escape") {
          setDraft(null);
        } else {
          browsing.current = true;
          setTimeout(() => {
            browsing.current = false;
          });
        }
      }}
      onChange={(e) => {
        if (browsing.current) {
          setDraft(e.target.value);
          return;
        }
        setDraft(null);
        if (e.target.value !== value) onCommit(e.target.value);
      }}
      onBlur={() => (commitOnBlur ? commit() : setDraft(null))}
    />
  );
}

function SelectWidget({ field, raw, control, onEdit }: { field: Field; raw: unknown; control: Control; onEdit: OnEdit }) {
  const stored = typeof raw === "string" ? raw : "";
  const [current, pick] = usePicked(stored, (value) => onEdit(value ? { op: "set", value } : { op: "clear" }));
  return (
    <CommitSelect {...control} className="prop-input" value={current} onCommit={pick} commitOnBlur>
      <option value="">Empty</option>
      {field.options
        .filter((o) => !o.retired || o.id === stored)
        .map((o) => (
          <option key={o.id} value={o.id}>
            {o.label}
          </option>
        ))}
    </CommitSelect>
  );
}

/** Date and date-time fields: typing a date with the keyboard changes the
 * input once per digit, so edits stay a local draft until blur or Enter, and
 * Escape reverts. So does a date left with only some of its parts cleared. */
function DateWidget({ field, raw, control, onEdit }: { field: Field; raw: unknown; control: Control; onEdit: OnEdit }) {
  const datetime = field.kind === "datetime";
  const stored = datetime ? datetimeToInput(raw) : typeof raw === "string" ? raw : "";
  const [shown, pick] = usePicked(stored, (text) => {
    const edit = editFromDateInput(field.kind, text, false);
    return edit ? onEdit(edit) : Promise.resolve(false);
  });
  const [draft, setDraft] = useState<string | null>(null);
  const commit = (input: HTMLInputElement) => {
    if (draft === null) return;
    setDraft(null);
    if (!editFromDateInput(field.kind, draft, input.validity.badInput)) {
      // The parts still filled in aren't a value; show the stored one again.
      input.value = shown;
      return;
    }
    if (draft !== shown) pick(draft);
  };
  return (
    <input
      {...control}
      type={datetime ? "datetime-local" : "date"}
      className="prop-input"
      value={draft ?? shown}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={(e) => commit(e.currentTarget)}
      onKeyDown={(e) => {
        if (e.key === "Enter") e.currentTarget.blur();
        if (e.key === "Escape") {
          setDraft(null);
          e.currentTarget.value = shown;
        }
      }}
    />
  );
}

/** Finds a page with the editor's @-mention search. */
function DocPicker({ label, search, onPick }: { label: string; search: SearchDocs; onPick: (id: string) => void }) {
  const listId = useId();
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<DocCandidate[]>([]);
  const [active, setActive] = useState(0);
  // A search still in flight when the input loses focus must not reopen the list.
  const focused = useRef(false);
  useEffect(() => {
    if (!query.trim()) {
      setHits([]);
      return;
    }
    let live = true;
    const timer = setTimeout(() => {
      void search(query)
        .then((found) => {
          if (!live || !focused.current) return;
          setHits(found);
          setActive(0);
        })
        .catch(() => setHits([]));
    }, 120);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [query, search]);
  const pick = (hit: DocCandidate) => {
    setQuery("");
    setHits([]);
    onPick(hit.id);
  };
  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (hits.length === 0) return;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const step = e.key === "ArrowDown" ? 1 : -1;
      setActive((i) => (i + step + hits.length) % hits.length);
    } else if (e.key === "Enter") {
      e.preventDefault();
      pick(hits[active]!);
    } else if (e.key === "Escape") {
      setHits([]);
    }
  };
  return (
    <div className="prop-picker">
      <input
        className="prop-input"
        role="combobox"
        aria-label={label}
        aria-expanded={hits.length > 0}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={hits.length > 0 ? `${listId}-${active}` : undefined}
        placeholder="Link a page…"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={onKeyDown}
        onFocus={() => {
          focused.current = true;
        }}
        onBlur={() => {
          focused.current = false;
          setHits([]);
        }}
      />
      {hits.length > 0 && (
        <div className="prop-picker-list menu-pop" role="listbox" id={listId}>
          {hits.map((hit, i) => (
            <div
              key={hit.id}
              id={`${listId}-${i}`}
              role="option"
              tabIndex={-1}
              aria-selected={i === active}
              className="menu-item"
              data-highlighted={i === active ? "" : undefined}
              onMouseDown={(e) => {
                e.preventDefault();
                pick(hit);
              }}
            >
              <Icon name="page" size={13} />
              {hit.title || "Untitled"}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function AddFieldDialog({
  workspaceId,
  typeId,
  typeName,
  onAdded,
  onClose,
}: {
  workspaceId: string;
  typeId: string | null;
  typeName: string | null;
  onAdded: (fieldId: string) => void;
  onClose: () => void;
}) {
  const utils = trpc.useUtils();
  const toast = useToast();
  const [label, setLabel] = useState("");
  const [kind, setKind] = useState<Exclude<FieldKind, "json">>("text");
  const [options, setOptions] = useState("");
  const createField = trpc.types.createField.useMutation({
    onSuccess: (field) => {
      void utils.types.fields.invalidate({ workspaceId });
      void utils.types.list.invalidate({ workspaceId });
      onAdded(field.id);
      onClose();
    },
    onError: (e) => toast(friendlyError(e, "Couldn't add that field."), "danger"),
  });
  const choosesOptions = kind === "select" || kind === "multi_select";
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const name = label.trim();
    if (!name) return;
    createField.mutate({
      workspaceId,
      typeId,
      key: keyFromLabel(name) || name,
      label: name,
      kind,
      options: choosesOptions
        ? options
            .split(",")
            .map((o) => o.trim())
            .filter(Boolean)
        : undefined,
    });
  };
  return (
    <Modal title="Add field" onClose={onClose}>
      <form className="dialog-form" onSubmit={submit}>
        <label className="field">
          <span>Name</span>
          <input autoFocus value={label} onChange={(e) => setLabel(e.target.value)} />
        </label>
        <label className="field">
          <span>Kind</span>
          <select value={kind} onChange={(e) => setKind(e.target.value as typeof kind)}>
            {Object.entries(KIND_LABELS).map(([value, text]) => (
              <option key={value} value={value}>
                {text}
              </option>
            ))}
          </select>
        </label>
        {choosesOptions && (
          <label className="field">
            <span>Options</span>
            <input
              value={options}
              placeholder="Comma-separated, e.g. Open, Done"
              onChange={(e) => setOptions(e.target.value)}
            />
          </label>
        )}
        <p className="dialog-body">
          {typeName
            ? `Every ${typeName} page gets this field.`
            : "A field any page can use. This page shows it now; others show it once it has a value."}
        </p>
        <div className="dialog-actions">
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn primary" disabled={!label.trim() || createField.isPending}>
            Add field
          </button>
        </div>
      </form>
    </Modal>
  );
}

/** The doc header's type control: attach, change or detach the page's type
 * (on a template, the type its new pages get); owners and admins can also
 * define a new type or add the starter types here. */
export function TypeMenu({
  docId,
  workspaceId,
  collectionId,
  typeId,
  templateId,
  canDefine,
  onAttached,
}: {
  docId: string;
  workspaceId: string;
  collectionId: string;
  typeId: string | null;
  /** Set when the page is a template. */
  templateId: string | null;
  canDefine: boolean;
  onAttached: () => void;
}) {
  const utils = trpc.useUtils();
  const toast = useToast();
  const types = trpc.types.list.useQuery({ workspaceId });
  const [dialog, setDialog] = useState<ReactNode>(null);
  const setType = trpc.documents.setType.useMutation({
    onSuccess: (view) => {
      void utils.documents.getMeta.invalidate({ id: docId });
      void utils.documents.tree.invalidate();
      if (view.type) onAttached();
    },
    onError: (e) => toast(friendlyError(e, "Couldn't change the page type."), "danger"),
  });
  const setTemplateType = trpc.templates.setDefaultType.useMutation({
    onSuccess: () => void utils.templates.list.invalidate(),
    onError: (e) => toast(friendlyError(e, "Couldn't change the template's type."), "danger"),
  });
  const attach = (id: string | null) =>
    templateId ? setTemplateType.mutate({ templateId, typeId: id }) : setType.mutate({ id: docId, typeId: id });
  const createType = trpc.types.create.useMutation({
    onSuccess: (type) => {
      void utils.types.list.invalidate({ workspaceId });
      attach(type.id);
    },
    onError: (e) => toast(friendlyError(e, "Couldn't create that type."), "danger"),
  });
  const addStarterKit = trpc.templates.addStarterKit.useMutation({
    onSuccess: (added) => {
      void utils.types.list.invalidate({ workspaceId });
      void utils.types.fields.invalidate({ workspaceId });
      void utils.templates.list.invalidate();
      void utils.documents.tree.invalidate({ collectionId });
      const parts = [
        ...(added.types.length > 0 ? [`the ${added.types.join(", ")} types`] : []),
        ...(added.templates.length > 0 ? [`the ${added.templates.join(", ")} templates`] : []),
      ];
      toast(parts.length > 0 ? `Added ${parts.join(" and ")}.` : "The starter types and templates are already here.");
    },
    onError: (e) => toast(friendlyError(e, "Couldn't add the starter types."), "danger"),
  });
  const list = types.data ?? [];
  if (!canDefine && (list.length === 0 || templateId)) return null;
  const current = list.find((t) => t.id === typeId) ?? null;
  const what = templateId ? "Type of new pages" : "Page type";
  const label = `${what}: ${current?.name ?? "none"}`;
  return (
    <>
      <DropdownMenu.Root modal={false}>
        <DropdownMenu.Trigger asChild>
          <button type="button" className="tool-btn type-btn" title={label} aria-label={label}>
            <Icon name="page" size={15} />
            <span>{current?.name ?? "Type"}</span>
          </button>
        </DropdownMenu.Trigger>
        <DropdownMenu.Portal>
          <DropdownMenu.Content className="menu-pop" align="end" sideOffset={4}>
            {list.map((t) => (
              <DropdownMenu.Item
                key={t.id}
                className="menu-item"
                onSelect={() => {
                  if (t.id === typeId) return;
                  // Changing a template's type clears its defaults on the server.
                  if (templateId && current) {
                    setDialog(
                      <ConfirmDialog
                        title={`Change type to ${t.name}?`}
                        body={`New pages from this template get the ${t.name} type, and its default values are cleared. Pages already made keep theirs.`}
                        confirmLabel="Change type"
                        onConfirm={() => attach(t.id)}
                        onClose={() => setDialog(null)}
                      />,
                    );
                  } else attach(t.id);
                }}
              >
                <span className="menu-check">{t.id === typeId && <Icon name="check" />}</span>
                {t.name}
              </DropdownMenu.Item>
            ))}
            {canDefine && (
              <>
                <DropdownMenu.Item
                  className="menu-item"
                  onSelect={() =>
                    setDialog(
                      <PromptDialog
                        title="New type"
                        label="Name"
                        placeholder="Meeting"
                        submitLabel="Create and attach"
                        onSubmit={(name) => createType.mutate({ workspaceId, name })}
                        onClose={() => setDialog(null)}
                      />,
                    )
                  }
                >
                  <span className="menu-check">
                    <Icon name="plus" />
                  </span>
                  New type…
                </DropdownMenu.Item>
                <DropdownMenu.Item
                  className="menu-item"
                  onSelect={() => addStarterKit.mutate({ workspaceId, collectionId })}
                >
                  <span className="menu-check">
                    <Icon name="plus" />
                  </span>
                  Add starter types
                </DropdownMenu.Item>
              </>
            )}
            {current && (
              <>
                <DropdownMenu.Separator className="menu-sep" />
                <DropdownMenu.Item
                  className="menu-item"
                  onSelect={() =>
                    setDialog(
                      <ConfirmDialog
                        title={`Detach ${current.name}?`}
                        body={
                          templateId
                            ? "New pages from this template will have no type, and its default values are cleared. Pages already made keep theirs."
                            : "The page keeps every value it holds; only empty fields leave the panel. Attach the type again to bring them back."
                        }
                        confirmLabel="Detach type"
                        onConfirm={() => attach(null)}
                        onClose={() => setDialog(null)}
                      />,
                    )
                  }
                >
                  <span className="menu-check">
                    <Icon name="close" />
                  </span>
                  Detach type
                </DropdownMenu.Item>
              </>
            )}
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>
      {dialog}
    </>
  );
}
