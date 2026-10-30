/** Storage by URL: a path or `local:/path` is a local directory, `sftp://user@host:port/path` is SFTP. */
import { resolve } from "node:path";
import { LocalBackend } from "./local";
import { SftpBackend, parseSftpUrl, type SftpOptions } from "./sftp";
import type { Backend } from "./types";

export type { Backend } from "./types";

export function openBackend(url: string, extra: Partial<SftpOptions> = {}): Backend {
  if (url.startsWith("sftp://")) return new SftpBackend({ ...parseSftpUrl(url), ...extra });
  if (url.startsWith("local:")) return new LocalBackend(resolve(url.slice("local:".length)));
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) throw new Error(`Unknown storage type: ${url}`);
  return new LocalBackend(resolve(url));
}
