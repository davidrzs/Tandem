import type { Editor } from "@tiptap/core";
import { useEffect, useRef, useState } from "react";
import { findPluginKey, type FindState } from "./find.js";
import { Icon } from "./Icon.js";

/**
 * Floating find/replace bar (Mod+F). Find is pure view state (decorations);
 * replace edits through the normal transaction path, so replaced text is
 * attributed to the local user like any other typing.
 */
export function FindBar({ editor, onClose }: { editor: Editor; onClose: () => void }) {
  const [query, setQuery] = useState("");
  const [replacement, setReplacement] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  // Count/position live in plugin state; re-render on every transaction.
  const [, force] = useState(0);
  useEffect(() => {
    const bump = () => force((n) => n + 1);
    editor.on("transaction", bump);
    return () => {
      editor.off("transaction", bump);
    };
  }, [editor]);
  useEffect(() => {
    inputRef.current?.focus();
    return () => {
      // Closing the bar clears the highlights.
      if (!editor.isDestroyed) {
        editor.view.dispatch(editor.state.tr.setMeta(findPluginKey, { query: "", active: 0 }));
      }
    };
  }, [editor]);

  const dispatch = (meta: Partial<FindState>) => {
    if (editor.isDestroyed) return;
    editor.view.dispatch(editor.state.tr.setMeta(findPluginKey, meta));
  };

  const scrollToActive = () => {
    const s = findPluginKey.getState(editor.state);
    const m = s?.matches[s.active];
    if (!m) return;
    const dom = editor.view.domAtPos(m.from);
    const el = dom.node instanceof Element ? dom.node : dom.node.parentElement;
    el?.scrollIntoView({ block: "center" });
  };

  const step = (dir: 1 | -1) => {
    const s = findPluginKey.getState(editor.state);
    if (!s || s.matches.length === 0) return;
    dispatch({ active: s.active + dir });
    requestAnimationFrame(scrollToActive);
  };

  const replaceRange = (m: { from: number; to: number }) => {
    editor.view.dispatch(editor.state.tr.insertText(replacement, m.from, m.to));
  };

  const replaceActive = () => {
    const s = findPluginKey.getState(editor.state);
    const m = s?.matches[s.active];
    if (!m) return;
    replaceRange(m);
    requestAnimationFrame(scrollToActive);
  };

  const replaceAll = () => {
    const s = findPluginKey.getState(editor.state);
    if (!s || s.matches.length === 0) return;
    let tr = editor.state.tr;
    // Back to front so earlier positions stay valid.
    for (const m of [...s.matches].reverse()) tr = tr.insertText(replacement, m.from, m.to);
    editor.view.dispatch(tr);
  };

  const state = findPluginKey.getState(editor.state);
  const count = state?.matches.length ?? 0;

  return (
    <div className="find-bar" role="search" aria-label="Find in document">
      <Icon name="search" size={14} />
      <input
        ref={inputRef}
        value={query}
        placeholder="Find in document"
        onChange={(e) => {
          setQuery(e.target.value);
          dispatch({ query: e.target.value, active: 0 });
          requestAnimationFrame(scrollToActive);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            step(e.shiftKey ? -1 : 1);
          } else if (e.key === "Escape") {
            e.preventDefault();
            onClose();
          }
        }}
      />
      <span className="find-count">
        {query ? (count > 0 ? `${(state?.active ?? 0) + 1}/${count}` : "0") : ""}
      </span>
      <button
        type="button"
        className="find-btn"
        aria-label="Previous match"
        title="Previous match (Shift+Enter)"
        onClick={() => step(-1)}
      >
        <Icon name="chevron" size={13} style={{ transform: "rotate(-90deg)" }} />
      </button>
      <button
        type="button"
        className="find-btn"
        aria-label="Next match"
        title="Next match (Enter)"
        onClick={() => step(1)}
      >
        <Icon name="chevron" size={13} style={{ transform: "rotate(90deg)" }} />
      </button>
      {editor.isEditable && (
        <>
          <input
            value={replacement}
            placeholder="Replace with"
            onChange={(e) => setReplacement(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                e.preventDefault();
                onClose();
              }
            }}
          />
          <button type="button" className="find-btn" disabled={count === 0} onClick={replaceActive}>
            Replace
          </button>
          <button type="button" className="find-btn" disabled={count === 0} onClick={replaceAll}>
            All
          </button>
        </>
      )}
      <button type="button" className="find-btn" aria-label="Close find" onClick={onClose}>
        <Icon name="close" size={13} />
      </button>
    </div>
  );
}
