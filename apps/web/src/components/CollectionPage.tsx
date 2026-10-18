import { useParams } from "react-router-dom";
import { useAppContext } from "../App.js";
import { friendlyError } from "../errors.js";
import { trpc } from "../trpc.js";
import { DocOutline, documentCount } from "./DocOutline.js";
import { Icon } from "./Icon.js";
import { useToast } from "./toast.js";
import { useCreateDocument } from "./useCreateDocument.js";

/** Stable, ID-addressed landing page for collection links returned by MCP. */
export function CollectionPage() {
  const { collectionId = "" } = useParams();
  const { collections, collectionsLoading } = useAppContext();
  const collection = collections.find((item) => item.id === collectionId);
  const createDocument = useCreateDocument();
  const toast = useToast();
  const documents = trpc.documents.tree.useQuery(
    { collectionId },
    { enabled: !!collectionId && !!collection },
  );

  if (collectionsLoading) return <div className="empty">Loading collection…</div>;
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
        {collection.writable && (
          <button
            type="button"
            className="btn primary"
            onClick={() =>
              void createDocument(collection.id).catch((e) => toast(friendlyError(e), "danger"))
            }
          >
            <Icon name="plus" size={14} /> New document
          </button>
        )}
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
        {documents.isLoading && <p className="home-empty">Loading documents…</p>}
        {!documents.isLoading && !documents.error && nodes.length === 0 && (
          <p className="home-empty">This collection has no documents yet.</p>
        )}
        {nodes.length > 0 && <DocOutline nodes={nodes} />}
      </section>
    </div>
  );
}
