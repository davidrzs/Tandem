import type { Editor } from "@tiptap/react";
import { getAuthors } from "@tandem/editor";
import { useCallback, useEffect, useRef, useState } from "react";
import type * as Y from "yjs";
import { authorLabel, blamePluginKey } from "../blame.js";
import { authorKey } from "../colors.js";
import type { HistorySession } from "../HistoryPanel.js";

/** History/blame view: author sessions, the blame decoration toggle, the
 * ?history= deep link and the blame hover card. */
export function useBlame({
  editor,
  ydoc,
  rail,
  setRail,
  historyTarget,
}: {
  editor: Editor | null;
  ydoc: Y.Doc;
  rail: null | "comments" | "history";
  setRail: (rail: null | "comments" | "history") => void;
  historyTarget: string | null;
}) {
  const blameOn = rail === "history";
  const [onlySession, setOnlySession] = useState<number | null>(null);
  const [sessions, setSessions] = useState<HistorySession[]>([]);
  const refreshSessions = useCallback(() => {
    const list: HistorySession[] = [...getAuthors(ydoc).entries()].map(
      ([clientId, info]) => ({
        clientId,
        key: authorKey(info.userId, info.ai),
        label: authorLabel(info),
        ai: info.ai,
        at: info.at,
      }),
    );
    list.sort((a, b) => b.at - a.at);
    setSessions(list.slice(0, 50));
  }, [ydoc]);

  useEffect(() => {
    if (!editor) return;
    editor.view.dispatch(
      editor.state.tr.setMeta(blamePluginKey, { enabled: blameOn, only: onlySession }),
    );
    if (!blameOn) return;
    refreshSessions();
    // Recompute (debounced) whenever the Yjs doc changes — remote or local.
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onUpdate = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        refreshSessions();
        editor.view.dispatch(
          editor.state.tr.setMeta(blamePluginKey, { recompute: true }),
        );
      }, 150);
    };
    ydoc.on("update", onUpdate);
    return () => {
      clearTimeout(timer);
      ydoc.off("update", onUpdate);
    };
  }, [editor, blameOn, onlySession, ydoc, refreshSessions]);

  useEffect(() => {
    if (historyTarget) setRail("history");
  }, [historyTarget]);

  const handledHistoryTarget = useRef<string | null>(null);
  useEffect(() => {
    if (!historyTarget || sessions.length === 0 || handledHistoryTarget.current === historyTarget) {
      return;
    }
    const selected =
      historyTarget === "ai"
        ? sessions.find((session) => session.ai)
        : sessions.find((session) => String(session.clientId) === historyTarget);
    if (!selected) return;
    handledHistoryTarget.current = historyTarget;
    setOnlySession(selected.clientId);
    requestAnimationFrame(() => {
      document
        .querySelector(`[data-blame-client="${selected.clientId}"]`)
        ?.scrollIntoView({ behavior: "smooth", block: "center" });
    });
  }, [historyTarget, sessions]);

  // Blame hover card (delegated — decorations carry data attributes).
  const [hover, setHover] = useState<{
    x: number;
    y: number;
    label: string;
    at: number;
  } | null>(null);
  const onMouseOver = useCallback((e: React.MouseEvent) => {
    const el = (e.target as HTMLElement).closest?.("[data-blame-label]");
    if (!(el instanceof HTMLElement)) {
      setHover(null);
      return;
    }
    const rect = el.getBoundingClientRect();
    setHover({
      x: rect.left,
      y: rect.bottom + 6,
      label: el.dataset.blameLabel ?? "Unknown",
      at: Number(el.dataset.blameAt ?? 0),
    });
  }, []);

  return { blameOn, onlySession, setOnlySession, sessions, hover, setHover, onMouseOver };
}
