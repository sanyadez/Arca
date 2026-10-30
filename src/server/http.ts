/**
 * HTTP API, MCP and the web UI on top of Service. Everything except /api/health, sign-in and the
 * UI's static files requires a token (`Authorization: Bearer …`) or a UI session cookie (auth.ts).
 */
import type { TokenConf } from "./config";
import { CSRF_HEADER, clearCookie, resolveCaller, startSession, tokenFromSecret } from "./auth";
import { serveUi } from "./ui";
import * as admin from "./admin";
import { allowed, handleMcp, ownerFilter } from "./mcp";
import { HttpError, type Service } from "./service";
import type { Run } from "./db";
import { VERSION, VERSION_STRING } from "../version";
import { hostname } from "node:os";

export { authenticate, hashToken } from "./auth";

type Handler = (svc: Service, p: Record<string, string>, req: Request, who: TokenConf, url: URL) => Promise<unknown>;

/** Run trigger as shown in history: "api:<token>" — who started it. */
const by = (who: TokenConf) => `api:${who.name}`;

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
  ["GET", "/api/overview", "read", async (s) => s.overview()],
  // admin: config changes and the helpers of the forms
  ["POST", "/api/sources", "admin", async (s, _p, r) => admin.createSource(s, await jsonBody(r))],
  ["PUT", "/api/sources/:name", "admin", async (s, p, r) => admin.updateSource(s, p.name!, await jsonBody(r))],
  ["DELETE", "/api/sources/:name", "admin", async (s, p) => admin.deleteSource(s, p.name!)],
  ["POST", "/api/sources/:name/exclude", "admin", async (s, p, r) => admin.addExclude(s, p.name!, (await jsonBody(r)).pattern)],
  ["POST", "/api/sources/preview", "admin", async (s, _p, r) => admin.previewSource(s, await jsonBody(r))],
  ["POST", "/api/repos", "admin", async (s, _p, r) => admin.createRepo(s, await jsonBody(r))],
  ["POST", "/api/repos/test", "admin", async (_s, _p, r) => admin.testStorage((await jsonBody(r)).url)],
  ["PUT", "/api/repos/:name", "admin", async (s, p, r) => admin.updateRepo(s, p.name!, await jsonBody(r))],
  ["DELETE", "/api/repos/:name", "admin", async (s, p) => admin.removeRepo(s, p.name!)],
  ["POST", "/api/repos/:name/prune-preview", "admin", async (s, p) => admin.prunePreview(s, p.name!)],
  ["GET", "/api/tokens", "admin", async (s) => admin.listTokens(s)],
  ["POST", "/api/tokens", "admin", async (s, _p, r) => admin.createToken(s, await jsonBody(r))],
  ["DELETE", "/api/tokens/:name", "admin", async (s, p) => admin.revokeToken(s, p.name!)],
  ["GET", "/api/ssh/key", "admin", async (s) => admin.sshKey(s)],
  ["GET", "/api/cron", "read", async (_s, _p, _r, _w, u) => admin.cronPreview(u.searchParams.get("expr") ?? "")],
  ["POST", "/api/retention/preview", "read", async (_s, _p, r) => {
    const b = await jsonBody(r);
    return admin.retentionPreview(String(b.schedule ?? ""), b.retention ?? {});
  }],
  ["GET", "/api/recovery", "read", async (s) => admin.recoveryInfo(s)],
  ["PUT", "/api/recovery", "admin", async (s, _p, r) => admin.setRecoveryState(s, await jsonBody(r))],
  ["GET", "/api/sources/:name", "read", async (s, p) => s.sourceDetail(p.name!)],
  [
    "GET",
    "/api/snapshots",
    "read",
    async (s, _p, _r, w, u) => {
      const q = (k: string) => u.searchParams.get(k) || undefined;
      return s.allSnapshots({ repo: q("repo"), source: q("source"), host: q("host"), tag: q("tag"), owner: ownerFilter(w) });
    },
  ],
  [
    "GET",
    "/api/search",
    "read",
    async (s, _p, r, w, u) => {
      const q = (k: string) => u.searchParams.get(k) || undefined;
      return s.searchFiles(q("q") ?? "", { repo: q("repo"), source: q("source"), snapshot: q("snapshot"), owner: ownerFilter(w), limit: Number(q("limit") ?? 200) }, r.signal);
    },
  ],
  ["GET", "/api/repos/:name/snapshots/:id", "read", async (s, p) => s.snapshotInfo(p.name!, p.id!)],
  [
    "GET",
    "/api/repos/:name/snapshots/:id/browse",
    "read",
    async (s, p, _r, _w, u) =>
      s.browse(p.name!, p.id!, u.searchParams.get("path") ?? "", {
        compare: u.searchParams.get("compare") === "1",
        limit: Number(u.searchParams.get("limit") ?? 500),
        offset: Number(u.searchParams.get("offset") ?? 0),
      }),
  ],
  [
    "POST",
    "/api/repos/:name/forget",
    "admin",
    async (s, p, r) => {
      const b = await jsonBody(r);
      if (!Array.isArray(b.ids) || b.ids.length === 0) throw new HttpError(400, "ids: a list of snapshot ids is required");
      return s.forgetSnapshots(p.name!, b.ids.map(String));
    },
  ],
  ["POST", "/api/sources/:name/backup", "backup", async (s, p, _r, w, u) => waitParam(u, s.runBackup(p.name!, by(w)))],
  [
    "GET",
    "/api/runs",
    "read",
    async (s, _p, _r, _w, u) => {
      const q = (k: string) => u.searchParams.get(k) || undefined;
      const days = Number(q("days") ?? 0);
      const base = { source: q("source"), repo: q("repo"), q: q("q"), since: days > 0 ? new Date(Date.now() - days * 86400_000).toISOString() : undefined };
      const filter = { ...base, kind: q("kind"), status: q("status"), trigger: q("trigger") };
      return {
        active: s.activeRuns(),
        runs: s.db.list({ ...filter, limit: Number(q("limit") ?? 50), offset: Number(q("offset") ?? 0) }).map(({ details, ...r }) => r),
        total: s.db.count(filter),
        // per status without the status filter itself, for the filter chips
        statusCounts: s.db.statusCounts({ ...base, kind: filter.kind, trigger: filter.trigger }),
      };
    },
  ],
  [
    "GET",
    "/api/runs/:id",
    "read",
    async (s, p) => {
      const r = s.db.get(Number(p.id));
      if (!r) throw new HttpError(404, "Run not found");
      const live = s.live(r.id);
      return { ...r, progress: live?.progress ?? null, log: live ? live.log : (r.details?.log ?? []) };
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
      const paths = Array.isArray(b.paths) ? b.paths.map(String) : undefined;
      return waitParam(u, s.runRestore(p.name!, p.id!, { path: b.path, paths, target: b.target, verify: !!b.verify, owners: b.owners }, by(_w)));
    },
  ],
  [
    "POST",
    "/api/repos/:name/check",
    "backup",
    async (s, p, r, w, u) => waitParam(u, s.runCheck(p.name!, by(w), (await jsonBody(r)).readData)),
  ],
  ["POST", "/api/repos/:name/prune", "admin", async (s, p, _r, w, u) => waitParam(u, s.runPrune(p.name!, by(w)))],
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

/** Server-sent events of one run: its current state first, then progress, log lines and the end. */
function runEvents(svc: Service, id: number, req: Request): Response {
  const run = svc.db.get(id);
  if (!run) throw new HttpError(404, "Run not found");
  const live = svc.live(id);
  const enc = new TextEncoder();
  let cleanup = () => {};
  const stream = new ReadableStream<Uint8Array>({
    start(ctl) {
      const send = (event: string, data: unknown) => {
        try {
          ctl.enqueue(enc.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
        } catch {
          cleanup();
        }
      };
      const close = () => {
        cleanup();
        try {
          ctl.close();
        } catch {}
      };
      const { details, ...row } = run;
      send("init", { run: row, status: live?.status ?? run.status, progress: live?.progress ?? null, log: live ? live.log : (details?.log ?? []) });
      if (!live) return close();
      const ping = setInterval(() => {
        try {
          ctl.enqueue(enc.encode(": ping\n\n"));
        } catch {
          cleanup();
        }
      }, 15_000);
      const off = live.subscribe((e) => {
        if (e.type === "done") {
          const { details: _d, ...done } = e.run;
          send("done", { run: done });
          close();
        } else send(e.type, e);
      });
      cleanup = () => {
        clearInterval(ping);
        off();
      };
      req.signal.addEventListener("abort", () => cleanup());
    },
    cancel() {
      cleanup();
    },
  });
  return new Response(stream, { headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-store", "X-Accel-Buffering": "no" } });
}

const noStore = { "Cache-Control": "no-store" };

export function makeHandler(svc: Service) {
  return async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    try {
      if (url.pathname === "/api/health") return Response.json({ ok: true, version: VERSION_STRING, host: hostname() });
      if (!url.pathname.startsWith("/api/") && url.pathname !== "/mcp") return serveUi(url.pathname, req);

      // Sign-in: exchange a token for a session cookie.
      if (url.pathname === "/api/session" && req.method === "POST") {
        const b = await jsonBody(req);
        const who = typeof b.token === "string" ? tokenFromSecret(svc.cfg.tokens, b.token) : null;
        if (!who) {
          await Bun.sleep(400); // slows down guessing
          return Response.json({ error: "This token is not valid on this server", reason: "invalid" }, { status: 401, headers: noStore });
        }
        const cookie = startSession(svc.db, req, who, !!b.remember);
        return Response.json({ name: who.name, scopes: who.scopes }, { headers: { ...noStore, "Set-Cookie": cookie } });
      }

      const auth = resolveCaller(req, svc.cfg.tokens, svc.db);
      if (!auth.ok) {
        if (auth.reason === "csrf") return Response.json({ error: `Missing ${CSRF_HEADER} header` }, { status: 403 });
        return Response.json(
          { error: auth.reason === "revoked" ? "The token of this session was revoked" : auth.reason === "expired" ? "The session has expired" : "Token required", reason: auth.reason },
          { status: 401, headers: { "WWW-Authenticate": "Bearer", ...noStore } },
        );
      }
      const who = auth.who;
      admin.noteTokenUse(svc, who, auth.via === "session" ? "web" : url.pathname === "/mcp" ? "MCP" : "API");
      if (url.pathname === "/mcp") return await handleMcp(svc, who, req);
      if (url.pathname === "/api/recovery/arca-restore" && req.method === "GET") {
        const bin = await admin.restoreBinary();
        if (!bin) return Response.json({ error: "arca-restore is not next to this server's binary (development run?)" }, { status: 404 });
        return new Response(Bun.file(bin.path), {
          headers: { "Content-Type": "application/octet-stream", "Content-Disposition": `attachment; filename="arca-restore-${VERSION}-linux-${process.arch === "arm64" ? "arm64" : "x64"}"` },
        });
      }

      if (url.pathname === "/api/session") {
        if (req.method === "GET")
          return Response.json({ name: who.name, scopes: who.scopes, via: auth.via, server: svc.overview().server }, { headers: noStore });
        if (req.method === "DELETE") {
          if (auth.sessionId) svc.db.deleteSession(auth.sessionId);
          return Response.json({ ok: true }, { headers: { "Set-Cookie": clearCookie(req) } });
        }
      }
      if (url.pathname === "/api/sessions" && req.method === "DELETE") {
        const closed = svc.db.deleteSessionsOf(who.sha256);
        return Response.json({ closed }, { headers: { "Set-Cookie": clearCookie(req) } });
      }
      const ev = /^\/api\/runs\/(\d+)\/events$/.exec(url.pathname);
      if (ev && req.method === "GET") {
        if (!allowed(who, "read")) return Response.json({ error: `Missing scope "read"` }, { status: 403 });
        return runEvents(svc, Number(ev[1]), req);
      }

      for (const [method, pattern, scope, h] of ROUTES) {
        const p = match(pattern, url.pathname);
        if (!p || method !== req.method) continue;
        if (!allowed(who, scope)) return Response.json({ error: `Missing scope "${scope}"` }, { status: 403 });
        return Response.json(await h(svc, p, req, who, url), { headers: noStore });
      }
      return Response.json({ error: "Not found" }, { status: 404 });
    } catch (e: any) {
      const status = e instanceof HttpError ? e.status : 500;
      return Response.json({ error: e?.message ?? String(e) }, { status });
    }
  };
}
