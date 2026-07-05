import { Extension } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import type { Node as PMNode } from "@tiptap/pm/model";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import { authorKey, authorTint } from "./colors.js";

/**
 * Renders @mentions of real workspace members with a soft tint in that
 * person's identity hue (the same hue as their presence caret and blame
 * colour). Pure decoration: the document keeps plain text — markdown, TODO
 * assignment, and authorship are untouched — and an @handle that matches no
 * member stays ordinary text.
 */

export interface MentionMember {
  userId: string;
  handle: string;
  email: string;
  name: string;
}

export const mentionHighlightKey = new PluginKey<DecorationSet>("mentionHighlight");

const MENTION_RE = /@([\w.+-]+(?:@[\w.-]+)?)/g;

export function createMentionHighlight(getMembers: () => MentionMember[]) {
  const compute = (doc: PMNode): DecorationSet => {
    const members = getMembers();
    if (members.length === 0) return DecorationSet.empty;
    const byHandle = new Map<string, MentionMember>();
    for (const m of members) {
      byHandle.set(m.handle.toLowerCase(), m);
      byHandle.set(m.email.toLowerCase(), m);
    }
    const decorations: Decoration[] = [];
    doc.descendants((node, pos) => {
      if (!node.isText || !node.text) return;
      for (const match of node.text.matchAll(MENTION_RE)) {
        const member = byHandle.get(match[1]!.toLowerCase());
        if (!member) continue;
        const from = pos + match.index;
        decorations.push(
          Decoration.inline(from, from + match[0].length, {
            class: "mention",
            spellcheck: "false",
            title: member.name,
            style: `background-color: ${authorTint(authorKey(member.userId, false))};`,
          }),
        );
      }
    });
    return DecorationSet.create(doc, decorations);
  };

  return Extension.create({
    name: "mentionHighlight",
    addProseMirrorPlugins() {
      return [
        new Plugin<DecorationSet>({
          key: mentionHighlightKey,
          state: {
            init: (_, state) => compute(state.doc),
            apply: (tr, prev, _old, next) =>
              tr.docChanged || tr.getMeta(mentionHighlightKey)
                ? compute(next.doc)
                : prev,
          },
          props: {
            decorations(state) {
              return mentionHighlightKey.getState(state);
            },
          },
        }),
      ];
    },
  });
}
