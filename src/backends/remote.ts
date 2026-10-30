/**
 * Storage of a repository reached through the Arca server (`/api/client/storage/<repo>/…`), for clients on
 * other machines. The client encrypts and deduplicates locally and only moves sealed files; the server
 * decides what is allowed (it only appends: see src/server/clients.ts).
 */
import { type Backend, type FileInfo, NotFoundError, checkPath } from "./types";

export interface RemoteOptions {
  /** Server address, e.g. http://backup.lan:7350 */
  server: string;
  token: string;
  repo: string;
  /** Whether the storage behind the server reads parts of files (told by the server with the job). */
  ranged: boolean;
  /** Attempts for a request that failed on the network or with a 5xx (default 4). */
  attempts?: number;
}

export class RemoteBackend implements Backend {
  readonly label: string;
  readonly ranged: boolean;
  private base: string;
  private attempts: number;

  constructor(private o: RemoteOptions) {
    this.base = `${o.server.replace(/\/+$/, "")}/api/client/storage/${encodeURIComponent(o.repo)}`;
    this.label = `${o.repo} via ${o.server}`;
    this.ranged = o.ranged;
    this.attempts = o.attempts ?? 4;
  }

  private async req(method: string, path: string, init: { body?: Uint8Array; headers?: Record<string, string> } = {}): Promise<Response> {
    let last: unknown;
    for (let i = 0; i < this.attempts; i++) {
      if (i) await Bun.sleep(500 * 2 ** (i - 1));
      try {
        const res = await fetch(this.base + path, {
          method,
          body: init.body,
          headers: { Authorization: `Bearer ${this.o.token}`, ...init.headers },
        });
        if (res.status < 500) return res;
        last = new Error(`${method} ${path}: HTTP ${res.status} ${await res.text().catch(() => "")}`.trim());
      } catch (e) {
        last = e;
      }
    }
    throw last instanceof Error ? last : new Error(String(last));
  }

  private static async fail(res: Response, what: string): Promise<never> {
    const body = await res.json().catch(() => ({}) as { error?: string });
    throw new Error(`${what}: ${(body as { error?: string }).error ?? `HTTP ${res.status}`}`);
  }

  async put(path: string, data: Uint8Array): Promise<void> {
    const res = await this.req("PUT", `/f/${checkPath(path)}`, { body: data, headers: { "Content-Type": "application/octet-stream" } });
    if (!res.ok) await RemoteBackend.fail(res, `put ${path}`);
  }

  async get(path: string, range?: { offset: number; length: number }): Promise<Uint8Array> {
    const headers: Record<string, string> = range ? { Range: `bytes=${range.offset}-${range.offset + range.length - 1}` } : {};
    const res = await this.req("GET", `/f/${checkPath(path)}`, { headers });
    if (res.status === 404) throw new NotFoundError(path);
    if (!res.ok) await RemoteBackend.fail(res, `get ${path}`);
    return new Uint8Array(await res.arrayBuffer());
  }

  async list(dir: string): Promise<FileInfo[]> {
    const res = await this.req("GET", `/list?dir=${encodeURIComponent(dir)}`);
    if (!res.ok) await RemoteBackend.fail(res, `list ${dir}`);
    return ((await res.json()) as { files: FileInfo[] }).files;
  }

  async delete(path: string): Promise<void> {
    const res = await this.req("DELETE", `/f/${checkPath(path)}`);
    if (!res.ok && res.status !== 404) await RemoteBackend.fail(res, `delete ${path}`);
  }

  async exists(path: string): Promise<boolean> {
    const res = await this.req("HEAD", `/f/${checkPath(path)}`);
    if (res.status === 404) return false;
    if (!res.ok) throw new Error(`exists ${path}: HTTP ${res.status}`);
    return true;
  }

  async close() {}
}
