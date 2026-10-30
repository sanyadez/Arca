/**
 * Live state of queued and running jobs: the latest progress, a bounded log and subscribers
 * (the SSE stream of the web UI). Finished runs live only in the database.
 */
import type { Run, RunKind } from "./db";

export interface LogLine {
  t: string; // ISO time
  stage: string;
  text: string;
}

export type LiveEvent =
  | { type: "state"; status: "queued" | "running" }
  | { type: "progress"; progress: unknown }
  | { type: "log"; line: LogLine }
  | { type: "done"; run: Run };

const LOG_LIMIT = 1000;
/** Progress is coalesced: subscribers get at most this many updates per second. */
const PROGRESS_HZ = 4;

export class LiveRun {
  status: "queued" | "running" = "queued";
  progress: unknown;
  log: LogLine[] = [];
  readonly abort = new AbortController();
  private listeners = new Set<(e: LiveEvent) => void>();
  private progressTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    readonly id: number,
    readonly kind: RunKind,
    readonly repo: string,
    readonly source: string | null,
    readonly trigger: string,
  ) {}

  subscribe(fn: (e: LiveEvent) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(e: LiveEvent) {
    for (const fn of this.listeners) {
      try {
        fn(e);
      } catch {
        // a broken subscriber must not break the job
      }
    }
  }

  setRunning() {
    this.status = "running";
    this.emit({ type: "state", status: "running" });
  }

  setProgress(p: unknown) {
    // The caller mutates the same object, so keep a copy.
    this.progress = typeof p === "object" && p !== null ? { ...p } : p;
    if (this.progressTimer) return;
    this.progressTimer = setTimeout(() => {
      this.progressTimer = undefined;
      this.emit({ type: "progress", progress: this.progress });
    }, 1000 / PROGRESS_HZ);
  }

  addLog(stage: string, text: string) {
    const line = { t: new Date().toISOString(), stage, text };
    this.log.push(line);
    if (this.log.length > LOG_LIMIT) this.log.splice(0, this.log.length - LOG_LIMIT);
    this.emit({ type: "log", line });
  }

  finish(run: Run) {
    clearTimeout(this.progressTimer);
    this.emit({ type: "progress", progress: this.progress });
    this.emit({ type: "done", run });
    this.listeners.clear();
  }

  summary() {
    return { id: this.id, kind: this.kind, repo: this.repo, source: this.source, trigger: this.trigger, status: this.status, progress: this.progress };
  }
}
