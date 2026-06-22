import { useEffect, useState } from "react";
import { Sidebar } from "./components/Sidebar.js";
import { Editor } from "./components/Editor.js";
import { trpc } from "./trpc.js";

export function App() {
  const collections = trpc.collections.list.useQuery();
  const [collectionId, setCollectionId] = useState<string | null>(null);
  const [docId, setDocId] = useState<string | null>(null);

  // Auto-select the first collection once loaded.
  useEffect(() => {
    if (!collectionId && collections.data && collections.data.length > 0) {
      setCollectionId(collections.data[0]!.id);
    }
  }, [collections.data, collectionId]);

  return (
    <div className="app">
      <Sidebar
        collections={collections.data ?? []}
        collectionId={collectionId}
        docId={docId}
        onSelectCollection={(id) => {
          setCollectionId(id);
          setDocId(null);
        }}
        onSelectDoc={setDocId}
      />
      <main className="main">
        {docId ? (
          <Editor key={docId} docId={docId} />
        ) : (
          <div className="empty">Select or create a document.</div>
        )}
      </main>
    </div>
  );
}
