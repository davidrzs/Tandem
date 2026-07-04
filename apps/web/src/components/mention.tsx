import { Extension } from "@tiptap/core";
import { PluginKey } from "@tiptap/pm/state";
import Suggestion from "@tiptap/suggestion";
import { suggestionRender } from "./suggestion-menu.js";

export interface MentionCandidate {
  /** What gets inserted after the @: the user's email local part. */
  handle: string;
  name: string;
  email: string;
}

/**
 * `@` autocomplete over workspace members. Inserts plain text (`@handle `) —
 * mentions are ordinary markdown, which is what assigns in-document TODOs
 * (`- [ ] @handle …`) to a user. Members load async, so the extension reads
 * them through a getter instead of capturing a snapshot.
 */
export function createMentionExtension(getMembers: () => MentionCandidate[]) {
  return Extension.create({
    name: "mentionSuggest",
    addProseMirrorPlugins() {
      return [
        Suggestion({
          editor: this.editor,
          char: "@",
          // Distinct key — the slash menu already owns the default one.
          pluginKey: new PluginKey("mentionSuggest"),
          items: ({ query }) => {
            const q = query.toLowerCase();
            return getMembers()
              .filter(
                (m) =>
                  m.handle.toLowerCase().includes(q) ||
                  m.name.toLowerCase().includes(q),
              )
              .slice(0, 8);
          },
          command: ({ editor, range, props }) => {
            const member = props as MentionCandidate;
            editor
              .chain()
              .focus()
              .deleteRange(range)
              .insertContent(`@${member.handle} `)
              .run();
          },
          render: suggestionRender<MentionCandidate>(
            (m) => (
              <>
                <span>{m.name}</span>
                <code>@{m.handle}</code>
              </>
            ),
            (m) => m.email,
          ),
        }),
      ];
    },
  });
}
