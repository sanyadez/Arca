/** Run history in bun:sqlite. */
import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export type RunKind = "backup" | "forget" | "prune" | "check" | "restore";
export type RunStatus = "running" | "ok" | "warning" | "error" | "interrupted";

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
    // Whatever was "running" when the process died is not running anymore.
    this.db.run("UPDATE runs SET status = 'interrupted', finished = ? WHERE status = 'running'", [new Date().toISOString()]);
  }

  start(kind: RunKind, repo: string, source: string | null, trigger: string): number {
    const r = this.db
      .query("INSERT INTO runs (kind, repo, source, trigger, status, started) VALUES (?, ?, ?, ?, 'running', ?) RETURNING id")
      .get(kind, repo, source, trigger, new Date().toISOString()) as { id: number };
    return r.id;
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

  list(o: { limit?: number; source?: string; repo?: string; kind?: string } = {}): Run[] {
    const where: string[] = [];
    const args: any[] = [];
    if (o.source) where.push("source = ?"), args.push(o.source);
    if (o.repo) where.push("repo = ?"), args.push(o.repo);
    if (o.kind) where.push("kind = ?"), args.push(o.kind);
    args.push(Math.min(o.limit ?? 50, 500));
    const rows = this.db
      .query(`SELECT * FROM runs ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY id DESC LIMIT ?`)
      .all(...args) as any[];
    return rows.map((r) => ({ ...r, details: r.details ? JSON.parse(r.details) : null }));
  }

  lastOf(kind: RunKind, source: string): Run | null {
    return this.list({ kind, source, limit: 1 })[0] ?? null;
  }

  close() {
    this.db.close();
  }
}
