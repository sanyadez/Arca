/** Snapshot trees: a directory is a tree blob with a list of nodes sorted by name. */
import type { Repository } from "./repo";

export type NodeType = "file" | "dir" | "symlink";

export interface TreeNode {
  name: string;
  type: NodeType;
  mode: number; // permission bits only (0o7777)
  uid: number;
  gid: number;
  mtime: number; // ms
  size?: number; // files
  inode?: number; // files: for incremental comparison with the parent snapshot
  content?: string[]; // files: data blob ids in order
  subtree?: string; // directories
  target?: string; // symlinks
}

export interface Tree {
  nodes: TreeNode[];
}

/** A node name from a foreign (possibly forged) repository must not escape the directory. */
export function checkName(name: string): string {
  if (!name || name === "." || name === ".." || name.includes("/") || name.includes("\0"))
    throw new Error(`Invalid name in snapshot: ${JSON.stringify(name)}`);
  return name;
}

export async function loadTree(repo: Repository, id: string): Promise<Tree> {
  const t: Tree = JSON.parse(new TextDecoder().decode(await repo.loadBlob(id)));
  for (const n of t.nodes) checkName(n.name);
  return t;
}

export function encodeTree(t: Tree): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(t));
}

/** Split a path inside a snapshot into segments ("" or "/" is the root). */
export function splitPath(p: string): string[] {
  return p.split("/").filter((s) => s !== "" && s !== ".");
}

/**
 * Find a node by path. For the root returns a synthetic directory node with subtree = rootTree.
 */
export async function findNode(repo: Repository, rootTree: string, path: string): Promise<TreeNode> {
  let node: TreeNode = { name: "", type: "dir", mode: 0o755, uid: 0, gid: 0, mtime: 0, subtree: rootTree };
  for (const seg of splitPath(path)) {
    if (node.type !== "dir" || !node.subtree) throw new Error(`Not a directory: ${path}`);
    const t = await loadTree(repo, node.subtree);
    const next = t.nodes.find((n) => n.name === seg);
    if (!next) throw new Error(`Not in snapshot: ${path}`);
    node = next;
  }
  return node;
}

export interface ListedNode extends TreeNode {
  path: string;
}

/** Walk the tree from a node; recursive=false lists only the directory's immediate contents. */
export async function* walkTree(
  repo: Repository,
  rootTree: string,
  path = "",
  recursive = false,
): AsyncGenerator<ListedNode> {
  const start = await findNode(repo, rootTree, path);
  const base = splitPath(path).join("/");
  if (start.type !== "dir") {
    yield { ...start, path: base };
    return;
  }
  async function* go(treeId: string, prefix: string): AsyncGenerator<ListedNode> {
    const t = await loadTree(repo, treeId);
    for (const n of t.nodes) {
      const p = prefix ? `${prefix}/${n.name}` : n.name;
      yield { ...n, path: p };
      if (recursive && n.type === "dir" && n.subtree) yield* go(n.subtree, p);
    }
  }
  yield* go(start.subtree!, base);
}
