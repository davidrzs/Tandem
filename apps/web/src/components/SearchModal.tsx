import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { friendlyError } from "../errors.js";
import { trpc } from "../trpc.js";
import { useCreateDocument } from "./create-document.js";
import { Icon, type IconName } from "./Icon.js";
import { listRecents } from "./recents.js";

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
  workspaceId,
  collections,
  onOpenSettings,
  onClose,
}: {
  initialQuery?: string;
  workspaceId: string | null;
  collections: Array<{ id: string; name: string; writable: boolean }>;
  onOpenSettings: () => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState(initialQuery);
  const [debounced, setDebounced] = useState(initialQuery.trim());
  const [selected, setSelected] = useState(0);
  const navigate = useNavigate();
  const inputRef = useRef<HTMLInputElement>(null);
  const favorites = trpc.favorites.list.useQuery();
  const openDoc = (id: string) => {
    onClose();
    navigate(`/d/${id}`);
  };
  const createDocument = useCreateDocument(workspaceId, openDoc);

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

  type ZeroItem = {
    id: string;
    title: string;
    detail: string;
    icon: IconName;
    run: () => void;
  };
  const zeroItems = useMemo<ZeroItem[]>(() => {
    const items: ZeroItem[] = [];
    const seen = new Set<string>();
    for (const recent of listRecents().filter((r) => r.workspaceId === workspaceId).slice(0, 5)) {
      seen.add(recent.id);
      items.push({
        id: `recent:${recent.id}`,
        title: recent.title || "Untitled",
        detail: "Recently viewed",
        icon: "restore",
        run: () => openDoc(recent.id),
      });
    }
    for (const favorite of (favorites.data ?? []).filter(
      (document) => document.workspaceId === workspaceId && !document.archivedAt,
    )) {
      if (seen.has(favorite.id)) continue;
      seen.add(favorite.id);
      items.push({
        id: `favorite:${favorite.id}`,
        title: favorite.title || "Untitled",
        detail: "Favorite",
        icon: "star",
        run: () => openDoc(favorite.id),
      });
      if (items.length >= 8) break;
    }
    const writable = collections.find((c) => c.writable);
    if (writable) {
      items.push({
        id: "action:new",
        title: "New document",
        detail: `Create in ${writable.name}`,
        icon: "plus",
        run: () => createDocument.mutate({ collectionId: writable.id, title: "" }),
      });
    }
    items.push({
      id: "action:agent",
      title: "Connect an AI agent",
      detail: "Open connection settings",
      icon: "settings",
      run: onOpenSettings,
    });
    return items;
  }, [collections, favorites.data, workspaceId]);

  useEffect(() => setSelected(0), [debounced]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") onClose();
    if (e.key === "ArrowDown") {
      e.preventDefault();
      const count = active ? hits.length : zeroItems.length;
      setSelected((s) => Math.min(s + 1, Math.max(0, count - 1)));
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      setSelected((s) => Math.max(s - 1, 0));
    }
    if (e.key === "Enter") {
      if (active && hits[selected]) openDoc(hits[selected]!.id);
      if (!active) zeroItems[selected]?.run();
    }
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
        {!active && zeroItems.length > 0 && (
          <div className="search-results command-results">
            <div className="search-section-label">Jump back in or take an action</div>
            {zeroItems.map((item, i) => (
              <button
                type="button"
                key={item.id}
                className={"search-hit command-hit" + (i === selected ? " selected" : "")}
                onMouseEnter={() => setSelected(i)}
                onClick={item.run}
              >
                <Icon name={item.icon} size={15} />
                <span className="command-copy">
                  <span className="search-title">{item.title}</span>
                  <span className="search-command-detail">{item.detail}</span>
                </span>
              </button>
            ))}
          </div>
        )}
        {results.error && (
          <div className="search-status">{friendlyError(results.error, "Search failed. Try again.")}</div>
        )}
        {createDocument.error && (
          <div className="search-status">
            {friendlyError(createDocument.error, "Couldn't create the document.")}
          </div>
        )}
        {active && !results.isLoading && hits.length === 0 && !results.error && (
          <div className="search-status">Nothing matches that search.</div>
        )}
        {hits.length > 0 && (
          <div className="search-results">
            {hits.map((hit, i) => (
              <button type="button"
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
