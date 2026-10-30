/**
 * Snapshot of a source (directory, SSH…) in three passes:
 *  1) state of all files from the source and comparison with the parent snapshot (size+mtime+inode);
 *  2) content of only the changed files, as one stream from the source: chunking, deduplication;
 *  3) directory trees, bottom up.
 */
import { hostname } from "node:os";
import { basename, posix } from "node:path";
import type { Repository, Snapshot, SnapshotStats } from "./repo";
import { type Tree, type TreeNode, encodeTree, loadTree } from "./tree";
import { LocalSource, type Source } from "./source";

export interface BackupOptions {
  /** What to back up: a source or a local directory path (the old root parameter, same thing). */
  from?: Source;
  root?: string;
  /** Source name; defaults to the source path/address. The parent snapshot is looked up by it. */
  source?: string;
  exclude?: string[];
  /** Parent snapshot id; "auto" (default) is the latest one with the same source and host; null means none. */
  parent?: string | null;
  tags?: string[];
  owner?: string;
  host?: string;
  signal?: AbortSignal;
  onProgress?: (p: { files: number; bytes: number; path: string }) => void;
}

export interface BackupError {
  path: string;
  error: string;
}

export interface BackupResult {
  id: string;
  snapshot: Snapshot;
  errors: BackupError[];
}

/** Exclude patterns: match the relative path or the name. `dir/` matches directories only. */
export class Excluder {
  private rules: { glob: InstanceType<typeof Bun.Glob>; dirOnly: boolean; anchored: boolean }[];
  constructor(patterns: string[] = []) {
    this.rules = patterns
      .map((p) => p.trim())
      .filter((p) => p && !p.startsWith("#"))
      .map((p) => {
        const dirOnly = p.endsWith("/");
        if (dirOnly) p = p.slice(0, -1);
        const anchored = p.startsWith("/") || p.includes("/");
        if (p.startsWith("/")) p = p.slice(1);
        return { glob: new Bun.Glob(p), dirOnly, anchored };
      });
  }
  excluded(rel: string, isDir: boolean): boolean {
    const name = basename(rel);
    for (const r of this.rules) {
      if (r.dirOnly && !isDir) continue;
      if (r.anchored ? r.glob.match(rel) : r.glob.match(name)) return true;
    }
    return false;
  }
}

export async function backup(repo: Repository, o: BackupOptions): Promise<BackupResult> {
  const t0 = performance.now();
  const src = o.from ?? (o.root !== undefined ? new LocalSource(o.root) : undefined);
  if (!src) throw new Error("Nothing to back up was specified");
  const host = o.host ?? src.host ?? hostname();
  const source = o.source ?? src.label;

  let parentId: string | undefined;
  let parentTree: string | undefined;
  if (o.parent !== null) {
    const snaps = await repo.listSnapshots();
    const p =
      o.parent && o.parent !== "auto"
        ? snaps.find((s) => s.id.startsWith(o.parent!))
        : snaps.filter((s) => s.snapshot.source === source && s.snapshot.host === host).at(-1);
    if (o.parent && o.parent !== "auto" && !p) throw new Error(`Parent snapshot ${o.parent} not found`);
    parentId = p?.id;
    parentTree = p?.snapshot.tree;
  }

  const ex = new Excluder(o.exclude);
  const stats: SnapshotStats = { files: 0, dirs: 0, bytes: 0, newBlobs: 0, newBytes: 0, errors: 0, seconds: 0 };

  // ── 1. state ──
  const listed = await src.list((rel) => ex.excluded(rel, true));
  const errors: BackupError[] = [...listed.errors];
  o.signal?.throwIfAborted();

  /** Nodes of each directory ("" is the root); directories missing here are excluded. */
  const dirs = new Map<string, TreeNode[]>([["", []]]);
  const subdirs = new Map<string, string[]>([["", []]]);
  const nodeOf = new Map<string, TreeNode>();
  for (const e of listed.entries) {
    const parent = posix.dirname(e.path) === "." ? "" : posix.dirname(e.path);
    const siblings = dirs.get(parent);
    if (!siblings) continue; // an ancestor is excluded
    if (ex.excluded(e.path, e.type === "dir")) continue;
    const node: TreeNode = { name: basename(e.path), type: e.type, mode: e.mode, uid: e.uid, gid: e.gid, mtime: e.mtime };
    if (e.type === "file") Object.assign(node, { size: e.size, inode: e.ino });
    if (e.type === "symlink") node.target = e.target;
    if (e.type === "dir") {
      dirs.set(e.path, []);
      subdirs.set(e.path, []);
      subdirs.get(parent)!.push(e.path);
    }
    siblings.push(node);
    nodeOf.set(e.path, node);
  }

  // Compare with the parent: what can be reused as is and what must be read.
  const toRead: string[] = [];
  const compare = async (dir: string, prevTreeId: string | undefined) => {
    let prev = new Map<string, TreeNode>();
    if (prevTreeId) {
      try {
        prev = new Map((await loadTree(repo, prevTreeId)).nodes.map((n) => [n.name, n]));
      } catch {
        // Parent tree is corrupted: just read everything again.
      }
    }
    for (const n of dirs.get(dir)!) {
      const p = prev.get(n.name);
      const rel = dir ? `${dir}/${n.name}` : n.name;
      if (n.type === "dir") await compare(rel, p?.type === "dir" ? p.subtree : undefined);
      else if (n.type === "file") {
        if (
          p?.type === "file" &&
          p.size === n.size &&
          p.mtime === n.mtime &&
          p.inode === n.inode &&
          p.content!.every((id) => repo.has(id))
        ) {
          n.content = p.content;
          stats.files++;
          stats.bytes += n.size!;
        } else toRead.push(rel);
      }
    }
  };
  await compare("", parentTree);

  // ── 2. content of changed files ──
  const failed = new Set<string>();
  for await (const item of src.read(toRead)) {
    o.signal?.throwIfAborted();
    const node = nodeOf.get(item.path)!;
    if (!item.reader) {
      errors.push({ path: item.path, error: item.error ?? "not read" });
      failed.add(item.path);
      continue;
    }
    const content: string[] = [];
    let size = 0;
    try {
      for await (const chunk of repo.chunker.chunksOfReader(item.reader)) {
        o.signal?.throwIfAborted();
        const { id, added } = await repo.saveBlob("data", chunk);
        if (added) {
          stats.newBlobs++;
          stats.newBytes += chunk.length;
        }
        content.push(id);
        size += chunk.length;
      }
    } catch (e: any) {
      if (e?.name === "AbortError") throw e;
      errors.push({ path: item.path, error: e?.message ?? String(e) });
      failed.add(item.path);
      continue;
    }
    node.content = content;
    node.size = size; // what was actually read (the file may have changed between passes)
    stats.files++;
    stats.bytes += size;
    o.onProgress?.({ files: stats.files, bytes: stats.bytes, path: item.path });
  }

  // ── 3. trees, bottom up ──
  const saveDir = async (dir: string): Promise<string> => {
    stats.dirs++;
    const subtrees = new Map<string, string>();
    for (const d of subdirs.get(dir)!) subtrees.set(d, await saveDir(d));
    const nodes: TreeNode[] = [];
    for (const n of dirs.get(dir)!) {
      const rel = dir ? `${dir}/${n.name}` : n.name;
      if (n.type === "file" && (failed.has(rel) || !n.content)) continue;
      if (n.type === "dir") n.subtree = subtrees.get(rel);
      nodes.push(n);
    }
    nodes.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    const { id } = await repo.saveBlob("tree", encodeTree({ nodes } satisfies Tree));
    return id;
  };
  const tree = await saveDir("");

  stats.errors = errors.length;
  stats.seconds = Math.round((performance.now() - t0) / 100) / 10;
  const snapshot: Snapshot = {
    v: 1,
    time: new Date().toISOString(),
    host,
    source,
    root: src.label,
    tree,
    parent: parentId,
    tags: o.tags ?? [],
    owner: o.owner ?? "default",
    stats,
  };
  const id = await repo.saveSnapshot(snapshot);
  return { id, snapshot, errors };
}
