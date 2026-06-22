import { useState } from "react";
import { trpc } from "../trpc.js";

interface Collection {
  id: string;
  name: string;
}

interface DocNode {
  id: string;
  title: string;
  children: DocNode[];
}

interface Props {
  collections: Collection[];
  collectionId: string | null;
  docId: string | null;
  onSelectCollection: (id: string) => void;
  onSelectDoc: (id: string) => void;
}

export function Sidebar({
  collections,
  collectionId,
  docId,
  onSelectCollection,
  onSelectDoc,
}: Props) {
  const utils = trpc.useUtils();
  const tree = trpc.documents.tree.useQuery(
    { collectionId: collectionId! },
    { enabled: !!collectionId },
  );

  const createCollection = trpc.collections.create.useMutation({
    onSuccess: (col) => {
      utils.collections.list.invalidate();
      onSelectCollection(col.id);
    },
  });
  const createDoc = trpc.documents.create.useMutation({
    onSuccess: (doc) => {
      utils.documents.tree.invalidate({ collectionId: collectionId! });
      if (doc) onSelectDoc(doc.id);
    },
  });

  const [newColName, setNewColName] = useState("");

  return (
    <aside className="sidebar">
      <div className="section">
        <div className="section-title">Collections</div>
        {collections.map((c) => (
          <button
            key={c.id}
            className={"row" + (c.id === collectionId ? " active" : "")}
            onClick={() => onSelectCollection(c.id)}
          >
            {c.name}
          </button>
        ))}
        <form
          className="new-collection"
          onSubmit={(e) => {
            e.preventDefault();
            const name = newColName.trim();
            if (!name) return;
            const slug =
              name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "") +
              "-" +
              Math.floor(performance.now()).toString(36);
            createCollection.mutate({ name, slug });
            setNewColName("");
          }}
        >
          <input
            value={newColName}
            placeholder="New collection…"
            onChange={(e) => setNewColName(e.target.value)}
          />
        </form>
      </div>

      {collectionId && (
        <div className="section">
          <div className="section-title">
            Documents
            <button
              className="add"
              onClick={() => createDoc.mutate({ collectionId, title: "Untitled" })}
            >
              +
            </button>
          </div>
          <DocTree nodes={tree.data ?? []} docId={docId} onSelect={onSelectDoc} />
        </div>
      )}
    </aside>
  );
}

function DocTree({
  nodes,
  docId,
  onSelect,
  depth = 0,
}: {
  nodes: DocNode[];
  docId: string | null;
  onSelect: (id: string) => void;
  depth?: number;
}) {
  return (
    <>
      {nodes.map((n) => (
        <div key={n.id}>
          <button
            className={"row" + (n.id === docId ? " active" : "")}
            style={{ paddingLeft: 12 + depth * 14 }}
            onClick={() => onSelect(n.id)}
          >
            {n.title || "Untitled"}
          </button>
          {n.children.length > 0 && (
            <DocTree
              nodes={n.children}
              docId={docId}
              onSelect={onSelect}
              depth={depth + 1}
            />
          )}
        </div>
      ))}
    </>
  );
}
