import MarkdownIt from "markdown-it";

/**
 * Safe markdown -> HTML for short prose rendered outside the editor (comment
 * bodies). This is not the document renderer: documents are parsed into the
 * ProseMirror schema (markdown.ts) and rendered by TipTap.
 *
 * - Raw HTML is escaped, never passed through (`html: false`).
 * - Links keep markdown-it's default target validation (no `javascript:`,
 *   `data:`, `file:` ...) and open in a new tab so a thread stays in view.
 * - Bare URLs become links; single newlines stay line breaks, so chat-style
 *   comments keep the structure they were typed with.
 * - Images are disabled: a comment must not make the reader's browser fetch
 *   arbitrary remote resources.
 */
const md = MarkdownIt({ html: false, linkify: true, breaks: true }).disable("image");

md.renderer.rules.link_open = (tokens, idx, options, _env, self) => {
  const tok = tokens[idx]!;
  tok.attrSet("target", "_blank");
  tok.attrSet("rel", "noopener noreferrer");
  return self.renderToken(tokens, idx, options);
};

export function markdownToHtml(markdown: string): string {
  return md.render(markdown);
}

/**
 * One-line plain text of a markdown string, for previews (notification
 * snippets): formatting and link targets dropped, code kept verbatim, blocks
 * joined by single spaces.
 */
export function markdownToText(markdown: string): string {
  const parts: string[] = [];
  for (const tok of md.parse(markdown, {})) {
    if (tok.type === "inline") {
      for (const child of tok.children ?? []) {
        if (child.type === "text" || child.type === "code_inline") parts.push(child.content);
        else if (child.type === "softbreak" || child.type === "hardbreak") parts.push(" ");
      }
      parts.push(" ");
    } else if (tok.type === "fence" || tok.type === "code_block") {
      parts.push(tok.content, " ");
    }
  }
  return parts.join("").replace(/\s+/g, " ").trim();
}
