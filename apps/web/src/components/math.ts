import { Extension } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import type { EditorState, Selection } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import type { Node as PMNode } from "@tiptap/pm/model";
import katex from "katex";
import "katex/dist/katex.min.css";

/**
 * Math via decorations, not nodes: `$…$` (inline) and `$$…$$` (block/display)
 * stay plain text in the document, so they round-trip through markdown
 * untouched, carry blame like any other text, and MCP edits can rewrite them.
 * When the cursor isn't inside a span we hide the raw source and render KaTeX
 * over it; move into it and the source reappears for editing.
 */
const mathKey = new PluginKey<DecorationSet>("tandemMath");
// Block first: `$$…$$` (display). Inline: single `$…$`, never part of a `$$`.
const BLOCK = /\$\$([^$]+?)\$\$/g;
const INLINE = /(?<!\$)\$([^\n$]+?)\$(?!\$)/g;

function renderMath(tex: string, displayMode: boolean): HTMLElement {
  const span = document.createElement("span");
  span.className = displayMode ? "math-render math-block" : "math-render";
  try {
    katex.render(tex, span, { throwOnError: false, displayMode });
  } catch {
    span.textContent = displayMode ? `$$${tex}$$` : `$${tex}$`;
  }
  return span;
}

function collect(
  decos: Decoration[],
  text: string,
  pos: number,
  selection: Selection,
  re: RegExp,
  displayMode: boolean,
): void {
  for (const m of text.matchAll(re)) {
    const from = pos + m.index;
    const to = from + m[0].length;
    // Editing this span (cursor inside/adjacent) → leave the source visible.
    if (selection.from <= to && selection.to >= from) continue;
    const tex = m[1]!;
    decos.push(Decoration.inline(from, to, { class: "math-src-hidden" }));
    decos.push(Decoration.widget(from, () => renderMath(tex, displayMode), { side: 1 }));
  }
}

function build(doc: PMNode, selection: Selection): DecorationSet {
  const decos: Decoration[] = [];
  doc.descendants((node, pos) => {
    if (!node.isText || !node.text) return;
    collect(decos, node.text, pos, selection, BLOCK, true);
    collect(decos, node.text, pos, selection, INLINE, false);
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
