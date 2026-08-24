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

/** "Collection / Parent / Grandparent / Current" in the document header bar.
 * The current title is the last, non-link crumb so the bar reads as a full
 * location even when the title itself has scrolled out of view. */
export function Breadcrumbs({
  docId,
  collectionId,
  currentTitle,
}: {
  docId: string;
  collectionId: string;
  currentTitle?: string;
}) {
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
            /
          </span>
          <RouterLink className="crumb" to={`/d/${a.id}`}>
            {a.title || "Untitled"}
          </RouterLink>
        </span>
      ))}
      {currentTitle !== undefined && (
        <span className="crumb-wrap crumb-current-wrap">
          <span className="crumb-sep" aria-hidden>
            /
          </span>
          <span className="crumb crumb-current">{currentTitle || "Untitled"}</span>
        </span>
      )}
    </nav>
  );
}
