# Clients

A client is a machine that backs up its own folders to an Arca server: a laptop, a VPS, a box behind NAT,
anything the server cannot reach over SSH. It runs the same `arca` binary as a small service, `arca-client`.

How it works:

- The client calls the server, never the other way round, so it needs no open port. It asks for jobs with a long poll.
- Schedules, the queue, the run history, retention, prune and check stay on the server, exactly as for other sources.
  In the web UI and over MCP a client source looks like any other: start it, watch it live, cancel it.
- For a backup the client reads its folder, splits files into chunks, deduplicates and encrypts them **on the machine**,
  and sends only new, already sealed chunks. A changed byte in a large file costs one chunk, not the whole file.
- The client reaches the repository only through the server, and the server lets it only append: it may add data, index
  and snapshot files (their names are the sha256 of their contents, and the server checks that) and manage locks.
  It cannot delete or overwrite anything, read or change the keys, or touch the storage between jobs. A stolen client
  token cannot destroy existing backups.
- The repository password comes with each job and stays in memory. On disk the client keeps only the server address
  and its token (`/etc/arca/client.json`, mode 600).

Whoever controls the client can read what the client backs up, as on any machine with a backup key. Give each client
its own repository, so that a compromised machine sees only its own snapshots. Deduplication then works within a
machine but not across machines.

## Setup

Below, `http://backup.lan:7350` is the Arca server and `laptop` is the name of the client.

**1. On the server**, create the client:

```sh
arca client add laptop --server http://backup.lan:7350
systemctl restart arca
```

It prints the client token (once) and the install command.

**2. On the machine**, run the printed command:

```sh
curl -fsSL https://raw.githubusercontent.com/sanyadez/Arca/main/install.sh | sudo sh -s -- \
  --client --server http://backup.lan:7350 --token arca_…
```

It installs Arca, checks the token against the server, saves `/etc/arca/client.json` and starts `arca-client`.
With Arca already installed, `arca client enroll --server … --token …` does the same without the service.

**3. On the server**, create a repository for the client and add its folders as sources with the path
`client://<client>/<folder>`:

```json
"repos": {
  "laptop": { "url": "sftp://arca@nas.lan/data/laptop", "passwordFile": "/etc/arca/laptop.pass" }
},
"sources": {
  "laptop-home": {
    "path": "client://laptop/home/me",
    "repo": "laptop",
    "schedule": "0 13 * * *",
    "exclude": [".cache/", "node_modules/"],
    "retention": { "daily": 14, "monthly": 6 }
  }
}
```

## When the client is offline

A run that starts while the client is offline fails at once with "Client laptop is offline (last seen …)", and the
Overview shows it. The next scheduled run tries again. A client that goes silent in the middle of a backup fails the
run after three minutes; the half-written data is not referenced by any snapshot and the next prune removes it.

## Commands

On the server (`--config`, default `/etc/arca/config.json`):

| Command | |
|---|---|
| `arca client add <name> [--server URL]` | create a client token and print the install command |
| `arca client list` | clients, when each was last seen, and their sources |
| `arca client remove <name>` | remove the client token (sources must not use it) |

On the machine (`--client-config`, default `/etc/arca/client.json`):

| Command | |
|---|---|
| `arca client enroll --server URL --token T` | check the token and save the config |
| `arca client run` | wait for jobs and run them (what the `arca-client` service does) |

Restoring happens on the server (web UI, MCP, `arca restore`) or anywhere with `arca-restore` and the repository password.
Restoring straight onto the client is planned.
