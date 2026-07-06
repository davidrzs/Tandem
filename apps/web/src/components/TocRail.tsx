import type { Editor } from "@tiptap/react";
import { useEffect, useState } from "react";

interface Heading {
  level: number;
  text: string;
}

/**
 * An Outline-style contents rail in the document's left gutter. It's a pure view
 * of the current headings — no node, no markdown, no blame. It tracks the section
 * you're reading (scroll-spy) and scrolls to a heading on click. The parent hides
 * it when a right rail is open, in full-width mode, or on a narrow viewport.
 */
export function TocRail({ editor, hidden }: { editor: Editor | null; hidden: boolean }) {
  const [headings, setHeadings] = useState<Heading[]>([]);
  const [active, setActive] = useState(-1);

  // Rebuild the heading list whenever the document changes.
  useEffect(() => {
    if (!editor) return;
    const compute = () => {
      const hs: Heading[] = [];
      editor.state.doc.descendants((node) => {
        if (node.type.name === "heading") {
          hs.push({ level: Number(node.attrs.level) || 1, text: node.textContent || "Untitled" });
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
          key={i}
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
