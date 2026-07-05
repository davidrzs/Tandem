import { Extension } from "@tiptap/core";
import { PluginKey } from "@tiptap/pm/state";
import Suggestion from "@tiptap/suggestion";
import { suggestionRender } from "./suggestion-menu.js";

export interface MentionCandidate {
  kind: "user";
  /** What gets inserted after the @: the user's email local part. */
  handle: string;
  name: string;
  email: string;
}

export interface DocCandidate {
  kind: "doc";
  id: string;
  title: string;
}

type Candidate = MentionCandidate | DocCandidate;

/**
 * `@` autocomplete over workspace members AND documents. A person inserts
 * plain text (`@handle `) — ordinary markdown, which is what assigns
 * in-document TODOs. A document inserts a link to it, so pages can reference
 * each other. Members load async and docs are searched per keystroke, so the
 * extension reads both through callbacks instead of capturing a snapshot.
 */
export function createMentionExtension(
  getMembers: () => MentionCandidate[],
  searchDocs: (query: string) => Promise<DocCandidate[]>,
) {
  return Extension.create({
    name: "mentionSuggest",
    addProseMirrorPlugins() {
      return [
        Suggestion({
          editor: this.editor,
          char: "@",
          // Distinct key — the slash menu already owns the default one.
          pluginKey: new PluginKey("mentionSuggest"),
          items: async ({ query }) => {
            const q = query.toLowerCase();
            const people = getMembers()
              .filter(
                (m) =>
                  m.handle.toLowerCase().includes(q) ||
                  m.name.toLowerCase().includes(q),
              )
              .slice(0, 5);
            const docs = q.length >= 2 ? await searchDocs(query).catch(() => []) : [];
            return [...people, ...docs.slice(0, 5)] as Candidate[];
          },
          command: ({ editor, range, props }) => {
            const item = props as Candidate;
            if (item.kind === "user") {
              editor
                .chain()
                .focus()
                .deleteRange(range)
                .insertContent(`@${item.handle} `)
                .run();
            } else {
              editor
                .chain()
                .focus()
                .deleteRange(range)
                .insertContent([
                  {
                    type: "text",
                    text: item.title || "Untitled",
                    marks: [{ type: "link", attrs: { href: `/d/${item.id}` } }],
                  },
                  { type: "text", text: " " },
                ])
                .run();
            }
          },
          render: suggestionRender<Candidate>(
            (item) =>
              item.kind === "user" ? (
                <>
                  <span>{item.name}</span>
                  <code>@{item.handle}</code>
                </>
              ) : (
                <>
                  <span>{item.title || "Untitled"}</span>
                  <code>page</code>
                </>
              ),
            (item) => (item.kind === "user" ? item.email : item.id),
          ),
        }),
      ];
    },
  });
}
