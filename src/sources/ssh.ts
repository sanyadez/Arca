/**
 * SSH source: the server pulls a directory from the machine itself.
 *
 * Two requests per snapshot: `find -printf` returns the whole state (type, mode, owner, mtime, size, inode,
 * link target) separated by NUL; `tar -cf -` returns the contents of changed files as one stream (the path
 * list goes to stdin). The source only needs GNU find (or bfs) and GNU tar.
 *
 * `forced` mode: on the source the key is bound to the forced command `arca-src`
 * (scripts/arca-src.sh) — then we send only `arca-src list|read <base64url root>`,
 * and the script decides what exactly to run. The find/tar commands here and in the script must match.
 */
import type { ListResult, ReadItem, Source, SourceEntry } from "../core/source";
import { type SshConn, shQuote, sshCloseMaster, sshOptionArgs, sshTarget } from "../ssh";
import { StreamBuf, tarMembers } from "./tar";

export interface SshSourceOptions extends SshConn {
  /** Absolute path of the directory on the source. */
  path: string;
  /** The key on the source is bound to the forced command arca-src. */
  forced?: boolean;
  /** How to run ssh (tests substitute their own). */
  sshCommand?: string[];
}

export const FIND_PRINTF = "%y %m %U %G %T@ %s %i\\0%P\\0%l\\0";
export const TAR_FLAGS = "--null --no-recursion --hard-dereference --warning=no-file-changed -T - -cf -";

export function parseSshUrl(url: string): Omit<SshSourceOptions, "forced"> {
  const u = new URL(url);
  if (u.protocol !== "ssh:") throw new Error(`Expected an ssh:// URL: ${url}`);
  const path = decodeURIComponent(u.pathname);
  if (!path.startsWith("/") || path.length < 2) throw new Error(`An absolute path is required: ${url}`);
  return {
    user: u.username ? decodeURIComponent(u.username) : undefined,
    host: u.hostname,
    port: u.port ? Number(u.port) : undefined,
    path: path.replace(/\/+$/, ""),
  };
}

const b64url = (s: string) => Buffer.from(s, "utf8").toString("base64url");

/** Parse find output: records of three fields, each terminated by NUL. */
export function parseFindOutput(buf: Uint8Array): SourceEntry[] {
  const dec = new TextDecoder();
  const out: SourceEntry[] = [];
  let i = 0;
  const field = () => {
    const z = buf.indexOf(0, i);
    if (z < 0) throw new Error("find: truncated output");
    const s = dec.decode(buf.subarray(i, z));
    i = z + 1;
    return s;
  };
  while (i < buf.length) {
    const meta = field().split(" ");
    const path = field();
    const target = field();
    const [y, m, uid, gid, t, size, ino] = meta;
    const type = y === "f" ? "file" : y === "d" ? "dir" : y === "l" ? "symlink" : null;
    if (!type || !path) continue; // sockets, devices, etc.
    const [sec, frac = ""] = t!.split(".");
    out.push({
      path,
      type,
      mode: parseInt(m!, 8),
      uid: Number(uid),
      gid: Number(gid),
      mtime: Number(sec) * 1000 + Number(frac.padEnd(3, "0").slice(0, 3)),
      size: type === "dir" ? 0 : Number(size),
      ino: Number(ino),
      ...(type === "symlink" ? { target } : {}),
    });
  }
  return out;
}

export class SshSource implements Source {
  readonly label: string;
  readonly host: string;

  constructor(readonly o: SshSourceOptions) {
    this.label = `ssh://${o.user ? o.user + "@" : ""}${o.host}${o.port ? ":" + o.port : ""}${o.path}`;
    this.host = o.host;
  }

  private command(op: "list" | "read"): string {
    if (this.o.forced) return `arca-src ${op} ${b64url(this.o.path)}`;
    const root = shQuote(this.o.path);
    return op === "list"
      ? `LC_ALL=C find ${root} -mindepth 1 -printf '${FIND_PRINTF}'`
      : `cd ${root} && LC_ALL=C tar ${TAR_FLAGS}`;
  }

  private async spawn(op: "list" | "read") {
    const base = this.o.sshCommand ?? ["ssh"];
    const args = [...base, ...(await sshOptionArgs(this.o))];
    if (this.o.port) args.push("-p", String(this.o.port));
    args.push(sshTarget(this.o), this.command(op));
    return Bun.spawn(args, { stdin: op === "read" ? "pipe" : "ignore", stdout: "pipe", stderr: "pipe" });
  }

  async list(): Promise<ListResult> {
    const p = await this.spawn("list");
    const [out, err, code] = await Promise.all([new Response(p.stdout).bytes(), new Response(p.stderr).text(), p.exited]);
    const errLines = err.split("\n").map((l) => l.trim()).filter(Boolean);
    if (code !== 0 && out.length === 0) throw new Error(`${this.label}: ${errLines.at(-1) ?? `ssh exit code ${code}`}`);
    const entries = parseFindOutput(out);
    // find order: a directory always comes before its contents (depth-first and breadth-first alike) — as required.
    return { entries, errors: errLines.map((e) => ({ path: "", error: e })) };
  }

  async *read(paths: string[]): AsyncGenerator<ReadItem> {
    if (paths.length === 0) return;
    const p = await this.spawn("read");
    // Write the list concurrently with reading, otherwise tar and we may wait on each other.
    const sink = p.stdin as import("bun").FileSink;
    const writing = (async () => {
      let chunk = "";
      for (const path of paths) {
        chunk += path + "\0";
        if (chunk.length < 1 << 16) continue;
        await sink.write(chunk);
        chunk = "";
      }
      if (chunk) await sink.write(chunk);
      await sink.end();
    })();
    writing.catch(() => {}); // if ssh failed, the exit code will report it
    const errText = new Response(p.stderr).text();
    const sb = new StreamBuf(p.stdout);
    let i = 0;
    let finished = false;
    // tar message about a single file: "tar: <path>: Cannot open: …".
    const fileError = (path: string, err: string) =>
      err.split("\n").find((l) => l.startsWith(`tar: ${path}: `))?.slice(5) ?? "not read";
    const skipped: string[] = [];
    try {
      for await (const m of tarMembers(sb)) {
        // tar skips files it could not read; the reason is taken from stderr at the end.
        while (i < paths.length && paths[i] !== m.name) skipped.push(paths[i++]!);
        if (i >= paths.length) throw new Error(`tar returned an unexpected file: ${m.name}`);
        i++;
        if (m.type !== "0") {
          yield { path: m.name, error: "no longer a regular file" };
          continue;
        }
        yield { path: m.name, reader: m.reader };
      }
      await writing;
      const code = await p.exited;
      const err = (await errText).trim();
      // GNU tar: 1 means files changed while being read, 2 means some could not be opened. The archive is
      // still intact, so these are per-file errors. Without a single archive byte the whole request failed.
      if (code > 2 || (code !== 0 && sb.total === 0))
        throw new Error(`${this.label}: ${err.split("\n").at(-1) || `ssh/tar exit code ${code}`}`);
      while (i < paths.length) skipped.push(paths[i++]!);
      for (const path of skipped) yield { path, error: fileError(path, err) };
      finished = true;
    } finally {
      if (!finished) {
        p.kill();
        await sb.cancel();
      }
    }
  }

  async close() {
    if (!this.o.sshCommand) await sshCloseMaster(this.o);
  }
}
