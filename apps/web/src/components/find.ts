import { Extension } from "@tiptap/core";
import type { Node as PMNode } from "@tiptap/pm/model";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";

export interface FindMatch {
  from: number;
  to: number;
}

export interface FindState {
  query: string;
  active: number;
  matches: FindMatch[];
}

export const findPluginKey = new PluginKey<FindState>("tandem-find");

const MAX_MATCHES = 500;

/** Case-insensitive matches within single text runs (a match can't cross a
 * mark boundary — fine for a find bar, and keeps the scan trivial). */
function computeMatches(doc: PMNode, query: string): FindMatch[] {
  if (!query) return [];
  const q = query.toLowerCase();
  const out: FindMatch[] = [];
  doc.descendants((node, pos) => {
    if (out.length >= MAX_MATCHES) return false;
    if (!node.isText || !node.text) return;
    const text = node.text.toLowerCase();
    let i = text.indexOf(q);
    while (i !== -1 && out.length < MAX_MATCHES) {
      out.push({ from: pos + i, to: pos + i + q.length });
      i = text.indexOf(q, i + q.length);
    }
  });
  return out;
}

/**
 * In-document find. The FindBar drives it by dispatching
 * `tr.setMeta(findPluginKey, { query?, active? })`; matches recompute on doc
 * changes so highlights track live edits. Pure view state — no doc mutation.
 */
export const Find = Extension.create({
  name: "tandemFind",
  addProseMirrorPlugins() {
    return [
      new Plugin<FindState>({
        key: findPluginKey,
        state: {
          init: () => ({ query: "", active: 0, matches: [] }),
          apply(tr, prev) {
            const meta = tr.getMeta(findPluginKey) as Partial<FindState> | undefined;
            if (!meta && !tr.docChanged) return prev;
            const query = meta?.query ?? prev.query;
            const matches =
              meta?.query !== undefined || tr.docChanged
                ? computeMatches(tr.doc, query)
                : prev.matches;
            let active = meta?.active ?? prev.active;
            if (matches.length === 0) active = 0;
            else active = ((active % matches.length) + matches.length) % matches.length;
            return { query, active, matches };
          },
        },
        props: {
          decorations(state) {
            const s = findPluginKey.getState(state);
            if (!s || s.matches.length === 0) return DecorationSet.empty;
            return DecorationSet.create(
              state.doc,
              s.matches.map((m, i) =>
                Decoration.inline(m.from, m.to, {
                  class: i === s.active ? "find-match find-match-active" : "find-match",
                }),
              ),
            );
          },
        },
      }),
    ];
  },
});
