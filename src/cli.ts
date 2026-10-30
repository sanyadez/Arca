#!/usr/bin/env bun
/**
 * Arca CLI. Repository: `--repo` or ARCA_REPO; password: ARCA_PASSWORD,
 * `--password-file`/ARCA_PASSWORD_FILE or a terminal prompt.
 */
import { parseArgs } from "node:util";
import { readFile } from "node:fs/promises";
import { openBackend } from "./backends";
import { Repository } from "./core/repo";
import { backup } from "./core/backup";
import { restore } from "./core/restore";
import { walkTree } from "./core/tree";
import { check, forget, prune } from "./core/maintenance";
import { withLock } from "./core/lock";
import type { RetentionPolicy } from "./core/retention";
import { formatBytes, formatNode } from "./util";
import { openSource } from "./sources";
import { password, readSecret } from "./secret";
import { VERSION_STRING } from "./version";

const HELP = `Arca: encrypted, deduplicated backups.

Usage: arca <command> [options]

Commands:
  init                              create a repository
  backup <dir> [--exclude P]...     snapshot a directory (--tag, --source, --exclude-file);
                                    dir may be ssh://user@host[:port]/path (--ssh-forced, -i key)
  snapshots                         list snapshots
  ls <snapshot> [path] [-r]         snapshot contents (snapshot: id, prefix or latest)
  restore <snapshot> --target <dir> restore into a new directory (--path: only a part)
  forget --keep-last N ...          retention (--keep-hourly/daily/weekly/monthly/yearly,
                                    --keep-within-days, --dry-run, --prune)
  prune [--dry-run]                 remove data not referenced by any snapshot
  check [--read-data]               check integrity; --read-data also downloads
                                    and decrypts the data (--subset 0.1: only a share of packs)
  key-add                           add another password (the new one from ARCA_NEW_PASSWORD or a prompt)
  token [name]                      generate an API/MCP token and the line for the server config
  serve [config]                    run the server (see config.example.json)

Clients (machines that back up their own folders to this server, docs/clients.md):
  client add <name> [--server URL]  on the server: create a client token and print the install command
  client list | client remove <name>  on the server (--config, default /etc/arca/config.json)
  client enroll --server URL --token T  on the machine: check the token and save it (--client-config)
  client run                        on the machine: wait for jobs from the server and run them

Common options:
  --repo <url>                      path, local:/path or sftp://user@host[:port]/path
  --password-file <file>
  --json                            JSON output
  --version                         version
`;

const num = (v: unknown) => (v === undefined ? undefined : Number(v));

type Out = (human: string, data: unknown) => void;

async function clientCommand(pos: string[], o: Record<string, unknown>, out: Out) {
  const sub = pos.shift();
  const agent = await import("./client/agent");
  const clientConfig = String(o["client-config"] ?? agent.DEFAULT_CLIENT_CONFIG);
  if (sub === "enroll") {
    if (!o.server || !o.token) throw new Error("client enroll needs --server and --token");
    const cfg = { server: String(o.server).replace(/\/+$/, ""), token: String(o.token) };
    const h = await new agent.ClientAgent(cfg).hello();
    await agent.saveClientConfig(clientConfig, cfg);
    out(`Connected to ${h.server.host} (Arca ${h.server.version}) as client ${h.client}. Saved ${clientConfig}.\n` +
      (h.sources.length ? `Sources: ${h.sources.map((s) => `${s.name} = ${s.path}`).join(", ")}` : "No sources for this client yet: add them on the server as client://" + h.client + "/<path>."), h);
    return;
  }
  if (sub === "run") {
    const a = new agent.ClientAgent(await agent.loadClientConfig(clientConfig));
    for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => void a.stop());
    await a.run();
    return;
  }

  // Server side: clients are tokens with the client scope in the server config.
  const { ConfigStore } = await import("./server/configstore");
  const { RunsDb } = await import("./server/db");
  const { isClientSource, parseClientUrl } = await import("./sources");
  const { join } = await import("node:path");
  const store = new ConfigStore(String(o.config ?? "/etc/arca/config.json"));
  const raw = await store.readRaw();
  const sourcesOf = (name: string) =>
    Object.entries<any>(raw.sources ?? {}).filter(([, s]) => isClientSource(s.path) && parseClientUrl(s.path).client === name).map(([n]) => n);
  if (sub === "add") {
    const name = pos[0];
    if (!name) throw new Error("client add needs a name");
    const { randomBytes } = await import("node:crypto");
    const { hashToken } = await import("./server/http");
    const token = `arca_${randomBytes(24).toString("base64url")}`;
    await store.update((r) => {
      r.tokens ??= [];
      if (r.tokens.some((t: any) => t.name === name)) throw new Error(`A token named ${name} already exists`);
      r.tokens.push({ name, sha256: hashToken(token), scopes: ["client"], created: new Date().toISOString() });
    });
    const { hostname } = await import("node:os");
    const listen = raw.listen ?? {};
    const server = String(o.server ?? `http://${!listen.host || listen.host === "0.0.0.0" || listen.host === "::" ? hostname() : listen.host}:${listen.port ?? 7350}`);
    out(
      `Client ${name} added. Its token (shown only once): ${token}\n\n` +
        `On the machine, install Arca as a client:\n` +
        `  curl -fsSL https://raw.githubusercontent.com/sanyadez/Arca/main/install.sh | sudo sh -s -- --client --server ${server} --token ${token}\n` +
        `or, with Arca already installed there:  arca client enroll --server ${server} --token ${token}\n\n` +
        `Then add its folders as sources with the path client://${name}/<folder>.\n` +
        `Restart the server to load the new token: systemctl restart arca`,
      { name, token, server },
    );
    return;
  }
  if (sub === "list") {
    const db = new RunsDb(join(raw.dataDir ?? "/var/lib/arca", "runs.sqlite"));
    const rows = (raw.tokens ?? [])
      .filter((t: any) => t.scopes?.includes("client"))
      .map((t: any) => ({ name: t.name, lastSeen: db.getValue<{ at: number; host?: string; version?: string }>(`client:${t.name}`), sources: sourcesOf(t.name) }));
    db.close();
    out(
      rows.length
        ? rows.map((r: any) => `${r.name}\t${r.lastSeen ? `seen ${new Date(r.lastSeen.at).toISOString()} (${r.lastSeen.host ?? "?"}, ${r.lastSeen.version ?? "?"})` : "never connected"}\t${r.sources.join(", ") || "no sources"}`).join("\n")
        : "No clients. Add one with: arca client add <name>",
      rows,
    );
    return;
  }
  if (sub === "remove") {
    const name = pos[0];
    if (!name) throw new Error("client remove needs a name");
    const used = sourcesOf(name);
    if (used.length) throw new Error(`Sources use this client: ${used.join(", ")}. Remove or change them first.`);
    await store.update((r) => {
      const before = (r.tokens ?? []).length;
      r.tokens = (r.tokens ?? []).filter((t: any) => !(t.name === name && t.scopes?.includes("client")));
      if (r.tokens.length === before) throw new Error(`No client named ${name}`);
    });
    out(`Client ${name} removed; its token no longer works after a restart of the server (systemctl restart arca).`, { removed: name });
    return;
  }
  throw new Error("Usage: arca client add|list|remove|enroll|run (see arca --help)");
}

async function main(argv: string[]) {
  const { values: o, positionals: pos } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      repo: { type: "string" },
      "password-file": { type: "string" },
      json: { type: "boolean" },
      help: { type: "boolean", short: "h" },
      version: { type: "boolean", short: "V" },
      exclude: { type: "string", multiple: true },
      "exclude-file": { type: "string" },
      "ssh-forced": { type: "boolean" },
      identity: { type: "string", short: "i" },
      tag: { type: "string", multiple: true },
      source: { type: "string" },
      target: { type: "string" },
      path: { type: "string" },
      recursive: { type: "boolean", short: "r" },
      "dry-run": { type: "boolean" },
      prune: { type: "boolean" },
      "read-data": { type: "boolean" },
      subset: { type: "string" },
      "keep-last": { type: "string" },
      "keep-hourly": { type: "string" },
      "keep-daily": { type: "string" },
      "keep-weekly": { type: "string" },
      "keep-monthly": { type: "string" },
      "keep-yearly": { type: "string" },
      "keep-within-days": { type: "string" },
      config: { type: "string" },
      "client-config": { type: "string" },
      server: { type: "string" },
      token: { type: "string" },
    },
  });
  if (o.version) {
    console.log(`arca ${VERSION_STRING}`);
    return;
  }
  const cmd = pos.shift();
  if (!cmd || o.help || cmd === "help") {
    process.stdout.write(HELP);
    return;
  }
  const json = !!o.json;
  const out = (human: string, data: unknown) => console.log(json ? JSON.stringify(data, null, 2) : human);

  if (cmd === "token") {
    const { randomBytes } = await import("node:crypto");
    const { hashToken } = await import("./server/http");
    const token = `arca_${randomBytes(24).toString("base64url")}`;
    const entry = { name: pos[0] ?? "admin", sha256: hashToken(token), scopes: ["admin"] };
    out(`Token (shown only once): ${token}\nAdd to the config, under "tokens":\n${JSON.stringify(entry)}`, { token, entry });
    return;
  }
  if (cmd === "client") {
    await clientCommand(pos, o, out);
    return;
  }
  if (cmd === "serve") {
    if (pos[0]) process.argv[2] = pos[0];
    else process.argv.length = 2;
    await import("./server/main");
    return;
  }

  const url = o.repo ?? process.env.ARCA_REPO;
  if (!url) throw new Error("No repository given (--repo or ARCA_REPO)");
  const backend = openBackend(url);

  if (cmd === "init") {
    const pw = await password(o["password-file"]);
    if (!process.env.ARCA_PASSWORD && !o["password-file"] && process.stdin.isTTY) {
      if ((await readSecret("Again: ")) !== pw) throw new Error("Passwords do not match");
    }
    const repo = await Repository.init(backend, pw);
    out(`Created repository ${repo.id.slice(0, 12)} at ${backend.label}\nKeep the password safe: without it the data cannot be restored.`, { id: repo.id });
    await repo.close();
    return;
  }

  const repo = await Repository.open(backend, await password(o["password-file"]));
  try {
    switch (cmd) {
      case "backup": {
        const root = pos[0];
        if (!root) throw new Error("Specify a directory");
        const exclude = [...(o.exclude ?? [])];
        if (o["exclude-file"]) exclude.push(...(await readFile(o["exclude-file"], "utf8")).split("\n"));
        const from = openSource(root, { forced: o["ssh-forced"], identity: o.identity });
        const r = await withLock(repo, false, "backup", () =>
          backup(repo, { from, exclude, tags: o.tag, source: o.source }),
        ).finally(() => from.close());
        const s = r.snapshot.stats!;
        for (const e of r.errors) console.error(`error: ${e.path}: ${e.error}`);
        out(
          `Snapshot ${r.id.slice(0, 8)}: ${s.files} files, ${s.dirs} directories, ${formatBytes(s.bytes)}; ${formatBytes(s.newBytes)} new; ${s.seconds} s` +
            (r.errors.length ? `; errors: ${r.errors.length}` : ""),
          { id: r.id, snapshot: r.snapshot, errors: r.errors },
        );
        if (r.errors.length) process.exitCode = 3;
        break;
      }
      case "snapshots": {
        const all = await repo.listSnapshots();
        out(
          all.length === 0
            ? "No snapshots"
            : all
                .map(
                  ({ id, snapshot: s }) =>
                    `${id.slice(0, 8)}  ${new Date(s.time).toLocaleString("en-GB")}  ${s.host}  ${s.source}  ${formatBytes(s.stats?.bytes ?? 0)}${s.tags.length ? "  [" + s.tags.join(",") + "]" : ""}`,
                )
                .join("\n"),
          all,
        );
        break;
      }
      case "ls": {
        const { snapshot } = await repo.findSnapshot(pos[0] ?? "latest");
        const items = [];
        for await (const n of walkTree(repo, snapshot.tree, pos[1] ?? "", !!o.recursive)) items.push(n);
        out(
          items
            .map(formatNode)
            .join("\n"),
          items.map(({ content, ...rest }) => rest),
        );
        break;
      }
      case "restore": {
        if (!o.target) throw new Error("Specify --target");
        const { id, snapshot } = await repo.findSnapshot(pos[0] ?? "latest");
        const r = await withLock(repo, false, "restore", () => restore(repo, snapshot.tree, o.target!, { path: o.path }));
        for (const e of r.errors) console.error(`error: ${e.path}: ${e.error}`);
        out(`Restored snapshot ${id.slice(0, 8)} to ${r.target}: ${r.files} files, ${formatBytes(r.bytes)}`, r);
        if (r.errors.length) process.exitCode = 3;
        break;
      }
      case "forget": {
        const policy: RetentionPolicy = {
          last: num(o["keep-last"]),
          hourly: num(o["keep-hourly"]),
          daily: num(o["keep-daily"]),
          weekly: num(o["keep-weekly"]),
          monthly: num(o["keep-monthly"]),
          yearly: num(o["keep-yearly"]),
          withinDays: num(o["keep-within-days"]),
        };
        const f = await withLock(repo, false, "forget", () => forget(repo, policy, { dryRun: o["dry-run"] }));
        out(
          `Snapshots ${o["dry-run"] ? "that would be removed" : "removed"}: ${f.removed.length}, kept: ${f.kept.length}` +
            (f.removed.length ? "\n  " + f.removed.map((x) => x.slice(0, 8)).join(" ") : ""),
          f,
        );
        if (o.prune && !o["dry-run"]) {
          const p = await withLock(repo, true, "prune", () => prune(repo));
          out(`Freed ${formatBytes(p.bytesFreed)} (packs deleted ${p.packsDeleted}, repacked ${p.packsRepacked})`, p);
        }
        break;
      }
      case "prune": {
        const p = await withLock(repo, true, "prune", () => prune(repo, { dryRun: o["dry-run"] }));
        out(
          `${p.dryRun ? "Would free" : "Freed"} ${formatBytes(p.bytesFreed)} (packs to delete ${p.packsDeleted}, to repack ${p.packsRepacked})`,
          p,
        );
        break;
      }
      case "check": {
        const share = o.subset ? Number(o.subset) : o["read-data"] ? 1 : 0;
        const c = await withLock(repo, false, "check", () => check(repo, { readData: share }));
        for (const w of c.warnings) console.error(`warning: ${w}`);
        for (const e of c.errors) console.error(`ERROR: ${e}`);
        out(
          `${c.errors.length ? "Errors found: " + c.errors.length : "No errors"}: snapshots ${c.snapshots}, packs ${c.packs}, blobs ${c.blobs}, data read in ${c.packsRead} packs`,
          c,
        );
        if (c.errors.length) process.exitCode = 1;
        break;
      }
      case "key-add": {
        const pw = process.env.ARCA_NEW_PASSWORD ?? (await readSecret("New password: "));
        if (!pw) throw new Error("Empty password");
        const id = await repo.addKey(pw);
        out(`Added key ${id.slice(0, 8)}`, { id });
        break;
      }
      default:
        throw new Error(`Unknown command: ${cmd}. See arca --help`);
    }
  } finally {
    await repo.close();
  }
}

main(process.argv.slice(2)).catch((e) => {
  console.error(`arca: ${e?.message ?? e}`);
  process.exit(process.exitCode && process.exitCode !== 0 ? process.exitCode : 2);
});
