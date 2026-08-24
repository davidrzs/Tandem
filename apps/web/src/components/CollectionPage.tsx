import { Link, useParams } from "react-router-dom";
import { useAppContext } from "../App.js";
import { friendlyError } from "../errors.js";
import { trpc } from "../trpc.js";
import { Icon } from "./Icon.js";
import { timeAgo } from "./time.js";

interface DocumentNode {
  id: string;
  title: string;
  updatedAt: string | Date;
  children: DocumentNode[];
}

function documentCount(nodes: DocumentNode[]): number {
  return nodes.reduce((count, node) => count + 1 + documentCount(node.children), 0);
}

function DocumentLinks({ nodes, depth = 0 }: { nodes: DocumentNode[]; depth?: number }) {
  return (
    <ul className="collection-document-list">
      {nodes.map((node) => (
        <li key={node.id}>
          <Link to={`/d/${node.id}`} style={{ paddingLeft: 14 + depth * 18 }}>
            <Icon name="page" size={14} />
            <span className="document-name">{node.title || "Untitled"}</span>
            <span className="document-when">edited {timeAgo(node.updatedAt)}</span>
          </Link>
          {node.children.length > 0 && <DocumentLinks nodes={node.children} depth={depth + 1} />}
        </li>
      ))}
    </ul>
  );
}

/** Stable, ID-addressed landing page for collection links returned by MCP. */
export function CollectionPage() {
  const { collectionId = "" } = useParams();
  const { collections, collectionsLoading } = useAppContext();
  const collection = collections.find((item) => item.id === collectionId);
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
        {nodes.length > 0 && <DocumentLinks nodes={nodes} />}
      </section>
    </div>
  );
}
