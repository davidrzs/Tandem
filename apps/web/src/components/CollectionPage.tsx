import { useParams } from "react-router-dom";
import { useAppContext } from "../App.js";
import { friendlyError } from "../errors.js";
import { trpc } from "../trpc.js";
import { DocOutline } from "./DocOutline.js";
import { documentCount } from "./outline.js";

/** Stable, ID-addressed landing page for collection links returned by MCP. */
export function CollectionPage() {
  const { collectionId = "" } = useParams();
  const { collections, collectionsLoading } = useAppContext();
  const collection = collections.find((item) => item.id === collectionId);
  const documents = trpc.documents.tree.useQuery(
    { collectionId },
    { enabled: !!collectionId && !!collection },
  );

  if (collectionsLoading) return <div className="empty"><span className="shimmer">Loading collection…</span></div>;
  if (!collection) {
    return (
      <div className="empty">
        This collection does not exist, or you do not have access to it.
      </div>
    );
  }

  const nodes = documents.data ?? [];
  const count = documentCount(nodes);
  return (
    <div className="home collection-page">
      <div className="home-heading">
        <div>
          <span className="eyebrow">Collection</span>
          <h1>{collection.name}</h1>
          <p className="home-sub">
            {collection.description ||
              `${count} document${count === 1 ? "" : "s"} in this collection.`}
          </p>
        </div>
      </div>

      <section className="home-section">
        {documents.error && (
          <div className="error-panel inline">
            <p className="error-detail">
              {friendlyError(documents.error, "Couldn't load this collection.")}
            </p>
            <button type="button" className="btn" onClick={() => void documents.refetch()}>
              Retry
            </button>
          </div>
        )}
        {documents.isLoading && <p className="home-empty"><span className="shimmer">Loading documents…</span></p>}
        {documents.data && (
          <DocOutline key={collection.id} nodes={nodes} collectionId={collection.id} canEdit={collection.writable} />
        )}
      </section>
    </div>
  );
}
