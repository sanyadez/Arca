/** Admin API: config changes written to the file and applied live, tokens, previews, recovery state. */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { loadConfig } from "../src/server/config";
import { ConfigStore } from "../src/server/configstore";
import { Service } from "../src/server/service";
import { RunsDb } from "../src/server/db";
import { hashToken, makeHandler } from "../src/server/http";
import { cleanup, makeTree, tmp } from "./helpers";

const ADMIN = "admin-secret";
let dir: string;
let cfgPath: string;
let svc: Service;
let handler: (r: Request) => Promise<Response>;

beforeAll(async () => {
  dir = await tmp("arca-test-admin-");
  await makeTree(join(dir, "src"));
  cfgPath = join(dir, "config.json");
  await writeFile(cfgPath, JSON.stringify({ dataDir: "data", tokens: [{ name: "admin", sha256: hashToken(ADMIN), scopes: ["admin"] }], repos: {}, sources: {} }));
  svc = new Service(await loadConfig(cfgPath), () => {}, new RunsDb(":memory:"), new ConfigStore(cfgPath));
  handler = makeHandler(svc);
});
afterAll(async () => {
  await svc.stop();
  await cleanup();
});

const j = (r: Response): Promise<any> => r.json();
const call = (method: string, path: string, body?: unknown, token = ADMIN) =>
  handler(new Request(`http://x${path}`, { method, headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) }));
const onDisk = async () => JSON.parse(await readFile(cfgPath, "utf8"));

describe("repositories and sources", () => {
  test("test storage, create a repository, add, edit and remove a source", async () => {
    const url = join(dir, "repo");
    expect(await j(await call("POST", "/api/repos/test", { url }))).toMatchObject({ reachable: true, isRepo: false, empty: true });
    expect((await call("POST", "/api/repos", { name: "main", url, password: "short", create: true })).status).toBe(400);
    const r = await call("POST", "/api/repos", { name: "main", url, password: "correct horse battery", create: true });
    expect(r.status).toBe(200);
    const disk = await onDisk();
    expect(disk.repos.main.url).toBe(url);
    expect(JSON.stringify(disk)).not.toContain("correct horse");
    expect(await readFile(disk.repos.main.passwordFile, "utf8")).toBe("correct horse battery\n");
    expect((await stat(cfgPath)).mode & 0o777).toBe(0o600);
    expect(await j(await call("POST", "/api/repos/test", { url }))).toMatchObject({ isRepo: true });
    expect((await call("POST", "/api/repos", { name: "again", url, password: "correct horse battery", create: true })).status).toBe(409);

    const bad = await call("POST", "/api/sources", { name: "docs", path: join(dir, "src"), repo: "nope" });
    expect(bad.status).toBe(400);
    expect((await j(bad)).error).toContain("unknown repository");
    const ok = await call("POST", "/api/sources", { name: "docs", path: join(dir, "src"), repo: "main", schedule: "30 2 * * *", exclude: ["*.log"], retention: { daily: 7, last: 0 } });
    expect(ok.status).toBe(200);
    expect((await onDisk()).sources.docs).toEqual({ path: join(dir, "src"), repo: "main", schedule: "30 2 * * *", exclude: ["*.log"], retention: { daily: 7 } });
    // applied live: the new source backs up without a restart
    const b = await j(await call("POST", "/api/sources/docs/backup?wait=1"));
    expect(b.status).toBe("ok");
    expect((await call("PUT", "/api/sources/docs", { path: join(dir, "src"), repo: "main", schedule: "bad cron" })).status).toBe(400);
    expect((await onDisk()).sources.docs.schedule).toBe("30 2 * * *"); // an invalid change is never written
    expect((await call("DELETE", "/api/repos/main")).status).toBe(409); // still used
    const prev = await j(await call("POST", "/api/repos/main/prune-preview"));
    expect(prev).toMatchObject({ dryRun: true });
    expect((await call("DELETE", "/api/sources/docs")).status).toBe(200);
    expect(svc.cfg.sources.docs).toBeUndefined();
  }, 60_000);

  test("connect an existing repository checks the password", async () => {
    const url = join(dir, "repo");
    expect((await call("POST", "/api/repos", { name: "other", url, password: "wrong password!", create: false })).status).toBe(400);
  });

  test("source preview lists folders with sizes", async () => {
    const p = await j(await call("POST", "/api/sources/preview", { path: join(dir, "src") }));
    expect(p.ok).toBe(true);
    expect(p.dirs.find((d: any) => d.path === "docs").size).toBeGreaterThan(0);
    const missing = await j(await call("POST", "/api/sources/preview", { path: join(dir, "nope") }));
    expect(missing.ok).toBe(false);
  });
});

describe("tokens", () => {
  test("create, use, revoke; the last admin token stays", async () => {
    const t = await j(await call("POST", "/api/tokens", { name: "agent", scopes: ["read", "backup"], expiresDays: 30 }));
    expect(t.token).toMatch(/^arca_/);
    expect((await call("GET", "/api/overview", undefined, t.token)).status).toBe(200);
    const list = await j(await call("GET", "/api/tokens"));
    const agent = list.find((x: any) => x.name === "agent");
    expect(agent.usedBy).toEqual(["API"]);
    expect(agent.expires).toBeTruthy();
    expect((await call("GET", "/api/tokens", undefined, t.token)).status).toBe(403);
    expect((await call("DELETE", "/api/tokens/admin")).status).toBe(409);
    expect((await call("DELETE", "/api/tokens/agent")).status).toBe(200);
    expect((await call("GET", "/api/overview", undefined, t.token)).status).toBe(401);
  });

  test("an expired token is refused", async () => {
    const t = await j(await call("POST", "/api/tokens", { name: "short", scopes: ["read"] }));
    svc.cfg.tokens.find((x) => x.name === "short")!.expires = new Date(Date.now() - 1000).toISOString();
    expect((await call("GET", "/api/overview", undefined, t.token)).status).toBe(401);
  });
});

describe("previews and recovery", () => {
  test("cron and retention previews", async () => {
    const c = await j(await call("GET", "/api/cron?expr=" + encodeURIComponent("0 3 * * *")));
    expect(c.valid).toBe(true);
    expect(c.next).toHaveLength(5);
    expect((await j(await call("GET", "/api/cron?expr=nope"))).valid).toBe(false);
    const r = await j(await call("POST", "/api/retention/preview", { schedule: "0 3 * * *", retention: { daily: 7, weekly: 4, monthly: 12 } }));
    expect(r.runs).toBeGreaterThan(360);
    // 7 daily + weekly beyond them + monthly beyond those, counted once each
    expect(r.kept).toBeGreaterThan(18);
    expect(r.kept).toBeLessThan(24);
  });

  test("recovery state is remembered", async () => {
    await call("PUT", "/api/recovery", { saved: { main: true }, tested: true });
    const info = await j(await call("GET", "/api/recovery"));
    expect(info.state.saved.main).toBe(true);
    expect(info.state.testedAt).toBeTruthy();
  });
});
