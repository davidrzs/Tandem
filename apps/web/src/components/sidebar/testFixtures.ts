import { buildSidebarIndex, type IndexInput, type Loaded } from "./sidebarIndex.js";
import type { Collection, DocNode } from "./types.js";

export const collection = (id: string, position: number, writable = true): Collection => ({
  id,
  name: id.toUpperCase(),
  workspaceId: "w",
  defaultRole: "editor",
  writable,
  position,
});

export const doc = (id: string, position: number, children: DocNode[] = []): DocNode => ({
  id,
  title: id,
  position,
  children,
});

export const ready = <T>(data: T): Loaded<T> => ({ status: "success", data });

/** Collections a (expanded) and b (collapsed). a holds
 *   p (1) > [c1 (1) > [g (1)], c2 (2)]
 *   q (2)
 * plus one archived and one trashed doc. */
export function sampleInput(): IndexInput {
  return {
    collections: [collection("a", 1), collection("b", 2), collection("r", 3, false)],
    trees: new Map([
      ["a", ready([doc("p", 1, [doc("c1", 1, [doc("g", 1)]), doc("c2", 2)]), doc("q", 2)])],
    ]),
    archived: new Map([["a", ready([{ id: "x", title: "Old" }])]]),
    trash: new Map([["a", ready([{ id: "t", title: "" }])]]),
  };
}

export const sampleIndex = () => buildSidebarIndex(sampleInput());
