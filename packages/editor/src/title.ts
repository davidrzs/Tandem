import * as Y from "yjs";

/**
 * A page's title lives in its Y.Doc next to the body, as a root fragment
 * holding one paragraph of plain text (what the title editor's schema,
 * `doc > paragraph > text*`, binds to). Co-editing, offline edits and blame
 * cover it like the body. `documents.title` is its projection, written when
 * the live doc is stored, so lists, search and links keep reading the column.
 *
 * An empty fragment means the title was never written to the doc: pages from
 * before titles moved here, and pages created without one. Such a doc takes
 * its column's title through `seedTitle` (authors.ts).
 */
export const TITLE_FIELD = "title";

/** Longest title kept; longer text is cut when projected (as INPUT_LIMITS). */
export const TITLE_MAX = 500;

function textOf(element: Y.XmlElement | Y.XmlText): string {
  if (element instanceof Y.XmlText) {
    return (element.toDelta() as Array<{ insert: unknown }>)
      .map((d) => (typeof d.insert === "string" ? d.insert : ""))
      .join("");
  }
  return element.toArray().map((child) => textOf(child as Y.XmlElement | Y.XmlText)).join("");
}

/** One line: no line breaks, no surrounding space, at most TITLE_MAX. */
export function cleanTitle(text: string): string {
  return text.replace(/\s*[\r\n]+\s*/g, " ").trim().slice(0, TITLE_MAX);
}

/** The title held by a doc, or null when it holds none (see TITLE_FIELD). */
export function titleOf(doc: Y.Doc): string | null {
  const fragment = doc.getXmlFragment(TITLE_FIELD);
  if (fragment.length === 0) return null;
  // One paragraph is the shape; join any others a merge produced.
  return cleanTitle(
    fragment
      .toArray()
      .map((child) => textOf(child as Y.XmlElement | Y.XmlText))
      .join(" "),
  );
}

/** Write `title` as the fragment's paragraph (the fragment is empty). */
export function writeTitle(fragment: Y.XmlFragment, title: string): void {
  const paragraph = new Y.XmlElement("paragraph");
  paragraph.insert(0, [new Y.XmlText(title)]);
  fragment.insert(0, [paragraph]);
}

/** Replace the doc's title with `title` in the current transaction and
 * clientID, keeping the characters both share (so a concurrent edit to the
 * rest survives and unchanged text keeps its author). Returns whether the
 * title changed. */
export function replaceTitle(doc: Y.Doc, title: string): boolean {
  const next = cleanTitle(title);
  const fragment = doc.getXmlFragment(TITLE_FIELD);
  if (titleOf(doc) === next) return false;
  const paragraph = fragment.length === 1 ? fragment.get(0) : null;
  const text = paragraph instanceof Y.XmlElement && paragraph.length === 1 ? paragraph.get(0) : null;
  if (!(paragraph instanceof Y.XmlElement) || paragraph.nodeName !== "paragraph" || !(text instanceof Y.XmlText)) {
    // Not the one-paragraph shape (no title yet, or a merge left more):
    // start over.
    fragment.delete(0, fragment.length);
    writeTitle(fragment, next);
    return true;
  }
  const current = textOf(text);
  let start = 0;
  while (start < current.length && start < next.length && current[start] === next[start]) start++;
  let end = 0;
  while (
    end < current.length - start &&
    end < next.length - start &&
    current[current.length - 1 - end] === next[next.length - 1 - end]
  ) {
    end++;
  }
  text.delete(start, current.length - start - end);
  text.insert(start, next.slice(start, next.length - end));
  return true;
}
