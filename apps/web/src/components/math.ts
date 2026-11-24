import { Extension } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import type { EditorState, Selection } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import type { Node as PMNode } from "@tiptap/pm/model";
import { mathSpans } from "@tandem/editor";
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

function collect(decos: Decoration[], text: string, pos: number, selection: Selection): void {
  for (const span of mathSpans(text)) {
    const from = pos + span.from;
    const to = pos + span.to;
    // Editing this span (cursor inside/adjacent) → leave the source visible.
    if (selection.from <= to && selection.to >= from) continue;
    const { tex, display: displayMode } = span;
    decos.push(Decoration.inline(from, to, { class: "math-src-hidden" }));
    // The key lets ProseMirror keep an unchanged formula's rendered DOM when
    // the set is rebuilt; without it every keystroke re-runs KaTeX on all of them.
    decos.push(
      Decoration.widget(from, () => renderMath(tex, displayMode), {
        side: 1,
        key: `${displayMode ? "block" : "inline"}:${tex}`,
      }),
    );
  }
}

function build(doc: PMNode, selection: Selection): DecorationSet {
  const decos: Decoration[] = [];
  // The same spans markdown writes raw (@tandem/editor math.ts); code is
  // never math.
  doc.descendants((node, pos, parent) => {
    if (node.type.spec.code) return false;
    if (!node.isText || !node.text || parent?.type.spec.code) return;
    if (node.marks.some((mk) => mk.type.spec.code)) return;
    collect(decos, node.text, pos, selection);
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
