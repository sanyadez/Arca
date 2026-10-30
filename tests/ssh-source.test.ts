/**
 * SSH source without a network: a fake "ssh" runs the remote command locally, as the shell on the
 * source would (or the forced command arca-src). The data is synthetic, in temporary directories.
 * Real SSH: if ARCA_SSH_TEST=ssh://user@host/dir-with-synthetic-data is set.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { chmod, mkdir, readFile, readlink, stat, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { SshSource, parseFindOutput, parseSshUrl } from "../src/sources/ssh";
import { openSource } from "../src/sources";
import { LocalSource } from "../src/core/source";
import { backup } from "../src/core/backup";
import { restore } from "../src/core/restore";
import { cleanup, makeTree, newRepo, prng, tmp } from "./helpers";

afterAll(cleanup);

const SCRIPT = join(import.meta.dir, "../scripts/arca-src.sh");

/** Fake ssh: skips options and the target; FAKE_FORCED runs the script as the forced command. */
async function fakeSsh(dir: string): Promise<string> {
  const p = join(dir, "fake-ssh");
  await writeFile(
    p,
    `#!/bin/sh
while [ $# -gt 0 ]; do case "$1" in -o|-i|-p) shift 2;; -*) shift;; *) break;; esac; done
shift
if [ -n "\${FAKE_FORCED:-}" ]; then SSH_ORIGINAL_COMMAND="$*" exec sh "$FAKE_FORCED" $FAKE_ROOTS; fi
exec sh -c "$*"
`,
  );
  await chmod(p, 0o755);
  return p;
}

async function weirdTree(root: string) {
  await makeTree(root);
  await mkdir(join(root, "odd names/with space"), { recursive: true });
  await writeFile(join(root, "odd names/with space/café 'with' quotes.txt"), "quotes\n");
  await writeFile(join(root, "odd names/line\nbreak"), "newline\n");
  const long = "d".repeat(60) + "/" + "e".repeat(110); // >100 bytes: GNU long name in tar
  await mkdir(join(root, long.split("/")[0]!), { recursive: true });
  await writeFile(join(root, long), prng(5)(70_000));
  await symlink("../hello.txt", join(root, "odd names/链接"));
}

function source(url: string, ssh: string, extra: Partial<ConstructorParameters<typeof SshSource>[0]> = {}) {
  return new SshSource({ ...parseSshUrl(url), sshCommand: [ssh], ...extra });
}

describe("ssh source", () => {
  test("URL", () => {
    expect(parseSshUrl("ssh://bk@host:2222/srv/data/")).toEqual({ user: "bk", host: "host", port: 2222, path: "/srv/data" });
    expect(() => parseSshUrl("ssh://host")).toThrow("absolute");
    expect(openSource("/tmp/x")).toBeInstanceOf(LocalSource);
    expect(() => openSource("ftp://x/y")).toThrow("Unknown");
  });

  test("parsing find output", () => {
    const raw = new TextEncoder().encode("f 644 1 2 1700000000.1234567 5 77\0a/b\0\0l 777 0 0 1700000000 3 78\0a/l\0b\0d 755 0 0 1700000000.5 4096 79\0a\0\0");
    expect(parseFindOutput(raw)).toEqual([
      { path: "a/b", type: "file", mode: 0o644, uid: 1, gid: 2, mtime: 1700000000123, size: 5, ino: 77 },
      { path: "a/l", type: "symlink", mode: 0o777, uid: 0, gid: 0, mtime: 1700000000000, size: 3, ino: 78, target: "b" },
      { path: "a", type: "dir", mode: 0o755, uid: 0, gid: 0, mtime: 1700000000500, size: 0, ino: 79 },
    ]);
  });

  for (const mode of ["raw", "forced"] as const) {
    test(`state matches local and the snapshot restores (${mode})`, async () => {
      const work = await tmp();
      const ssh = await fakeSsh(work);
      const root = join(work, "src");
      await weirdTree(root);
      {
        const cmd = mode === "forced" ? ["env", `FAKE_FORCED=${SCRIPT}`, `FAKE_ROOTS=${work}`, ssh] : [ssh];
        const src = source(`ssh://bk@host${root}`, ssh, { forced: mode === "forced", sshCommand: cmd });
        const remote = (await src.list()).entries.sort((a, b) => a.path.localeCompare(b.path));
        const local = (await new LocalSource(root).list()).entries.sort((a, b) => a.path.localeCompare(b.path));
        expect(remote).toEqual(local);

        const { repo } = await newRepo();
        const r1 = await backup(repo, { from: src, source: "s" });
        expect(r1.errors).toEqual([]);
        expect(r1.snapshot.host).toBe("host");
        expect(r1.snapshot.root).toBe(`ssh://bk@host${root}`);

        // The same content snapshotted locally yields the same tree.
        const rl = await backup(repo, { root, source: "local", parent: null });
        expect(rl.snapshot.tree).toBe(r1.snapshot.tree);

        const r2 = await backup(repo, { from: src, source: "s" });
        expect(r2.snapshot.parent).toBe(r1.id);
        expect(r2.snapshot.stats!.newBytes).toBe(0);

        await writeFile(join(root, "hello.txt"), "changed over ssh\n");
        const r3 = await backup(repo, { from: src, source: "s", exclude: ["node_modules/"] });
        expect(r3.snapshot.stats!.newBytes).toBeLessThan(1000);

        const out = join(await tmp(), "r");
        expect((await restore(repo, r3.snapshot.tree, out)).errors).toEqual([]);
        expect(await readFile(join(out, "hello.txt"), "utf8")).toBe("changed over ssh\n");
        expect(await readFile(join(out, "odd names/with space/café 'with' quotes.txt"), "utf8")).toBe("quotes\n");
        expect(await readFile(join(out, "odd names/line\nbreak"), "utf8")).toBe("newline\n");
        expect(await readlink(join(out, "odd names/链接"))).toBe("../hello.txt");
        const long = "d".repeat(60) + "/" + "e".repeat(110);
        expect(Buffer.compare(await readFile(join(out, long)), await readFile(join(root, long)))).toBe(0);
        expect((await stat(join(out, long))).mtimeMs).toBe(Math.floor((await stat(join(root, long))).mtimeMs));
        await expect(readFile(join(out, "node_modules/pkg/index.js"))).rejects.toThrow();
      }
    }, 60_000);
  }

  test("a file that vanished between passes is a file error, not a snapshot error", async () => {
    const work = await tmp();
    const ssh = await fakeSsh(work);
    const root = join(work, "src");
    await makeTree(root);
    const src = source(`ssh://h${root}`, ssh);
    const { rm } = await import("node:fs/promises");
    const orig = src.list.bind(src);
    src.list = async () => {
      const r = await orig();
      await rm(join(root, "big.bin"));
      return r;
    };
    const { repo } = await newRepo();
    const r = await backup(repo, { from: src });
    expect(r.errors.map((e) => e.path)).toEqual(["big.bin"]);
    expect(r.errors[0]!.error).toContain("No such file");
    expect(r.snapshot.stats!.files).toBe(6);
  }, 30_000);

  test("forced command rejects anything else", async () => {
    const work = await tmp();
    const run = async (cmd: string, roots: string[]) => {
      const p = Bun.spawn(["sh", SCRIPT, ...roots], { env: { ...process.env, SSH_ORIGINAL_COMMAND: cmd }, stderr: "pipe", stdout: "ignore" });
      return { code: await p.exited, err: await new Response(p.stderr).text() };
    };
    const enc = (s: string) => Buffer.from(s).toString("base64url");
    expect((await run(`arca-src list ${enc(work)}`, [work])).code).toBe(0);
    expect((await run(`arca-src list ${enc("/etc")}`, [work])).err).toContain("not allowed");
    expect((await run(`arca-src list ${enc(work + "/../..")}`, [work])).err).toContain("..");
    expect((await run(`arca-src list ${enc(work + "x")}`, [work])).err).toContain("not allowed");
    expect((await run("cat /etc/passwd", [work])).err).toContain("not allowed");
    expect((await run("arca-src list a;b", [work])).err).toContain("invalid path");
    expect((await run(`arca-src list ${enc(work)}`, [])).err).toContain("no allowed directories");
  });
});

const LIVE = process.env.ARCA_SSH_TEST;
(LIVE ? describe : describe.skip)("ssh source (real ssh)", () => {
  test("snapshot and restore", async () => {
    const src = openSource(LIVE!, { forced: process.env.ARCA_SSH_FORCED === "1" });
    const { repo } = await newRepo();
    const r = await backup(repo, { from: src });
    expect(r.errors).toEqual([]);
    const out = join(await tmp(), "r");
    expect((await restore(repo, r.snapshot.tree, out)).errors).toEqual([]);
    await src.close();
  }, 120_000);
});
