/**
 * Comparing a snapshot with its parent and finding files in snapshots. Trees are content-addressed,
 * so a subtree with the same id as in the parent is unchanged and is never opened: the work grows
 * with the size of the change, not with the size of the snapshot.
 */
import type { Repository, Snapshot } from "./repo";
import { type TreeNode, loadTree } from "./tree";

export type Change = "new" | "changed" | null;

export interface DiffEntry {
  change: Change;
  /** For directories: bytes of new and changed files below. */
  added?: number;
}

const sameContent = (a?: string[], b?: string[]) => !!a && !!b && a.length === b.length && a.every((x, i) => x === b[i]);

function nodeChange(n: TreeNode, p: TreeNode | undefined): Change {
  if (!p || p.type !== n.type) return "new";
  if (n.type === "file") return sameContent(n.content, p.content) ? null : "changed";
  if (n.type === "symlink") return n.target === p.target ? null : "changed";
  return n.subtree === p.subtree ? null : "changed";
}

export class Differ {
  private memo = new Map<string, number>();
  constructor(private repo: Repository) {}

  /** Bytes of new and changed files in tree `a` compared with tree `b` (b may be missing). */
  async added(a: string, b: string | undefined): Promise<number> {
    if (a === b) return 0;
    const key = `${a}:${b ?? ""}`;
    const hit = this.memo.get(key);
    if (hit !== undefined) return hit;
    const [ta, tb] = await Promise.all([loadTree(this.repo, a), b ? loadTree(this.repo, b) : null]);
    const prev = new Map((tb?.nodes ?? []).map((n) => [n.name, n]));
    let sum = 0;
    for (const n of ta.nodes) {
      const p = prev.get(n.name);
      if (n.type === "file" && nodeChange(n, p)) sum += n.size ?? 0;
      else if (n.type === "dir" && n.subtree) sum += await this.added(n.subtree, p?.type === "dir" ? p.subtree : undefined);
    }
    this.memo.set(key, sum);
    return sum;
  }

  /** Change marks for the entries of one directory. */
  async dir(treeId: string, prevTreeId: string | undefined): Promise<Map<string, DiffEntry>> {
    const [t, tp] = await Promise.all([loadTree(this.repo, treeId), prevTreeId ? loadTree(this.repo, prevTreeId) : null]);
    const prev = new Map((tp?.nodes ?? []).map((n) => [n.name, n]));
    const out = new Map<string, DiffEntry>();
    for (const n of t.nodes) {
      const p = prev.get(n.name);
      const e: DiffEntry = { change: nodeChange(n, p) };
      if (n.type === "dir" && n.subtree) e.added = await this.added(n.subtree, p?.type === "dir" ? p.subtree : undefined);
      out.set(n.name, e);
    }
    return out;
  }
}

export interface SearchHit {
  snapshot: string;
  time: string;
  source: string;
  path: string;
  type: TreeNode["type"];
  size?: number;
  mtime: number;
  /** How many other searched snapshots hold the same entry unchanged. */
  alsoIn: number;
}

/**
 * Find entries whose name contains `query` (case-insensitive), newest snapshots first.
 * A subtree already searched in a newer snapshot is skipped: its hits are reported once,
 * with `alsoIn` counting the older snapshots that share them.
 */
export async function searchSnapshots(
  repo: Repository,
  snaps: { id: string; snapshot: Snapshot }[],
  query: string,
  limit = 200,
  signal?: AbortSignal,
): Promise<{ hits: SearchHit[]; truncated: boolean }> {
  const q = query.toLowerCase();
  const hits: SearchHit[] = [];
  const seen = new Map<string, SearchHit[]>(); // tree id → hits found under it
  let truncated = false;
  const ordered = [...snaps].sort((a, b) => b.snapshot.time.localeCompare(a.snapshot.time));
  const walk = async (snap: { id: string; snapshot: Snapshot }, treeId: string, prefix: string): Promise<SearchHit[]> => {
    signal?.throwIfAborted();
    const known = seen.get(treeId);
    if (known) {
      for (const h of known) h.alsoIn++;
      return known;
    }
    const found: SearchHit[] = [];
    const t = await loadTree(repo, treeId);
    for (const n of t.nodes) {
      if (hits.length >= limit) {
        truncated = true;
        break;
      }
      const path = prefix ? `${prefix}/${n.name}` : n.name;
      if (n.name.toLowerCase().includes(q)) {
        const h: SearchHit = { snapshot: snap.id, time: snap.snapshot.time, source: snap.snapshot.source, path, type: n.type, size: n.size, mtime: n.mtime, alsoIn: 0 };
        hits.push(h);
        found.push(h);
      }
      if (n.type === "dir" && n.subtree) found.push(...(await walk(snap, n.subtree, path)));
    }
    if (!truncated) seen.set(treeId, found);
    return found;
  };
  for (const s of ordered) {
    if (hits.length >= limit) {
      truncated = true;
      break;
    }
    await walk(s, s.snapshot.tree, "");
  }
  return { hits, truncated };
}
