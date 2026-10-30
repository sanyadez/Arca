/** Web UI backend: sessions, CSRF, static files, overview, run filters and the SSE stream of a run. */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { validateConfig, type Config } from "../src/server/config";
import { Service } from "../src/server/service";
import { RunsDb } from "../src/server/db";
import { hashToken, makeHandler } from "../src/server/http";
import { LocalBackend } from "../src/backends/local";
import { Repository } from "../src/core/repo";
import { FAST_KDF, SMALL_CHUNKER, cleanup, makeTree, tmp } from "./helpers";

const ADMIN = "admin-token";
const READER = "reader-token";
let svc: Service;
let handler: (r: Request) => Promise<Response>;
let cfg: Config;

beforeAll(async () => {
  const root = await tmp("arca-test-web-");
  await makeTree(join(root, "src"));
  await Repository.init(new LocalBackend(join(root, "repo")), "pw", { kdf: FAST_KDF, chunker: SMALL_CHUNKER });
  await writeFile(join(root, "pass"), "pw\n");
  cfg = validateConfig(
    {
      dataDir: join(root, "data"),
      tokens: [
        { name: "admin", sha256: hashToken(ADMIN), scopes: ["admin"] },
        { name: "reader", sha256: hashToken(READER), scopes: ["read"] },
      ],
      repos: { main: { url: join(root, "repo"), passwordFile: join(root, "pass") } },
      sources: {
        docs: { path: join(root, "src"), repo: "main", schedule: "0 3 * * *" },
        broken: { path: join(root, "missing"), repo: "main" },
      },
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

/** Response body as untyped JSON (tests look into it freely). */
const j = (r: Response): Promise<any> => r.json();

function req(method: string, path: string, o: { token?: string; cookie?: string; csrf?: boolean; body?: unknown } = {}) {
  const headers: Record<string, string> = {};
  if (o.token) headers.authorization = `Bearer ${o.token}`;
  if (o.cookie) headers.cookie = o.cookie;
  if (o.csrf) headers["x-arca-request"] = "1";
  if (o.body !== undefined) headers["content-type"] = "application/json";
  return handler(new Request(`http://x${path}`, { method, headers, body: o.body === undefined ? undefined : JSON.stringify(o.body) }));
}

async function signIn(token: string, remember = false) {
  const r = await req("POST", "/api/session", { body: { token, remember } });
  expect(r.status).toBe(200);
  const set = r.headers.get("set-cookie")!;
  expect(set).toContain("HttpOnly");
  expect(set).toContain("SameSite=Strict");
  return set.split(";")[0]!;
}

describe("sessions", () => {
  test("token → cookie, CSRF header for writes, sign out", async () => {
    expect((await req("POST", "/api/session", { body: { token: "nope" } })).status).toBe(401);
    const cookie = await signIn(ADMIN);
    const me = await j(await req("GET", "/api/session", { cookie }));
    expect(me).toMatchObject({ name: "admin", via: "session" });
    expect((await req("POST", "/api/sources/docs/backup", { cookie })).status).toBe(403);
    expect((await req("POST", "/api/sources/docs/backup?wait=1", { cookie, csrf: true })).status).toBe(200);
    expect((await req("DELETE", "/api/session", { cookie, csrf: true })).status).toBe(200);
    const after = await req("GET", "/api/session", { cookie });
    expect(after.status).toBe(401);
    expect((await j(after)).reason).toBe("expired");
  });

  test("a removed token signs its sessions out; sign out everywhere", async () => {
    const reader = await signIn(READER, true);
    const a = await signIn(ADMIN);
    const b = await signIn(ADMIN);
    const saved = cfg.tokens;
    cfg.tokens = saved.filter((t) => t.name !== "reader");
    const gone = await req("GET", "/api/session", { cookie: reader });
    expect((await j(gone)).reason).toBe("revoked");
    cfg.tokens = saved;
    const out = await j(await req("DELETE", "/api/sessions", { cookie: a, csrf: true }));
    expect(out.closed).toBe(2);
    expect((await req("GET", "/api/session", { cookie: b })).status).toBe(401);
  });

  test("scopes still apply to sessions", async () => {
    const cookie = await signIn(READER);
    expect((await req("GET", "/api/overview", { cookie })).status).toBe(200);
    expect((await req("POST", "/api/sources/docs/backup", { cookie, csrf: true })).status).toBe(403);
  });
});

describe("static UI", () => {
  test("index, assets, security headers", async () => {
    const index = await req("GET", "/");
    expect(index.status).toBe(200);
    expect(index.headers.get("content-type")).toContain("text/html");
    expect(index.headers.get("content-security-policy")).toContain("script-src 'self'");
    expect(await index.text()).toContain("/assets/app.js");
    const js = await req("GET", "/assets/app.js");
    expect(js.headers.get("content-type")).toContain("javascript");
    const etag = js.headers.get("etag")!;
    expect((await handler(new Request("http://x/assets/app.js", { headers: { "if-none-match": etag } }))).status).toBe(304);
    expect((await req("GET", "/assets/nope.js")).status).toBe(404);
    expect((await req("GET", "/api/nope", { token: ADMIN })).status).toBe(404);
  });
});

describe("overview and runs", () => {
  test("overview reflects backups, errors and attention", async () => {
    await req("POST", "/api/sources/docs/backup?wait=1", { token: ADMIN });
    await req("POST", "/api/sources/broken/backup?wait=1", { token: ADMIN });
    await svc.computeRepoStats("main");
    const o = await j(await req("GET", "/api/overview", { token: READER }));
    const docs = o.sources.find((s: any) => s.name === "docs");
    expect(docs.status).toBe("ok");
    expect(docs.size).toBeGreaterThan(0);
    expect(docs.runs.at(-1)).toBe("ok");
    expect(docs.next).toBeTruthy();
    expect(o.attention.map((a: any) => a.name)).toEqual(["broken"]);
    expect(o.repos[0].stats.snapshots).toBeGreaterThan(0);
    expect(o.repos[0].stats.stored).toBeGreaterThan(0);
    expect(o.metrics.sources).toMatchObject({ total: 2, issues: 1 });
    expect(o.upcoming[0]).toHaveProperty("at");
  });

  test("filters, counts, trigger names", async () => {
    const all = await j(await req("GET", "/api/runs?days=7", { token: READER }));
    expect(all.total).toBeGreaterThan(2);
    expect(all.statusCounts.error).toBeGreaterThanOrEqual(1);
    const errs = await j(await req("GET", "/api/runs?status=error", { token: READER }));
    expect(errs.runs.every((r: any) => r.status === "error")).toBe(true);
    const api = await j(await req("GET", "/api/runs?trigger=api", { token: READER }));
    expect(api.runs[0].trigger).toMatch(/^api:/);
    const q = await j(await req("GET", "/api/runs?q=broken", { token: READER }));
    expect(q.runs.every((r: any) => r.source === "broken")).toBe(true);
    const one = await j(await req("GET", `/api/runs/${api.runs[0].id}`, { token: READER }));
    expect(one.log.length).toBeGreaterThan(0);
  });

  test("SSE stream of a run: init, log, progress, done", async () => {
    const started = await j(await req("POST", "/api/sources/docs/backup", { token: ADMIN }));
    const res = await req("GET", `/api/runs/${started.runId}/events`, { token: READER });
    expect(res.headers.get("content-type")).toBe("text/event-stream");
    const text = await res.text(); // the stream ends after "done"
    const events = [...text.matchAll(/^event: (\w+)$/gm)].map((m) => m[1]);
    expect(events[0]).toBe("init");
    expect(events).toContain("log");
    expect(events.at(-1)).toBe("done");
    const done = JSON.parse(text.trim().split("\n").at(-1)!.replace(/^data: /, ""));
    expect(done.run.status).toBe("ok");
    // a finished run streams only its state
    const again = await (await req("GET", `/api/runs/${started.runId}/events`, { token: READER })).text();
    expect([...again.matchAll(/^event: (\w+)$/gm)].map((m) => m[1])).toEqual(["init"]);
  });

  test("cancelling a queued run marks it interrupted", async () => {
    const a = await j(await req("POST", "/api/sources/docs/backup", { token: ADMIN }));
    const b = await j(await req("POST", "/api/sources/docs/backup", { token: ADMIN }));
    expect(svc.live(b.runId)?.status).toBe("queued");
    await req("POST", `/api/runs/${b.runId}/cancel`, { token: ADMIN });
    while (svc.live(a.runId) || svc.live(b.runId)) await Bun.sleep(20);
    const rb = await j(await req("GET", `/api/runs/${b.runId}`, { token: READER }));
    expect(rb.status).toBe("interrupted");
    expect(rb.summary).toBe("cancelled while queued");
  });
});
