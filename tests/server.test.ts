import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Cron } from "../src/server/cron";
import { validateConfig, type Config } from "../src/server/config";
import { Service } from "../src/server/service";
import { RunsDb } from "../src/server/db";
import { hashToken, makeHandler } from "../src/server/http";
import { LocalBackend } from "../src/backends/local";
import { Repository } from "../src/core/repo";
import { FAST_KDF, SMALL_CHUNKER, cleanup, makeTree, tmp } from "./helpers";

describe("cron", () => {
  const at = (s: string) => new Date(s); // local time
  test("fields, ranges, steps, names", () => {
    const c = new Cron("*/15 9-17 * * mon-fri");
    expect(c.matches(at("2026-10-29T09:30:00"))).toBe(true); // Thursday
    expect(c.matches(at("2026-10-29T09:31:00"))).toBe(false);
    expect(c.matches(at("2026-11-01T09:30:00"))).toBe(false); // Sunday
    expect(new Cron("@daily").matches(at("2026-10-29T00:00:00"))).toBe(true);
    expect(new Cron("0 0 * * 7").matches(at("2026-11-01T00:00:00"))).toBe(true);
  });
  test("day of month OR day of week when both are restricted", () => {
    const c = new Cron("0 12 1 * fri");
    expect(c.matches(at("2026-10-30T12:00:00"))).toBe(true); // Friday
    expect(c.matches(at("2026-11-01T12:00:00"))).toBe(true); // the 1st
    expect(c.matches(at("2026-11-02T12:00:00"))).toBe(false);
  });
  test("next and errors", () => {
    expect(new Cron("30 4 * * *").next(at("2026-10-29T05:00:00"))!.toString()).toBe(at("2026-10-30T04:30:00").toString());
    expect(() => new Cron("61 * * * *")).toThrow();
    expect(() => new Cron("* * *")).toThrow();
  });
});

describe("config", () => {
  test("validates references and names", () => {
    expect(() => validateConfig({ repos: {}, sources: { a: { path: "/x", repo: "nope" } } }, "/")).toThrow("unknown repository");
    expect(() => validateConfig({ repos: { "Bad Name": { url: "/x" } } }, "/")).toThrow("name");
    expect(() => validateConfig({ repos: { r: { url: "/x" } }, sources: { s: { path: "/x", repo: "r", schedule: "bad" } } }, "/")).toThrow();
    const c = validateConfig({ repos: { r: { url: "/x", passwordFile: "p" } }, sources: {} }, "/etc/b");
    expect(c.repos.r!.passwordFile).toBe("/etc/b/p");
    expect(c.restoreRoot).toBe("/etc/b/data/restore");
    const ssh = validateConfig(
      { repos: { r: { url: "/x" } }, sources: { s: { path: "ssh://bk@h/srv", repo: "r", ssh: { forced: true, identity: "k" } } } },
      "/etc/b",
    );
    expect(ssh.sources.s!.path).toBe("ssh://bk@h/srv");
    expect(ssh.sources.s!.ssh!.identity).toBe("/etc/b/k");
    expect(() => validateConfig({ repos: { r: { url: "/x" } }, sources: { s: { path: "ssh://h", repo: "r" } } }, "/")).toThrow();
  });
});

describe("service + HTTP + MCP", () => {
  let svc: Service;
  let handler: (r: Request) => Promise<Response>;
  let src: string;
  let cfg: Config;
  const ADMIN = "admin-token";
  const READER = "reader-token";

  beforeAll(async () => {
    const root = await tmp("arca-test-srv-");
    src = join(root, "src");
    await makeTree(src);
    await Repository.init(new LocalBackend(join(root, "repo")), "srv-pass", { kdf: FAST_KDF, chunker: SMALL_CHUNKER });
    await writeFile(join(root, "pass"), "srv-pass\n");
    cfg = validateConfig(
      {
        dataDir: join(root, "data"),
        tokens: [
          { name: "admin", sha256: hashToken(ADMIN), scopes: ["admin"] },
          { name: "reader", sha256: hashToken(READER), scopes: ["read"] },
        ],
        repos: { main: { url: join(root, "repo"), passwordFile: join(root, "pass"), prune: "30 4 * * 0", check: "" } },
        sources: { test: { path: src, repo: "main", schedule: "0 3 * * *", exclude: ["node_modules/"], retention: { last: 2 } } },
      },
      root,
    );
    svc = new Service(cfg, () => {}, new RunsDb(":memory:"));
    handler = makeHandler(svc);
  });
  afterAll(async () => {
    await svc.stop();
    await cleanup();
  });

  const call = async (method: string, path: string, token?: string, body?: unknown) => {
    const r = await handler(
      new Request(`http://x${path}`, {
        method,
        headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
    );
    return { status: r.status, body: (r.status === 202 ? null : await r.json()) as any };
  };
  const mcp = async (token: string, method: string, params?: unknown, notify = false) =>
    call("POST", "/mcp", token, { jsonrpc: "2.0", ...(notify ? {} : { id: 1 }), method, params });
  const tool = async (token: string, name: string, args: unknown = {}) => {
    const r = await mcp(token, "tools/call", { name, arguments: args });
    const c = r.body.result;
    return { isError: !!c.isError, data: c.isError ? c.content[0].text : JSON.parse(c.content[0].text) };
  };

  test("authentication and scopes", async () => {
    expect((await call("GET", "/api/health")).status).toBe(200);
    expect((await call("GET", "/api/sources")).status).toBe(401);
    expect((await call("GET", "/api/sources", "wrong")).status).toBe(401);
    expect((await call("GET", "/api/sources", READER)).status).toBe(200);
    expect((await call("POST", "/api/sources/test/backup", READER)).status).toBe(403);
    expect((await call("POST", "/api/sources/nope/backup", ADMIN)).status).toBe(404);
  });

  test("backup via API, history, retention", async () => {
    const r1 = await call("POST", "/api/sources/test/backup?wait=1", ADMIN);
    expect(r1.body.status).toBe("ok");
    expect(r1.body.snapshot).toMatch(/^[0-9a-f]{64}$/);
    await call("POST", "/api/sources/test/backup?wait=1", ADMIN);
    const r3 = await call("POST", "/api/sources/test/backup?wait=1", ADMIN);
    expect(r3.body.summary).toContain("retention removed 1");
    const snaps = await call("GET", "/api/repos/main/snapshots", READER);
    expect(snaps.body.length).toBe(2);
    const runs = await call("GET", "/api/runs?source=test", READER);
    expect(runs.body.runs.length).toBe(3);
    const src = (await call("GET", "/api/sources", READER)).body[0];
    expect(src.last.status).toBe("ok");
    expect(src.next).toBeTruthy();
  });

  test("MCP: initialize, tools/list by scope, notifications", async () => {
    const init = await mcp(READER, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } });
    expect(init.body.result.protocolVersion).toBe("2025-06-18");
    expect(init.body.result.serverInfo.name).toBe("arca");
    expect((await mcp(READER, "notifications/initialized", undefined, true)).status).toBe(202);
    const readerTools = (await mcp(READER, "tools/list")).body.result.tools.map((t: any) => t.name);
    expect(readerTools).toContain("snapshots_list");
    expect(readerTools).not.toContain("backup_run");
    expect(readerTools).not.toContain("snapshot_restore");
    const adminTools = (await mcp(ADMIN, "tools/list")).body.result.tools.map((t: any) => t.name);
    expect(adminTools).toContain("snapshot_restore");
    const denied = await tool(READER, "backup_run", { source: "test" });
    expect(denied.isError).toBe(true);
  });

  test("MCP: backup, browse, restore into restoreRoot", async () => {
    await writeFile(join(src, "hello.txt"), "new version\n");
    const b = await tool(ADMIN, "backup_run", { source: "test" });
    expect(b.data.status).toBe("ok");
    const list = await tool(READER, "snapshots_list", { repo: "main", source: "test" });
    expect(list.data.length).toBe(2);
    const ls = await tool(READER, "snapshot_ls", { repo: "main", snapshot: "latest", path: "docs" });
    expect(ls.data.items.map((i: any) => i.name)).toEqual(["copy-of-big.bin", "deep"]);
    expect(ls.data.items[0].content).toBeUndefined();

    const bad = await tool(ADMIN, "snapshot_restore", { repo: "main", snapshot: "latest", target: "../escape" });
    expect(bad.isError).toBe(true);
    const r = await tool(ADMIN, "snapshot_restore", { repo: "main", snapshot: "latest", target: "t1", path: "hello.txt" });
    expect(r.data.status).toBe("ok");
    expect(await readFile(join(cfg.restoreRoot, "t1/hello.txt"), "utf8")).toBe("new version\n");
  });

  test("check via MCP and the scheduler", async () => {
    const c = await tool(ADMIN, "repo_check", { repo: "main", readData: 1 });
    expect(c.data.status).toBe("ok");
    expect(svc.dueAt(new Date("2026-10-29T03:00:00"))).toEqual([{ kind: "backup", name: "test" }]);
    expect(svc.dueAt(new Date("2026-11-01T04:30:00"))).toEqual([{ kind: "prune", name: "main" }]);
    expect(svc.dueAt(new Date("2026-10-29T05:00:00"))).toEqual([]); // check disabled ("")
  });

  test("a failing job lands in the history instead of crashing the server", async () => {
    svc.cfg.sources.broken = { path: "/nonexistent-arca-test", repo: "main" };
    const r = await call("POST", "/api/sources/broken/backup?wait=1", ADMIN);
    expect(r.body.status).toBe("error");
    expect(r.body.summary).toContain("nonexistent");
    delete svc.cfg.sources.broken;
  });
});
