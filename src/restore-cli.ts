#!/usr/bin/env bun
/**
 * arca-restore: a standalone restore tool. Needs only the storage URL and the password, no server or config.
 * Built into a single binary (`scripts/build-restore.sh`).
 *
 * Read-only: it writes nothing to the storage (not even locks), so it also works with a copy of the
 * repository on read-only media. For the same reason, don't run it concurrently with prune.
 */
import { parseArgs } from "node:util";
import { openBackend } from "./backends";
import { FORMAT_VERSION, Repository } from "./core/repo";
import { restore } from "./core/restore";
import { walkTree } from "./core/tree";
import { check } from "./core/maintenance";
import { formatBytes, formatNode } from "./util";
import { password } from "./secret";
import { VERSION_STRING } from "./version";

const HELP = `arca-restore: restore from an Arca repository without the server (format v${FORMAT_VERSION}).

Usage: arca-restore <command> --repo <url> [options]

Commands:
  snapshots [--source S] [--host H]     list snapshots
  ls <snapshot> [path] [-r]             snapshot contents (snapshot: id, prefix or latest)
  restore <snapshot> --target <dir>     restore into a new or empty directory
          [--path path]                 only part of the snapshot
          [--source S] [--host H]       for latest: the latest snapshot of this source/host
  check [--read-data] [--subset 0.1]    check integrity (changes nothing)

Storage URL: a directory path, local:/path or sftp://user@host[:port]/path
(SFTP needs the system ssh/sftp and key-based access).
Password: ARCA_PASSWORD, --password-file / ARCA_PASSWORD_FILE or a terminal prompt.
The URL can also come from ARCA_REPO. --json: JSON output.
`;

async function main(argv: string[]) {
  const { values: o, positionals: pos } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      repo: { type: "string" },
      "password-file": { type: "string" },
      identity: { type: "string", short: "i" },
      json: { type: "boolean" },
      help: { type: "boolean", short: "h" },
      version: { type: "boolean" },
      target: { type: "string" },
      path: { type: "string" },
      source: { type: "string" },
      host: { type: "string" },
      recursive: { type: "boolean", short: "r" },
      "read-data": { type: "boolean" },
      subset: { type: "string" },
    },
  });
  if (o.version) {
    console.log(`arca-restore ${VERSION_STRING}, repository format v${FORMAT_VERSION}`);
    return;
  }
  const cmd = pos.shift();
  if (!cmd || o.help || cmd === "help") {
    process.stdout.write(HELP);
    return;
  }
  if (!["snapshots", "ls", "restore", "check"].includes(cmd)) throw new Error(`Unknown command: ${cmd}. See --help`);
  const url = o.repo ?? process.env.ARCA_REPO;
  if (!url) throw new Error("No repository given (--repo or ARCA_REPO)");
  const json = !!o.json;
  const out = (human: string, data: unknown) => console.log(json ? JSON.stringify(data, null, 2) : human);
  const filter = (s: { source: string; host: string }) => (!o.source || s.source === o.source) && (!o.host || s.host === o.host);

  const repo = await Repository.open(openBackend(url, o.identity ? { identity: o.identity } : {}), await password(o["password-file"]));
  try {
    switch (cmd) {
      case "snapshots": {
        const all = (await repo.listSnapshots()).filter((x) => filter(x.snapshot));
        out(
          all.length === 0
            ? "No snapshots"
            : all
                .map(
                  ({ id, snapshot: s }) =>
                    `${id.slice(0, 8)}  ${new Date(s.time).toLocaleString("en-GB")}  ${s.host}  ${s.source}  ${formatBytes(s.stats?.bytes ?? 0)}`,
                )
                .join("\n"),
          all,
        );
        break;
      }
      case "ls": {
        const { snapshot } = await repo.findSnapshot(pos[0] ?? "latest", filter);
        const items = [];
        for await (const n of walkTree(repo, snapshot.tree, pos[1] ?? "", !!o.recursive)) items.push(n);
        out(items.map(formatNode).join("\n"), items.map(({ content, ...rest }) => rest));
        break;
      }
      case "restore": {
        if (!o.target) throw new Error("Specify --target");
        const { id, snapshot } = await repo.findSnapshot(pos[0] ?? "latest", filter);
        let last = 0;
        const r = await restore(repo, snapshot.tree, o.target, {
          path: o.path,
          onProgress: json || !process.stderr.isTTY
            ? undefined
            : (p) => {
                if (Date.now() - last < 500) return;
                last = Date.now();
                process.stderr.write(`\r${p.files} files, ${formatBytes(p.bytes)}…`);
              },
        });
        if (last) process.stderr.write("\r\x1b[K");
        for (const e of r.errors) console.error(`error: ${e.path}: ${e.error}`);
        out(`Restored snapshot ${id.slice(0, 8)} (${snapshot.source}, ${snapshot.time}) to ${r.target}: ${r.files} files, ${r.dirs} directories, ${formatBytes(r.bytes)}`, r);
        if (r.errors.length) process.exitCode = 3;
        break;
      }
      case "check": {
        const c = await check(repo, { readData: o.subset ? Number(o.subset) : o["read-data"] ? 1 : 0 });
        for (const w of c.warnings) console.error(`warning: ${w}`);
        for (const e of c.errors) console.error(`ERROR: ${e}`);
        out(
          `${c.errors.length ? "Errors found: " + c.errors.length : "No errors"}: snapshots ${c.snapshots}, packs ${c.packs}, data read in ${c.packsRead}`,
          c,
        );
        if (c.errors.length) process.exitCode = 1;
        break;
      }
    }
  } finally {
    await repo.close();
  }
}

main(process.argv.slice(2)).catch((e) => {
  console.error(`arca-restore: ${e?.message ?? e}`);
  process.exit(2);
});
