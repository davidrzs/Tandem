import type { EditorState, Transaction } from "@tiptap/pm/state";
import { NodeSelection, Plugin, TextSelection } from "@tiptap/pm/state";

/** Where the live section sits that Backspace (`dir` -1) or Delete (1) at the
 * edge of the cursor's textblock would remove, or null. */
function sectionAcross(state: EditorState, dir: -1 | 1): number | null {
  const { selection } = state;
  if (!(selection instanceof TextSelection) || !selection.empty) return null;
  const $cursor = selection.$from;
  const atEdge = dir < 0 ? $cursor.parentOffset === 0 : $cursor.parentOffset === $cursor.parent.content.size;
  if (!atEdge || $cursor.depth === 0) return null;
  const $edge = state.doc.resolve(dir < 0 ? $cursor.before() : $cursor.after());
  const node = dir < 0 ? $edge.nodeBefore : $edge.nodeAfter;
  if (node?.type.name !== "liveSection") return null;
  return dir < 0 ? $edge.pos - node.nodeSize : $edge.pos;
}

/** Select the section instead of deleting it; an empty textblock beside it goes. */
function selectSection(state: EditorState, dir: -1 | 1, at: number): Transaction {
  const $cursor = state.selection.$from;
  const tr = state.tr;
  if ($cursor.parent.content.size === 0) tr.delete($cursor.before(), $cursor.after());
  return tr.setSelection(NodeSelection.create(tr.doc, tr.mapping.map(at, dir))).scrollIntoView();
}

/**
 * Keeps live sections atomic. Backspace or Delete next to one selects it
 * rather than removing it, so it is only ever deleted as a whole, once
 * selected. Typing while one is selected writes a new paragraph after it
 * instead of replacing it.
 */
export function liveSectionGuard(): Plugin {
  return new Plugin({
    props: {
      handleKeyDown(view, event) {
        const dir = event.key === "Backspace" ? -1 : event.key === "Delete" ? 1 : 0;
        if (dir === 0) return false;
        const at = sectionAcross(view.state, dir);
        if (at === null) return false;
        view.dispatch(selectSection(view.state, dir, at));
        return true;
      },
      handleTextInput(view, _from, _to, text) {
        const { state } = view;
        const { selection } = state;
        if (!(selection instanceof NodeSelection) || selection.node.type.name !== "liveSection") return false;
        const paragraph = state.schema.nodes.paragraph!.create(null, state.schema.text(text));
        const tr = state.tr.insert(selection.to, paragraph);
        view.dispatch(tr.setSelection(TextSelection.create(tr.doc, selection.to + 1 + text.length)).scrollIntoView());
        return true;
      },
    },
  });
}
