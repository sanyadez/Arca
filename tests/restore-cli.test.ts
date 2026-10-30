/** arca-restore as a separate process: restore without server or config, writes nothing to the storage. */
import { afterAll, describe, expect, test } from "bun:test";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { backup } from "../src/core/backup";
import { cleanup, makeTree, newRepo, tmp } from "./helpers";

afterAll(cleanup);

const CLI = join(import.meta.dir, "../src/restore-cli.ts");

async function run(args: string[], env: Record<string, string> = {}) {
  const p = Bun.spawn(["bun", CLI, ...args], {
    env: { ...process.env, ...env },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  return { stdout, stderr, code };
}

async function listAll(dir: string) {
  return ((await readdir(dir, { recursive: true })) as string[]).sort();
}

describe("arca-restore", () => {
  test("snapshots, ls, restore, check; storage is unchanged", async () => {
    const { repo, dir } = await newRepo();
    const src = await tmp();
    await makeTree(src);
    const r = await backup(repo, { root: src, source: "test" });
    const before = await listAll(dir);
    const env = { ARCA_PASSWORD: "test-pass", ARCA_REPO: dir };

    const snaps = await run(["snapshots", "--json"], env);
    expect(snaps.code).toBe(0);
    expect(JSON.parse(snaps.stdout).map((s: any) => s.id)).toEqual([r.id]);

    const ls = await run(["ls", "latest", "docs", "-r"], env);
    expect(ls.code).toBe(0);
    expect(ls.stdout).toContain("docs/deep/er/notes.md");

    const out = join(await tmp(), "restored");
    const res = await run(["restore", r.id.slice(0, 8), "--target", out, "--source", "test"], env);
    expect(res.code).toBe(0);
    expect(res.stdout).toContain("Restored");
    expect(await readFile(join(out, "hello.txt"), "utf8")).toBe("Hello, backup!\n");
    expect(Buffer.compare(await readFile(join(out, "big.bin")), await readFile(join(src, "big.bin")))).toBe(0);

    const c = await run(["check", "--read-data"], env);
    expect(c.code).toBe(0);
    expect(c.stdout).toContain("No errors");

    expect(await listAll(dir)).toEqual(before);
  }, 30_000);

  test("errors: wrong password, no repository, unknown command", async () => {
    const { dir } = await newRepo();
    const bad = await run(["snapshots"], { ARCA_PASSWORD: "nope", ARCA_REPO: dir });
    expect(bad.code).toBe(2);
    expect(bad.stderr).toContain("Wrong password");
    const none = await run(["snapshots"], { ARCA_PASSWORD: "x", ARCA_REPO: await tmp() });
    expect(none.stderr).toContain("No repository at");
    expect((await run(["prune"], { ARCA_REPO: dir })).stderr).toContain("Unknown command");
  }, 30_000);
});
