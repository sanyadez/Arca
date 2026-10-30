/**
 * Snapshot source: where the files come from — a local directory, SSH (src/sources/ssh.ts), later a client on the machine.
 * Backup works in two passes: first `list()` returns the whole state (no content), then `read()` streams the content
 * of only the changed files. So a remote source needs just two requests per snapshot.
 */
import { lstat, open, readdir, readlink } from "node:fs/promises";
import { join, resolve } from "node:path";

export type EntryType = "file" | "dir" | "symlink";

export interface SourceEntry {
  /** Path relative to the source root, "/" separator. */
  path: string;
  type: EntryType;
  mode: number; // 0o7777
  uid: number;
  gid: number;
  mtime: number; // ms
  size: number;
  ino: number;
  target?: string;
}

export interface ListResult {
  /** Every directory comes before its contents. */
  entries: SourceEntry[];
  errors: { path: string; error: string }[];
}

/** Sequential read: like FileHandle.read but without a position. 0 means EOF. */
export interface ByteReader {
  read(buf: Uint8Array, offset: number, length: number): Promise<number>;
}

export interface ReadItem {
  path: string;
  reader?: ByteReader;
  error?: string;
}

export interface Source {
  /** Description for snapshots and logs, without secrets (absolute path or ssh://…). */
  readonly label: string;
  /** Host the snapshot is taken from (for grouping snapshots); undefined means this one. */
  readonly host?: string;
  /** skipDir: do not descend into a directory (exclusion); a remote source may ignore it. */
  list(skipDir?: (rel: string) => boolean): Promise<ListResult>;
  /**
   * File contents in the order of `paths`. A reader is valid only until the next iteration step.
   * A file that could not be read yields an item with error.
   */
  read(paths: string[]): AsyncGenerator<ReadItem>;
  close(): Promise<void>;
}

export class LocalSource implements Source {
  readonly root: string;
  readonly label: string;
  readonly host = undefined;
  constructor(root: string) {
    this.root = resolve(root);
    this.label = this.root;
  }

  async list(skipDir?: (rel: string) => boolean): Promise<ListResult> {
    const st = await lstat(this.root).catch(() => null);
    if (!st?.isDirectory()) throw new Error(`Not a directory: ${this.root}`);
    const res: ListResult = { entries: [], errors: [] };
    const walk = async (rel: string) => {
      let names: string[];
      try {
        names = (await readdir(rel ? join(this.root, rel) : this.root)).sort();
      } catch (e: any) {
        res.errors.push({ path: rel, error: e?.message ?? String(e) });
        return false;
      }
      for (const name of names) {
        const r = rel ? `${rel}/${name}` : name;
        const a = join(this.root, r);
        try {
          const s = await lstat(a);
          const base = { path: r, mode: s.mode & 0o7777, uid: s.uid, gid: s.gid, mtime: Math.floor(s.mtimeMs), size: s.size, ino: s.ino };
          if (s.isDirectory()) {
            if (skipDir?.(r)) continue;
            const at = res.entries.push({ ...base, type: "dir", size: 0 }) - 1;
            // Unreadable directory: drop its own entry too, the error is already recorded.
            if (!(await walk(r))) res.entries.splice(at, res.entries.length - at);
          } else if (s.isFile()) res.entries.push({ ...base, type: "file" });
          else if (s.isSymbolicLink()) res.entries.push({ ...base, type: "symlink", target: await readlink(a) });
          // Sockets, FIFOs and devices are skipped.
        } catch (e: any) {
          res.errors.push({ path: r, error: e?.message ?? String(e) });
        }
      }
      return true;
    };
    await walk("");
    return res;
  }

  async *read(paths: string[]): AsyncGenerator<ReadItem> {
    for (const path of paths) {
      let fh;
      try {
        fh = await open(join(this.root, path), "r");
      } catch (e: any) {
        yield { path, error: e?.message ?? String(e) };
        continue;
      }
      try {
        yield { path, reader: { read: async (b, o, l) => (await fh.read(b, o, l, null)).bytesRead } };
      } finally {
        await fh.close();
      }
    }
  }

  async close() {}
}
