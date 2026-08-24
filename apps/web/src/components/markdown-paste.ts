import { Extension } from "@tiptap/core";
import type { Schema } from "@tiptap/pm/model";
import { Slice } from "@tiptap/pm/model";
import { Plugin } from "@tiptap/pm/state";
import { markdownToJSON } from "@tandem/editor";

function parseMarkdownSlice(markdown: string, schema: Schema): Slice {
  // The shared parser owns a separate schema instance. JSON is the safe
  // boundary: rehydrate into the live editor schema before insertion.
  const parsed = schema.nodeFromJSON(markdownToJSON(markdown));
  return Slice.maxOpen(parsed.content);
}

/**
 * Plain clipboard text is Markdown's source format, so parse it with the same
 * schema-aware parser used by Tandem's import/export path. ProseMirror still
 * owns rich HTML paste, code-block paste, and paste-without-formatting.
 */
export const MarkdownPaste = Extension.create({
  name: "tandemMarkdownPaste",

  addProseMirrorPlugins() {
    return [
      new Plugin({
        props: {
          clipboardTextParser(text, _context, plainText, view) {
            if (plainText) {
              // ProseMirror accepts a falsy result here to use its native
              // literal-text fallback, although its public type is narrower.
              return null as unknown as Slice;
            }
            return parseMarkdownSlice(text, view.state.schema);
          },

          // Some clipboard producers expose an explicit Markdown flavor
          // alongside HTML. Prefer that deliberate source representation.
          handlePaste(view, event) {
            const markdown = event.clipboardData?.getData("text/markdown");
            if (
              !markdown?.trim() ||
              !view.editable ||
              view.state.selection.$from.parent.type.spec.code
            ) {
              return false;
            }

            event.preventDefault();
            view.dispatch(
              view.state.tr
                .replaceSelection(parseMarkdownSlice(markdown, view.state.schema))
                .scrollIntoView(),
            );
            return true;
          },
        },
      }),
    ];
  },
});
