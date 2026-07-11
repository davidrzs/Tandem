import CodeBlockLowlight from "@tiptap/extension-code-block-lowlight";
import {
  NodeViewContent,
  NodeViewWrapper,
  ReactNodeViewRenderer,
  type NodeViewProps,
} from "@tiptap/react";
import { useState } from "react";

/**
 * Code block chrome: a language picker (writes the fence language, so it
 * round-trips through markdown) and a copy button. The content itself stays
 * a plain contenteditable <code> so lowlight decorations apply unchanged.
 */
function CodeBlockView({ node, updateAttributes, editor, extension }: NodeViewProps) {
  const language = String(node.attrs.language ?? "");
  const [copied, setCopied] = useState(false);
  const languages: string[] =
    (extension.options as { lowlight?: { listLanguages?: () => string[] } }).lowlight
      ?.listLanguages?.()
      ?.sort() ?? [];

  return (
    <NodeViewWrapper className="code-block">
      <div className="code-head" contentEditable={false}>
        {editor.isEditable ? (
          <select
            className="code-lang"
            value={languages.includes(language) ? language : ""}
            onChange={(e) => updateAttributes({ language: e.target.value })}
            aria-label="Code block language"
          >
            <option value="">plain</option>
            {languages.map((l) => (
              <option key={l} value={l}>
                {l}
              </option>
            ))}
          </select>
        ) : (
          <span className="code-lang">{language || "plain"}</span>
        )}
        <button
          type="button"
          className="code-copy"
          aria-label="Copy code"
          onClick={() =>
            void navigator.clipboard.writeText(node.textContent).then(() => {
              setCopied(true);
              setTimeout(() => setCopied(false), 1200);
            })
          }
        >
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <pre>
        <NodeViewContent as={"code" as never} />
      </pre>
    </NodeViewWrapper>
  );
}

/** CodeBlockLowlight with the header chrome; pass the shared lowlight instance. */
export function createCodeBlock(lowlight: unknown) {
  return CodeBlockLowlight.extend({
    addNodeView() {
      return ReactNodeViewRenderer(CodeBlockView);
    },
  }).configure({ lowlight });
}
