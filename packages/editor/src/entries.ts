import type { Node } from "@tiptap/pm/model";
import { inlineToMarkdown } from "./markdown.js";
import { scanHeadings } from "./markdown-ops.js";

/**
 * Entries: the dated sections of a running page. An entry is a top-level
 * level-2 heading whose text starts with a valid `YYYY-MM-DD` date, plus
 * everything up to the next level-1 or level-2 heading. Content before the
 * first entry is the page's pinned top. Any page with such headings has
 * entries; nothing opts in. Entries are plain markdown, so export, import,
 * MCP edits and agents keep them with no hidden state.
 */
export interface Entry {
  /** `YYYY-MM-DD`, from the start of the heading. */
  date: string;
  /** The heading's inline content as markdown, without the `## `. */
  heading: string;
  /** Start and end of the entry: document positions for `entriesOf`,
   * character offsets for `entriesOfMarkdown`. `to` is where the next
   * level-1 or level-2 heading starts, or the end of the document. */
  from: number;
  to: number;
}

const DATE = /^(\d{4})-(\d{2})-(\d{2})(?!\w)/;

/** The date a heading's text starts with, or null when it starts with none or
 * with an impossible one (2026-02-30). */
export function entryDate(heading: string): string | null {
  const m = DATE.exec(heading);
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const date = new Date(Date.UTC(y, mo - 1, d));
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== mo - 1 || date.getUTCDate() !== d) return null;
  return m[0];
}

interface Heading {
  level: number;
  text: string;
  at: number;
}

function collect(headings: Heading[], end: number): Entry[] {
  const entries: Entry[] = [];
  let open: Entry | null = null;
  for (const h of headings) {
    if (h.level > 2) continue;
    if (open) {
      open.to = h.at;
      open = null;
    }
    const date = h.level === 2 ? entryDate(h.text) : null;
    if (date) {
      open = { date, heading: h.text, from: h.at, to: end };
      entries.push(open);
    }
  }
  return entries;
}

/** The entries of a document node (this schema), in document order. */
export function entriesOf(doc: Node): Entry[] {
  const headings: Heading[] = [];
  doc.forEach((child, offset) => {
    if (child.type.name !== "heading") return;
    headings.push({ level: Number(child.attrs.level), text: inlineToMarkdown(child), at: offset });
  });
  return collect(headings, doc.content.size);
}

/** The entries of canonical markdown (as the serializer writes it: ATX
 * headings, none inside fences), in document order. */
export function entriesOfMarkdown(markdown: string): Entry[] {
  const lines = markdown.split("\n");
  const starts: number[] = [];
  let at = 0;
  for (const line of lines) {
    starts.push(at);
    at += line.length + 1;
  }
  const headings = scanHeadings(lines).map((h) => ({ level: h.level, text: h.text, at: starts[h.line]! }));
  return collect(headings, markdown.length);
}
