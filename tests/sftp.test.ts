/**
 * SFTP integration test: only when ARCA_SFTP_TEST is set (URL of a test directory,
 * e.g. sftp://user@host/path/to/test-dir). Each run uses its own subdirectory,
 * which the test removes afterwards. The data is synthetic.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { SftpBackend, parseSftpUrl } from "../src/backends/sftp";
import { NotFoundError } from "../src/backends/types";
import { Repository } from "../src/core/repo";
import { backup } from "../src/core/backup";
import { restore } from "../src/core/restore";
import { check, forget, prune } from "../src/core/maintenance";
import { randomHex } from "../src/core/crypto";
import { FAST_KDF, SMALL_CHUNKER, cleanup, makeTree, tmp } from "./helpers";

const BASE = process.env.ARCA_SFTP_TEST;
const suite = BASE ? describe : describe.skip;

suite("sftp", () => {
  const opts = BASE ? parseSftpUrl(BASE) : { host: "", path: "" };
  const be = new SftpBackend({ ...opts, path: `${opts.path}/run-${randomHex(4)}` });

  afterAll(async () => {
    await be.destroyAll().catch(() => {});
    await be.close();
    await cleanup();
  });

  test("put/get/list/exists/delete", async () => {
    await be.put("keys/a", new TextEncoder().encode("one"));
    await be.put("data/ab/abc", new Uint8Array([1, 2, 3, 4]));
    await be.put("data/cd/cde", new Uint8Array(10));
    expect(new TextDecoder().decode(await be.get("keys/a"))).toBe("one");
    expect(await be.get("data/ab/abc", { offset: 1, length: 2 })).toEqual(new Uint8Array([2, 3]));
    expect((await be.list("data")).sort((a, b) => a.name.localeCompare(b.name))).toEqual([
      { name: "data/ab/abc", size: 4 },
      { name: "data/cd/cde", size: 10 },
    ]);
    expect(await be.list("nothing")).toEqual([]);
    expect(await be.exists("keys/a")).toBe(true);
    expect(await be.exists("keys/zzz")).toBe(false);
    await be.put("keys/a", new TextEncoder().encode("two"));
    expect(new TextDecoder().decode(await be.get("keys/a"))).toBe("two");
    await be.delete("keys/a");
    await expect(be.get("keys/a")).rejects.toBeInstanceOf(NotFoundError);
    await be.delete("data/ab/abc");
    await be.delete("data/cd/cde");
  }, 30_000);

  test("full repository cycle on SFTP", async () => {
    const repo = await Repository.init(be, "sftp-pass", { kdf: FAST_KDF, chunker: SMALL_CHUNKER });
    const src = await tmp();
    await makeTree(src);
    const r1 = await backup(repo, { root: src });
    const r2 = await backup(repo, { root: src });
    expect(r2.snapshot.stats!.newBytes).toBe(0);

    const fresh = await Repository.open(be, "sftp-pass");
    await forget(fresh, { last: 1 });
    await prune(fresh);
    const c = await check(fresh, { readData: 1 });
    expect(c.errors).toEqual([]);
    expect(c.snapshots).toBe(1);

    const out = join(await tmp(), "r");
    const res = await restore(fresh, r1.snapshot.tree, out);
    expect(res.errors).toEqual([]);
    expect(Buffer.compare(await readFile(join(out, "big.bin")), await readFile(join(src, "big.bin")))).toBe(0);
  }, 120_000);
});
