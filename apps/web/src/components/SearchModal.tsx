import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { friendlyError } from "../errors.js";
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

/** Split a raw query into free text and a single `#tag` filter. */
function parseQuery(raw: string): { text: string; tag?: string } {
  let tag: string | undefined;
  const rest: string[] = [];
  for (const tok of raw.trim().split(/\s+/).filter(Boolean)) {
    if (!tag && tok.length > 1 && tok.startsWith("#")) tag = tok.slice(1);
    else rest.push(tok);
  }
  return { text: rest.join(" "), tag };
}

export function SearchModal({
  initialQuery = "",
  onClose,
}: {
  initialQuery?: string;
  onClose: () => void;
}) {
  const [query, setQuery] = useState(initialQuery);
  const [debounced, setDebounced] = useState(initialQuery.trim());
  const [selected, setSelected] = useState(0);
  const navigate = useNavigate();
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const t = setTimeout(() => setDebounced(query.trim()), 200);
    return () => clearTimeout(t);
  }, [query]);
  useEffect(() => {
    inputRef.current?.focus();
    // Caret to the end so a prefilled "#tag " is ready to type after.
    const len = inputRef.current?.value.length ?? 0;
    inputRef.current?.setSelectionRange(len, len);
  }, []);

  const { text, tag } = useMemo(() => parseQuery(debounced), [debounced]);
  const active = text.length > 0 || !!tag;

  const results = trpc.documents.search.useQuery(
    { query: text, tag, limit: 20 },
    { enabled: active, placeholderData: (prev) => prev },
  );
  const hits = active ? (results.data ?? []) : [];

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
          placeholder="Search documents…  (try #tag)"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onKeyDown}
        />
        {tag && (
          <div className="search-status">
            Filtering by tag <span className="tag-chip">{tag}</span>
            {text ? ` and text "${text}"` : ""}
          </div>
        )}
        {results.error && (
          <div className="search-status">{friendlyError(results.error, "Search failed. Try again.")}</div>
        )}
        {active && !results.isLoading && hits.length === 0 && !results.error && (
          <div className="search-status">Nothing matches that search.</div>
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
                {hit.snippet && <Snippet text={hit.snippet} />}
                {hit.tags.length > 0 && (
                  <span className="search-tags">
                    {hit.tags.map((t) => (
                      <span key={t} className="tag-chip">
                        {t}
                      </span>
                    ))}
                  </span>
                )}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
