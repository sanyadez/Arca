/** Restore a snapshot (or part of it) into a new directory. Never writes over existing files. */
import { chmod, lchown, lutimes, mkdir, open, readdir, stat, symlink, utimes } from "node:fs/promises";
import { join, posix, resolve } from "node:path";
import type { Repository } from "./repo";
import { type TreeNode, checkName, findNode, loadTree, splitPath } from "./tree";

export interface RestoreOptions {
  /** Path inside the snapshot; empty means the whole snapshot. */
  path?: string;
  /**
   * Several paths inside the snapshot. They are restored relative to their common parent:
   * items of one folder land directly in the target, items of different folders keep the
   * part of their path below the common parent.
   */
  paths?: string[];
  /** Read every restored file back and check its chunks against the snapshot. */
  verify?: boolean;
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
  /** Files read back and found identical (with `verify`). */
  verified: number;
  errors: { path: string; error: string }[];
}

export async function restore(repo: Repository, rootTree: string, target: string, o: RestoreOptions = {}): Promise<RestoreResult> {
  target = resolve(target);
  const s = await stat(target).catch(() => null);
  if (s && !s.isDirectory()) throw new Error(`Target exists and is not a directory: ${target}`);
  if (s && (await readdir(target)).length > 0) throw new Error(`Target directory is not empty: ${target}`);
  await mkdir(target, { recursive: true });

  const owners = o.owners ?? process.getuid?.() === 0;
  const res: RestoreResult = { target, files: 0, dirs: 0, bytes: 0, verified: 0, errors: [] };

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
    if (o.verify) {
      // Chunking the restored file again must give exactly the chunk ids of the snapshot.
      const ids: string[] = [];
      const rf = await open(abs, "r");
      try {
        for await (const chunk of repo.chunker.chunksOfFile(rf)) ids.push(repo.blobId(chunk));
      } finally {
        await rf.close();
      }
      const want = n.content ?? [];
      if (ids.length !== want.length || ids.some((x, i) => x !== want[i])) throw new Error("verification failed: the restored file differs from the snapshot");
      res.verified++;
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

  const paths = (o.paths ?? (o.path ? [o.path] : [])).map((p) => splitPath(p).join("/")).filter(Boolean);
  if (paths.length === 0) {
    await restoreChildren(target, rootTree, "");
    return res;
  }
  // The deepest folder that contains all selected paths.
  let common = posix.dirname(paths[0]!);
  for (const p of paths) while (common !== "." && !(p + "/").startsWith(common + "/")) common = posix.dirname(common);
  for (const p of paths) {
    o.signal?.throwIfAborted();
    const n = await findNode(repo, rootTree, p);
    const below = common === "." ? p : p.slice(common.length + 1);
    const dir = posix.dirname(below);
    const dirAbs = dir === "." ? target : join(target, ...dir.split("/").map(checkName));
    await mkdir(dirAbs, { recursive: true });
    await restoreNode(dirAbs, n, p);
  }
  return res;
}
