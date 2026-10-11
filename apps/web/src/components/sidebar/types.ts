export interface Workspace {
  id: string;
  name: string;
}
export interface Collection {
  id: string;
  name: string;
  workspaceId: string;
  defaultRole: string;
  writable: boolean;
  position: number;
}
export interface DocNode {
  id: string;
  title: string;
  position: number;
  children: DocNode[];
}
