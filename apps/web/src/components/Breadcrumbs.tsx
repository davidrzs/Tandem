import { Link as RouterLink } from "react-router-dom";
import { useAppContext } from "../App.js";
import { trpc } from "../trpc.js";

interface TreeNode {
  id: string;
  title: string;
  children: TreeNode[];
}

/** Ancestor chain of `id` within the tree (empty for a root document). */
function pathTo(nodes: TreeNode[], id: string, trail: TreeNode[]): TreeNode[] | null {
  for (const n of nodes) {
    if (n.id === id) return trail;
    const found = pathTo(n.children ?? [], id, [...trail, n]);
    if (found) return found;
  }
  return null;
}

/** "Collection › Parent › Grandparent" above a document's title. The current
 * document itself isn't repeated — its title sits right below. */
export function Breadcrumbs({ docId, collectionId }: { docId: string; collectionId: string }) {
  const { collections } = useAppContext();
  const tree = trpc.documents.tree.useQuery({ collectionId });
  const collection = collections.find((c) => c.id === collectionId);
  const ancestors = tree.data ? (pathTo(tree.data as TreeNode[], docId, []) ?? []) : [];
  if (!collection) return null;
  return (
    <nav className="breadcrumbs" aria-label="Location">
      <span className="crumb crumb-collection">{collection.name}</span>
      {ancestors.map((a) => (
        <span key={a.id} className="crumb-wrap">
          <span className="crumb-sep" aria-hidden>
            ›
          </span>
          <RouterLink className="crumb" to={`/d/${a.id}`}>
            {a.title || "Untitled"}
          </RouterLink>
        </span>
      ))}
    </nav>
  );
}
