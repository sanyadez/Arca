/** Maintenance: forget (snapshot retention), prune (garbage collection), check (integrity check). */
import { type Repository, packPath } from "./repo";
import { type RetentionPolicy, applyRetention } from "./retention";
import { loadTree } from "./tree";

// ── forget ──

export interface ForgetResult {
  kept: { id: string; reasons: string[] }[];
  removed: string[];
}

export async function forget(
  repo: Repository,
  policy: RetentionPolicy,
  o: { dryRun?: boolean; filter?: (s: import("./repo").Snapshot) => boolean } = {},
): Promise<ForgetResult> {
  const all = (await repo.listSnapshots()).filter((x) => !o.filter || o.filter(x.snapshot));
  const d = applyRetention(all, policy);
  if (!o.dryRun) for (const r of d.remove) await repo.deleteSnapshot(r.id);
  return { kept: d.keep.map((k) => ({ id: k.item.id, reasons: k.reasons })), removed: d.remove.map((r) => r.id) };
}

// ── reachability ──

/** All blobs referenced by snapshots. Throws if a tree is missing: prune would be unsafe then. */
export async function reachableBlobs(repo: Repository): Promise<Set<string>> {
  const used = new Set<string>();
  const walk = async (treeId: string) => {
    if (used.has(treeId)) return;
    used.add(treeId);
    const t = await loadTree(repo, treeId);
    for (const n of t.nodes) {
      if (n.type === "dir" && n.subtree) await walk(n.subtree);
      else if (n.type === "file") for (const id of n.content ?? []) used.add(id);
    }
  };
  for (const { snapshot } of await repo.listSnapshots()) await walk(snapshot.tree);
  return used;
}

// ── prune ──

export interface PruneResult {
  packsDeleted: number;
  packsRepacked: number;
  bytesFreed: number;
  orphanPacks: number;
  dryRun: boolean;
}

/**
 * A pack with no needed blobs is deleted; a pack where needed blobs take less than
 * `repackBelow` (a fraction) of all its blobs is repacked. The new full index is written BEFORE old indexes and packs are deleted,
 * so a failure midway leaves only extra files, not lost data.
 * Call under an exclusive lock.
 */
export async function prune(repo: Repository, o: { dryRun?: boolean; repackBelow?: number } = {}): Promise<PruneResult> {
  const repackBelow = o.repackBelow ?? 0.8;
  await repo.loadIndex();
  const used = await reachableBlobs(repo);

  const packSize = new Map((await repo.backend.list("data")).map((f) => [f.name.split("/").pop()!, f.size]));
  // The garbage fraction is computed from blobs, not file size: otherwise a small pack's header
  // would look like garbage and such a pack would be repacked on every run.
  const usedBytes = new Map<string, number>();
  const unusedBytes = new Map<string, number>();
  const blobsByPack = new Map<string, string[]>();
  for (const [id, e] of repo.entries()) {
    let l = blobsByPack.get(e.pack);
    if (!l) blobsByPack.set(e.pack, (l = []));
    l.push(id);
    const m = used.has(id) ? usedBytes : unusedBytes;
    m.set(e.pack, (m.get(e.pack) ?? 0) + e.len);
  }

  const toDelete = new Set<string>();
  const toRepack = new Set<string>();
  let bytesFreed = 0;
  for (const [pack, size] of packSize) {
    const u = usedBytes.get(pack) ?? 0;
    const waste = unusedBytes.get(pack) ?? 0;
    if (u === 0) {
      toDelete.add(pack);
      bytesFreed += size;
    } else if (u / (u + waste) < repackBelow) {
      toRepack.add(pack);
      toDelete.add(pack);
      bytesFreed += waste;
    }
  }
  const orphanPacks = [...packSize.keys()].filter((p) => !blobsByPack.has(p)).length;
  const result: PruneResult = {
    packsDeleted: toDelete.size - toRepack.size,
    packsRepacked: toRepack.size,
    bytesFreed,
    orphanPacks,
    dryRun: !!o.dryRun,
  };
  if (o.dryRun || (toDelete.size === 0 && repo.indexFileIds().length <= 1)) return result;

  // Repack the needed blobs from half-empty packs.
  for (const pack of toRepack) {
    const need = (blobsByPack.get(pack) ?? []).filter((id) => used.has(id) && repo.lookup(id)?.pack === pack);
    repo.forgetBlobs(need);
    const needSet = new Set(need);
    for await (const b of repo.packBlobs(pack)) if (needSet.has(b.id)) await repo.saveBlob(b.type, b.plain, b.id);
  }
  await repo.flush();

  const { replaced } = await repo.writeFullIndex((id, e) => used.has(id) && !toDelete.has(e.pack));
  for (const ix of replaced) await repo.backend.delete(`index/${ix}`);
  for (const pack of toDelete) await repo.backend.delete(packPath(pack));
  return result;
}

// ── check ──

export interface CheckResult {
  errors: string[];
  warnings: string[];
  snapshots: number;
  packs: number;
  packsRead: number;
  blobs: number;
}

/** readData: fraction of packs (0..1) to download and verify in full. */
export async function check(repo: Repository, o: { readData?: number } = {}): Promise<CheckResult> {
  const r: CheckResult = { errors: [], warnings: [], snapshots: 0, packs: 0, packsRead: 0, blobs: 0 };
  await repo.loadIndex();
  const packSize = new Map((await repo.backend.list("data")).map((f) => [f.name.split("/").pop()!, f.size]));
  r.packs = packSize.size;
  const indexed = new Set<string>();
  for (const [, e] of repo.entries()) {
    r.blobs++;
    indexed.add(e.pack);
  }
  for (const p of indexed) if (!packSize.has(p)) r.errors.push(`Pack ${p} is in the index but missing from the storage`);
  for (const p of packSize.keys()) if (!indexed.has(p)) r.warnings.push(`Pack ${p} is not referenced by the index (prune will remove it)`);

  // Structure: all trees are readable, all data blobs are in the index.
  const seenTrees = new Set<string>();
  const walk = async (treeId: string, where: string) => {
    if (seenTrees.has(treeId)) return;
    seenTrees.add(treeId);
    let t;
    try {
      t = await loadTree(repo, treeId);
    } catch (e: any) {
      r.errors.push(`${where}: tree ${treeId.slice(0, 12)}: ${e.message}`);
      return;
    }
    for (const n of t.nodes) {
      const p = where ? `${where}/${n.name}` : n.name;
      if (n.type === "dir" && n.subtree) await walk(n.subtree, p);
      else if (n.type === "file")
        for (const id of n.content ?? []) {
          const e = repo.lookup(id);
          if (!e) r.errors.push(`${p}: blob ${id.slice(0, 12)} is not in the index`);
          else if (!packSize.has(e.pack)) r.errors.push(`${p}: pack ${e.pack.slice(0, 12)} is missing`);
        }
    }
  };
  for (const { id, snapshot } of await repo.listSnapshots()) {
    r.snapshots++;
    await walk(snapshot.tree, `snapshot ${id.slice(0, 8)}`);
  }

  // Data: download some of the packs and verify every blob.
  const share = o.readData ?? 0;
  if (share > 0) {
    const packs = [...indexed].filter((p) => packSize.has(p));
    const n = share >= 1 ? packs.length : Math.max(1, Math.ceil(packs.length * share));
    for (let i = packs.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [packs[i], packs[j]] = [packs[j]!, packs[i]!];
    }
    for (const p of packs.slice(0, n)) {
      try {
        const rows = await repo.verifyPack(p);
        for (const [bid, , off, len] of rows) {
          const e = repo.lookup(bid);
          if (e && e.pack === p && (e.off !== off || e.len !== len)) r.errors.push(`Pack ${p.slice(0, 12)}: index disagrees with the header for ${bid.slice(0, 12)}`);
        }
      } catch (e: any) {
        r.errors.push(e.message);
      }
      r.packsRead++;
    }
  }
  return r;
}
