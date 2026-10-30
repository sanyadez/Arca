/** Restore a snapshot (or part of it) into a new directory. Never writes over existing files. */
import { chmod, lchown, lutimes, mkdir, open, readdir, stat, symlink, utimes } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { Repository } from "./repo";
import { type TreeNode, checkName, findNode, loadTree, splitPath } from "./tree";

export interface RestoreOptions {
  /** Path inside the snapshot; empty means the whole snapshot. */
  path?: string;
  /** Restore ownership (uid/gid). By default only when running as root. */
  owners?: boolean;
  signal?: AbortSignal;
  onProgress?: (p: { files: number; bytes: number; path: string }) => void;
}

export interface RestoreResult {
  target: string;
  files: number;
  dirs: number;
  bytes: number;
  errors: { path: string; error: string }[];
}

export async function restore(repo: Repository, rootTree: string, target: string, o: RestoreOptions = {}): Promise<RestoreResult> {
  target = resolve(target);
  const s = await stat(target).catch(() => null);
  if (s && !s.isDirectory()) throw new Error(`Target exists and is not a directory: ${target}`);
  if (s && (await readdir(target)).length > 0) throw new Error(`Target directory is not empty: ${target}`);
  await mkdir(target, { recursive: true });

  const owners = o.owners ?? process.getuid?.() === 0;
  const res: RestoreResult = { target, files: 0, dirs: 0, bytes: 0, errors: [] };

  const meta = async (abs: string, n: TreeNode) => {
    if (owners) await lchown(abs, n.uid, n.gid).catch(() => {});
    if (n.type === "symlink") {
      await lutimes(abs, n.mtime / 1000, n.mtime / 1000).catch(() => {});
      return;
    }
    await chmod(abs, n.mode);
    await utimes(abs, n.mtime / 1000, n.mtime / 1000);
  };

  const writeFile = async (abs: string, n: TreeNode, rel: string) => {
    const fh = await open(abs, "wx", 0o600);
    try {
      for (const id of n.content ?? []) {
        o.signal?.throwIfAborted();
        const data = await repo.loadBlob(id);
        await fh.write(data);
        res.bytes += data.length;
      }
    } finally {
      await fh.close();
    }
    res.files++;
    o.onProgress?.({ files: res.files, bytes: res.bytes, path: rel });
  };

  const restoreNode = async (dirAbs: string, n: TreeNode, rel: string) => {
    const abs = join(dirAbs, checkName(n.name));
    try {
      if (n.type === "dir") {
        await mkdir(abs);
        res.dirs++;
        await restoreChildren(abs, n.subtree!, rel);
      } else if (n.type === "file") {
        await writeFile(abs, n, rel);
      } else if (n.type === "symlink") {
        await symlink(n.target!, abs);
      }
      await meta(abs, n);
    } catch (e: any) {
      if (e?.name === "AbortError") throw e;
      res.errors.push({ path: rel, error: e?.message ?? String(e) });
    }
  };

  const restoreChildren = async (dirAbs: string, treeId: string, rel: string) => {
    const t = await loadTree(repo, treeId);
    for (const n of t.nodes) await restoreNode(dirAbs, n, rel ? `${rel}/${n.name}` : n.name);
  };

  const segs = splitPath(o.path ?? "");
  if (segs.length === 0) {
    await restoreChildren(target, rootTree, "");
  } else {
    const n = await findNode(repo, rootTree, o.path!);
    await restoreNode(target, n, segs.join("/"));
  }
  return res;
}
