# Arca

**English** · [Українська](README.uk.md)

Encrypted, deduplicated backups for a home lab, run as one self-hosted service.
("Arca" is Latin for a chest for valuables, and for an ark: *arca Noë*, Noah's ark.)

One binary, built on Bun with no dependencies. Arca takes snapshots of folders on its own machine and on
other machines over SSH, encrypts them before they leave, and keeps them in storage that only ever sees
ciphertext. AI agents can use it through its own MCP server: start a backup, look through the copies, restore.

**Status:** early development (0.x). The storage format and the API may still change.

## Questions and answers

**What does it do?**
You list the folders to keep — configs, app data, documents — and when to back them up. Arca cuts every file
into chunks by content, stores each unique chunk once, encrypts it and writes it to the repository: a local
disk or an SFTP server. The next snapshot only uploads what changed. Old snapshots are thinned out by a
retention policy (keep 7 daily, 4 weekly, 12 monthly…), unused data is pruned, and the repository is
checked regularly by downloading and decrypting part of it.

**What is it an alternative to?**
To restic, BorgBackup and Kopia, with whom it shares the idea: content-defined chunks, deduplication,
client-side encryption. Arca is not a better restic. It is one service for a whole home lab: a schedule,
run history, sources on other machines and an HTTP API come built in rather than as scripts around a CLI,
and the MCP server lets AI agents (Claude Code and others) work with backups directly. The repository format is its own, not restic's.

**Who holds the keys?**
You do. Every repository has its own random master key, stored only wrapped with your password (scrypt).
Data, file names and directory structure are encrypted with AES-256-GCM before they reach the storage.
Chunk ids are keyed hashes, so the storage cannot even check whether it holds a file it already knows.
**A lost password cannot be recovered**, and neither can the data behind it.

**Do the other machines need anything installed?**
No agent. The server connects over SSH and asks two things: the state of all files (one `find`) and the
contents of the changed ones (one `tar` stream). A machine needs OpenSSH, GNU find and GNU tar — any ordinary
Debian or Ubuntu. The key can be tied to a forced command that only allows reading the chosen folders:
[docs/ssh-sources.md](docs/ssh-sources.md). A small client for machines the server cannot reach is planned.

**What if the server itself is gone?**
`arca-restore` is a separate binary in every release. Give it the repository address and the password, and
it lists snapshots and restores them, with no server, config or database. It only reads the storage, so a
read-only copy of the repository on a disk works too. Keep a copy of it and of the password away from the
server. The format is documented in [FORMAT.md](FORMAT.md), so the data can be read even without Arca.

**Is there a web UI?**
Yes, served by the same binary at the server's address (port 7350 by default). Sign in with a token; the
browser then keeps a session cookie. It shows what needs attention, live progress of running backups, the
snapshots with a file browser and restore, and it is where you add repositories and sources (including
the SSH setup of another machine), manage tokens and keep the recovery kit. It works on a phone too.

**What do agents get?**
An MCP server (Streamable HTTP) with tools to list sources and snapshots, browse a snapshot, run a backup or
a check, and restore into a new folder on the server. Access goes by tokens with scopes — read, backup,
restore, admin — so an agent can be allowed to back up and look, but not to prune or restore.

**Why the name?**
A chest keeps valuables closed, an ark carries what matters through the flood: the data lies encrypted, and it
can be restored even when nothing is left of the server. The word reads and sounds the same in many languages
(Spanish, Italian, Portuguese have it too) and is short on the command line: `arca backup`, `arca-restore`.

## Status

Works now:

- Snapshots of folders with excludes; a repeated snapshot reads only changed files (size, mtime, inode).
- Deduplication by content-defined chunks (FastCDC), across files and snapshots; zstd compression.
- AES-256-GCM, a separate key per repository behind a password (scrypt); several passwords per repository.
- Storage: a local folder, SFTP (through the system OpenSSH).
- Sources: local folders and folders on other machines over SSH, with an optional forced command.
- Restore of a whole snapshot or a part of it into a new folder; existing files are never overwritten.
- Retention (`forget`), garbage collection (`prune`), integrity checks (`check --read-data`), repository locks.
- The server: schedules, retention after each backup, scheduled prune and check, run history, HTTP API with tokens.
- Web UI: overview, sources, snapshots with a file browser and restore, runs with live progress,
  repositories, tokens, a source wizard with SSH setup, recovery kit; light and dark, desktop and phone, English and Ukrainian.
- MCP for agents.
- `arca-restore`: restore without the server.

Planned: S3 and other cloud storage, several storages per source, database dumps, notifications, several users,
a client for remote machines.

## Install

On a Linux machine (x86_64 or arm64, glibc), as root:

```sh
curl -fsSL https://raw.githubusercontent.com/sanyadez/Arca/main/install.sh | sudo sh
```

The installer downloads the newest release, checks it against `SHA256SUMS`, puts it into `/opt/arca` and links
`arca` and `arca-restore` into `/usr/local/bin`. On the first install it writes a minimal
`/etc/arca/config.json` with a new admin token (printed once) and starts the `arca` systemd service on port 7350.
Running it again updates Arca and keeps the config and the data. Options go after `sh -s --`:
`--version <tag>`, `--port <number>`, `--no-service`, `--uninstall`.

Then create a repository and describe it, with the folders to back up, in the config
(see [config.example.json](config.example.json)), and restart the service:

```sh
echo 'a long password' > /etc/arca/main.pass && chmod 600 /etc/arca/main.pass
arca init --repo /mnt/backup/arca --password-file /etc/arca/main.pass
systemctl restart arca
```

Manual install: a release has `arca-<version>-<target>.tar.gz` — the `arca` and `arca-restore` binaries, an
example config, a systemd unit and the SSH forced-command script — plus `arca-restore-<version>-<target>` on its
own and `SHA256SUMS`. Targets: `linux-x64`, `linux-arm64`. Bun is not needed.

## Commands

```sh
export ARCA_REPO=sftp://arca@192.0.2.30/data/repo
export ARCA_PASSWORD_FILE=~/.config/arca/repo.pass

arca init
arca backup /srv/data --exclude node_modules/ --exclude '*.log'
arca backup ssh://arca-src@192.0.2.20/etc/nginx --ssh-forced -i /etc/arca/source_ed25519
arca snapshots
arca ls latest -r
arca restore latest --target /tmp/restored --path docs
arca forget --keep-daily 7 --keep-weekly 4 --keep-monthly 12 --prune
arca check --read-data --subset 0.1
```

Without the server:

```sh
arca-restore snapshots --repo sftp://arca@192.0.2.30/data/repo
arca-restore restore latest --source web-data --target /tmp/restored
```

`arca --help` and `arca-restore --help` list everything.

## Development

```sh
bun install          # only type definitions
bun test             # unit tests on temporary folders with synthetic data
bun run typecheck
scripts/release.sh   # build a release into dist/release/v<version>/
```

The change log is in [CHANGELOG.md](CHANGELOG.md).

## License

[MIT](LICENSE).
