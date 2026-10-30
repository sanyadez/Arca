/**
 * `arca client`: runs on a machine whose folders are backed up. It asks the server for jobs (long poll),
 * runs the backup locally with the same core (chunking, deduplication, encryption), writes through the
 * server's storage proxy, and streams progress and log lines back. Only the server address and the client
 * token are kept on disk; the repository password comes with each job and stays in memory.
 */
import { hostname } from "node:os";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { RemoteBackend } from "../backends/remote";
import { Repository } from "../core/repo";
import { backup, type BackupProgress } from "../core/backup";
import { withLock } from "../core/lock";
import { LocalSource } from "../core/source";
import { VERSION_STRING } from "../version";
import type { ClientBackupResult, ClientJob } from "../server/clients";

export const DEFAULT_CLIENT_CONFIG = "/etc/arca/client.json";

export interface ClientConfig {
  server: string;
  token: string;
}

export async function loadClientConfig(path = DEFAULT_CLIENT_CONFIG): Promise<ClientConfig> {
  const raw = JSON.parse(await readFile(path, "utf8"));
  if (typeof raw.server !== "string" || typeof raw.token !== "string") throw new Error(`${path}: server and token are required`);
  return { server: raw.server.replace(/\/+$/, ""), token: raw.token };
}

export async function saveClientConfig(path: string, c: ClientConfig) {
  const p = resolve(path);
  await mkdir(dirname(p), { recursive: true });
  const tmp = `${p}.tmp-${process.pid}`;
  await writeFile(tmp, JSON.stringify(c, null, 2) + "\n", { mode: 0o600 });
  await chmod(tmp, 0o600);
  await rename(tmp, p);
}

type Log = (msg: string) => void;

export interface Hello {
  client: string;
  server: { version: string; host: string };
  sources: { name: string; path: string; repo: string; schedule: string | null }[];
}

export class ClientAgent {
  private stopped = false;
  private poller: AbortController | undefined;
  private current: AbortController | undefined;

  constructor(
    readonly cfg: ClientConfig,
    private log: Log = (m) => console.log(m),
  ) {}

  private headers(extra: Record<string, string> = {}) {
    return { Authorization: `Bearer ${this.cfg.token}`, "X-Arca-Version": VERSION_STRING, "X-Arca-Host": hostname(), ...extra };
  }

  private async call<T>(method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
    const res = await fetch(`${this.cfg.server}/api/client${path}`, {
      method,
      signal,
      headers: this.headers(body !== undefined ? { "Content-Type": "application/json" } : {}),
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const data = (await res.json().catch(() => ({}))) as { error?: string };
    if (!res.ok) throw new Error(`${method} ${path}: ${data.error ?? `HTTP ${res.status}`}`);
    return data as T;
  }

  hello(): Promise<Hello> {
    return this.call<Hello>("GET", "/hello");
  }

  /** Poll and run jobs until stop(). Network errors are retried with a growing pause. */
  async run(o: { wait?: number } = {}) {
    let pause = 1000;
    const h = await this.hello().catch((e) => (this.log(`server not reachable yet: ${e.message}`), null));
    if (h) this.log(`connected to ${this.cfg.server} (Arca ${h.server.version}) as client ${h.client}; sources: ${h.sources.map((s) => `${s.name}=${s.path}`).join(", ") || "none yet"}`);
    while (!this.stopped) {
      try {
        this.poller = new AbortController();
        const { job } = await this.call<{ job: ClientJob | null }>("GET", `/poll?wait=${o.wait ?? 25}`, undefined, this.poller.signal);
        pause = 1000;
        if (job) await this.runJob(job);
      } catch (e: any) {
        if (this.stopped) break;
        this.log(`poll failed: ${e?.message ?? e}; retrying in ${Math.round(pause / 1000)} s`);
        await Bun.sleep(pause);
        pause = Math.min(pause * 2, 60_000);
      }
    }
  }

  async stop() {
    this.stopped = true;
    this.poller?.abort();
    this.current?.abort();
  }

  /** One backup job; the result (or the error) always goes back to the server. */
  async runJob(job: ClientJob) {
    this.log(`run #${job.runId}: backup ${job.source} (${job.path}) → ${job.repo}`);
    const abort = (this.current = new AbortController());
    let progress: BackupProgress | undefined;
    let logs: { stage: string; text: string }[] = [];
    let sending: Promise<void> | null = null;
    // Progress at most every second, and a heartbeat even when nothing changes.
    const flush = async () => {
      const body = { progress: progress ? { ...progress } : undefined, logs };
      logs = [];
      try {
        const r = await this.call<{ cancel: boolean }>("POST", `/runs/${job.runId}/events`, body);
        if (r.cancel && !abort.signal.aborted) {
          this.log(`run #${job.runId}: cancelled on the server`);
          abort.abort();
        }
      } catch (e: any) {
        this.log(`run #${job.runId}: could not send progress: ${e?.message ?? e}`);
      }
    };
    const tick = setInterval(() => {
      if (!sending) sending = flush().finally(() => (sending = null));
    }, 1000);

    let report: { ok: boolean; result?: ClientBackupResult; error?: string; cancelled?: boolean };
    let repo: Repository | undefined;
    try {
      const backend = new RemoteBackend({ server: this.cfg.server, token: this.cfg.token, repo: job.repo, ranged: job.ranged });
      repo = await Repository.open(backend, job.password);
      const from = new LocalSource(job.path);
      const r = await withLock(repo, false, `backup ${job.source} (client ${hostname()})`, () =>
        backup(repo!, {
          from,
          source: job.source,
          exclude: job.exclude,
          tags: job.tags,
          owner: job.owner,
          signal: abort.signal,
          onProgress: (p) => (progress = p),
          onLog: (stage, text) => logs.push({ stage, text }),
        }),
      );
      report = { ok: true, result: { id: r.id, changed: r.changed, stats: r.snapshot.stats!, errors: r.errors.slice(0, 200) } };
      this.log(`run #${job.runId}: snapshot ${r.id.slice(0, 8)}, ${r.changed} changed, ${r.errors.length} errors`);
    } catch (e: any) {
      const cancelled = e?.name === "AbortError";
      report = { ok: false, cancelled, error: e?.message ?? String(e) };
      this.log(`run #${job.runId}: ${cancelled ? "cancelled" : `failed: ${report.error}`}`);
    } finally {
      clearInterval(tick);
      await sending;
      await repo?.close().catch(() => {});
      this.current = undefined;
    }
    await flush();
    for (let i = 0; ; i++) {
      try {
        await this.call("POST", `/runs/${job.runId}/finish`, report);
        return;
      } catch (e: any) {
        if (i >= 5 || this.stopped) return this.log(`run #${job.runId}: could not report the result: ${e?.message ?? e}`);
        await Bun.sleep(1000 * 2 ** i);
      }
    }
  }
}
