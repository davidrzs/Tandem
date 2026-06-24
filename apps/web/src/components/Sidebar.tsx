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
  defaultRole: string;
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

  // Use mutateAsync + await so the follow-up (invalidate/select) can't be
  // dropped by StrictMode's per-call-callback teardown.
  const createWorkspace = trpc.workspaces.create.useMutation();
  const createCollection = trpc.collections.create.useMutation();
  const createDoc = trpc.documents.create.useMutation();
  const createInvite = trpc.workspaces.createInvite.useMutation();
  const setDefaultRole = trpc.collections.setDefaultRole.useMutation({
    onSuccess: () => utils.collections.list.invalidate(),
  });

  const selectedCol = collections.find((c) => c.id === collectionId);
  const [inviteLink, setInviteLink] = useState<string | null>(null);

  async function newWorkspace() {
    const name = window.prompt("Workspace name")?.trim();
    if (!name) return;
    const ws = await createWorkspace.mutateAsync({ name, slug: slugify(name) });
    await utils.workspaces.mine.invalidate();
    onSelectWorkspace(ws.id);
  }
  async function newCollection() {
    const name = window.prompt("Collection name")?.trim();
    if (!name) return;
    // workspaceId is optional — the server resolves the user's workspace if the
    // active one isn't set yet (avoids a silent no-op on a startup race).
    await createCollection.mutateAsync({
      name,
      slug: slugify(name),
      ...(workspaceId ? { workspaceId } : {}),
    });
    await utils.collections.list.invalidate();
  }
  async function newDoc() {
    if (!collectionId) return;
    const doc = await createDoc.mutateAsync({ collectionId, title: "Untitled" });
    await utils.documents.tree.invalidate({ collectionId });
    if (doc) onSelectDoc(doc.id);
  }
  async function invite() {
    if (!workspaceId) return;
    setInviteLink(null);
    const { token } = await createInvite.mutateAsync({ workspaceId });
    setInviteLink(`${window.location.origin}/invite?token=${token}`);
  }

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
          <button className="add" title="New workspace" onClick={newWorkspace}>
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
          <button className="invite-btn" onClick={invite}>
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
          <button className="add" title="New collection" onClick={newCollection}>
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
            <button className="add" onClick={newDoc}>
              +
            </button>
          </div>
          {selectedCol && (
            <select
              className="access-select"
              value={selectedCol.defaultRole}
              title="Who in the workspace can access this collection"
              onChange={(e) =>
                setDefaultRole.mutate({
                  id: selectedCol.id,
                  role: e.target.value as "none" | "read" | "read_write",
                })
              }
            >
              <option value="read_write">Members can edit</option>
              <option value="read">Members can view</option>
              <option value="none">Private (invited only)</option>
            </select>
          )}
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
