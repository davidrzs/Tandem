import { Extension } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import type { EditorState, Selection } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import type { Node as PMNode } from "@tiptap/pm/model";
import katex from "katex";

/**
 * Inline math via decorations, not a node: `$…$` stays plain text in the
 * document, so it round-trips through markdown untouched, carries blame like
 * any other text, and MCP edits can rewrite it. When the cursor isn't inside a
 * span we hide the raw `$…$` and render KaTeX over it; move into it and the
 * source reappears for editing. Single-dollar only (block `$$…$$` is left as
 * literal text for now).
 */
const mathKey = new PluginKey<DecorationSet>("tandemMath");
const MATH = /(?<!\$)\$([^\n$]+?)\$(?!\$)/g;

function renderMath(tex: string): HTMLElement {
  const span = document.createElement("span");
  span.className = "math-render";
  try {
    katex.render(tex, span, { throwOnError: false, displayMode: false });
  } catch {
    span.textContent = `$${tex}$`;
  }
  return span;
}

function build(doc: PMNode, selection: Selection): DecorationSet {
  const decos: Decoration[] = [];
  doc.descendants((node, pos) => {
    if (!node.isText || !node.text) return;
    const text = node.text;
    for (const m of text.matchAll(MATH)) {
      const from = pos + m.index;
      const to = from + m[0].length;
      // Editing this span (cursor inside/adjacent) → leave the source visible.
      if (selection.from <= to && selection.to >= from) continue;
      const tex = m[1]!;
      decos.push(Decoration.inline(from, to, { class: "math-src-hidden" }));
      decos.push(Decoration.widget(from, () => renderMath(tex), { side: 1 }));
    }
  });
  return DecorationSet.create(doc, decos);
}

export function createMathExtension() {
  return Extension.create({
    name: "tandemMath",
    addProseMirrorPlugins() {
      return [
        new Plugin<DecorationSet>({
          key: mathKey,
          state: {
            init: (_config, state: EditorState) => build(state.doc, state.selection),
            apply: (tr, prev) =>
              tr.docChanged || tr.selectionSet ? build(tr.doc, tr.selection) : prev,
          },
          props: {
            decorations(state) {
              return mathKey.getState(state);
            },
          },
        }),
      ];
    },
  });
}
