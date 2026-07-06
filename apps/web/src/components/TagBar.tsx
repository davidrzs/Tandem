import { useState } from "react";
import { Icon } from "./Icon.js";

/** Tag chips under the title. Click a tag to search it; when editable, remove
 * with the × or add via the inline "+ tag" input (autocompleted from existing
 * tags). Normalization/dedupe is enforced server-side; this just avoids obvious
 * duplicates locally. */
export function TagBar({
  tags,
  canEdit,
  suggestions,
  onChange,
  onTagClick,
}: {
  tags: string[];
  canEdit: boolean;
  suggestions: string[];
  onChange: (tags: string[]) => void;
  onTagClick: (tag: string) => void;
}) {
  const [adding, setAdding] = useState(false);
  const [value, setValue] = useState("");

  if (!canEdit && tags.length === 0) return null;

  const commit = () => {
    const next = value.trim();
    if (next && !tags.some((t) => t.toLowerCase() === next.toLowerCase())) {
      onChange([...tags, next]);
    }
    setValue("");
    setAdding(false);
  };

  return (
    <div className="tag-bar">
      {tags.map((tag) => (
        <span key={tag} className="tag-chip">
          <button className="tag-label" onClick={() => onTagClick(tag)} title={`Find #${tag}`}>
            {tag}
          </button>
          {canEdit && (
            <button
              className="tag-remove"
              title="Remove tag" aria-label="Remove tag"
              onClick={() => onChange(tags.filter((t) => t !== tag))}
            >
              <Icon name="close" size={11} />
            </button>
          )}
        </span>
      ))}

      {canEdit &&
        (adding ? (
          <>
            <input
              className="tag-input"
              list="tandem-tag-suggestions"
              autoFocus
              value={value}
              placeholder="Tag…"
              onChange={(e) => setValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  commit();
                } else if (e.key === "Escape") {
                  setValue("");
                  setAdding(false);
                }
              }}
              onBlur={commit}
            />
            <datalist id="tandem-tag-suggestions">
              {suggestions.map((s) => (
                <option key={s} value={s} />
              ))}
            </datalist>
          </>
        ) : (
          <button className="tag-add" onClick={() => setAdding(true)}>
            <Icon name="plus" size={14} />
            Add tag
          </button>
        ))}
    </div>
  );
}
