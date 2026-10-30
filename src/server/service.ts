/**
 * Service: open repositories, a job queue (one job per repository at a time),
 * the scheduler and run history. The HTTP API and MCP are thin wrappers over this class.
 */
import { mkdir } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { openBackend } from "../backends";
import { Repository, type Snapshot } from "../core/repo";
import { backup } from "../core/backup";
import { restore } from "../core/restore";
import { check, forget, prune } from "../core/maintenance";
import { withLock } from "../core/lock";
import { walkTree, type ListedNode } from "../core/tree";
import { isEmptyPolicy } from "../core/retention";
import { formatBytes } from "../util";
import { openSource } from "../sources";
import { type Config, repoPassword } from "./config";
import { Cron } from "./cron";
import { RunsDb, type Run, type RunKind } from "./db";

export const DEFAULT_PRUNE = "30 4 * * 0";
export const DEFAULT_CHECK = "0 5 * * *";

type Log = (msg: string) => void;

export class Service {
  readonly db: RunsDb;
  private repos = new Map<string, Promise<Repository>>();
  private queues = new Map<string, Promise<unknown>>();
  private active = new Map<number, { kind: RunKind; repo: string; source: string | null; progress?: unknown; abort: AbortController }>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private crons = new Map<string, Cron>();

  constructor(
    readonly cfg: Config,
    readonly log: Log = (m) => console.log(m),
    db?: RunsDb,
  ) {
    this.db = db ?? new RunsDb(join(cfg.dataDir, "runs.sqlite"));
  }

  // ── repositories ──

  repo(name: string): Promise<Repository> {
    const rc = this.cfg.repos[name];
    if (!rc) throw new HttpError(404, `Unknown repository: ${name}`);
    let p = this.repos.get(name);
    if (!p) {
      p = (async () => Repository.open(openBackend(rc.url), await repoPassword(name, rc)))();
      p.catch(() => this.repos.delete(name));
      this.repos.set(name, p);
    }
    return p;
  }

  /** Serialised per repository: two jobs never run against the same storage at once. */
  private serial<T>(repo: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.queues.get(repo) ?? Promise.resolve();
    const next = prev.catch(() => {}).then(fn);
    this.queues.set(repo, next.catch(() => {}));
    return next;
  }

  source(name: string) {
    const s = this.cfg.sources[name];
    if (!s) throw new HttpError(404, `Unknown source: ${name}`);
    return s;
  }

  // ── jobs ──

  /**
   * Queue a job. Returns the run id immediately along with a promise of the result.
   * Errors are not thrown to the caller — they go to the history (status=error) and the log.
   */
  private enqueue(
    kind: RunKind,
    repo: string,
    source: string | null,
    trigger: string,
    fn: (r: Repository, ctl: { signal: AbortSignal; progress: (p: unknown) => void }) => Promise<{
      status?: "ok" | "warning";
      summary: string;
      snapshot?: string;
      details?: unknown;
    }>,
  ): { runId: number; done: Promise<Run> } {
    const runId = this.db.start(kind, repo, source, trigger);
    const abort = new AbortController();
    const entry: { kind: RunKind; repo: string; source: string | null; progress?: unknown; abort: AbortController } = {
      kind,
      repo,
      source,
      abort,
    };
    this.active.set(runId, entry);
    const done = this.serial(repo, async () => {
      const label = `${kind}${source ? " " + source : ""} → ${repo} (#${runId}, ${trigger})`;
      try {
        const r = await this.repo(repo);
        const res = await fn(r, { signal: abort.signal, progress: (p) => (entry.progress = p) });
        this.db.finish(runId, res.status ?? "ok", res.summary, res);
        this.log(`${res.status === "warning" ? "WARNING" : "ok"}: ${label}: ${res.summary}`);
      } catch (e: any) {
        const msg = e?.message ?? String(e);
        this.db.finish(runId, "error", msg);
        this.log(`ERROR: ${label}: ${msg}`);
      } finally {
        this.active.delete(runId);
      }
      return this.db.get(runId)!;
    });
    return { runId, done };
  }

  activeRuns() {
    return [...this.active].map(([id, a]) => ({ id, kind: a.kind, repo: a.repo, source: a.source, progress: a.progress }));
  }

  cancel(runId: number): boolean {
    const a = this.active.get(runId);
    a?.abort.abort();
    return !!a;
  }

  runBackup(sourceName: string, trigger: string) {
    const s = this.source(sourceName);
    const res = this.enqueue("backup", s.repo, sourceName, trigger, async (repo, ctl) => {
      await repo.reloadIndex();
      const from = openSource(s.path, s.ssh);
      const r = await withLock(repo, false, `backup ${sourceName}`, () =>
        backup(repo, {
          from,
          source: sourceName,
          exclude: s.exclude,
          tags: s.tags,
          owner: s.owner,
          signal: ctl.signal,
          onProgress: ctl.progress,
        }),
      ).finally(() => from.close());
      const st = r.snapshot.stats!;
      let summary = `snapshot ${r.id.slice(0, 8)}: ${st.files} files, ${formatBytes(st.bytes)}, ${formatBytes(st.newBytes)} new, ${st.seconds} s`;
      let forgotten: string[] = [];
      if (s.retention && !isEmptyPolicy(s.retention)) {
        const f = await withLock(repo, false, `forget ${sourceName}`, () =>
          forget(repo, s.retention!, { filter: (x) => x.source === sourceName }),
        );
        forgotten = f.removed;
        if (forgotten.length) summary += `; retention removed ${forgotten.length}`;
      }
      if (r.errors.length) summary += `; read errors: ${r.errors.length}`;
      return {
        status: r.errors.length ? "warning" : "ok",
        summary,
        snapshot: r.id,
        details: { stats: st, errors: r.errors.slice(0, 200), forgotten },
      };
    });
    return res;
  }

  runPrune(repoName: string, trigger: string) {
    return this.enqueue("prune", repoName, null, trigger, async (repo) => {
      await repo.reloadIndex();
      const p = await withLock(repo, true, "prune", () => prune(repo));
      return { summary: `freed ${formatBytes(p.bytesFreed)}, packs deleted ${p.packsDeleted}, repacked ${p.packsRepacked}`, details: p };
    });
  }

  runCheck(repoName: string, trigger: string, readData?: number) {
    const share = readData ?? this.cfg.repos[repoName]?.checkReadData ?? 0.05;
    return this.enqueue("check", repoName, null, trigger, async (repo) => {
      await repo.reloadIndex();
      const c = await withLock(repo, false, "check", () => check(repo, { readData: share }));
      if (c.errors.length) throw new Error(`errors found: ${c.errors.length}; first: ${c.errors[0]}`);
      return {
        status: c.warnings.length ? "warning" : "ok",
        summary: `no errors; snapshots ${c.snapshots}, packs ${c.packs}, data read in ${c.packsRead}` +
          (c.warnings.length ? `; warnings ${c.warnings.length}` : ""),
        details: c,
      };
    });
  }

  /** target is a subdirectory of restoreRoot (relative path); returns the absolute path. */
  restoreTarget(target: string): string {
    const root = resolve(this.cfg.restoreRoot);
    const abs = resolve(root, target);
    const rel = relative(root, abs);
    if (!target || isAbsolute(rel) || rel.startsWith("..") || rel === "")
      throw new HttpError(400, `Target must be a subdirectory of ${root}`);
    return abs;
  }

  runRestore(repoName: string, snapshotRef: string, o: { path?: string; target?: string }, trigger: string) {
    const target = this.restoreTarget(o.target ?? `${repoName}-${snapshotRef.slice(0, 8)}-${Date.now()}`);
    return this.enqueue("restore", repoName, null, trigger, async (repo, ctl) => {
      await mkdir(this.cfg.restoreRoot, { recursive: true });
      const { id, snapshot } = await repo.findSnapshot(snapshotRef);
      const r = await withLock(repo, false, "restore", () =>
        restore(repo, snapshot.tree, target, { path: o.path, signal: ctl.signal, onProgress: ctl.progress }),
      );
      return {
        status: r.errors.length ? "warning" : "ok",
        summary: `restored ${r.files} files (${formatBytes(r.bytes)}) from snapshot ${id.slice(0, 8)} to ${r.target}`,
        snapshot: id,
        details: r,
      };
    });
  }

  // ── browsing ──

  async snapshots(repoName: string, o: { source?: string; owner?: string } = {}) {
    const repo = await this.repo(repoName);
    const all = await repo.listSnapshots();
    return all.filter(
      ({ snapshot: s }) => (!o.source || s.source === o.source) && (!o.owner || s.owner === o.owner),
    );
  }

  async ls(repoName: string, snapshotRef: string, path = "", recursive = false, limit = 1000) {
    const repo = await this.repo(repoName);
    const { id, snapshot } = await repo.findSnapshot(snapshotRef);
    const items: Omit<ListedNode, "content" | "inode">[] = [];
    let truncated = false;
    for await (const n of walkTree(repo, snapshot.tree, path, recursive)) {
      if (items.length >= limit) {
        truncated = true;
        break;
      }
      const { content, inode, ...rest } = n;
      items.push(rest);
    }
    return { snapshot: id, items, truncated };
  }

  sourcesInfo() {
    return Object.entries(this.cfg.sources).map(([name, s]) => {
      const last = this.db.lastOf("backup", name);
      return {
        name,
        path: s.path,
        repo: s.repo,
        schedule: s.schedule ?? null,
        next: s.schedule ? (this.cron(s.schedule).next()?.toISOString() ?? null) : null,
        retention: s.retention ?? null,
        exclude: s.exclude ?? [],
        last: last && { id: last.id, status: last.status, started: last.started, finished: last.finished, summary: last.summary },
      };
    });
  }

  reposInfo() {
    return Object.entries(this.cfg.repos).map(([name, r]) => ({
      name,
      url: r.url,
      prune: r.prune ?? DEFAULT_PRUNE,
      check: r.check ?? DEFAULT_CHECK,
    }));
  }

  // ── scheduler ──

  private cron(expr: string) {
    let c = this.crons.get(expr);
    if (!c) this.crons.set(expr, (c = new Cron(expr)));
    return c;
  }

  /** What to run in this minute. Split out for tests. */
  dueAt(d: Date): { kind: "backup" | "prune" | "check"; name: string }[] {
    const due: { kind: "backup" | "prune" | "check"; name: string }[] = [];
    for (const [name, s] of Object.entries(this.cfg.sources))
      if (s.schedule && this.cron(s.schedule).matches(d)) due.push({ kind: "backup", name });
    for (const [name, r] of Object.entries(this.cfg.repos)) {
      const p = r.prune ?? DEFAULT_PRUNE;
      const c = r.check ?? DEFAULT_CHECK;
      if (p && this.cron(p).matches(d)) due.push({ kind: "prune", name });
      if (c && this.cron(c).matches(d)) due.push({ kind: "check", name });
    }
    return due;
  }

  private tick() {
    const now = new Date();
    for (const job of this.dueAt(now)) {
      // Don't queue again if the previous identical run hasn't finished yet.
      const busy = [...this.active.values()].some(
        (a) => a.kind === job.kind && (job.kind === "backup" ? a.source === job.name : a.repo === job.name),
      );
      if (busy) {
        this.log(`skipped: ${job.kind} ${job.name} — previous run still in progress`);
        continue;
      }
      if (job.kind === "backup") this.runBackup(job.name, "schedule");
      else if (job.kind === "prune") this.runPrune(job.name, "schedule");
      else this.runCheck(job.name, "schedule");
    }
  }

  startScheduler() {
    const arm = () => {
      const ms = 60_000 - (Date.now() % 60_000) + 50;
      this.timer = setTimeout(() => {
        try {
          this.tick();
        } catch (e: any) {
          this.log(`scheduler ERROR: ${e?.message ?? e}`);
        }
        arm();
      }, ms);
    };
    arm();
  }

  async stop() {
    clearTimeout(this.timer);
    for (const a of this.active.values()) a.abort.abort();
    await Promise.allSettled([...this.queues.values()]);
    for (const p of this.repos.values()) await (await p.catch(() => null))?.close();
    this.db.close();
  }
}

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export type { Snapshot };
