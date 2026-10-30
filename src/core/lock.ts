/**
 * Repository locks: files `locks/<random id>`. Shared for backup/restore/check,
 * exclusive for prune (it deletes packs, so nobody else may write meanwhile).
 * A lock is refreshed every 5 min; one older than 30 min is considered abandoned (the process died).
 */
import { hostname } from "node:os";
import { randomHex } from "./crypto";
import type { Repository } from "./repo";

export const STALE_MS = 30 * 60 * 1000;
const REFRESH_MS = 5 * 60 * 1000;

interface LockInfo {
  time: string;
  exclusive: boolean;
  host: string;
  pid: number;
  what: string;
}

export class Lock {
  private timer: ReturnType<typeof setInterval> | undefined;
  private constructor(
    private repo: Repository,
    readonly path: string,
    private info: LockInfo,
  ) {
    this.timer = setInterval(() => void this.refresh(), REFRESH_MS);
    this.timer.unref?.();
  }

  static async acquire(repo: Repository, exclusive: boolean, what: string): Promise<Lock> {
    const path = `locks/${randomHex(16)}`;
    const info: LockInfo = { time: new Date().toISOString(), exclusive, host: hostname(), pid: process.pid, what };
    const conflict = await Lock.findConflict(repo, exclusive, path);
    if (conflict) throw conflict;
    await repo.putSealedAt(path, info);
    // Check again after writing: two processes may have entered at once.
    const again = await Lock.findConflict(repo, exclusive, path);
    if (again) {
      await repo.backend.delete(path);
      throw again;
    }
    return new Lock(repo, path, info);
  }

  private static async findConflict(repo: Repository, exclusive: boolean, own: string): Promise<Error | null> {
    for (const f of await repo.backend.list("locks")) {
      if (f.name === own) continue;
      let l: LockInfo;
      try {
        l = await repo.getSealed<LockInfo>(f.name);
      } catch {
        continue; // vanished between list and get, or foreign junk
      }
      if (Date.now() - Date.parse(l.time) > STALE_MS) {
        await repo.backend.delete(f.name).catch(() => {});
        continue;
      }
      if (exclusive || l.exclusive)
        return new Error(`Repository is busy: ${l.what} (${l.host}, pid ${l.pid}, since ${l.time})`);
    }
    return null;
  }

  private async refresh() {
    this.info.time = new Date().toISOString();
    await this.repo.putSealedAt(this.path, this.info).catch(() => {});
  }

  async release() {
    clearInterval(this.timer);
    await this.repo.backend.delete(this.path).catch(() => {});
  }
}

export async function withLock<T>(repo: Repository, exclusive: boolean, what: string, fn: () => Promise<T>): Promise<T> {
  const lock = await Lock.acquire(repo, exclusive, what);
  try {
    return await fn();
  } finally {
    await lock.release();
  }
}
