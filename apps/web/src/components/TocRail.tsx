import type { Editor } from "@tiptap/react";
import { useEffect, useState } from "react";

interface Heading {
  level: number;
  text: string;
  /** Stable render key: heading text, disambiguated when texts repeat. */
  key: string;
}

/**
 * A contents rail in the document's left gutter. It's a pure view
 * of the current headings — no node, no markdown, no blame. It tracks the section
 * you're reading (scroll-spy) and scrolls to a heading on click. The parent hides
 * it when a right rail is open; CSS hides it on viewports too narrow to fit it
 * beside the centered document column.
 */
export function TocRail({ editor, hidden }: { editor: Editor | null; hidden: boolean }) {
  const [headings, setHeadings] = useState<Heading[]>([]);
  const [active, setActive] = useState(-1);

  // Rebuild the heading list whenever the document changes.
  useEffect(() => {
    if (!editor) return;
    const compute = () => {
      const hs: Heading[] = [];
      const seen = new Map<string, number>();
      editor.state.doc.descendants((node) => {
        if (node.type.name === "heading") {
          const text = node.textContent || "Untitled";
          const n = seen.get(text) ?? 0;
          seen.set(text, n + 1);
          hs.push({ level: Number(node.attrs.level) || 1, text, key: n === 0 ? text : `${text}#${n}` });
        }
      });
      setHeadings(hs);
    };
    compute();
    editor.on("update", compute);
    return () => {
      editor.off("update", compute);
    };
  }, [editor]);

  // Scroll-spy: the active entry is the last heading scrolled above the fold.
  useEffect(() => {
    if (!editor || headings.length === 0) return;
    const scroller = editor.view.dom.closest(".main");
    if (!scroller) return;
    const onScroll = () => {
      const els = editor.view.dom.querySelectorAll("h1, h2, h3, h4");
      let cur = -1;
      els.forEach((el, i) => {
        if (el.getBoundingClientRect().top <= 96) cur = i;
      });
      setActive(cur);
    };
    onScroll();
    scroller.addEventListener("scroll", onScroll, { passive: true });
    return () => scroller.removeEventListener("scroll", onScroll);
  }, [editor, headings.length]);

  if (hidden || !editor || headings.length < 2) return null;

  const scrollTo = (i: number) => {
    const els = editor.view.dom.querySelectorAll("h1, h2, h3, h4");
    els[i]?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  return (
    <nav className="toc-rail" aria-label="Table of contents">
      <div className="toc-title">On this page</div>
      {headings.map((h, i) => (
        <button
          key={h.key}
          type="button"
          className={`toc-entry toc-l${Math.min(h.level, 3)}` + (i === active ? " active" : "")}
          onClick={() => scrollTo(i)}
          title={h.text}
        >
          {h.text}
        </button>
      ))}
    </nav>
  );
}
