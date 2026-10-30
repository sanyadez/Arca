import { afterAll, describe, expect, test } from "bun:test";
import { readFile, readlink, readdir, stat, writeFile, appendFile } from "node:fs/promises";
import { join } from "node:path";
import { decrypt, encrypt, newMasterKey, unwrapMasterKey, wrapMasterKey } from "../src/core/crypto";
import { Chunker, gearTable } from "../src/core/chunker";
import { Repository } from "../src/core/repo";
import { LocalBackend } from "../src/backends/local";
import { backup, Excluder } from "../src/core/backup";
import { restore } from "../src/core/restore";
import { walkTree } from "../src/core/tree";
import { FAST_KDF, SMALL_CHUNKER, cleanup, makeTree, newRepo, prng, tmp } from "./helpers";

afterAll(cleanup);

describe("crypto", () => {
  test("encryption round trip, tampering is detected", () => {
    const k = newMasterKey().enc;
    const c = encrypt(k, new TextEncoder().encode("secret"));
    expect(new TextDecoder().decode(decrypt(k, c))).toBe("secret");
    c[20]! ^= 1;
    expect(() => decrypt(k, c)).toThrow();
  });

  test("wrapping the key with a password", async () => {
    const mk = newMasterKey();
    const kf = await wrapMasterKey(mk, "repo1", "pw", FAST_KDF);
    const back = await unwrapMasterKey(kf, "repo1", "pw");
    expect(Buffer.from(back.mac).equals(Buffer.from(mk.mac))).toBe(true);
    await expect(unwrapMasterKey(kf, "repo1", "wrong")).rejects.toThrow();
    await expect(unwrapMasterKey(kf, "repo2", "pw")).rejects.toThrow("different");
  });
});

describe("chunker", () => {
  const ch = new Chunker(gearTable(new Uint8Array(32)), SMALL_CHUNKER);

  test("chunks are within min..max and join back into the original", () => {
    const data = prng(7)(500_000);
    const parts = [...ch.chunksOf(data)];
    expect(Buffer.concat(parts).equals(Buffer.from(data))).toBe(true);
    for (const p of parts.slice(0, -1)) {
      expect(p.length).toBeGreaterThanOrEqual(SMALL_CHUNKER.min);
      expect(p.length).toBeLessThanOrEqual(SMALL_CHUNKER.max);
    }
    expect(parts.length).toBeGreaterThan(20);
  });

  test("an insertion at the start keeps most chunks", () => {
    const data = prng(9)(500_000);
    const a = new Set([...ch.chunksOf(data)].map((p) => Buffer.from(p).toString("base64")));
    const shifted = new Uint8Array(data.length + 3);
    shifted.set([1, 2, 3]);
    shifted.set(data, 3);
    const b = [...ch.chunksOf(shifted)].map((p) => Buffer.from(p).toString("base64"));
    const same = b.filter((x) => a.has(x)).length;
    expect(same / b.length).toBeGreaterThan(0.8);
  });

  test("streaming a file yields the same chunks", async () => {
    const d = await tmp();
    const data = prng(3)(200_000);
    await writeFile(join(d, "f"), data);
    const { open } = await import("node:fs/promises");
    const fh = await open(join(d, "f"));
    const parts: Uint8Array[] = [];
    for await (const p of ch.chunksOfFile(fh, 10_000)) parts.push(p);
    await fh.close();
    expect(parts.map((p) => p.length)).toEqual([...ch.chunksOf(data)].map((p) => p.length));
  });
});

describe("excluder", () => {
  test("names, paths, directories only", () => {
    const e = new Excluder(["node_modules/", "*.log", "/docs/deep", "# comment"]);
    expect(e.excluded("a/node_modules", true)).toBe(true);
    expect(e.excluded("a/node_modules", false)).toBe(false);
    expect(e.excluded("x/app.log", false)).toBe(true);
    expect(e.excluded("docs/deep", true)).toBe(true);
    expect(e.excluded("other/docs/deep", true)).toBe(false);
  });
});

describe("repository", () => {
  test("wrong password and a second key", async () => {
    const { dir } = await newRepo();
    await expect(Repository.open(new LocalBackend(dir), "nope")).rejects.toThrow("Wrong password");
    const r = await Repository.open(new LocalBackend(dir), "test-pass");
    await r.addKey("second", FAST_KDF);
    const r2 = await Repository.open(new LocalBackend(dir), "second");
    expect(r2.id).toBe(r.id);
  });

  test("the storage holds no plaintext", async () => {
    const { dir, repo } = await newRepo();
    const src = await tmp();
    await makeTree(src);
    await backup(repo, { root: src });
    const files = await new LocalBackend(dir).list("data");
    for (const f of files) {
      const raw = await readFile(join(dir, f.name));
      expect(raw.includes(Buffer.from("notes"))).toBe(false);
      expect(raw.includes(Buffer.from("hello.txt"))).toBe(false);
    }
  });
});

describe("backup → restore", () => {
  test("full cycle preserving content and metadata", async () => {
    const { repo, dir } = await newRepo();
    const src = await tmp();
    await makeTree(src);
    const r1 = await backup(repo, { root: src, exclude: ["node_modules/", "*.log"] });
    expect(r1.errors).toEqual([]);
    expect(r1.snapshot.stats!.files).toBe(5);

    // Deduplication: the copy of big.bin added no new bytes.
    expect(r1.snapshot.stats!.newBytes).toBeLessThan(300_000 + 20_000);

    // A freshly opened repository sees the snapshot.
    const repo2 = await Repository.open(new LocalBackend(dir), "test-pass");
    const snap = await repo2.findSnapshot("latest");
    expect(snap.id).toBe(r1.id);

    const out = join(await tmp(), "restored");
    const res = await restore(repo2, snap.snapshot.tree, out);
    expect(res.errors).toEqual([]);
    expect(await readFile(join(out, "hello.txt"), "utf8")).toBe("Hello, backup!\n");
    expect(Buffer.compare(await readFile(join(out, "big.bin")), await readFile(join(src, "big.bin")))).toBe(0);
    expect(await readFile(join(out, "docs/deep/er/notes.md"), "utf8")).toBe("# notes\n".repeat(500));
    expect(await readlink(join(out, "link-to-hello"))).toBe("hello.txt");
    expect((await readFile(join(out, "empty"))).length).toBe(0);
    expect((await readdir(join(out, "empty-dir"))).length).toBe(0);
    expect(await readdir(out)).not.toContain("node_modules");
    expect(await readdir(out)).not.toContain("app.log");
    const [a, b] = await Promise.all([stat(join(src, "docs/deep/er/notes.md")), stat(join(out, "docs/deep/er/notes.md"))]);
    expect(Math.floor(b.mtimeMs)).toBe(Math.floor(a.mtimeMs));
    expect(b.mode).toBe(a.mode);
  });

  test("an incremental snapshot skips unchanged files and catches changes", async () => {
    const { repo } = await newRepo();
    const src = await tmp();
    await makeTree(src);
    const r1 = await backup(repo, { root: src });
    const r2 = await backup(repo, { root: src });
    expect(r2.snapshot.parent).toBe(r1.id);
    expect(r2.snapshot.stats!.newBytes).toBe(0);
    expect(r2.snapshot.tree).toBe(r1.snapshot.tree);

    await appendFile(join(src, "hello.txt"), "one more line\n");
    const r3 = await backup(repo, { root: src });
    expect(r3.snapshot.tree).not.toBe(r1.snapshot.tree);
    expect(r3.snapshot.stats!.newBytes).toBeGreaterThan(0);
    expect(r3.snapshot.stats!.newBytes).toBeLessThan(1000);
  });

  test("restoring a subpath, ls, and the target is not overwritten", async () => {
    const { repo } = await newRepo();
    const src = await tmp();
    await makeTree(src);
    const { snapshot } = await backup(repo, { root: src });
    const out = await tmp();
    await restore(repo, snapshot.tree, out, { path: "docs/deep" });
    expect(await readFile(join(out, "deep/er/notes.md"), "utf8")).toContain("notes");
    await expect(restore(repo, snapshot.tree, out)).rejects.toThrow("not empty");

    const names: string[] = [];
    for await (const n of walkTree(repo, snapshot.tree, "docs", true)) names.push(n.path);
    expect(names).toEqual(["docs/copy-of-big.bin", "docs/deep", "docs/deep/er", "docs/deep/er/notes.md"]);
  });

  test("an unreadable file still produces a snapshot, with an error", async () => {
    if (process.getuid?.() === 0) return; // root can read everything
    const { repo } = await newRepo();
    const src = await tmp();
    await makeTree(src);
    const { chmod } = await import("node:fs/promises");
    await chmod(join(src, "hello.txt"), 0);
    const r = await backup(repo, { root: src });
    expect(r.errors.map((e) => e.path)).toEqual(["hello.txt"]);
  });
});
