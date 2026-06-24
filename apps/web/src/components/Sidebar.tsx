import { useState } from "react";
import { trpc } from "../trpc.js";

interface Workspace {
  id: string;
  name: string;
}
interface Collection {
  id: string;
  name: string;
  workspaceId: string;
}
interface DocNode {
  id: string;
  title: string;
  children: DocNode[];
}

interface Props {
  workspaces: Workspace[];
  workspaceId: string | null;
  collections: Collection[];
  collectionId: string | null;
  docId: string | null;
  onSelectWorkspace: (id: string) => void;
  onSelectCollection: (id: string) => void;
  onSelectDoc: (id: string) => void;
}

export function Sidebar({
  workspaces,
  workspaceId,
  collections,
  collectionId,
  docId,
  onSelectWorkspace,
  onSelectCollection,
  onSelectDoc,
}: Props) {
  const utils = trpc.useUtils();
  const tree = trpc.documents.tree.useQuery(
    { collectionId: collectionId! },
    { enabled: !!collectionId },
  );

  const createWorkspace = trpc.workspaces.create.useMutation({
    onSuccess: (ws) => {
      utils.workspaces.mine.invalidate();
      onSelectWorkspace(ws.id);
    },
  });
  const createCollection = trpc.collections.create.useMutation({
    onSuccess: () => utils.collections.list.invalidate(),
  });
  const createDoc = trpc.documents.create.useMutation({
    onSuccess: (doc) => {
      utils.documents.tree.invalidate({ collectionId: collectionId! });
      if (doc) onSelectDoc(doc.id);
    },
  });
  const createInvite = trpc.workspaces.createInvite.useMutation({
    onSuccess: ({ token }) => {
      setInviteLink(`${window.location.origin}/invite?token=${token}`);
    },
  });

  const [newColName, setNewColName] = useState("");
  const [inviteLink, setInviteLink] = useState<string | null>(null);

  function slugify(name: string) {
    return (
      name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "") +
      "-" +
      Math.floor(performance.now()).toString(36)
    );
  }

  return (
    <aside className="sidebar">
      <div className="section">
        <div className="section-title">
          Workspace
          <button
            className="add"
            title="New workspace"
            onClick={() => {
              const name = window.prompt("Workspace name");
              if (name?.trim()) createWorkspace.mutate({ name: name.trim(), slug: slugify(name) });
            }}
          >
            +
          </button>
        </div>
        <select
          className="ws-select"
          value={workspaceId ?? ""}
          onChange={(e) => onSelectWorkspace(e.target.value)}
        >
          {workspaces.map((w) => (
            <option key={w.id} value={w.id}>
              {w.name}
            </option>
          ))}
        </select>
        {workspaceId && (
          <button
            className="invite-btn"
            onClick={() => {
              setInviteLink(null);
              createInvite.mutate({ workspaceId });
            }}
          >
            Invite someone
          </button>
        )}
        {inviteLink && (
          <input
            className="invite-link"
            readOnly
            value={inviteLink}
            onFocus={(e) => e.currentTarget.select()}
          />
        )}
      </div>

      <div className="section">
        <div className="section-title">
          Collections
          <button
            className="add"
            title="New collection"
            onClick={() => {
              if (!workspaceId) return;
              const name = window.prompt("Collection name") ?? "";
              if (name.trim())
                createCollection.mutate({
                  name: name.trim(),
                  slug: slugify(name),
                  workspaceId,
                });
            }}
          >
            +
          </button>
        </div>
        {collections.map((c) => (
          <button
            key={c.id}
            className={"row" + (c.id === collectionId ? " active" : "")}
            onClick={() => onSelectCollection(c.id)}
          >
            {c.name}
          </button>
        ))}
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
            <DocTree nodes={n.children} docId={docId} onSelect={onSelect} depth={depth + 1} />
          )}
        </div>
      ))}
    </>
  );
}
