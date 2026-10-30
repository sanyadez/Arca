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
import { findNode, walkTree, type ListedNode } from "../core/tree";
import { isEmptyPolicy, applyRetention } from "../core/retention";
import { Differ, searchSnapshots } from "../core/diff";
import { loadTree } from "../core/tree";
import { formatBytes } from "../util";
import { hostname } from "node:os";
import { VERSION_STRING } from "../version";
import { isClientSource, openSource, parseClientUrl } from "../sources";
import { type Config, repoPassword } from "./config";
import { Cron } from "./cron";
import { RunsDb, type Run, type RunKind } from "./db";
import { LiveRun } from "./live";
import type { ConfigStore } from "./configstore";
import { ClientHub } from "./clients";

export const DEFAULT_PRUNE = "30 4 * * 0";
export const DEFAULT_CHECK = "0 5 * * *";

type Log = (msg: string) => void;

export class Service {
  readonly db: RunsDb;
  private repos = new Map<string, Promise<Repository>>();
  private queues = new Map<string, Promise<unknown>>();
  private active = new Map<number, LiveRun>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private crons = new Map<string, Cron>();
  readonly clients: ClientHub;

  constructor(
    readonly cfg: Config,
    readonly log: Log = (m) => console.log(m),
    db?: RunsDb,
    /** Lets the API change the config file (admin forms of the web UI). */
    readonly configStore?: ConfigStore,
  ) {
    this.db = db ?? new RunsDb(join(cfg.dataDir, "runs.sqlite"));
    this.clients = new ClientHub(() => this.cfg, { get: (k) => this.db.getValue(k), set: (k, v) => this.db.setValue(k, v) });
  }

  /** Switch to a new config without a restart: open repositories whose address or password changed are reopened. */
  applyConfig(next: Config) {
    for (const [name, p] of this.repos) {
      const a = this.cfg.repos[name];
      const b = next.repos[name];
      if (!b || a?.url !== b.url || a?.passwordFile !== b.passwordFile) {
        this.repos.delete(name);
        void p.then((r) => r.close()).catch(() => {});
      }
    }
    this.cfg.tokens = next.tokens;
    this.cfg.repos = next.repos;
    this.cfg.sources = next.sources;
    this.cfg.restoreRoot = next.restoreRoot;
    this.log("config changed from the API");
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
    fn: (r: Repository, ctl: JobControl, runId: number) => Promise<{
      status?: "ok" | "warning";
      summary: string;
      snapshot?: string;
      details?: unknown;
    }>,
  ): { runId: number; done: Promise<Run> } {
    const runId = this.db.start(kind, repo, source, trigger);
    const live = new LiveRun(runId, kind, repo, source, trigger);
    this.active.set(runId, live);
    const done = this.serial(repo, async () => {
      const label = `${kind}${source ? " " + source : ""} → ${repo} (#${runId}, ${trigger})`;
      const ctl: JobControl = {
        signal: live.abort.signal,
        progress: (p) => live.setProgress(p),
        log: (stage, text) => live.addLog(stage, text),
      };
      try {
        if (live.abort.signal.aborted) throw new DOMException("cancelled while queued", "AbortError");
        this.db.markRunning(runId);
        live.setRunning();
        live.addLog("run", `Run #${runId} started by ${trigger}: ${kind}${source ? " " + source : ""} → ${repo}`);
        const r = await this.repo(repo);
        const res = await fn(r, ctl, runId);
        live.addLog("run", `Finished: ${res.summary}`);
        this.db.finish(runId, res.status ?? "ok", res.summary, { ...res, details: { ...(res.details as object), log: live.log.slice(-300) } });
        this.log(`${res.status === "warning" ? "WARNING" : "ok"}: ${label}: ${res.summary}`);
      } catch (e: any) {
        const cancelled = e?.name === "AbortError";
        const msg = cancelled ? cancelSummary(live) : (e?.message ?? String(e));
        live.addLog("run", cancelled ? `Cancelled: ${msg}` : `Failed: ${msg}`);
        this.db.finish(runId, cancelled ? "interrupted" : "error", msg, { details: { log: live.log.slice(-300) } });
        this.log(`${cancelled ? "cancelled" : "ERROR"}: ${label}: ${msg}`);
      } finally {
        this.active.delete(runId);
        live.finish(this.db.get(runId)!);
      }
      if (kind !== "restore") void this.computeRepoStats(repo).catch((e) => this.log(`stats ${repo}: ${e?.message ?? e}`));
      return this.db.get(runId)!;
    });
    return { runId, done };
  }

  activeRuns() {
    return [...this.active.values()].map((a) => a.summary());
  }

  live(runId: number): LiveRun | undefined {
    return this.active.get(runId);
  }

  cancel(runId: number): boolean {
    const a = this.active.get(runId);
    a?.abort.abort();
    return !!a;
  }

  runBackup(sourceName: string, trigger: string) {
    const s = this.source(sourceName);
    const res = this.enqueue("backup", s.repo, sourceName, trigger, async (repo, ctl, runId) => {
      const tags = [...(s.tags ?? []), triggerTag(trigger)];
      let r: { id: string; changed: number; stats: NonNullable<Snapshot["stats"]>; errors: { path: string; error: string }[] };
      if (isClientSource(s.path)) {
        // The client chunks, encrypts and writes through the storage proxy; this repository only reads the result.
        r = await this.clients.backup(sourceName, { runId, kind: "backup", source: sourceName, url: s.path, exclude: s.exclude ?? [], tags, owner: s.owner, repo: s.repo }, ctl);
        await repo.reloadIndex();
      } else {
        await repo.reloadIndex();
        const from = openSource(s.path, s.ssh);
        const b = await withLock(repo, false, `backup ${sourceName}`, () =>
          backup(repo, { from, source: sourceName, exclude: s.exclude, tags, owner: s.owner, signal: ctl.signal, onProgress: ctl.progress, onLog: ctl.log }),
        ).finally(() => from.close());
        r = { id: b.id, changed: b.changed, stats: b.snapshot.stats!, errors: b.errors };
      }
      const st = r.stats;
      let summary = `+${formatBytes(st.newBytes)}, ${r.changed} file${r.changed === 1 ? "" : "s"} changed · snapshot ${r.id.slice(0, 8)}`;
      let forgotten: string[] = [];
      if (s.retention && !isEmptyPolicy(s.retention)) {
        const f = await withLock(repo, false, `forget ${sourceName}`, () =>
          forget(repo, s.retention!, { filter: (x) => x.source === sourceName }),
        );
        forgotten = f.removed;
        if (forgotten.length) summary += ` · retention removed ${forgotten.length}`;
      }
      if (r.errors.length) summary = `${r.errors.length} file${r.errors.length === 1 ? "" : "s"} unreadable · ${summary}`;
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
      return { summary: `${formatBytes(p.bytesFreed)} freed (${p.packsDeleted} packs deleted, ${p.packsRepacked} repacked)`, details: p };
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
        summary: `${share >= 1 ? "read all data" : share > 0 ? `read ${Math.round(share * 100)}% of data` : "structure only"}, 0 errors` +
          (c.warnings.length ? ` · ${c.warnings.length} warning${c.warnings.length === 1 ? "" : "s"}` : ""),
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

  runRestore(
    repoName: string,
    snapshotRef: string,
    o: { path?: string; paths?: string[]; target?: string; verify?: boolean; owners?: boolean },
    trigger: string,
  ) {
    const target = this.restoreTarget(o.target ?? `${repoName}-${snapshotRef.slice(0, 8)}-${Date.now()}`);
    return this.enqueue("restore", repoName, null, trigger, async (repo, ctl) => {
      await mkdir(this.cfg.restoreRoot, { recursive: true });
      const { id, snapshot } = await repo.findSnapshot(snapshotRef);
      const r = await withLock(repo, false, "restore", () =>
        restore(repo, snapshot.tree, target, {
          path: o.path,
          paths: o.paths,
          verify: o.verify,
          owners: o.owners,
          signal: ctl.signal,
          onProgress: ctl.progress,
        }),
      );
      ctl.log("restore", `Restored ${r.files} files, ${r.dirs} folders from snapshot ${id.slice(0, 8)} into ${r.target}`);
      return {
        status: r.errors.length ? "warning" : "ok",
        summary: `${r.files} files, ${formatBytes(r.bytes)} to ${r.target}${o.verify ? `, ${r.verified} verified` : ""}${r.errors.length ? ` · ${r.errors.length} errors` : ""}`,
        snapshot: id,
        details: r,
      };
    });
  }

  /** Remove snapshots (admin). Their data is freed by the next prune. */
  async forgetSnapshots(repoName: string, ids: string[]) {
    const repo = await this.repo(repoName);
    const all = await repo.listSnapshots();
    const full = ids.map((ref) => {
      const m = all.filter((x) => x.id.startsWith(ref));
      if (m.length !== 1) throw new HttpError(400, `Snapshot ${ref} not found or ambiguous`);
      return m[0]!.id;
    });
    await withLock(repo, false, "forget", async () => {
      for (const id of full) await repo.deleteSnapshot(id);
    });
    this.log(`forgot ${full.length} snapshot(s) in ${repoName}`);
    void this.computeRepoStats(repoName).catch(() => {});
    return { removed: full };
  }

  // ── browsing ──

  /** Snapshots of all (or one) repositories, newest first, with the fields the UI lists. */
  async allSnapshots(f: { repo?: string; source?: string; host?: string; tag?: string; owner?: string } = {}) {
    const names = f.repo ? [f.repo] : Object.keys(this.cfg.repos);
    const out: SnapshotRow[] = [];
    for (const name of names) {
      let list: { id: string; snapshot: Snapshot }[];
      try {
        list = await (await this.repo(name)).listSnapshots();
      } catch (e: any) {
        if (f.repo) throw e;
        continue; // one unreachable repository must not hide the others
      }
      for (const { id, snapshot: s } of list) {
        if (f.source && s.source !== f.source) continue;
        if (f.host && s.host !== f.host) continue;
        if (f.tag && !s.tags.includes(f.tag)) continue;
        if (f.owner && s.owner !== f.owner) continue;
        out.push({ repo: name, id, time: s.time, host: s.host, source: s.source, root: s.root, tags: s.tags, parent: s.parent ?? null, stats: s.stats ?? null });
      }
    }
    return out.sort((a, b) => b.time.localeCompare(a.time));
  }

  async snapshotInfo(repoName: string, ref: string) {
    const repo = await this.repo(repoName);
    const { id, snapshot } = await repo.findSnapshot(ref);
    const parent = snapshot.parent ? (await repo.listSnapshots()).find((x) => x.id === snapshot.parent) : undefined;
    return {
      repo: repoName,
      id,
      ...snapshot,
      parentInfo: parent ? { id: parent.id, time: parent.snapshot.time } : null,
      restoreRoot: this.cfg.restoreRoot,
    };
  }

  /** One folder of a snapshot, optionally with new/changed marks against the parent snapshot. */
  async browse(repoName: string, ref: string, path = "", o: { compare?: boolean; limit?: number; offset?: number } = {}) {
    const repo = await this.repo(repoName);
    const { id, snapshot } = await repo.findSnapshot(ref);
    const node = await findNodeOrThrow(repo, snapshot.tree, path);
    if (node.type !== "dir") throw new HttpError(400, `Not a folder: ${path}`);
    const tree = await loadTree(repo, node.subtree!);
    let marks: Map<string, { change: string | null; added?: number }> | undefined;
    let comparedWith: { id: string; time: string } | null = null;
    if (o.compare && snapshot.parent) {
      const parent = (await repo.listSnapshots()).find((x) => x.id === snapshot.parent);
      if (parent) {
        comparedWith = { id: parent.id, time: parent.snapshot.time };
        const prevNode = await findNodeOrNull(repo, parent.snapshot.tree, path);
        marks = await new Differ(repo).dir(node.subtree!, prevNode?.type === "dir" ? prevNode.subtree : undefined);
      }
    }
    const offset = o.offset ?? 0;
    const limit = Math.min(o.limit ?? 500, 5000);
    // Folders first, then files; both by name.
    const sorted = [...tree.nodes].sort((a, b) => (a.type === "dir") === (b.type === "dir") ? NAME_ORDER.compare(a.name, b.name) : a.type === "dir" ? -1 : 1);
    const items = sorted.slice(offset, offset + limit).map(({ content, inode, subtree, ...n }) => ({ ...n, ...(marks?.get(n.name) ?? {}) }));
    return { snapshot: id, path, total: tree.nodes.length, offset, items, comparedWith };
  }

  async searchFiles(q: string, f: { repo?: string; source?: string; snapshot?: string; owner?: string; limit?: number }, signal?: AbortSignal) {
    if (q.trim().length < 2) throw new HttpError(400, "Type at least 2 characters to search");
    const names = f.repo ? [f.repo] : Object.keys(this.cfg.repos);
    const hits: (Awaited<ReturnType<typeof searchSnapshots>>["hits"][number] & { repo: string })[] = [];
    let truncated = false;
    for (const name of names) {
      const repo = await this.repo(name);
      let snaps = await repo.listSnapshots();
      snaps = snaps.filter((x) => (!f.source || x.snapshot.source === f.source) && (!f.owner || x.snapshot.owner === f.owner) && (!f.snapshot || x.id.startsWith(f.snapshot)));
      const r = await searchSnapshots(repo, snaps, q.trim(), (f.limit ?? 200) - hits.length, signal);
      hits.push(...r.hits.map((h) => ({ ...h, repo: name })));
      if (r.truncated || hits.length >= (f.limit ?? 200)) {
        truncated = true;
        break;
      }
    }
    return { hits, truncated };
  }

  /** Everything the source page shows. */
  async sourceDetail(name: string) {
    const s = this.source(name);
    const info = this.sourcesInfo().find((x) => x.name === name)!;
    const st = this.sourceState(name);
    let snaps: SnapshotRow[] = [];
    try {
      snaps = await this.allSnapshots({ repo: s.repo, source: name });
    } catch {
      // the repository may be unreachable; the page still shows the configuration
    }
    let wouldKeep: number | null = null;
    if (s.retention && !isEmptyPolicy(s.retention) && snaps.length) {
      wouldKeep = applyRetention(snaps.map((x) => ({ snapshot: { ...x, tree: "", owner: "", v: 1 } as Snapshot })), s.retention).keep.length;
    }
    const lastRun = st.last ? this.db.get(st.last.id) : null;
    return {
      ...info,
      status: st.status,
      runId: st.running?.id ?? null,
      progress: st.running?.progress ?? null,
      tags: s.tags ?? [],
      client: isClientSource(s.path) ? this.clients.state(parseClientUrl(s.path).client) : null,
      ssh: s.path.startsWith("ssh://") ? { forced: !!s.ssh?.forced, identity: s.ssh?.identity ? true : false, lastConnected: st.good?.finished ?? null } : null,
      repoInfo: { name: s.repo, url: this.cfg.repos[s.repo]?.url ?? "", stats: this.repoStats(s.repo), lastCheck: this.db.list({ kind: "check", repo: s.repo, limit: 1 })[0] ?? null },
      snapshots: snaps,
      kept: snaps.length,
      wouldKeep,
      lastRun: lastRun && { id: lastRun.id, status: lastRun.status, started: lastRun.started, finished: lastRun.finished, trigger: lastRun.trigger, summary: lastRun.summary, errors: lastRun.details?.errors ?? [] },
    };
  }

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

  // ── repository stats and the overview ──

  /** Cached numbers of a repository; refreshed after every job, computed on first request. */
  repoStats(name: string): RepoStats | null {
    const cached = this.db.getValue<RepoStats>(`repo-stats:${name}`);
    if (!cached && !this.statsPending.has(name)) void this.computeRepoStats(name).catch(() => {});
    return cached;
  }

  private statsPending = new Set<string>();

  async computeRepoStats(name: string): Promise<RepoStats> {
    this.statsPending.add(name);
    try {
      const repo = await this.repo(name);
      const [packs, snaps, usage] = await Promise.all([
        repo.backend.list("data"),
        repo.listSnapshots(),
        repo.backend.usage?.().catch(() => null) ?? null,
      ]);
      const latest = new Map<string, number>();
      for (const { snapshot: s } of snaps) latest.set(`${s.host}\0${s.source}`, s.stats?.bytes ?? 0);
      const stored = packs.reduce((a, f) => a + f.size, 0);
      const protectedBytes = [...latest.values()].reduce((a, b) => a + b, 0);
      const stats: RepoStats = {
        stored,
        packs: packs.length,
        snapshots: snaps.length,
        protected: protectedBytes,
        dedup: stored > 0 ? Math.round((protectedBytes / stored) * 10) / 10 : null,
        usage,
        computed: new Date().toISOString(),
      };
      this.db.setValue(`repo-stats:${name}`, stats);
      return stats;
    } finally {
      this.statsPending.delete(name);
    }
  }

  /** State of a source for the UI: running, or the status of its last backup. */
  private sourceState(name: string) {
    const running = [...this.active.values()].find((a) => a.kind === "backup" && a.source === name);
    const last = this.db.lastOf("backup", name);
    const good = last?.status === "ok" || last?.status === "warning" ? last : this.db.lastGood("backup", { source: name });
    const status = running ? running.status : (last?.status ?? "never");
    return { running, last, good, status };
  }

  overview() {
    const now = Date.now();
    const since = new Date(now - 86400_000).toISOString();
    const sources = Object.entries(this.cfg.sources).map(([name, s]) => {
      const st = this.sourceState(name);
      const goodStats = (st.good?.details as { stats?: { bytes?: number; newBytes?: number } } | null)?.stats;
      return {
        name,
        path: s.path,
        repo: s.repo,
        schedule: s.schedule ?? null,
        next: s.schedule ? (this.cron(s.schedule).next()?.toISOString() ?? null) : null,
        status: st.status,
        lastBackup: st.good?.finished ?? null,
        size: goodStats?.bytes ?? null,
        newBytes: goodStats?.newBytes ?? null,
        runs: this.db.recentStatuses("backup", name, 14),
        lastRun: st.last && { id: st.last.id, status: st.last.status, finished: st.last.finished, summary: st.last.summary },
        progress: st.running?.progress ?? null,
        runId: st.running?.id ?? null,
      };
    });
    const repos = Object.entries(this.cfg.repos).map(([name, r]) => {
      const check = this.db.list({ kind: "check", repo: name, limit: 1 })[0];
      return {
        name,
        url: r.url,
        schedules: { check: r.check ?? DEFAULT_CHECK, prune: r.prune ?? DEFAULT_PRUNE, checkReadData: r.checkReadData ?? 0.05 },
        stats: this.repoStats(name),
        lastCheck: check && { id: check.id, status: check.status, finished: check.finished, summary: check.summary },
      };
    });
    const attention = [
      ...sources
        .filter((s) => s.status === "error" || s.status === "warning")
        .map((s) => ({ kind: "source" as const, name: s.name, status: s.status, summary: s.lastRun?.summary ?? "", at: s.lastRun?.finished ?? null, runId: s.lastRun?.id ?? null })),
      ...repos
        .filter((r) => r.lastCheck?.status === "error")
        .map((r) => ({ kind: "repo" as const, name: r.name, status: "error", summary: r.lastCheck!.summary ?? "", at: r.lastCheck!.finished, runId: r.lastCheck!.id })),
    ];
    const upcoming: { at: string; kind: "backup" | "prune" | "check"; name: string }[] = [];
    for (const s of sources) if (s.next) upcoming.push({ at: s.next, kind: "backup", name: s.name });
    for (const [name, r] of Object.entries(this.cfg.repos)) {
      for (const [kind, expr] of [["prune", r.prune ?? DEFAULT_PRUNE], ["check", r.check ?? DEFAULT_CHECK]] as const) {
        const at = expr ? this.cron(expr).next()?.toISOString() : null;
        if (at) upcoming.push({ at, kind, name });
      }
    }
    upcoming.sort((a, b) => a.at.localeCompare(b.at));
    const counts = this.db.statusCounts({ since });
    const runs24 = Object.values(counts).reduce((a, b) => a + b, 0);
    const protectedBytes = sources.reduce((a, s) => a + (s.size ?? 0), 0);
    const stored = repos.reduce((a, r) => a + (r.stats?.stored ?? 0), 0);
    return {
      server: { version: VERSION_STRING, host: hostname(), restoreRoot: this.cfg.restoreRoot, configFile: this.configStore?.path ?? null, listen: this.cfg.listen, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone },
      metrics: {
        sources: {
          total: sources.length,
          ok: sources.filter((s) => s.status === "ok").length,
          running: sources.filter((s) => s.status === "running" || s.status === "queued").length,
          issues: attention.filter((a) => a.kind === "source").length,
        },
        protected: protectedBytes,
        stored,
        dedup: stored > 0 ? Math.round((protectedBytes / stored) * 10) / 10 : null,
        runs24h: { total: runs24, ok: counts.ok ?? 0, warning: counts.warning ?? 0, error: counts.error ?? 0 },
        next: upcoming.find((u) => u.kind === "backup") ?? null,
      },
      attention,
      running: this.activeRuns(),
      sources,
      repos,
      upcoming: upcoming.slice(0, 5),
    };
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
    await this.clients.close();
    for (const p of this.repos.values()) await (await p.catch(() => null))?.close();
    this.db.close();
  }
}

export interface SnapshotRow {
  repo: string;
  id: string;
  time: string;
  host: string;
  source: string;
  root: string;
  tags: string[];
  parent: string | null;
  stats: Snapshot["stats"] | null;
}

/** Natural order for file names: "conf-2" before "conf-10". */
const NAME_ORDER = new Intl.Collator("en", { numeric: true, sensitivity: "base" });

function triggerTag(trigger: string) {
  return trigger === "schedule" ? "scheduled" : trigger.startsWith("mcp") ? "mcp" : "manual";
}

async function findNodeOrNull(repo: Repository, tree: string, path: string) {
  try {
    return await findNode(repo, tree, path);
  } catch {
    return null;
  }
}

async function findNodeOrThrow(repo: Repository, tree: string, path: string) {
  const n = await findNodeOrNull(repo, tree, path);
  if (!n) throw new HttpError(404, `Not in this snapshot: ${path}`);
  return n;
}

export interface RepoStats {
  /** Bytes of pack files in the storage. */
  stored: number;
  packs: number;
  snapshots: number;
  /** Logical size of the newest snapshot of every source. */
  protected: number;
  dedup: number | null;
  usage: { total: number; used: number } | null;
  computed: string;
}

export interface JobControl {
  signal: AbortSignal;
  progress: (p: unknown) => void;
  log: (stage: string, text: string) => void;
}

function cancelSummary(live: LiveRun): string {
  if (live.status === "queued") return "cancelled while queued";
  const p = live.progress as { bytesRead?: number; bytesToRead?: number } | undefined;
  const pct = p?.bytesToRead ? Math.floor(((p.bytesRead ?? 0) / p.bytesToRead) * 100) : undefined;
  return `cancelled${pct !== undefined ? ` at ${pct}%` : ""}${live.kind === "backup" ? ", no snapshot saved" : ""}`;
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
