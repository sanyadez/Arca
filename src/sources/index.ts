/** Source by URL: a path is a local directory, `ssh://user@host[:port]/path` is over SSH. */
import { LocalSource, type Source } from "../core/source";
import { SshSource, parseSshUrl, type SshSourceOptions } from "./ssh";

export type SshExtra = Partial<Pick<SshSourceOptions, "identity" | "forced" | "sshOptions" | "sshCommand">>;

export function isRemoteSource(path: string) {
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(path);
}

export function openSource(path: string, ssh: SshExtra = {}): Source {
  if (path.startsWith("ssh://")) return new SshSource({ ...parseSshUrl(path), ...ssh });
  if (isRemoteSource(path)) throw new Error(`Unknown source type: ${path}`);
  return new LocalSource(path);
}
