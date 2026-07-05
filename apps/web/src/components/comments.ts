import { Extension } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import type { EditorState } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import {
  absolutePositionToRelativePosition,
  relativePositionToAbsolutePosition,
  ySyncPluginKey,
} from "y-prosemirror";
import * as Y from "yjs";

/**
 * Comment anchoring. A comment marks a span with a pair of Yjs relative
 * positions — CRDT references that follow the text through concurrent edits
 * and survive in ydoc_state without touching the document content or its
 * markdown read model. The editor renders them as live decorations; a span
 * whose text was deleted simply stops resolving (the thread stays in the
 * panel as document-level).
 */

export interface CommentAnchor {
  id: string;
  anchor: string;
  head: string;
}

interface CommentsState {
  decorations: DecorationSet;
}

export const commentsPluginKey = new PluginKey<CommentsState>("tandemComments");

function toBase64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes));
}

function fromBase64(s: string): Uint8Array | null {
  try {
    return Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
  } catch {
    return null;
  }
}

/** Encode the current selection as a relative-position pair, if the collab
 * binding is ready. */
export function selectionAnchor(
  state: EditorState,
): { anchor: string; head: string } | null {
  const ystate = ySyncPluginKey.getState(state) as
    | { type: Y.XmlFragment; binding?: { mapping: Map<Y.AbstractType<unknown>, unknown> } }
    | undefined;
  if (!ystate?.binding) return null;
  const { from, to } = state.selection;
  if (from === to) return null;
  const encode = (pos: number) =>
    toBase64(
      Y.encodeRelativePosition(
        absolutePositionToRelativePosition(pos, ystate.type, ystate.binding!.mapping as never),
      ),
    );
  return { anchor: encode(from), head: encode(to) };
}

/** Where a stored anchor currently sits in the document, or null if its text
 * is gone / the binding isn't ready. */
export function anchorRange(
  state: EditorState,
  ydoc: Y.Doc,
  anchor: string,
  head: string,
): { from: number; to: number } | null {
  const ystate = ySyncPluginKey.getState(state) as
    | { type: Y.XmlFragment; binding?: { mapping: Map<Y.AbstractType<unknown>, unknown> } }
    | undefined;
  if (!ystate?.binding) return null;
  const decode = (s: string): number | null => {
    const bytes = fromBase64(s);
    if (!bytes) return null;
    try {
      return relativePositionToAbsolutePosition(
        ydoc,
        ystate.type,
        Y.decodeRelativePosition(bytes),
        ystate.binding!.mapping as never,
      );
    } catch {
      return null;
    }
  };
  const from = decode(anchor);
  const to = decode(head);
  if (from === null || to === null || from >= to) return null;
  return { from, to };
}

function computeDecorations(
  state: EditorState,
  ydoc: Y.Doc,
  anchors: CommentAnchor[],
  activeId: string | null,
): DecorationSet {
  const decorations: Decoration[] = [];
  for (const c of anchors) {
    const range = anchorRange(state, ydoc, c.anchor, c.head);
    if (!range || range.to > state.doc.content.size) continue;
    decorations.push(
      Decoration.inline(range.from, range.to, {
        class: "comment-span" + (c.id === activeId ? " active" : ""),
        "data-comment-id": c.id,
      }),
    );
  }
  return DecorationSet.create(state.doc, decorations);
}

export interface CommentsMeta {
  recompute?: boolean;
}

export function createCommentsExtension(
  ydoc: Y.Doc,
  getAnchors: () => CommentAnchor[],
  getActiveId: () => string | null,
) {
  return Extension.create({
    name: "tandemComments",
    addProseMirrorPlugins() {
      return [
        new Plugin<CommentsState>({
          key: commentsPluginKey,
          state: {
            init: () => ({ decorations: DecorationSet.empty }),
            apply(tr, prev, _old, next) {
              const meta = tr.getMeta(commentsPluginKey) as CommentsMeta | undefined;
              if (meta?.recompute || tr.docChanged) {
                return {
                  decorations: computeDecorations(next, ydoc, getAnchors(), getActiveId()),
                };
              }
              return { decorations: prev.decorations.map(tr.mapping, tr.doc) };
            },
          },
          props: {
            decorations(state) {
              return commentsPluginKey.getState(state)?.decorations;
            },
          },
        }),
      ];
    },
  });
}
