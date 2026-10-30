/** Shared by everything that goes through the system OpenSSH: options and one connection per host (ControlMaster). */
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface SshConn {
  user?: string;
  host: string;
  port?: number;
  identity?: string;
  /** Extra `-o` options for ssh (e.g. "StrictHostKeyChecking=accept-new"). */
  sshOptions?: string[];
  /** How many seconds to keep the background connection after the last operation. */
  persist?: number;
}

let ctlDir: Promise<string> | undefined;

export function controlPath(): Promise<string> {
  ctlDir ??= (async () => {
    const base = join(tmpdir(), `arca-ssh-${process.getuid?.() ?? "u"}`);
    await mkdir(base, { recursive: true, mode: 0o700 });
    return base;
  })();
  return ctlDir.then((d) => join(d, "cm-%C"));
}

/** `-o …` options for ssh and sftp (the caller adds the port: -p for ssh, -P for sftp). */
export async function sshOptionArgs(c: SshConn): Promise<string[]> {
  const a = [
    "-o", "BatchMode=yes",
    "-o", "ControlMaster=auto",
    "-o", `ControlPath=${await controlPath()}`,
    "-o", `ControlPersist=${c.persist ?? 60}`,
    "-o", "ConnectTimeout=15",
    "-o", "ServerAliveInterval=15",
  ];
  if (c.identity) a.push("-i", c.identity);
  for (const opt of c.sshOptions ?? []) a.push("-o", opt);
  return a;
}

export function sshTarget(c: SshConn) {
  return c.user ? `${c.user}@${c.host}` : c.host;
}

/** Close the background connection to the host. */
export async function sshCloseMaster(c: SshConn) {
  const p = Bun.spawn(
    ["ssh", "-O", "exit", "-o", `ControlPath=${await controlPath()}`, ...(c.port ? ["-p", String(c.port)] : []), sshTarget(c)],
    { stdout: "ignore", stderr: "ignore" },
  );
  await p.exited;
}

/** Single-quoted string for the remote shell. */
export function shQuote(s: string) {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}
