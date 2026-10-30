/**
 * Server config (JSON). Example: config.example.json.
 *
 * Repository passwords are never written into the config: use `passwordFile` (a file with mode 600) or the
 * environment variable ARCA_PASSWORD_<NAME> (uppercase, `-` → `_`). API tokens are stored only as sha256 hashes.
 */
import { readFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import type { RetentionPolicy } from "../core/retention";
import { Cron } from "./cron";
import { isClientSource, isRemoteSource, openSource, parseClientUrl, type SshExtra } from "../sources";

export interface RepoConf {
  url: string;
  passwordFile?: string;
  /** Prune schedule; defaults to Sundays at 04:30. "" disables it. */
  prune?: string;
  /** Check schedule; defaults to daily at 05:00, reading the data of 5% of packs. */
  check?: string;
  checkReadData?: number;
}

export interface SourceConf {
  /** Local directory, ssh://user@host[:port]/path or client://<client>/path (a machine running `arca client`). */
  path: string;
  /** For ssh://: key, forced arca-src command on the source, extra -o options. */
  ssh?: Pick<SshExtra, "identity" | "forced" | "sshOptions">;
  repo: string;
  schedule?: string;
  exclude?: string[];
  tags?: string[];
  retention?: RetentionPolicy;
  owner?: string;
}

export interface TokenConf {
  name: string;
  sha256: string;
  /** Whose snapshots the token sees; for now all tokens belong to owner "default". */
  owner?: string;
  /**
   * What is allowed: read — browse; backup — run backup and check; restore — restore; admin — everything.
   * client — a machine running `arca client` (the token name is the client name); it allows only the
   * client API and cannot be combined with other scopes.
   */
  scopes: ("read" | "backup" | "restore" | "admin" | "client")[];
  /** ISO times; a token past `expires` is refused. */
  created?: string;
  expires?: string;
}

export interface Config {
  listen: { host: string; port: number };
  dataDir: string;
  /** Directory the API/MCP may restore into (only into its subdirectories). */
  restoreRoot: string;
  tokens: TokenConf[];
  repos: Record<string, RepoConf>;
  sources: Record<string, SourceConf>;
}

const NAME = /^[a-z0-9][a-z0-9_-]{0,62}$/;

export function validateConfig(raw: any, baseDir: string): Config {
  const err = (m: string) => {
    throw new Error(`Config: ${m}`);
  };
  if (!raw || typeof raw !== "object") err("expected a JSON object");
  const abs = (p: string) => (isAbsolute(p) ? p : resolve(baseDir, p));
  const dataDir = abs(raw.dataDir ?? "data");
  const cfg: Config = {
    listen: { host: raw.listen?.host ?? "127.0.0.1", port: Number(raw.listen?.port ?? 7350) },
    dataDir,
    restoreRoot: abs(raw.restoreRoot ?? resolve(dataDir, "restore")),
    tokens: raw.tokens ?? [],
    repos: {},
    sources: {},
  };
  for (const t of cfg.tokens) {
    if (!t.name || !/^[0-9a-f]{64}$/.test(t.sha256 ?? "")) err(`token ${t.name ?? "?"}: name and sha256 (64 hex) are required`);
    if (!Array.isArray(t.scopes) || t.scopes.length === 0) err(`token ${t.name}: scopes are required`);
    if (t.scopes.some((s: string) => !["read", "backup", "restore", "admin", "client"].includes(s))) err(`token ${t.name}: unknown scope`);
    if (t.scopes.includes("client") && t.scopes.length > 1) err(`token ${t.name}: the client scope cannot be combined with others`);
    if (cfg.tokens.filter((x) => x.name === t.name).length > 1) err(`token name "${t.name}" is used twice`);
  }
  for (const [name, r] of Object.entries<any>(raw.repos ?? {})) {
    if (!NAME.test(name)) err(`invalid repository name "${name}"`);
    if (typeof r?.url !== "string") err(`repository ${name}: url is required`);
    for (const k of ["prune", "check"] as const) if (r[k]) new Cron(r[k]);
    cfg.repos[name] = { ...r, passwordFile: r.passwordFile ? abs(r.passwordFile) : undefined };
  }
  for (const [name, s] of Object.entries<any>(raw.sources ?? {})) {
    if (!NAME.test(name)) err(`invalid source name "${name}"`);
    if (typeof s?.path !== "string") err(`source ${name}: path is required`);
    if (!cfg.repos[s.repo]) err(`source ${name}: unknown repository "${s.repo}"`);
    if (s.schedule) new Cron(s.schedule);
    const path = isRemoteSource(s.path) ? s.path : abs(s.path);
    if (isClientSource(path)) parseClientUrl(path);
    else openSource(path, s.ssh); // validate the address
    cfg.sources[name] = { ...s, path, ssh: s.ssh?.identity ? { ...s.ssh, identity: abs(s.ssh.identity) } : s.ssh };
  }
  return cfg;
}

export async function loadConfig(path: string): Promise<Config> {
  const p = resolve(path);
  return validateConfig(JSON.parse(await readFile(p, "utf8")), dirname(p));
}

export async function repoPassword(name: string, r: RepoConf): Promise<string> {
  const env = process.env[`ARCA_PASSWORD_${name.toUpperCase().replace(/-/g, "_")}`];
  if (env) return env;
  if (r.passwordFile) return (await readFile(r.passwordFile, "utf8")).replace(/\r?\n$/, "");
  throw new Error(`Repository ${name}: no password set (passwordFile or ARCA_PASSWORD_${name.toUpperCase().replace(/-/g, "_")})`);
}
