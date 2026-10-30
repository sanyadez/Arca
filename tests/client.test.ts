// Clients (`arca client`): jobs over long poll, backup through the storage proxy, the proxy's append-only rules.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { validateConfig } from "../src/server/config";
import { Service } from "../src/server/service";
import { RunsDb } from "../src/server/db";
import { hashToken, makeHandler } from "../src/server/http";
import { LocalBackend } from "../src/backends/local";
import { Repository } from "../src/core/repo";
import { restore } from "../src/core/restore";
import { ClientAgent } from "../src/client/agent";
import { parseClientUrl } from "../src/sources";
import { FAST_KDF, SMALL_CHUNKER, cleanup, makeTree, tmp } from "./helpers";

describe("client sources", () => {
  test("client:// addresses", () => {
    expect(parseClientUrl("client://laptop/home/me/")).toEqual({ client: "laptop", path: "/home/me" });
    expect(parseClientUrl("client://pc/")).toEqual({ client: "pc", path: "/" });
    expect(() => parseClientUrl("client://laptop")).toThrow();
    expect(() => parseClientUrl("client://Bad/x")).toThrow();
    expect(() => parseClientUrl("client://pc/a/../etc")).toThrow();
    const base = { repos: { r: { url: "/x" } } };
    expect(() => validateConfig({ ...base, sources: { s: { path: "client://pc/srv", repo: "r" } } }, "/")).not.toThrow();
    expect(() => validateConfig({ ...base, tokens: [{ name: "pc", sha256: "a".repeat(64), scopes: ["client", "read"] }] }, "/")).toThrow("cannot be combined");
  });
});

describe("client end to end", () => {
  let svc: Service;
  let server: ReturnType<typeof Bun.serve>;
  let base: string;
  let src: string;
  let root: string;
  let agent: ClientAgent;
  let agentDone: Promise<void>;
  const ADMIN = "admin-token";
  const LAPTOP = "laptop-token";
  const ROGUE = "rogue-token";

  beforeAll(async () => {
    root = await tmp("arca-test-client-");
    src = join(root, "laptop-files");
    await makeTree(src);
    await Repository.init(new LocalBackend(join(root, "repo")), "client-pass", { kdf: FAST_KDF, chunker: SMALL_CHUNKER });
    await writeFile(join(root, "pass"), "client-pass\n");
    const cfg = validateConfig(
      {
        dataDir: join(root, "data"),
        tokens: [
          { name: "admin", sha256: hashToken(ADMIN), scopes: ["admin"] },
          { name: "laptop", sha256: hashToken(LAPTOP), scopes: ["client"] },
          { name: "rogue", sha256: hashToken(ROGUE), scopes: ["client"] },
        ],
        repos: { main: { url: join(root, "repo"), passwordFile: join(root, "pass"), prune: "", check: "" } },
        sources: {
          lap: { path: `client://laptop${src}`, repo: "main", exclude: ["node_modules/"], retention: { last: 1 } },
          rog: { path: "client://rogue/srv", repo: "main" },
          ghost: { path: "client://nobody/srv", repo: "main" },
        },
      },
      root,
    );
    svc = new Service(cfg, () => {}, new RunsDb(":memory:"));
    server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: makeHandler(svc) });
    base = `http://127.0.0.1:${server.port}`;
    agent = new ClientAgent({ server: base, token: LAPTOP }, () => {});
  });
  afterAll(async () => {
    await agent.stop();
    await agentDone;
    server.stop(true);
    await svc.stop();
    await cleanup();
  });

  const call = async (method: string, path: string, token: string, body?: string | Uint8Array, headers: Record<string, string> = {}) => {
    const r = await fetch(base + path, { method, body, headers: { authorization: `Bearer ${token}`, ...headers } });
    const text = await r.text();
    let json: any = null;
    try {
      json = JSON.parse(text);
    } catch {}
    return { status: r.status, body: json, raw: text };
  };

  test("an offline or unknown client fails the run at once", async () => {
    const off = await svc.runBackup("lap", "test").done;
    expect(off.status).toBe("error");
    expect(off.summary).toContain("offline");
    const ghost = await svc.runBackup("ghost", "test").done;
    expect(ghost.summary).toContain('Unknown client "nobody"');
  });

  test("client tokens reach only the client API, and only client tokens reach it", async () => {
    expect((await call("GET", "/api/sources", LAPTOP)).status).toBe(403);
    expect((await call("GET", "/api/client/hello", ADMIN)).status).toBe(403);
    const signIn = await fetch(`${base}/api/session`, { method: "POST", body: JSON.stringify({ token: LAPTOP }) });
    expect(signIn.status).toBe(401);
    const h = await call("GET", "/api/client/hello", LAPTOP);
    expect(h.status).toBe(200);
    expect(h.body.client).toBe("laptop");
    expect(h.body.sources).toEqual([{ name: "lap", path: src, repo: "main", schedule: null }]);
  });

  test("backup on the client, retention on the server", async () => {
    agentDone = agent.run({ wait: 1 });
    await Bun.sleep(100);
    const first = await svc.runBackup("lap", "test").done;
    expect(first.status).toBe("ok");
    expect(first.snapshot).toBeTruthy();
    expect(first.details.log.map((l: any) => l.text).join("\n")).toContain("Client laptop started the backup");

    // The server reads what the client wrote.
    const snaps = await svc.snapshots("main");
    expect(snaps).toHaveLength(1);
    expect(snaps[0]!.snapshot.source).toBe("lap");
    const out = join(root, "restored");
    const repo = await svc.repo("main");
    await restore(repo, snaps[0]!.snapshot.tree, out);
    expect(await readFile(join(out, "big.bin"))).toEqual(await readFile(join(src, "big.bin")));
    expect(await Bun.file(join(out, "node_modules/pkg/index.js")).exists()).toBe(false);

    // A second run reuses everything; retention (last: 1) runs on the server and leaves one snapshot.
    await writeFile(join(src, "new.txt"), "new file\n");
    const second = await svc.runBackup("lap", "test").done;
    expect(second.status).toBe("ok");
    expect(second.summary).toContain("1 file changed");
    expect(second.summary).toContain("retention removed 1");
    expect(await svc.snapshots("main")).toHaveLength(1);
    expect(svc.clients.state("laptop")).toMatchObject({ online: true, running: null });
  });

  test("the storage proxy only appends, and only during a job", async () => {
    const st = "/api/client/storage/main";
    expect((await call("GET", `${st}/list?dir=index`, ROGUE)).status).toBe(403); // no job yet

    await call("GET", "/api/client/hello", ROGUE); // online
    const run = svc.runBackup("rog", "test");
    const poll = await call("GET", "/api/client/poll?wait=5", ROGUE);
    const job = poll.body.job;
    expect(job).toMatchObject({ runId: run.runId, source: "rog", path: "/srv", repo: "main" });

    expect((await call("GET", `${st}/list?dir=keys`, ROGUE)).body.files.length).toBe(1);
    expect((await call("GET", `${st}/list?dir=`, ROGUE)).status).toBe(403);
    expect((await call("GET", `${st}/f/config`, ROGUE)).status).toBe(200);
    expect((await call("PUT", `${st}/f/config`, ROGUE, "x")).status).toBe(403);
    expect((await call("PUT", `${st}/f/keys/${"a".repeat(64)}`, ROGUE, "x")).status).toBe(403);

    const snap = (await call("GET", `${st}/list?dir=snapshots`, ROGUE)).body.files[0].name as string;
    const data = (await fetch(`${base}${st}/f/${snap}`, { headers: { authorization: `Bearer ${ROGUE}` } }).then((r) => r.arrayBuffer())) as ArrayBuffer;
    expect((await call("PUT", `${st}/f/${snap}`, ROGUE, new Uint8Array(data))).status).toBe(200); // same contents: a no-op
    expect((await call("PUT", `${st}/f/${snap}`, ROGUE, "forged")).status).toBe(400);
    expect((await call("DELETE", `${st}/f/${snap}`, ROGUE)).status).toBe(403);
    const pack = (await call("GET", `${st}/list?dir=data`, ROGUE)).body.files[0].name as string;
    expect((await call("DELETE", `${st}/f/${pack}`, ROGUE)).status).toBe(403);
    expect((await call("GET", `${st}/f/${pack}`, ROGUE, undefined, { range: "bytes=0-9" })).raw.length).toBeGreaterThan(0);

    const lock = `locks/${"b".repeat(32)}`;
    expect((await call("PUT", `${st}/f/${lock}`, ROGUE, "lock")).status).toBe(200);
    expect((await call("PUT", `${st}/f/${lock}`, ROGUE, "lock again")).status).toBe(200);
    expect((await call("DELETE", `${st}/f/${lock}`, ROGUE)).status).toBe(200);

    // The laptop has no job on this run.
    expect((await call("POST", `/api/client/runs/${run.runId}/events`, LAPTOP, "{}")).status).toBe(404);

    // Cancel on the server: the client hears it in the reply to its next event.
    svc.cancel(run.runId);
    const ev = await call("POST", `/api/client/runs/${run.runId}/events`, ROGUE, JSON.stringify({ logs: [{ stage: "scan", text: "hi" }] }));
    expect(ev.body).toEqual({ cancel: true });
    await call("POST", `/api/client/runs/${run.runId}/finish`, ROGUE, JSON.stringify({ ok: false, cancelled: true, error: "cancelled" }));
    const done = await run.done;
    expect(done.status).toBe("interrupted");
    expect((await call("GET", `${st}/list?dir=index`, ROGUE)).status).toBe(403); // job over
  });
});
