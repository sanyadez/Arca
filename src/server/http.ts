/** HTTP API and MCP on top of Service. Everything except /api/health requires `Authorization: Bearer …`. */
import { createHash, timingSafeEqual } from "node:crypto";
import type { TokenConf } from "./config";
import { allowed, handleMcp, ownerFilter } from "./mcp";
import { HttpError, type Service } from "./service";
import type { Run } from "./db";
import { VERSION_STRING } from "../version";

export function hashToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

export function authenticate(tokens: TokenConf[], header: string | null): TokenConf | null {
  const m = /^Bearer\s+(.+)$/i.exec(header ?? "");
  if (!m) return null;
  const h = Buffer.from(hashToken(m[1]!.trim()), "hex");
  for (const t of tokens) {
    const want = Buffer.from(t.sha256, "hex");
    if (want.length === h.length && timingSafeEqual(want, h)) return t;
  }
  return null;
}

type Handler = (svc: Service, p: Record<string, string>, req: Request, who: TokenConf, url: URL) => Promise<unknown>;

async function waitParam(url: URL, r: { runId: number; done: Promise<Run> }) {
  if (url.searchParams.get("wait") !== "1") return { runId: r.runId, status: "running" };
  return r.done;
}

async function jsonBody(req: Request): Promise<any> {
  const t = await req.text();
  if (!t) return {};
  try {
    return JSON.parse(t);
  } catch {
    throw new HttpError(400, "Invalid JSON");
  }
}

const ROUTES: [string, string, TokenConf["scopes"][number], Handler][] = [
  ["GET", "/api/sources", "read", async (s) => s.sourcesInfo()],
  ["GET", "/api/repos", "read", async (s) => s.reposInfo()],
  ["POST", "/api/sources/:name/backup", "backup", async (s, p, _r, _w, u) => waitParam(u, s.runBackup(p.name!, "api"))],
  [
    "GET",
    "/api/runs",
    "read",
    async (s, _p, _r, _w, u) => ({
      active: s.activeRuns(),
      runs: s.db.list({
        source: u.searchParams.get("source") ?? undefined,
        repo: u.searchParams.get("repo") ?? undefined,
        kind: u.searchParams.get("kind") ?? undefined,
        limit: Number(u.searchParams.get("limit") ?? 50),
      }),
    }),
  ],
  [
    "GET",
    "/api/runs/:id",
    "read",
    async (s, p) => {
      const r = s.db.get(Number(p.id));
      if (!r) throw new HttpError(404, "Run not found");
      return { ...r, progress: s.activeRuns().find((x) => x.id === r.id)?.progress };
    },
  ],
  ["POST", "/api/runs/:id/cancel", "backup", async (s, p) => ({ cancelled: s.cancel(Number(p.id)) })],
  [
    "GET",
    "/api/repos/:name/snapshots",
    "read",
    async (s, p, _r, w, u) => s.snapshots(p.name!, { source: u.searchParams.get("source") ?? undefined, owner: ownerFilter(w) }),
  ],
  [
    "GET",
    "/api/repos/:name/snapshots/:id/ls",
    "read",
    async (s, p, _r, _w, u) =>
      s.ls(p.name!, p.id!, u.searchParams.get("path") ?? "", u.searchParams.get("recursive") === "1", Number(u.searchParams.get("limit") ?? 1000)),
  ],
  [
    "POST",
    "/api/repos/:name/snapshots/:id/restore",
    "restore",
    async (s, p, r, _w, u) => {
      const b = await jsonBody(r);
      return waitParam(u, s.runRestore(p.name!, p.id!, { path: b.path, target: b.target }, "api"));
    },
  ],
  [
    "POST",
    "/api/repos/:name/check",
    "backup",
    async (s, p, r, _w, u) => waitParam(u, s.runCheck(p.name!, "api", (await jsonBody(r)).readData)),
  ],
  ["POST", "/api/repos/:name/prune", "admin", async (s, p, _r, _w, u) => waitParam(u, s.runPrune(p.name!, "api"))],
];

function match(pattern: string, path: string): Record<string, string> | null {
  const a = pattern.split("/");
  const b = path.split("/");
  if (a.length !== b.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < a.length; i++) {
    if (a[i]!.startsWith(":")) params[a[i]!.slice(1)] = decodeURIComponent(b[i]!);
    else if (a[i] !== b[i]) return null;
  }
  return params;
}

export function makeHandler(svc: Service) {
  return async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    try {
      if (url.pathname === "/api/health") return Response.json({ ok: true, version: VERSION_STRING });
      const who = authenticate(svc.cfg.tokens, req.headers.get("authorization"));
      if (!who) return Response.json({ error: "Token required" }, { status: 401, headers: { "WWW-Authenticate": "Bearer" } });
      if (url.pathname === "/mcp") return await handleMcp(svc, who, req);
      for (const [method, pattern, scope, h] of ROUTES) {
        const p = match(pattern, url.pathname);
        if (!p || method !== req.method) continue;
        if (!allowed(who, scope)) return Response.json({ error: `Missing scope "${scope}"` }, { status: 403 });
        return Response.json(await h(svc, p, req, who, url));
      }
      return Response.json({ error: "Not found" }, { status: 404 });
    } catch (e: any) {
      const status = e instanceof HttpError ? e.status : 500;
      return Response.json({ error: e?.message ?? String(e) }, { status });
    }
  };
}
