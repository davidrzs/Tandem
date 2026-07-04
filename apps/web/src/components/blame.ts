import { Extension } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import type { EditorState } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import { blameSpans, COLLAB_FIELD, getAuthors } from "@tandem/editor";
import type * as Y from "yjs";
import { authorKey, authorTint } from "./colors.js";

/**
 * The blame view: colour every span of the document by the session that wrote
 * it. Off by default; toggled via a transaction meta. Attribution comes from
 * the Yjs layer (item clientIDs + the doc's authors map), so it is exactly
 * what the server persisted — the editor only renders it.
 */
export const blamePluginKey = new PluginKey<BlamePluginState>("tandemBlame");

interface BlamePluginState {
  enabled: boolean;
  decorations: DecorationSet;
}

function computeDecorations(ydoc: Y.Doc, state: EditorState): DecorationSet {
  try {
    const authors = getAuthors(ydoc);
    const size = state.doc.content.size;
    const decorations: Decoration[] = [];
    for (const span of blameSpans(ydoc.getXmlFragment(COLLAB_FIELD))) {
      if (span.from >= span.to || span.to > size) continue;
      const info = authors.get(span.clientId);
      const key = info ? authorKey(info.userId, info.ai) : "unknown";
      decorations.push(
        Decoration.inline(span.from, span.to, {
          class: "blame-span" + (info?.ai ? " blame-ai" : ""),
          style: `background-color: ${authorTint(key)};`,
          "data-blame-name": info ? info.name || info.userId : "Unknown",
          "data-blame-ai": info?.ai ? "1" : "0",
          "data-blame-at": String(info?.at ?? 0),
        }),
      );
    }
    return DecorationSet.create(state.doc, decorations);
  } catch {
    // A transient Yjs/ProseMirror mismatch (mid-sync) just skips one render.
    return DecorationSet.empty;
  }
}

export interface BlameMeta {
  enabled?: boolean;
  recompute?: boolean;
}

export function createBlameExtension(ydoc: Y.Doc) {
  return Extension.create({
    name: "tandemBlame",
    addProseMirrorPlugins() {
      return [
        new Plugin<BlamePluginState>({
          key: blamePluginKey,
          state: {
            init: () => ({ enabled: false, decorations: DecorationSet.empty }),
            apply(tr, prev, _old, next) {
              const meta = tr.getMeta(blamePluginKey) as BlameMeta | undefined;
              if (meta?.enabled !== undefined) {
                return meta.enabled
                  ? { enabled: true, decorations: computeDecorations(ydoc, next) }
                  : { enabled: false, decorations: DecorationSet.empty };
              }
              if (!prev.enabled) return prev;
              if (meta?.recompute) {
                return { enabled: true, decorations: computeDecorations(ydoc, next) };
              }
              // Map through edits until the next debounced recompute lands.
              return {
                enabled: true,
                decorations: prev.decorations.map(tr.mapping, tr.doc),
              };
            },
          },
          props: {
            decorations(state) {
              return blamePluginKey.getState(state)?.decorations;
            },
          },
        }),
      ];
    },
  });
}
