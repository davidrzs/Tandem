import { EditorContent, useEditor, type AnyExtension } from "@tiptap/react";
import { LiveSection } from "@tandem/editor";
import { contentExtensions } from "./editor/content-extensions.js";

/**
 * A read-only render of a document's ProseMirror JSON (a past version, a page
 * in a series). Same node set as the live editor (tables/code/math/page-refs
 * render identically) but without collaboration, blame, comments, or editing
 * affordances. `liveSection` decides how live sections inside show.
 */
export function ReadOnlyDoc({
  contentJson,
  liveSection = LiveSection,
}: {
  contentJson: unknown;
  liveSection?: AnyExtension;
}) {
  const editor = useEditor(
    {
      editable: false,
      content: contentJson as object,
      extensions: contentExtensions(liveSection),
    },
    [contentJson],
  );

  return <EditorContent className="prose" editor={editor} />;
}
