import { afterAll, describe, expect, test } from "bun:test";
import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { backup } from "../src/core/backup";
import { check, forget, prune } from "../src/core/maintenance";
import { applyRetention } from "../src/core/retention";
import { Lock, withLock } from "../src/core/lock";
import { restore } from "../src/core/restore";
import { Repository, type Snapshot } from "../src/core/repo";
import { LocalBackend } from "../src/backends/local";
import { cleanup, makeTree, newRepo, prng, tmp } from "./helpers";

afterAll(cleanup);

const snap = (time: string, source = "s"): { id: string; snapshot: Snapshot } => ({
  id: time,
  snapshot: { v: 1, time, host: "h", source, root: "/", tree: "", tags: [], owner: "default" },
});

describe("retention", () => {
  test("last + daily + monthly", () => {
    const items = [
      snap("2026-10-29T20:00:00Z"),
      snap("2026-10-29T10:00:00Z"),
      snap("2026-10-28T10:00:00Z"),
      snap("2026-10-27T10:00:00Z"),
      snap("2026-09-15T10:00:00Z"),
      snap("2026-08-15T10:00:00Z"),
    ];
    const d = applyRetention(items, { last: 1, daily: 2, monthly: 2 });
    const kept = d.keep.map((k) => k.item.id).sort();
    expect(kept).toEqual(["2026-09-15T10:00:00Z", "2026-10-28T10:00:00Z", "2026-10-29T20:00:00Z"]);
    expect(d.remove.map((r) => r.id).sort()).toEqual(["2026-08-15T10:00:00Z", "2026-10-27T10:00:00Z", "2026-10-29T10:00:00Z"]);
  });

  test("groups by source are independent, an empty policy is rejected", () => {
    const d = applyRetention([snap("2026-10-01T00:00:00Z", "a"), snap("2026-10-02T00:00:00Z", "b")], { last: 1 });
    expect(d.remove).toEqual([]);
    expect(() => applyRetention([], {})).toThrow();
  });
});

describe("locks", () => {
  test("an exclusive lock blocks others, shared ones are compatible", async () => {
    const { repo } = await newRepo();
    const a = await Lock.acquire(repo, false, "backup");
    const b = await Lock.acquire(repo, false, "check");
    await expect(Lock.acquire(repo, true, "prune")).rejects.toThrow("busy");
    await a.release();
    await b.release();
    await withLock(repo, true, "prune", async () => {
      await expect(Lock.acquire(repo, false, "backup")).rejects.toThrow("prune");
    });
    expect(await repo.backend.list("locks")).toEqual([]);
  });
});

describe("forget + prune + check", () => {
  test("removed data is freed, the rest restores, check is clean", async () => {
    const { repo, dir } = await newRepo();
    const src = await tmp();
    await makeTree(src);
    const r1 = await backup(repo, { root: src });
    // A large unique file only in the first snapshot.
    await writeFile(join(src, "only-first.bin"), prng(42)(400_000));
    const r2 = await backup(repo, { root: src });
    await rm(join(src, "only-first.bin"));
    await writeFile(join(src, "hello.txt"), "changed\n");
    const r3 = await backup(repo, { root: src });

    const sizeBefore = (await repo.backend.list("data")).reduce((a, f) => a + f.size, 0);
    const f = await forget(repo, { last: 1 });
    expect(f.removed.sort()).toEqual([r1.id, r2.id].sort());
    const p = await prune(repo, { repackBelow: 0.8 });
    expect(p.bytesFreed).toBeGreaterThan(350_000);
    const sizeAfter = (await repo.backend.list("data")).reduce((a, x) => a + x.size, 0);
    expect(sizeBefore - sizeAfter).toBeGreaterThan(350_000);
    expect((await repo.backend.list("index")).length).toBe(1);
    // A repeated prune does nothing.
    const again = await prune(repo);
    expect([again.packsDeleted, again.packsRepacked, again.bytesFreed]).toEqual([0, 0, 0]);

    const fresh = await Repository.open(new LocalBackend(dir), "test-pass");
    const c = await check(fresh, { readData: 1 });
    expect(c.errors).toEqual([]);
    expect(c.warnings).toEqual([]);
    expect(c.snapshots).toBe(1);
    expect(c.packsRead).toBe(c.packs);

    const out = join(await tmp(), "r");
    const res = await restore(fresh, r3.snapshot.tree, out);
    expect(res.errors).toEqual([]);
    expect(await readFile(join(out, "hello.txt"), "utf8")).toBe("changed\n");
    expect(Buffer.compare(await readFile(join(out, "big.bin")), await readFile(join(src, "big.bin")))).toBe(0);
  });

  test("check finds a corrupted pack", async () => {
    const { repo, dir } = await newRepo();
    const src = await tmp();
    await makeTree(src);
    await backup(repo, { root: src });
    const [first] = await repo.backend.list("data");
    const path = join(dir, first!.name);
    const buf = await readFile(path);
    buf[100]! ^= 0xff;
    await writeFile(path, buf);
    const c = await check(await Repository.open(new LocalBackend(dir), "test-pass"), { readData: 1 });
    expect(c.errors.length).toBeGreaterThan(0);
  });

  test("check finds a missing pack", async () => {
    const { repo, dir } = await newRepo();
    const src = await tmp();
    await makeTree(src);
    await backup(repo, { root: src });
    const [first] = await repo.backend.list("data");
    await rm(join(dir, first!.name));
    const c = await check(await Repository.open(new LocalBackend(dir), "test-pass"));
    expect(c.errors.some((e) => e.includes("missing"))).toBe(true);
  });
});
