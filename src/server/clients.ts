/**
 * Clients: machines running `arca client` that back up their own folders (sources `client://<name>/path`).
 *
 * A client calls the server, never the other way round, so it works behind NAT: it long-polls for jobs,
 * runs the backup with the same core locally (chunking, deduplication and encryption happen on the client),
 * reaches the repository through the storage proxy below, streams progress and log lines, and reports the
 * result. Schedules, the queue, the history and retention stay on the server.
 *
 * The storage proxy only appends: a client may add data, index and snapshot files (named by the sha256 of
 * their contents, which is checked) and manage locks, nothing else. A stolen client token cannot delete or
 * overwrite existing backups, and it reaches the storage only while one of its jobs is running.
 */
import { createHash } from "node:crypto";
import { openBackend, type Backend } from "../backends";
import { NotFoundError } from "../backends/types";
import { parseClientUrl } from "../sources";
import { repoPassword, type Config } from "./config";
import { HttpError, type JobControl } from "./service";

/** A client that polled within this time counts as online. */
export const ONLINE_MS = 75_000;
/** A running job whose client sent nothing for this long has failed. */
const SILENT_MS = 3 * 60_000;
/** A job nobody picked up in this time fails: the client went away. */
const PICKUP_MS = 2 * 60_000;
const POLL_MAX_MS = 30_000;

export interface ClientJob {
  runId: number;
  kind: "backup";
  source: string;
  /** Folder on the client machine. */
  path: string;
  exclude: string[];
  tags: string[];
  owner?: string;
  repo: string;
  password: string;
  /** Whether the storage reads parts of files (RemoteBackend uses ranged reads then). */
  ranged: boolean;
}

export interface ClientBackupResult {
  id: string;
  changed: number;
  stats: { files: number; dirs: number; bytes: number; newBlobs: number; newBytes: number; errors: number; seconds: number };
  errors: { path: string; error: string }[];
}

interface Pending {
  client: string;
  job: ClientJob;
  ctl: JobControl;
  picked: boolean;
  last: number;
  resolve: (r: ClientBackupResult) => void;
  reject: (e: Error) => void;
}

export interface ClientState {
  name: string;
  online: boolean;
  lastSeen: string | null;
  version: string | null;
  host: string | null;
  /** Run id of the job it is running now. */
  running: number | null;
}

type Meta = { at: number; version?: string; host?: string };

/** Storage files a client may write: the name is the sha256 of the contents. */
const CONTENT_FILE = /^(?:data\/[0-9a-f]{2}\/|index\/|snapshots\/)([0-9a-f]{64})$/;
const LOCK_FILE = /^locks\/[0-9a-f]{32}$/;
const READABLE = /^(?:config|keys\/[0-9a-f]{64}|data\/[0-9a-f]{2}\/[0-9a-f]{64}|index\/[0-9a-f]{64}|snapshots\/[0-9a-f]{64}|locks\/[0-9a-f]{32})$/;
const LISTABLE = new Set(["keys", "data", "index", "snapshots", "locks"]);

export class ClientHub {
  private seen = new Map<string, Meta>();
  private queued = new Map<string, Pending[]>();
  private running = new Map<number, Pending>();
  private waiters = new Map<string, Set<() => void>>();
  private backends = new Map<string, Backend>();
  private watchdog: ReturnType<typeof setInterval> | undefined;

  constructor(
    private cfg: () => Config,
    private persist: { get: <T>(k: string) => T | null; set: (k: string, v: unknown) => void },
  ) {}

  // ── presence ──

  touch(name: string, meta: { version?: string; host?: string } = {}) {
    const prev = this.seen.get(name) ?? this.persist.get<Meta>(`client:${name}`) ?? undefined;
    const now = Date.now();
    const next: Meta = { at: now, version: meta.version ?? prev?.version, host: meta.host ?? prev?.host };
    this.seen.set(name, next);
    // The database only needs "last seen" for after a restart: write it at most once a minute.
    if (!prev || now - prev.at > 60_000 || prev.version !== next.version || prev.host !== next.host) this.persist.set(`client:${name}`, next);
  }

  state(name: string): ClientState {
    const m = this.seen.get(name) ?? this.persist.get<Meta>(`client:${name}`);
    const run = [...this.running.values()].find((p) => p.client === name);
    return {
      name,
      online: !!m && Date.now() - m.at < ONLINE_MS,
      lastSeen: m ? new Date(m.at).toISOString() : null,
      version: m?.version ?? null,
      host: m?.host ?? null,
      running: run?.job.runId ?? null,
    };
  }

  /** Clients known from the config: tokens with the client scope. */
  names(): string[] {
    return this.cfg().tokens.filter((t) => t.scopes.includes("client")).map((t) => t.name);
  }

  // ── jobs, server side ──

  /** Run a backup on the client; resolves with its result. Fails at once if the client is offline. */
  async backup(sourceName: string, job: Omit<ClientJob, "password" | "ranged" | "path"> & { url: string }, ctl: JobControl): Promise<ClientBackupResult> {
    const { client, path } = parseClientUrl(job.url);
    if (!this.names().includes(client)) throw new Error(`Unknown client "${client}": add it with arca client add ${client}`);
    const st = this.state(client);
    if (!st.online) throw new Error(`Client ${client} is offline${st.lastSeen ? ` (last seen ${st.lastSeen})` : " (it has never connected)"}`);
    const rc = this.cfg().repos[job.repo]!;
    const full: ClientJob = {
      runId: job.runId,
      kind: "backup",
      source: sourceName,
      path,
      exclude: job.exclude,
      tags: job.tags,
      owner: job.owner,
      repo: job.repo,
      password: await repoPassword(job.repo, rc),
      ranged: this.backend(job.repo).ranged,
    };
    ctl.log("client", `Waiting for client ${client} to pick up the job`);
    return new Promise<ClientBackupResult>((resolve, reject) => {
      const p: Pending = { client, job: full, ctl, picked: false, last: Date.now(), resolve, reject };
      const q = this.queued.get(client) ?? [];
      q.push(p);
      this.queued.set(client, q);
      ctl.signal.addEventListener("abort", () => {
        if (p.picked) return; // the client learns it from the reply to its next event
        this.dropQueued(p);
        reject(new DOMException("cancelled while queued", "AbortError"));
      });
      this.wake(client);
      this.startWatchdog();
    });
  }

  private dropQueued(p: Pending) {
    const q = this.queued.get(p.client);
    if (q) this.queued.set(p.client, q.filter((x) => x !== p));
  }

  private wake(client: string) {
    for (const w of this.waiters.get(client) ?? []) w();
  }

  private startWatchdog() {
    if (this.watchdog) return;
    this.watchdog = setInterval(() => {
      const now = Date.now();
      for (const [client, q] of this.queued)
        for (const p of q.filter((x) => now - x.last > PICKUP_MS)) {
          this.dropQueued(p);
          p.reject(new Error(`Client ${client} did not pick up the job (it went offline)`));
        }
      for (const [id, p] of this.running)
        if (now - p.last > SILENT_MS) {
          this.running.delete(id);
          p.reject(new Error(`Client ${p.client} stopped responding during the backup`));
        }
      if (!this.running.size && ![...this.queued.values()].some((q) => q.length)) {
        clearInterval(this.watchdog);
        this.watchdog = undefined;
      }
    }, 5_000);
    this.watchdog.unref?.();
  }

  // ── jobs, client side (the HTTP API) ──

  /** Long poll: the next job for this client, or null after `waitMs`. */
  async poll(client: string, waitMs: number, signal?: AbortSignal): Promise<ClientJob | null> {
    const deadline = Date.now() + Math.min(Math.max(waitMs, 0), POLL_MAX_MS);
    for (;;) {
      this.touch(client);
      const p = this.queued.get(client)?.shift();
      if (p) {
        p.picked = true;
        p.last = Date.now();
        this.running.set(p.job.runId, p);
        p.ctl.log("client", `Client ${client} started the backup`);
        return p.job;
      }
      const left = deadline - Date.now();
      if (left <= 0 || signal?.aborted) return null;
      await new Promise<void>((resolve) => {
        const set = this.waiters.get(client) ?? new Set();
        this.waiters.set(client, set);
        const done = () => {
          clearTimeout(timer);
          set.delete(done);
          signal?.removeEventListener("abort", done);
          resolve();
        };
        const timer = setTimeout(done, left);
        set.add(done);
        signal?.addEventListener("abort", done);
      });
    }
  }

  private job(client: string, runId: number): Pending {
    const p = this.running.get(runId);
    if (!p || p.client !== client) throw new HttpError(404, `No running job #${runId} for this client`);
    return p;
  }

  /** Progress and log lines from the client. The reply tells it whether the run was cancelled. */
  event(client: string, runId: number, b: { progress?: unknown; logs?: { stage: string; text: string }[] }) {
    this.touch(client);
    const p = this.job(client, runId);
    p.last = Date.now();
    if (b.progress) p.ctl.progress(b.progress);
    for (const l of b.logs ?? []) p.ctl.log(String(l.stage), String(l.text));
    return { cancel: p.ctl.signal.aborted };
  }

  finish(client: string, runId: number, b: { ok: boolean; result?: ClientBackupResult; error?: string; cancelled?: boolean }) {
    this.touch(client);
    const p = this.job(client, runId);
    this.running.delete(runId);
    if (b.ok && b.result) p.resolve(b.result);
    else if (b.cancelled) p.reject(new DOMException(b.error ?? "cancelled", "AbortError"));
    else p.reject(new Error(b.error ?? "the client reported a failure"));
    return { ok: true };
  }

  // ── storage proxy ──

  private backend(repo: string): Backend {
    const url = this.cfg().repos[repo]?.url;
    if (!url) throw new HttpError(404, `Unknown repository: ${repo}`);
    let b = this.backends.get(url);
    if (!b) this.backends.set(url, (b = openBackend(url)));
    return b;
  }

  /** `/api/client/storage/<repo>/f/<path>` and `/api/client/storage/<repo>/list?dir=`. */
  async storage(client: string, repo: string, rest: string, req: Request, url: URL): Promise<Response> {
    this.touch(client);
    const job = [...this.running.values()].find((p) => p.client === client && p.job.repo === repo);
    if (!job) throw new HttpError(403, `No running job of this client uses repository ${repo}`);
    job.last = Date.now();
    const b = this.backend(repo);

    if (rest === "list" && req.method === "GET") {
      const dir = url.searchParams.get("dir") ?? "";
      if (!LISTABLE.has(dir)) throw new HttpError(403, `Not allowed to list ${dir}`);
      return Response.json({ files: await b.list(dir) });
    }
    if (!rest.startsWith("f/")) throw new HttpError(404, "Not found");
    const path = rest.slice(2);

    if (req.method === "GET" || req.method === "HEAD") {
      if (!READABLE.test(path)) throw new HttpError(403, `Not allowed to read ${path}`);
      if (req.method === "HEAD") return new Response(null, { status: (await b.exists(path)) ? 200 : 404 });
      const range = /^bytes=(\d+)-(\d+)$/.exec(req.headers.get("range") ?? "");
      try {
        let data: Uint8Array;
        if (range) {
          const offset = Number(range[1]);
          const length = Number(range[2]) - offset + 1;
          data = b.ranged ? await b.get(path, { offset, length }) : (await b.get(path)).subarray(offset, offset + length);
        } else data = await b.get(path);
        return new Response(data, { status: range ? 206 : 200, headers: { "Content-Type": "application/octet-stream" } });
      } catch (e) {
        if (e instanceof NotFoundError) return Response.json({ error: "not found" }, { status: 404 });
        throw e;
      }
    }

    if (req.method === "PUT") {
      const data = new Uint8Array(await req.arrayBuffer());
      if (LOCK_FILE.test(path)) {
        await b.put(path, data);
        return Response.json({ ok: true });
      }
      const m = CONTENT_FILE.exec(path);
      if (!m) throw new HttpError(403, `Not allowed to write ${path}`);
      if (createHash("sha256").update(data).digest("hex") !== m[1]) throw new HttpError(400, `Contents of ${path} do not match its name`);
      // Same name means same contents: a repeated upload (a retry) is fine and changes nothing.
      if (!(await b.exists(path))) await b.put(path, data);
      return Response.json({ ok: true });
    }

    if (req.method === "DELETE") {
      if (!LOCK_FILE.test(path)) throw new HttpError(403, `Not allowed to delete ${path}`);
      await b.delete(path).catch((e) => {
        if (!(e instanceof NotFoundError)) throw e;
      });
      return Response.json({ ok: true });
    }
    throw new HttpError(405, "Method not allowed");
  }

  async close() {
    clearInterval(this.watchdog);
    for (const b of this.backends.values()) await b.close().catch(() => {});
    this.backends.clear();
  }
}
