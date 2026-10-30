/**
 * MCP server (Streamable HTTP, JSON responses only, no SSE and no sessions): agents run backups,
 * browse snapshots and restore. The protocol is JSON-RPC 2.0 in the body of POST /mcp.
 */
import type { Run } from "./db";
import { type Service, HttpError } from "./service";
import type { TokenConf } from "./config";
import { VERSION } from "../version";

type Scope = TokenConf["scopes"][number];

interface Tool {
  name: string;
  description: string;
  scope: Scope;
  inputSchema: Record<string, unknown>;
  run: (svc: Service, args: any, who: TokenConf) => Promise<unknown>;
}

const str = (description: string) => ({ type: "string", description });
const obj = (props: Record<string, unknown>, required: string[] = []) => ({
  type: "object",
  properties: props,
  required,
  additionalProperties: false,
});

/** Wait for the run at most timeoutSec; otherwise return the current state (the agent can wait via run_get). */
/** Wait limit: Bun.serve drops the connection after 255 s of idle time. */
const MAX_WAIT_SEC = 240;

async function waitRun(svc: Service, r: { runId: number; done: Promise<Run> }, wait: boolean | undefined, timeoutSec = MAX_WAIT_SEC) {
  if (wait === false) return { runId: r.runId, status: "running" };
  let timer: ReturnType<typeof setTimeout> | undefined;
  const t = new Promise<null>((res) => (timer = setTimeout(() => res(null), Math.min(timeoutSec, MAX_WAIT_SEC) * 1000)));
  const run = await Promise.race([r.done, t]);
  clearTimeout(timer);
  return run ?? { runId: r.runId, status: "running", note: "Still running — check run_get" };
}

const waitProps = {
  wait: { type: "boolean", description: "Wait for completion (default: true)" },
  timeoutSec: { type: "integer", description: "How long to wait, in seconds (default and maximum: 240)" },
};

export const TOOLS: Tool[] = [
  {
    name: "sources_list",
    description: "Backup sources (directories on the server): path, repository, schedule, next run, last result.",
    scope: "read",
    inputSchema: obj({}),
    run: async (svc) => svc.sourcesInfo(),
  },
  {
    name: "repos_list",
    description: "Repositories (storages) and their maintenance schedules.",
    scope: "read",
    inputSchema: obj({}),
    run: async (svc) => svc.reposInfo(),
  },
  {
    name: "backup_run",
    description: "Run a source's backup now. The source's retention policy is applied after the backup.",
    scope: "backup",
    inputSchema: obj({ source: str("Source name (sources_list)"), ...waitProps }, ["source"]),
    run: async (svc, a, who) => waitRun(svc, svc.runBackup(a.source, `mcp:${who.name}`), a.wait, a.timeoutSec),
  },
  {
    name: "runs_list",
    description: "Run history (backups, retention, prune, check, restore), newest first, plus runs in progress.",
    scope: "read",
    inputSchema: obj({
      source: str("Only this source"),
      repo: str("Only this repository"),
      kind: { type: "string", enum: ["backup", "prune", "check", "restore"] },
      limit: { type: "integer", description: "How many (default 20)" },
    }),
    run: async (svc, a) => ({
      active: svc.activeRuns(),
      runs: svc.db.list({ source: a.source, repo: a.repo, kind: a.kind, limit: a.limit ?? 20 }).map(({ details, ...r }) => r),
    }),
  },
  {
    name: "run_get",
    description: "A single run in full: status, summary, stats, file read errors.",
    scope: "read",
    inputSchema: obj({ id: { type: "integer" } }, ["id"]),
    run: async (svc, a) => {
      const r = svc.db.get(a.id);
      if (!r) throw new HttpError(404, `Run ${a.id} not found`);
      return { ...r, progress: svc.activeRuns().find((x) => x.id === a.id)?.progress };
    },
  },
  {
    name: "snapshots_list",
    description: "Snapshots in a repository, oldest first. ids can be shortened to 8 characters.",
    scope: "read",
    inputSchema: obj({ repo: str("Repository (repos_list)"), source: str("Only this source") }, ["repo"]),
    run: async (svc, a, who) =>
      (await svc.snapshots(a.repo, { source: a.source, owner: ownerFilter(who) })).map(({ id, snapshot: s }) => ({
        id: id.slice(0, 16),
        time: s.time,
        source: s.source,
        host: s.host,
        tags: s.tags,
        stats: s.stats,
      })),
  },
  {
    name: "snapshot_ls",
    description: "Snapshot contents: files and directories at a path (default: the root).",
    scope: "read",
    inputSchema: obj(
      {
        repo: str("Repository"),
        snapshot: str("Snapshot id, its prefix, or latest"),
        path: str("Path inside the snapshot"),
        recursive: { type: "boolean" },
        limit: { type: "integer", description: "Maximum number of entries (default 500)" },
      },
      ["repo", "snapshot"],
    ),
    run: async (svc, a) => svc.ls(a.repo, a.snapshot, a.path ?? "", !!a.recursive, Math.min(a.limit ?? 500, 5000)),
  },
  {
    name: "snapshot_restore",
    description:
      "Restore a snapshot or part of it on the server into a new directory inside the restore directory (restoreRoot). " +
      "Never overwrites existing files. Returns the absolute path of the result.",
    scope: "restore",
    inputSchema: obj(
      {
        repo: str("Repository"),
        snapshot: str("Snapshot id, prefix, or latest"),
        path: str("What to restore inside the snapshot (default: everything)"),
        target: str("Name of the new subdirectory in restoreRoot (default: generated)"),
        ...waitProps,
      },
      ["repo", "snapshot"],
    ),
    run: async (svc, a, who) => waitRun(svc, svc.runRestore(a.repo, a.snapshot, { path: a.path, target: a.target }, `mcp:${who.name}`), a.wait, a.timeoutSec),
  },
  {
    name: "repo_check",
    description: "Check repository integrity. readData is the share of packs (0..1) to download and decrypt.",
    scope: "backup",
    inputSchema: obj({ repo: str("Repository"), readData: { type: "number" }, ...waitProps }, ["repo"]),
    run: async (svc, a, who) => waitRun(svc, svc.runCheck(a.repo, `mcp:${who.name}`, a.readData), a.wait, a.timeoutSec),
  },
];

export function allowed(who: TokenConf, scope: Scope) {
  return who.scopes.includes("admin") || who.scopes.includes(scope);
}

export function ownerFilter(who: TokenConf): string | undefined {
  return who.scopes.includes("admin") ? undefined : who.owner;
}

const PROTOCOLS = ["2025-06-18", "2025-03-26", "2024-11-05"];

interface RpcReq {
  jsonrpc: "2.0";
  id?: string | number | null;
  method: string;
  params?: any;
}

async function handleOne(svc: Service, who: TokenConf, m: RpcReq): Promise<unknown | undefined> {
  const reply = (result: unknown) => ({ jsonrpc: "2.0", id: m.id, result });
  const fail = (code: number, message: string) => ({ jsonrpc: "2.0", id: m.id ?? null, error: { code, message } });
  if (m.id === undefined) return undefined; // notification (notifications/initialized etc.)
  switch (m.method) {
    case "initialize": {
      const v = m.params?.protocolVersion;
      return reply({
        protocolVersion: PROTOCOLS.includes(v) ? v : PROTOCOLS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "arca", version: VERSION },
        instructions:
          "Arca: encrypted, deduplicated backups of server directories. " +
          "sources_list — what is backed up; backup_run — run now; snapshots_list/snapshot_ls — browse backups; " +
          "snapshot_restore — restore into a new directory on the server (overwrites nothing).",
      });
    }
    case "ping":
      return reply({});
    case "tools/list":
      return reply({
        tools: TOOLS.filter((t) => allowed(who, t.scope)).map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
      });
    case "tools/call": {
      const t = TOOLS.find((x) => x.name === m.params?.name);
      if (!t) return fail(-32602, `Unknown tool: ${m.params?.name}`);
      if (!allowed(who, t.scope)) return reply({ content: [{ type: "text", text: `Missing scope "${t.scope}" for ${t.name}` }], isError: true });
      try {
        const out = await t.run(svc, m.params?.arguments ?? {}, who);
        return reply({ content: [{ type: "text", text: JSON.stringify(out, null, 2) }] });
      } catch (e: any) {
        return reply({ content: [{ type: "text", text: e?.message ?? String(e) }], isError: true });
      }
    }
    default:
      return fail(-32601, `Method not supported: ${m.method}`);
  }
}

export async function handleMcp(svc: Service, who: TokenConf, req: Request): Promise<Response> {
  if (req.method !== "POST") return new Response("POST only", { status: 405, headers: { Allow: "POST" } });
  let body: any;
  try {
    body = await req.json();
  } catch {
    return Response.json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Invalid JSON" } }, { status: 400 });
  }
  const batch = Array.isArray(body);
  const msgs: RpcReq[] = batch ? body : [body];
  const out = (await Promise.all(msgs.map((m) => handleOne(svc, who, m)))).filter((x) => x !== undefined);
  if (out.length === 0) return new Response(null, { status: 202 });
  return Response.json(batch ? out : out[0]);
}
