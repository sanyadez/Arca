/**
 * SFTP storage via the system OpenSSH (`sftp -b -`), without npm dependencies.
 *
 * Each operation is a separate sftp process with a command batch on stdin; all of them share one
 * connection (ControlMaster), so a process costs tens of ms rather than a full SSH handshake.
 * Keys, known_hosts and ~/.ssh/config are the usual ones, as for `ssh`.
 * The server may allow SFTP only (ForceCommand internal-sftp, chroot) — nothing else is needed.
 */
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, posix } from "node:path";
import { randomBytes } from "node:crypto";
import { type Backend, type FileInfo, NotFoundError, checkPath } from "./types";
import { type SshConn, sshCloseMaster, sshOptionArgs, sshTarget } from "../ssh";

export interface SftpOptions extends SshConn {
  /** Repository root on the server (absolute or relative to the home directory). */
  path: string;
}

class SftpError extends Error {}

const SAFE = /^[^"\n\r\\]*$/;
function q(p: string) {
  if (!SAFE.test(p)) throw new Error(`Invalid character in SFTP path: ${p}`);
  return `"${p}"`;
}

export function parseSftpUrl(url: string): SftpOptions {
  const u = new URL(url);
  if (u.protocol !== "sftp:") throw new Error(`Expected an sftp:// URL: ${url}`);
  const path = decodeURIComponent(u.pathname) || ".";
  return {
    user: u.username ? decodeURIComponent(u.username) : undefined,
    host: u.hostname,
    port: u.port ? Number(u.port) : undefined,
    // sftp://host/abs/path is an absolute path; sftp://host/~/repo is relative to the home directory.
    path: path.startsWith("/~/") ? path.slice(3) : path,
  };
}

export class SftpBackend implements Backend {
  readonly ranged = false;
  readonly label: string;
  private used = false;
  private knownDirs = new Set<string>();
  private readonly root: string;

  constructor(readonly o: SftpOptions) {
    this.root = o.path.replace(/\/+$/, "") || ".";
    this.label = `sftp://${o.user ? o.user + "@" : ""}${o.host}${o.port ? ":" + o.port : ""}/${this.root.replace(/^\//, "")}`;
  }

  /** Run a command batch; commands prefixed with `-` may fail without stopping the batch. */
  private async run(batch: string[]): Promise<string> {
    this.used = true;
    const args = ["sftp", "-b", "-", "-q", ...(await sshOptionArgs(this.o))];
    if (this.o.port) args.push("-P", String(this.o.port));
    args.push(sshTarget(this.o));
    const p = Bun.spawn(args, { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
    p.stdin.write(batch.join("\n") + "\n");
    await p.stdin.end();
    const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
    if (code !== 0) {
      const msg = err.trim().split("\n").filter((l) => l && !l.startsWith("sftp>")).pop() ?? `exit code ${code}`;
      throw new SftpError(msg);
    }
    return out;
  }

  private abs(path: string) {
    return posix.join(this.root, checkPath(path));
  }

  private mkdirs(dir: string): string[] {
    const cmds: string[] = [];
    const parts = dir.split("/");
    for (let i = 1; i <= parts.length; i++) {
      const d = parts.slice(0, i).join("/");
      if (!d || this.knownDirs.has(d)) continue;
      cmds.push(`-mkdir ${q(d)}`);
      this.knownDirs.add(d);
    }
    return cmds;
  }

  private async withTmp<T>(fn: (dir: string) => Promise<T>): Promise<T> {
    const d = await mkdtemp(join(tmpdir(), "arca-sftp-"));
    try {
      return await fn(d);
    } finally {
      await rm(d, { recursive: true, force: true });
    }
  }

  async put(path: string, data: Uint8Array) {
    const dst = this.abs(path);
    const tmpName = `${dst}.tmp-${randomBytes(6).toString("hex")}`;
    await this.withTmp(async (d) => {
      const local = join(d, "f");
      await writeFile(local, data, { mode: 0o600 });
      const dirs = this.mkdirs(posix.dirname(dst));
      try {
        await this.run([...dirs, `put ${q(local)} ${q(tmpName)}`, `rename ${q(tmpName)} ${q(dst)}`]);
      } catch (e) {
        for (const c of dirs) this.knownDirs.delete(c.slice(8, -1));
        await this.run([`-rm ${q(tmpName)}`]).catch(() => {});
        throw e;
      }
    });
  }

  async get(path: string, range?: { offset: number; length: number }) {
    return this.withTmp(async (d) => {
      const local = join(d, "f");
      try {
        await this.run([`get ${q(this.abs(path))} ${q(local)}`]);
      } catch (e) {
        if (e instanceof SftpError && /not found|no such file/i.test(e.message)) throw new NotFoundError(path);
        throw e;
      }
      const buf = new Uint8Array(await readFile(local));
      return range ? buf.slice(range.offset, range.offset + range.length) : buf;
    });
  }

  /** Parse `ls -ln` output following each echoed `sftp> ls -ln <dir>` command. */
  private parseListing(out: string): Map<string, { name: string; size: number; dir: boolean }[]> {
    const res = new Map<string, { name: string; size: number; dir: boolean }[]>();
    let cur: { name: string; size: number; dir: boolean }[] | null = null;
    for (const line of out.split("\n")) {
      const m = /^sftp> -?ls -ln "(.*)"$/.exec(line);
      if (m) {
        cur = [];
        res.set(m[1]!, cur);
        continue;
      }
      if (!cur) continue;
      const f = line.trim().split(/\s+/);
      if (f.length < 9 || !/^[-dl]/.test(f[0]!)) continue;
      const full = f.slice(8).join(" ");
      cur.push({ name: posix.basename(full), size: Number(f[4]), dir: f[0]!.startsWith("d") });
    }
    return res;
  }

  async list(dir: string): Promise<FileInfo[]> {
    return (await this.walk(dir)).files;
  }

  /** Recursive walk: one sftp process per nesting level. */
  private async walk(dir: string): Promise<{ files: FileInfo[]; dirs: string[] }> {
    const files: FileInfo[] = [];
    const dirs: string[] = [];
    let level = [checkPath(dir)];
    while (level.length > 0) {
      const listing = this.parseListing(await this.run(level.map((d) => `-ls -ln ${q(this.abs(d))}`)));
      const next: string[] = [];
      for (const d of level) {
        for (const e of listing.get(this.abs(d)) ?? []) {
          if (e.name === "." || e.name === "..") continue;
          if (e.dir) next.push(`${d}/${e.name}`);
          else if (!e.name.includes(".tmp-")) files.push({ name: `${d}/${e.name}`, size: e.size });
        }
      }
      dirs.push(...next);
      level = next;
    }
    return { files, dirs };
  }

  async delete(path: string) {
    await this.run([`-rm ${q(this.abs(path))}`]);
  }

  async exists(path: string) {
    const listing = this.parseListing(await this.run([`-ls -ln ${q(this.abs(path))}`]));
    return (listing.get(this.abs(path)) ?? []).some((e) => !e.dir);
  }

  /** Delete the whole repository (tests only). */
  async usage() {
    // `df` of the sftp client (statvfs extension): sizes in KiB.
    const out = await this.run([`-df ${q(this.root)}`]).catch(() => "");
    const line = out.split("\n").find((l) => /^\s*\d+\s+\d+\s+\d+/.test(l));
    if (!line) return null;
    const [size, used] = line.trim().split(/\s+/).map(Number);
    return { total: size! * 1024, used: used! * 1024 };
  }

  async destroyAll() {
    const cmds = [`-rm ${q(this.abs("config"))}`];
    const dirs: string[] = [];
    for (const top of ["keys", "data", "index", "snapshots", "locks"]) {
      const w = await this.walk(top);
      cmds.push(...w.files.map((f) => `-rm ${q(this.abs(f.name))}`));
      dirs.push(...w.dirs, top);
    }
    for (const d of dirs.sort((a, b) => b.length - a.length)) cmds.push(`-rmdir ${q(this.abs(d))}`);
    cmds.push(`-rmdir ${q(this.root)}`);
    await this.run(cmds);
    this.knownDirs.clear();
  }

  async close() {
    if (this.used) await sshCloseMaster(this.o);
  }
}
