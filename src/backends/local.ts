/** Storage in a local directory (tests, external disk). */
import { mkdir, open, readdir, rename, rm, stat, statfs } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomBytes } from "node:crypto";
import { type Backend, type FileInfo, NotFoundError, checkPath } from "./types";

export class LocalBackend implements Backend {
  readonly ranged = true;
  readonly label: string;

  constructor(readonly root: string) {
    this.label = `local:${root}`;
  }

  private abs(path: string) {
    return join(this.root, checkPath(path));
  }

  async put(path: string, data: Uint8Array) {
    const dst = this.abs(path);
    await mkdir(dirname(dst), { recursive: true });
    const tmp = `${dst}.tmp-${randomBytes(6).toString("hex")}`;
    try {
      const fh = await open(tmp, "wx", 0o600);
      try {
        await fh.writeFile(data);
        await fh.sync();
      } finally {
        await fh.close();
      }
      await rename(tmp, dst);
    } catch (e) {
      await rm(tmp, { force: true });
      throw e;
    }
  }

  async get(path: string, range?: { offset: number; length: number }) {
    let fh;
    try {
      fh = await open(this.abs(path), "r");
    } catch (e: any) {
      if (e?.code === "ENOENT") throw new NotFoundError(path);
      throw e;
    }
    try {
      if (!range) return new Uint8Array(await fh.readFile());
      const buf = new Uint8Array(range.length);
      let got = 0;
      while (got < range.length) {
        const { bytesRead } = await fh.read(buf, got, range.length - got, range.offset + got);
        if (bytesRead === 0) throw new Error(`File is shorter than expected: ${path}`);
        got += bytesRead;
      }
      return buf;
    } finally {
      await fh.close();
    }
  }

  async list(dir: string): Promise<FileInfo[]> {
    const base = this.abs(dir);
    let names: string[];
    try {
      names = (await readdir(base, { recursive: true })) as string[];
    } catch (e: any) {
      if (e?.code === "ENOENT") return [];
      throw e;
    }
    const out: FileInfo[] = [];
    for (const n of names) {
      if (n.includes(".tmp-")) continue;
      const s = await stat(join(base, n)).catch(() => null);
      if (s?.isFile()) out.push({ name: `${dir}/${n.split("\\").join("/")}`, size: s.size });
    }
    return out;
  }

  async delete(path: string) {
    await rm(this.abs(path), { force: true });
  }

  async exists(path: string) {
    return (await stat(this.abs(path)).catch(() => null))?.isFile() ?? false;
  }

  async usage() {
    const s = await statfs(this.root).catch(() => null);
    if (!s) return null;
    return { total: s.blocks * s.bsize, used: (s.blocks - s.bfree) * s.bsize };
  }

  async close() {}
}
