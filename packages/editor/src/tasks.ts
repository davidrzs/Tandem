import type { Node } from "@tiptap/pm/model";
import { yXmlFragmentToProsemirrorJSON } from "y-prosemirror";
import * as Y from "yjs";
import type { AuthorInfo } from "./authors.js";
import { inlineToMarkdown } from "./markdown.js";
import { taskMentions } from "./markdown-ops.js";
import { COLLAB_FIELD, schema } from "./schema.js";

/** One task item as the `tasks` table stores it. */
export interface ProjectedTask {
  blockId: string;
  /** The item's first line as markdown, like a `- [ ] …` line shows it. */
  text: string;
  done: boolean;
  /** Lower-cased @handles the task assigns. */
  handles: string[];
  /** 0-based order among the page's tasks. */
  position: number;
  /** Who wrote the item, from blame; null when it predates blame. */
  createdBy: string | null;
  ai: boolean;
}

interface PMJson {
  type: string;
  attrs?: Record<string, unknown>;
  content?: PMJson[];
  text?: string;
}

export function newBlockId(): string {
  return crypto.randomUUID().replace(/-/g, "").slice(0, 12);
}

function taskItems(node: PMJson, out: PMJson[] = []): PMJson[] {
  if (node.type === "taskItem") out.push(node);
  for (const child of node.content ?? []) taskItems(child, out);
  return out;
}

function plainText(node: PMJson | undefined): string {
  if (!node) return "";
  if (node.text !== undefined) return node.text;
  if (node.type === "pageRef") return String(node.attrs?.title ?? "");
  return (node.content ?? []).map(plainText).join("");
}

const idOf = (item: PMJson): string | null =>
  typeof item.attrs?.blockId === "string" && item.attrs.blockId ? item.attrs.blockId : null;

/**
 * `next` (ProseMirror JSON) with a unique block id on every task item. An item
 * that already holds an id not used earlier in `next` keeps it. The others
 * take the id of an item in `prev` that no longer appears: first one with the
 * same text, then, for an edited item, one sitting between the same matched
 * neighbours. Whatever is still without an id gets a fresh one. This is what
 * keeps ids stable when a body is rebuilt from markdown, which has no ids.
 */
export function withTaskBlockIds(prev: unknown, next: unknown): unknown {
  const out = structuredClone(next) as PMJson;
  const items = taskItems(out);
  const old = prev ? taskItems(prev as PMJson).filter((t) => idOf(t) !== null) : [];
  const oldIndex = new Map(old.map((t, j) => [idOf(t)!, j]));
  const used = new Set<string>();
  const assigned: Array<string | null> = items.map((item) => {
    const id = idOf(item);
    if (id === null || used.has(id)) return null;
    used.add(id);
    return id;
  });
  const free = old.map((t, j) => ({ id: idOf(t)!, key: plainText(t.content?.[0]).trim(), j }));
  const take = (i: number, candidate: (typeof free)[number]) => {
    assigned[i] = candidate.id;
    used.add(candidate.id);
  };

  items.forEach((item, i) => {
    if (assigned[i] !== null) return;
    const key = plainText(item.content?.[0]).trim();
    const match = free.find((c) => !used.has(c.id) && c.key === key);
    if (match) take(i, match);
  });

  let run: number[] = [];
  let lowerBound = -1;
  const pairRun = (upperBound: number) => {
    const candidates = free.filter((c) => !used.has(c.id) && c.j > lowerBound && c.j < upperBound);
    run.forEach((i, k) => {
      if (candidates[k]) take(i, candidates[k]);
    });
    run = [];
  };
  items.forEach((_, i) => {
    const anchor = assigned[i] === null ? undefined : oldIndex.get(assigned[i]!);
    if (assigned[i] === null) run.push(i);
    else if (anchor !== undefined) {
      pairRun(anchor);
      lowerBound = Math.max(lowerBound, anchor);
    }
  });
  pairRun(old.length);

  items.forEach((item, i) => {
    let id = assigned[i];
    while (id === null) {
      const fresh = newBlockId();
      if (used.has(fresh)) continue;
      used.add(fresh);
      id = fresh;
    }
    item.attrs = { ...item.attrs, blockId: id };
  });
  return out;
}

function eachTaskElement(parent: Y.XmlFragment | Y.XmlElement, visit: (el: Y.XmlElement) => void): void {
  for (const child of parent.toArray()) {
    if (!(child instanceof Y.XmlElement)) continue;
    if (child.nodeName === "taskItem") visit(child);
    eachTaskElement(child, visit);
  }
}

/** Give every task item in the collab fragment that lacks a block id, or
 * repeats one seen earlier (a copied item), a fresh one. Returns how many it
 * set; call it inside the transaction that should own the writes. */
export function fillTaskBlockIds(doc: Y.Doc): number {
  const seen = new Set<string>();
  const missing: Y.XmlElement[] = [];
  eachTaskElement(doc.getXmlFragment(COLLAB_FIELD), (el) => {
    const id: unknown = el.getAttribute("blockId");
    if (typeof id === "string" && id && !seen.has(id)) seen.add(id);
    else missing.push(el);
  });
  for (const el of missing) {
    let id = newBlockId();
    while (seen.has(id)) id = newBlockId();
    seen.add(id);
    el.setAttribute("blockId", id);
  }
  return missing.length;
}

/** The task rows of a doc whose task items all carry block ids, with who
 * wrote each item (the session that created its element). */
export function projectTasks(doc: Y.Doc, authors: ReadonlyMap<number, AuthorInfo>): ProjectedTask[] {
  const fragment = doc.getXmlFragment(COLLAB_FIELD);
  const creators = new Map<string, number>();
  eachTaskElement(fragment, (el) => {
    const id: unknown = el.getAttribute("blockId");
    if (typeof id === "string" && el._item && !creators.has(id)) creators.set(id, el._item.id.client);
  });
  if (creators.size === 0) return [];
  const tasks: ProjectedTask[] = [];
  const seen = new Set<string>();
  schema.nodeFromJSON(yXmlFragmentToProsemirrorJSON(fragment)).descendants((node: Node) => {
    if (node.type.name !== "taskItem") return true;
    const blockId = node.attrs.blockId as string | null;
    if (!blockId || seen.has(blockId)) return true;
    seen.add(blockId);
    const first = node.firstChild;
    const text = first?.type.name === "paragraph" ? inlineToMarkdown(first) : "";
    const author = authors.get(creators.get(blockId)!);
    tasks.push({
      blockId,
      text,
      done: node.attrs.checked === true,
      handles: [...new Set(taskMentions(text))],
      position: tasks.length,
      createdBy: author?.userId || null,
      ai: author?.ai ?? false,
    });
    return true;
  });
  return tasks;
}
