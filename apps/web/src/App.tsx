import { useEffect, useState } from "react";
import { Sidebar } from "./components/Sidebar.js";
import { Editor } from "./components/Editor.js";
import { trpc } from "./trpc.js";

export function App() {
  const workspaces = trpc.workspaces.mine.useQuery();
  const collections = trpc.collections.list.useQuery();
  const [workspaceId, setWorkspaceId] = useState<string | null>(null);
  const [collectionId, setCollectionId] = useState<string | null>(null);
  const [docId, setDocId] = useState<string | null>(null);

  // Default to the first workspace once loaded.
  useEffect(() => {
    if (!workspaceId && workspaces.data && workspaces.data.length > 0) {
      setWorkspaceId(workspaces.data[0]!.id);
    }
  }, [workspaces.data, workspaceId]);

  const wsCollections = (collections.data ?? []).filter(
    (c) => c.workspaceId === workspaceId,
  );
  const activeCollection = wsCollections.find((c) => c.id === collectionId);

  return (
    <div className="app">
      <Sidebar
        workspaces={workspaces.data ?? []}
        workspaceId={workspaceId}
        collections={wsCollections}
        collectionId={collectionId}
        docId={docId}
        onSelectWorkspace={(id) => {
          setWorkspaceId(id);
          setCollectionId(null);
          setDocId(null);
        }}
        onSelectCollection={(id) => {
          setCollectionId(id);
          setDocId(null);
        }}
        onSelectDoc={setDocId}
      />
      <main className="main">
        {docId ? (
          <Editor
            key={docId}
            docId={docId}
            canEdit={activeCollection?.writable ?? false}
          />
        ) : (
          <div className="empty">Select or create a document.</div>
        )}
      </main>
    </div>
  );
}
