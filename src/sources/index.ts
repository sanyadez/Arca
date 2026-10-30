/**
 * Source by URL: a path is a local directory, `ssh://user@host[:port]/path` is over SSH,
 * `client://<client>/path` is a folder on a machine running `arca client` (the backup runs there, not here).
 */
import { LocalSource, type Source } from "../core/source";
import { SshSource, parseSshUrl, type SshSourceOptions } from "./ssh";

export type SshExtra = Partial<Pick<SshSourceOptions, "identity" | "forced" | "sshOptions" | "sshCommand">>;

export function isRemoteSource(path: string) {
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(path);
}

const CLIENT_URL = /^client:\/\/([a-z0-9][a-z0-9_-]{0,62})(\/.*)$/;

export const isClientSource = (path: string) => path.startsWith("client://");

/** `client://laptop/home/me` → { client: "laptop", path: "/home/me" }. */
export function parseClientUrl(url: string): { client: string; path: string } {
  const m = CLIENT_URL.exec(url);
  if (!m || m[2]!.split("/").some((p, i) => i > 0 && (p === "." || p === ".."))) throw new Error(`Invalid client source: ${url} (expected client://<client>/<absolute path>)`);
  return { client: m[1]!, path: m[2]!.length > 1 ? m[2]!.replace(/\/+$/, "") : "/" };
}

export function openSource(path: string, ssh: SshExtra = {}): Source {
  if (path.startsWith("ssh://")) return new SshSource({ ...parseSshUrl(path), ...ssh });
  if (isClientSource(path)) throw new Error(`${path} is backed up by the client on that machine, not by the server`);
  if (isRemoteSource(path)) throw new Error(`Unknown source type: ${path}`);
  return new LocalSource(path);
}
