import { Extension, InputRule } from "@tiptap/core";
import { TextSelection } from "@tiptap/pm/state";
import type { Node as PMNode } from "@tiptap/pm/model";

/**
 * Turn `[ ] ` / `[x] ` typed at the start of a bullet-list item into a real
 * checkbox, live.
 *
 * Tiptap's built-in TaskItem rule is a `wrappingInputRule`: it can only fire
 * on a top-level paragraph, because wrapping a paragraph that already sits
 * inside a `bulletList > listItem` into a `taskItem` produces an invalid tree
 * and silently no-ops. That's why typing `- ` (which immediately becomes a
 * bullet) and then `[ ] ` left the marker as literal text.
 *
 * This rule rebuilds the whole ancestor bullet list as a task list in a single
 * step — you can't convert the children first (a `taskItem` inside a
 * `bulletList` is invalid) nor the list first (a `taskList` demands
 * `taskItem+`), so we replace the node wholesale. Converting the entire list
 * (not just the one item) matches how these lists are actually used — as
 * checklists — and is one undo away if it isn't wanted.
 */
const MARKER = /^\[([ xX])\]\s$/;

export const TaskListInputRule = Extension.create({
  name: "taskListInputRule",
  addInputRules() {
    return [
      new InputRule({
        find: MARKER,
        handler: ({ state, match }) => {
          const { tr, schema, selection } = state;
          const { $from } = selection;
          const depth = $from.depth;
          if (depth < 2) return null;

          const paragraph = $from.node(depth);
          const listItem = $from.node(depth - 1);
          const parentList = $from.node(depth - 2);
          if (
            !paragraph.isTextblock ||
            listItem.type.name !== "listItem" ||
            parentList.type.name !== "bulletList"
          ) {
            return null; // leave top-level markers to the built-in TaskItem rule
          }

          const taskList = schema.nodes.taskList;
          const taskItem = schema.nodes.taskItem;
          if (!taskList || !taskItem) return null;

          // Every child must be a plain listItem for a clean 1:1 conversion.
          const children: PMNode[] = [];
          let convertible = true;
          parentList.forEach((child) => {
            if (child.type.name !== "listItem") convertible = false;
            children.push(child);
          });
          if (!convertible || children.length === 0) return null;

          const triggerIndex = $from.index(depth - 2);
          const checked = match[1]!.toLowerCase() === "x";
          const markerLen = match[0].length;

          const items = children.map((child, index) => {
            if (index !== triggerIndex) {
              return taskItem.create({ checked: false }, child.content);
            }
            const firstPara = child.child(0);
            const stripped = firstPara.copy(firstPara.content.cut(markerLen));
            const rest: PMNode[] = [];
            for (let i = 1; i < child.childCount; i++) rest.push(child.child(i));
            return taskItem.create({ checked }, [stripped, ...rest]);
          });

          const listStart = $from.before(depth - 2);
          tr.replaceWith(listStart, listStart + parentList.nodeSize, taskList.create(null, items));

          // Cursor to the start of the (now marker-less) trigger item's text.
          let caret = listStart + 1;
          for (let i = 0; i < triggerIndex; i++) caret += items[i]!.nodeSize;
          caret += 2; // enter taskItem, then its first paragraph
          tr.setSelection(TextSelection.create(tr.doc, caret));
          return undefined;
        },
      }),
    ];
  },
});
