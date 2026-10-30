/** Shared test helpers: temporary directories and synthetic data. Tests never touch real files. */
import { mkdtemp, mkdir, rm, writeFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalBackend } from "../src/backends/local";
import { Repository } from "../src/core/repo";
import type { KdfParams } from "../src/core/crypto";

/** Weak KDF for tests only, to avoid waiting on scrypt. */
export const FAST_KDF: KdfParams = { N: 1 << 10, r: 8, p: 1 };
/** Small chunks so tests see many chunks on little data. */
export const SMALL_CHUNKER = { min: 2048, avg: 8192, max: 32768 };

const dirs: string[] = [];

export async function tmp(prefix = "arca-test-"): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}

export async function cleanup() {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
}

/** Deterministic pseudorandom generator (xorshift32). */
export function prng(seed: number) {
  let x = seed >>> 0 || 1;
  return (n: number) => {
    const out = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      x ^= x << 13;
      x >>>= 0;
      x ^= x >>> 17;
      x ^= x << 5;
      x >>>= 0;
      out[i] = x & 0xff;
    }
    return out;
  };
}

/** Synthetic directory: nested directories, duplicates, an empty file, a symlink, a "cache" for exclusions. */
export async function makeTree(root: string, seed = 1) {
  const rnd = prng(seed);
  await mkdir(join(root, "docs/deep/er"), { recursive: true });
  await mkdir(join(root, "node_modules/pkg"), { recursive: true });
  await mkdir(join(root, "empty-dir"));
  await writeFile(join(root, "hello.txt"), "Hello, backup!\n");
  await writeFile(join(root, "empty"), "");
  const big = rnd(300_000);
  await writeFile(join(root, "big.bin"), big);
  await writeFile(join(root, "docs/copy-of-big.bin"), big);
  await writeFile(join(root, "docs/deep/er/notes.md"), "# notes\n".repeat(500));
  await writeFile(join(root, "node_modules/pkg/index.js"), "module.exports = 1;\n");
  await writeFile(join(root, "app.log"), "log\n");
  await symlink("hello.txt", join(root, "link-to-hello"));
}

export async function newRepo() {
  const dir = await tmp("arca-test-repo-");
  const backend = new LocalBackend(dir);
  const repo = await Repository.init(backend, "test-pass", { kdf: FAST_KDF, chunker: SMALL_CHUNKER });
  return { dir, backend, repo };
}
