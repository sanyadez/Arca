/**
 * Changes made from the web UI: sources, repositories and tokens in the config, plus the helpers the
 * forms need (storage test, prune preview, SSH key and connection test, folder preview, schedule
 * and retention preview, recovery kit). Everything here requires the admin scope.
 */
import { createHash, randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { networkInterfaces } from "node:os";
import { dirname, join, resolve } from "node:path";
import { openBackend } from "../backends";
import { Repository } from "../core/repo";
import { prune } from "../core/maintenance";
import { withLock } from "../core/lock";
import { applyRetention, isEmptyPolicy, type RetentionPolicy } from "../core/retention";
import { openSource } from "../sources";
import { hashToken } from "./auth";
import type { Config, SourceConf, TokenConf } from "./config";
import { Cron } from "./cron";
import { HttpError, type Service } from "./service";
import { VERSION } from "../version";

const NAME = /^[a-z0-9][a-z0-9_-]{0,62}$/;
const SCOPES = ["read", "backup", "restore", "admin", "client"] as const;

function store(svc: Service) {
  if (!svc.configStore) throw new HttpError(409, "This server was started without a config file, so it cannot change it");
  return svc.configStore;
}

function checkName(kind: string, name: unknown): string {
  if (typeof name !== "string" || !NAME.test(name)) throw new HttpError(400, `${kind} name: lowercase letters, digits, - and _, up to 63 characters`);
  return name;
}

/** Turn a config error into a 400 with the message the form can show. */
async function save(svc: Service, change: (raw: any) => void | Promise<void>): Promise<Config> {
  try {
    const cfg = await store(svc).update(change);
    svc.applyConfig(cfg);
    return cfg;
  } catch (e: any) {
    if (e instanceof HttpError) throw e;
    throw new HttpError(400, String(e?.message ?? e).replace(/^Config: /, ""));
  }
}

// ── sources ──

function sourceFromBody(b: any): SourceConf {
  if (typeof b.path !== "string" || !b.path.trim()) throw new HttpError(400, "path is required");
  if (typeof b.repo !== "string" || !b.repo) throw new HttpError(400, "repo is required");
  const s: SourceConf = { path: b.path.trim(), repo: b.repo };
  if (b.schedule) s.schedule = String(b.schedule).trim();
  if (Array.isArray(b.exclude) && b.exclude.length) s.exclude = b.exclude.map(String).map((x: string) => x.trim()).filter(Boolean);
  if (Array.isArray(b.tags) && b.tags.length) s.tags = b.tags.map(String);
  if (b.retention && typeof b.retention === "object") {
    const r: RetentionPolicy = {};
    for (const k of ["last", "hourly", "daily", "weekly", "monthly", "yearly", "withinDays"] as const) {
      const v = Number(b.retention[k]);
      if (Number.isInteger(v) && v > 0) r[k] = v;
    }
    if (!isEmptyPolicy(r)) s.retention = r;
  }
  if (s.path.startsWith("ssh://") && b.ssh) {
    s.ssh = {};
    if (b.ssh.forced) s.ssh.forced = true;
    if (b.ssh.identity) s.ssh.identity = String(b.ssh.identity);
    if (Array.isArray(b.ssh.sshOptions) && b.ssh.sshOptions.length) s.ssh.sshOptions = b.ssh.sshOptions.map(String);
  }
  return s;
}

export async function createSource(svc: Service, b: any) {
  const name = checkName("Source", b.name);
  if (svc.cfg.sources[name]) throw new HttpError(409, `A source named ${name} already exists`);
  const s = sourceFromBody(b);
  await save(svc, (raw) => {
    raw.sources ??= {};
    raw.sources[name] = s;
  });
  return { name, ...s };
}

export async function updateSource(svc: Service, name: string, b: any) {
  if (!svc.cfg.sources[name]) throw new HttpError(404, `Unknown source: ${name}`);
  const s = sourceFromBody(b);
  await save(svc, (raw) => {
    // The UI does not see key paths: an edit without one keeps the key the source had.
    const old = raw.sources[name]?.ssh;
    if (s.ssh && !s.ssh.identity && old?.identity) s.ssh.identity = old.identity;
    raw.sources[name] = s;
  });
  return { name, ...s };
}

/** Add one exclude pattern (the "Add exclude" button next to a file that could not be read). */
export async function addExclude(svc: Service, name: string, pattern: unknown) {
  if (!svc.cfg.sources[name]) throw new HttpError(404, `Unknown source: ${name}`);
  if (typeof pattern !== "string" || !pattern.trim()) throw new HttpError(400, "pattern is required");
  const p = pattern.trim();
  await save(svc, (raw) => {
    const s = raw.sources[name];
    s.exclude = [...new Set([...(s.exclude ?? []), p])];
  });
  return { name, exclude: svc.cfg.sources[name]!.exclude };
}

export async function deleteSource(svc: Service, name: string) {
  if (!svc.cfg.sources[name]) throw new HttpError(404, `Unknown source: ${name}`);
  await save(svc, (raw) => {
    delete raw.sources[name];
  });
  return { removed: name, note: "Its snapshots stay in the repository until they are forgotten." };
}

// ── repositories ──

/** Is the address reachable, and is there a repository, an empty folder or something else? */
export async function testStorage(url: string) {
  if (typeof url !== "string" || !url.trim()) throw new HttpError(400, "url is required");
  let backend;
  try {
    backend = openBackend(url.trim());
  } catch (e: any) {
    return { reachable: false, error: e.message };
  }
  try {
    const isRepo = await backend.exists("config");
    const files = isRepo ? [] : [...(await backend.list("data")), ...(await backend.list("snapshots"))];
    const usage = await backend.usage?.().catch(() => null);
    return { reachable: true, isRepo, empty: !isRepo && files.length === 0, usage: usage ?? null };
  } catch (e: any) {
    return { reachable: false, error: e?.message ?? String(e) };
  } finally {
    await backend.close().catch(() => {});
  }
}

/**
 * Add a repository: create it (`create: true`, the folder must be empty) or connect an existing one.
 * The password is stored in a file next to the config, never in the config itself.
 */
export async function createRepo(svc: Service, b: any) {
  const name = checkName("Repository", b.name);
  if (svc.cfg.repos[name]) throw new HttpError(409, `A repository named ${name} already exists`);
  if (typeof b.url !== "string" || !b.url.trim()) throw new HttpError(400, "url is required");
  if (typeof b.password !== "string" || b.password.length < 8) throw new HttpError(400, "The password must have at least 8 characters");
  const url = b.url.trim();
  const backend = openBackend(url);
  try {
    if (b.create) {
      if (await backend.exists("config")) throw new HttpError(409, "There is already a repository at this address: connect it instead");
      await Repository.init(backend, b.password);
    } else {
      try {
        await Repository.open(backend, b.password);
      } catch (e: any) {
        throw new HttpError(400, e.message);
      }
    }
  } finally {
    await backend.close().catch(() => {});
  }
  const file = `${name}.pass`;
  const passwordFile = await store(svc).writeSecret(file, b.password).catch((e: any) => {
    if (e?.code === "EEXIST") throw new HttpError(409, `${file} already exists next to the config; remove it or pick another name`);
    throw e;
  });
  await save(svc, (raw) => {
    raw.repos ??= {};
    raw.repos[name] = { url, passwordFile };
  });
  return { name, url, created: !!b.create };
}

export async function updateRepo(svc: Service, name: string, b: any) {
  if (!svc.cfg.repos[name]) throw new HttpError(404, `Unknown repository: ${name}`);
  await save(svc, (raw) => {
    const r = raw.repos[name];
    for (const k of ["prune", "check"] as const) if (typeof b[k] === "string") r[k] = b[k].trim();
    if (b.checkReadData !== undefined) r.checkReadData = Math.min(1, Math.max(0, Number(b.checkReadData)));
  });
  return { name, ...svc.cfg.repos[name] };
}

export async function removeRepo(svc: Service, name: string) {
  if (!svc.cfg.repos[name]) throw new HttpError(404, `Unknown repository: ${name}`);
  const users = Object.entries(svc.cfg.sources).filter(([, s]) => s.repo === name).map(([n]) => n);
  if (users.length) throw new HttpError(409, `Sources still use ${name}: ${users.join(", ")}`);
  await save(svc, (raw) => {
    delete raw.repos[name];
  });
  return { removed: name, note: "Only the server forgot it: the data in the storage is untouched." };
}

/** What a prune would do, without changing anything. */
export async function prunePreview(svc: Service, name: string) {
  const repo = await svc.repo(name);
  await repo.reloadIndex();
  const r = await withLock(repo, false, "prune preview", () => prune(repo, { dryRun: true }));
  return { ...r, snapshots: (await repo.listSnapshots()).length };
}

// ── tokens ──

export function listTokens(svc: Service) {
  return svc.cfg.tokens.map((t) => {
    const use = svc.db.getValue<{ last: string; via: string[] }>(`token-use:${t.sha256}`);
    return { name: t.name, scopes: t.scopes, created: t.created ?? null, expires: t.expires ?? null, lastUsed: use?.last ?? null, usedBy: use?.via ?? [] };
  });
}

export async function createToken(svc: Service, b: any) {
  const name = checkName("Token", b.name);
  if (svc.cfg.tokens.some((t) => t.name === name)) throw new HttpError(409, `A token named ${name} already exists`);
  const scopes = Array.isArray(b.scopes) ? [...new Set(b.scopes.map(String))] : [];
  if (!scopes.length || scopes.some((s) => !(SCOPES as readonly string[]).includes(s as string))) throw new HttpError(400, `scopes: some of ${SCOPES.join(", ")}`);
  if (scopes.includes("client") && scopes.length > 1) throw new HttpError(400, "The client scope cannot be combined with others");
  const days = Number(b.expiresDays ?? 0);
  const secret = `arca_${randomBytes(24).toString("base64url")}`;
  const entry: TokenConf = {
    name,
    sha256: hashToken(secret),
    scopes: scopes as TokenConf["scopes"],
    created: new Date().toISOString(),
    ...(days > 0 ? { expires: new Date(Date.now() + days * 86400_000).toISOString() } : {}),
  };
  await save(svc, (raw) => {
    raw.tokens ??= [];
    raw.tokens.push(entry);
  });
  return { token: secret, name, scopes: entry.scopes, expires: entry.expires ?? null };
}

export async function revokeToken(svc: Service, name: string) {
  const t = svc.cfg.tokens.find((x) => x.name === name);
  if (!t) throw new HttpError(404, `Unknown token: ${name}`);
  const admins = svc.cfg.tokens.filter((x) => x.scopes.includes("admin") && x.name !== name && (!x.expires || Date.parse(x.expires) > Date.now()));
  if (t.scopes.includes("admin") && admins.length === 0) throw new HttpError(409, "This is the last admin token: create another admin token first");
  await save(svc, (raw) => {
    raw.tokens = raw.tokens.filter((x: any) => x.name !== name);
  });
  svc.db.deleteSessionsOf(t.sha256);
  return { revoked: name };
}

/** Remember when and how a token was last used (at most once a minute per token). */
export function noteTokenUse(svc: Service, t: TokenConf, via: "web" | "API" | "MCP" | "client") {
  const k = `token-use:${t.sha256}`;
  const cur = svc.db.getValue<{ last: string; via: string[] }>(k);
  const now = Date.now();
  if (cur && now - Date.parse(cur.last) < 60_000 && cur.via.includes(via)) return;
  svc.db.setValue(k, { last: new Date(now).toISOString(), via: [...new Set([...(cur?.via ?? []), via])].sort() });
}

// ── SSH helper ──

function sourceKeyPath(svc: Service) {
  return join(store(svc).dir, "source_ed25519");
}

/** The key the server uses for SSH sources: created on first request. */
export async function sshKey(svc: Service) {
  const path = sourceKeyPath(svc);
  if (!existsSync(path)) {
    const p = Bun.spawn(["ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-C", "arca-src", "-f", path], { stdout: "ignore", stderr: "pipe" });
    if ((await p.exited) !== 0) throw new HttpError(500, `ssh-keygen failed: ${await new Response(p.stderr).text()}`);
  }
  const pub = (await readFile(`${path}.pub`, "utf8")).trim();
  const fp = Bun.spawnSync(["ssh-keygen", "-l", "-f", `${path}.pub`]).stdout.toString().trim().split(/\s+/)[1] ?? "";
  return { identity: path, publicKey: pub, fingerprint: fp, serverAddresses: lanAddresses() };
}

function lanAddresses(): string[] {
  return Object.values(networkInterfaces())
    .flat()
    .filter((i) => i && !i.internal && i.family === "IPv4")
    .map((i) => i!.address);
}

/** Try a source: list it and report how many entries came back (or the error). */
export async function previewSource(svc: Service, b: any, depth = 2) {
  if (typeof b.path !== "string" || !b.path.trim()) throw new HttpError(400, "path is required");
  const ssh = b.path.startsWith("ssh://") ? { forced: !!b.ssh?.forced, identity: b.ssh?.identity, sshOptions: b.ssh?.sshOptions ?? ["StrictHostKeyChecking=accept-new"] } : {};
  const src = openSource(b.path.trim(), ssh);
  const t0 = performance.now();
  try {
    const l = await src.list();
    // folder sizes up to `depth` levels, for the "What" step of the wizard
    const dirs = new Map<string, { size: number; files: number }>();
    let total = 0;
    for (const e of l.entries) {
      if (e.type === "dir" && e.path.split("/").length <= depth) dirs.set(e.path, dirs.get(e.path) ?? { size: 0, files: 0 });
      if (e.type !== "file") continue;
      total += e.size;
      const parts = e.path.split("/");
      for (let i = 1; i <= Math.min(depth, parts.length - 1); i++) {
        const d = parts.slice(0, i).join("/");
        const v = dirs.get(d) ?? { size: 0, files: 0 };
        v.size += e.size;
        v.files++;
        dirs.set(d, v);
      }
    }
    return {
      ok: true,
      seconds: Math.round((performance.now() - t0) / 100) / 10,
      files: l.entries.filter((e) => e.type === "file").length,
      size: total,
      dirs: [...dirs].map(([path, v]) => ({ path, ...v })).sort((a, c) => a.path.localeCompare(c.path)),
      errors: l.errors.slice(0, 20),
    };
  } catch (e: any) {
    return { ok: false, error: e?.message ?? String(e) };
  } finally {
    await src.close().catch(() => {});
  }
}

// ── schedule and retention previews ──

export function cronPreview(expr: string) {
  try {
    const c = new Cron(expr);
    const next: string[] = [];
    let d: Date | null = new Date();
    for (let i = 0; i < 5 && d; i++) {
      d = c.next(d);
      if (d) next.push(d.toISOString());
    }
    return { valid: true, next };
  } catch (e: any) {
    return { valid: false, error: e.message, next: [] };
  }
}

/** How many snapshots a policy keeps after a year of backups on the given schedule. */
export function retentionPreview(schedule: string, policy: RetentionPolicy) {
  if (!schedule || isEmptyPolicy(policy)) return { kept: null };
  let c: Cron;
  try {
    c = new Cron(schedule);
  } catch (e: any) {
    throw new HttpError(400, e.message);
  }
  const end = Date.now() + 365 * 86400_000;
  const times: string[] = [];
  let d: Date | null = new Date();
  while ((d = c.next(d)) && d.getTime() <= end && times.length < 20000) times.push(d.toISOString());
  const items = times.map((t) => ({ snapshot: { v: 1, time: t, host: "h", source: "s", root: "", tree: "", tags: [], owner: "" } }));
  const r = applyRetention(items, policy, new Date(end));
  const byRule: Record<string, number> = {};
  for (const k of r.keep) for (const reason of k.reasons) byRule[reason] = (byRule[reason] ?? 0) + 1;
  const kept = r.keep.map((k) => k.item.snapshot.time).sort();
  return { runs: times.length, kept: kept.length, byRule, oldest: kept[0] ?? null };
}

// ── recovery kit ──

export async function recoveryInfo(svc: Service) {
  const repos = [];
  for (const [name, r] of Object.entries(svc.cfg.repos)) {
    let id: string | null = null;
    try {
      id = (await svc.repo(name)).id;
    } catch {
      // unreachable now; the address is what matters for the kit
    }
    repos.push({ name, url: r.url, id: id?.slice(0, 8) ?? null });
  }
  const state = svc.db.getValue<{ saved: Record<string, boolean>; testedAt: string | null }>("recovery-state") ?? { saved: {}, testedAt: null };
  return { version: VERSION, repos, state, restoreBinary: await restoreBinary() };
}

export function setRecoveryState(svc: Service, b: any) {
  const cur = svc.db.getValue<{ saved: Record<string, boolean>; testedAt: string | null }>("recovery-state") ?? { saved: {}, testedAt: null };
  if (b.saved && typeof b.saved === "object") for (const [k, v] of Object.entries(b.saved)) cur.saved[k] = !!v;
  if (b.tested) cur.testedAt = new Date().toISOString();
  svc.db.setValue("recovery-state", cur);
  return cur;
}

let restoreBinCache: { path: string; size: number; sha256: string; mtime: number } | null = null;

/** arca-restore next to the running binary (release installs), with its checksum. */
export async function restoreBinary() {
  const path = resolve(dirname(process.execPath), "arca-restore");
  const st = await stat(path).catch(() => null);
  if (!st?.isFile() || process.execPath.endsWith("/bun")) return null;
  if (restoreBinCache?.path === path && restoreBinCache.mtime === st.mtimeMs) return restoreBinCache;
  const sha256 = createHash("sha256").update(await readFile(path)).digest("hex");
  restoreBinCache = { path, size: st.size, sha256, mtime: st.mtimeMs };
  return restoreBinCache;
}
