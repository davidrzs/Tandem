import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { trpc } from "../trpc.js";

/** Highlighted-fragment markers from ts_headline (chr(2)/chr(3) delimiters). */
function Snippet({ text }: { text: string }) {
  const parts = text.split(/(\x02[^\x03]*\x03)/g).filter(Boolean);
  return (
    <span className="search-snippet">
      {parts.map((part, i) =>
        part.startsWith("\x02") ? (
          <mark key={i}>{part.slice(1, -1)}</mark>
        ) : (
          <span key={i}>{part}</span>
        ),
      )}
    </span>
  );
}

export function SearchModal({ onClose }: { onClose: () => void }) {
  const [query, setQuery] = useState("");
  const [debounced, setDebounced] = useState("");
  const [selected, setSelected] = useState(0);
  const navigate = useNavigate();
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const t = setTimeout(() => setDebounced(query.trim()), 200);
    return () => clearTimeout(t);
  }, [query]);
  useEffect(() => inputRef.current?.focus(), []);

  const results = trpc.documents.search.useQuery(
    { query: debounced, limit: 20 },
    { enabled: debounced.length > 0, placeholderData: (prev) => prev },
  );
  const hits = debounced.length > 0 ? (results.data ?? []) : [];

  useEffect(() => setSelected(0), [debounced]);

  const openDoc = (id: string) => {
    onClose();
    navigate(`/d/${id}`);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") onClose();
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setSelected((s) => Math.min(s + 1, hits.length - 1));
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      setSelected((s) => Math.max(s - 1, 0));
    }
    if (e.key === "Enter" && hits[selected]) openDoc(hits[selected]!.id);
  };

  return (
    <div className="modal-overlay search-overlay" onMouseDown={onClose}>
      <div className="search-box" onMouseDown={(e) => e.stopPropagation()}>
        <input
          ref={inputRef}
          className="search-input"
          placeholder="Search documents…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onKeyDown}
        />
        {results.error && (
          <div className="search-status">Search failed: {results.error.message}</div>
        )}
        {debounced && !results.isLoading && hits.length === 0 && !results.error && (
          <div className="search-status">No documents match "{debounced}".</div>
        )}
        {hits.length > 0 && (
          <div className="search-results">
            {hits.map((hit, i) => (
              <button
                key={hit.id}
                className={"search-hit" + (i === selected ? " selected" : "")}
                onMouseEnter={() => setSelected(i)}
                onClick={() => openDoc(hit.id)}
              >
                <span className="search-title">{hit.title || "Untitled"}</span>
                <Snippet text={hit.snippet} />
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
