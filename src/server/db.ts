/** Run history in bun:sqlite. */
import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export type RunKind = "backup" | "forget" | "prune" | "check" | "restore";
export type RunStatus = "queued" | "running" | "ok" | "warning" | "error" | "interrupted";

export interface Run {
  id: number;
  kind: RunKind;
  repo: string;
  source: string | null;
  trigger: string; // schedule | api | mcp | cli
  status: RunStatus;
  started: string;
  finished: string | null;
  snapshot: string | null;
  summary: string | null;
  details: any;
}

export interface RunFilter {
  source?: string;
  repo?: string;
  /** One kind or several, comma-separated. */
  kind?: string;
  /** One status or several, comma-separated. */
  status?: string;
  /** "schedule", "api" or "mcp" (matches "api:<token>" too). */
  trigger?: string;
  /** ISO time: only runs started at or after it. */
  since?: string;
  /** Substring of source, repository, trigger or summary. */
  q?: string;
}

export interface Session {
  /** sha256 of the cookie value: a leaked database does not leak live sessions. */
  id: string;
  tokenSha: string;
  tokenName: string;
  created: string;
  lastSeen: string;
  expires: string;
  persistent: boolean;
}

export class RunsDb {
  private db: Database;
  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path, { create: true });
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec(`CREATE TABLE IF NOT EXISTS runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      kind TEXT NOT NULL, repo TEXT NOT NULL, source TEXT, trigger TEXT NOT NULL,
      status TEXT NOT NULL, started TEXT NOT NULL, finished TEXT,
      snapshot TEXT, summary TEXT, details TEXT
    )`);
    this.db.exec("CREATE INDEX IF NOT EXISTS runs_source ON runs(source, id)");
    this.db.exec(`CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY, token_sha TEXT NOT NULL, token_name TEXT NOT NULL,
      created TEXT NOT NULL, last_seen TEXT NOT NULL, expires TEXT NOT NULL, persistent INTEGER NOT NULL
    )`);
    this.db.exec(`CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT NOT NULL)`);
    // Whatever was "running" when the process died is not running anymore.
    this.db.run("UPDATE runs SET status = 'interrupted', finished = ?, summary = 'server restarted' WHERE status IN ('queued', 'running')", [
      new Date().toISOString(),
    ]);
  }

  start(kind: RunKind, repo: string, source: string | null, trigger: string): number {
    const r = this.db
      .query("INSERT INTO runs (kind, repo, source, trigger, status, started) VALUES (?, ?, ?, ?, 'queued', ?) RETURNING id")
      .get(kind, repo, source, trigger, new Date().toISOString()) as { id: number };
    return r.id;
  }

  /** The job left the queue: the start time becomes the real one. */
  markRunning(id: number) {
    this.db.run("UPDATE runs SET status = 'running', started = ? WHERE id = ?", [new Date().toISOString(), id]);
  }

  finish(id: number, status: RunStatus, summary: string, o: { snapshot?: string; details?: unknown } = {}) {
    this.db.run("UPDATE runs SET status = ?, finished = ?, summary = ?, snapshot = ?, details = ? WHERE id = ?", [
      status,
      new Date().toISOString(),
      summary,
      o.snapshot ?? null,
      o.details === undefined ? null : JSON.stringify(o.details),
      id,
    ]);
  }

  get(id: number): Run | null {
    const r = this.db.query("SELECT * FROM runs WHERE id = ?").get(id) as any;
    return r ? { ...r, details: r.details ? JSON.parse(r.details) : null } : null;
  }

  private where(o: RunFilter): [string, any[]] {
    const where: string[] = [];
    const args: any[] = [];
    if (o.source) where.push("source = ?"), args.push(o.source);
    if (o.repo) where.push("repo = ?"), args.push(o.repo);
    if (o.kind) where.push(`kind IN (${o.kind.split(",").map(() => "?").join(",")})`), args.push(...o.kind.split(","));
    if (o.status) where.push(`status IN (${o.status.split(",").map(() => "?").join(",")})`), args.push(...o.status.split(","));
    if (o.trigger) where.push("(trigger = ? OR trigger LIKE ?)"), args.push(o.trigger, `${o.trigger}:%`);
    if (o.since) where.push("started >= ?"), args.push(o.since);
    if (o.q) {
      where.push("(source LIKE ? OR repo LIKE ? OR trigger LIKE ? OR summary LIKE ?)");
      args.push(...Array(4).fill(`%${o.q}%`));
    }
    return [where.length ? "WHERE " + where.join(" AND ") : "", args];
  }

  list(o: RunFilter & { limit?: number; offset?: number } = {}): Run[] {
    const [w, args] = this.where(o);
    const rows = this.db
      .query(`SELECT * FROM runs ${w} ORDER BY id DESC LIMIT ? OFFSET ?`)
      .all(...args, Math.min(o.limit ?? 50, 500), o.offset ?? 0) as any[];
    return rows.map((r) => ({ ...r, details: r.details ? JSON.parse(r.details) : null }));
  }

  count(o: RunFilter = {}): number {
    const [w, args] = this.where(o);
    return (this.db.query(`SELECT COUNT(*) AS n FROM runs ${w}`).get(...args) as { n: number }).n;
  }

  /** Number of runs per status (for filter chips and the overview). */
  statusCounts(o: RunFilter = {}): Record<string, number> {
    const [w, args] = this.where(o);
    const rows = this.db.query(`SELECT status, COUNT(*) AS n FROM runs ${w} GROUP BY status`).all(...args) as { status: string; n: number }[];
    return Object.fromEntries(rows.map((r) => [r.status, r.n]));
  }

  /** Statuses of the last n runs of a kind for a source, oldest first. */
  recentStatuses(kind: RunKind, source: string, n: number): RunStatus[] {
    const rows = this.db
      .query("SELECT status FROM runs WHERE kind = ? AND source = ? ORDER BY id DESC LIMIT ?")
      .all(kind, source, n) as { status: RunStatus }[];
    return rows.map((r) => r.status).reverse();
  }

  /** The last finished run of a kind for a source or repository that produced a result. */
  lastGood(kind: RunKind, o: { source?: string; repo?: string }): Run | null {
    return this.list({ kind, ...o, status: "ok,warning", limit: 1 })[0] ?? null;
  }

  // ── sessions of the web UI ──

  createSession(s: Session) {
    this.db.run("INSERT INTO sessions (id, token_sha, token_name, created, last_seen, expires, persistent) VALUES (?, ?, ?, ?, ?, ?, ?)", [
      s.id,
      s.tokenSha,
      s.tokenName,
      s.created,
      s.lastSeen,
      s.expires,
      s.persistent ? 1 : 0,
    ]);
  }

  getSession(id: string): Session | null {
    const r = this.db.query("SELECT * FROM sessions WHERE id = ?").get(id) as any;
    return r
      ? { id: r.id, tokenSha: r.token_sha, tokenName: r.token_name, created: r.created, lastSeen: r.last_seen, expires: r.expires, persistent: !!r.persistent }
      : null;
  }

  touchSession(id: string, lastSeen: string, expires: string) {
    this.db.run("UPDATE sessions SET last_seen = ?, expires = ? WHERE id = ?", [lastSeen, expires, id]);
  }

  deleteSession(id: string) {
    this.db.run("DELETE FROM sessions WHERE id = ?", [id]);
  }

  /** Sign out everywhere for one token. Returns how many sessions were closed. */
  deleteSessionsOf(tokenSha: string): number {
    return this.db.run("DELETE FROM sessions WHERE token_sha = ?", [tokenSha]).changes;
  }

  deleteExpiredSessions(now: string) {
    this.db.run("DELETE FROM sessions WHERE expires < ?", [now]);
  }

  // ── small persistent values (cached repository stats and the like) ──

  getValue<T>(k: string): T | null {
    const r = this.db.query("SELECT v FROM kv WHERE k = ?").get(k) as { v: string } | null;
    return r ? (JSON.parse(r.v) as T) : null;
  }

  setValue(k: string, v: unknown) {
    this.db.run("INSERT INTO kv (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v", [k, JSON.stringify(v)]);
  }

  lastOf(kind: RunKind, source: string): Run | null {
    return this.list({ kind, source, limit: 1 })[0] ?? null;
  }

  close() {
    this.db.close();
  }
}
