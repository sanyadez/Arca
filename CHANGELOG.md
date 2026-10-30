# Changelog

Versions follow [semver](https://semver.org/). While on 0.x, the storage format and the API may change;
a format change always bumps `FORMAT_VERSION` and is mentioned here.

## Unreleased

## 0.1.0-beta.2 — 2026-10-30

- Clients (`arca client`, docs/clients.md): a machine backs up its own folders to the server. Sources
  `client://<client>/<folder>`; the client long-polls for jobs (works behind NAT), chunks, deduplicates and
  encrypts locally, and writes through an append-only storage proxy on the server (new content-named files and
  locks only, checked by hash). Schedules, history, live progress, cancel and retention work as for other sources.
  `arca client add|list|remove` on the server, `arca client enroll|run` on the machine, `install.sh --client`,
  the `arca-client` systemd unit. Client tokens (scope `client`) work only for the client API.
- Web UI in the same binary: sign-in with a token (session cookie), overview, sources, snapshots with a file
  browser (new/changed against the parent), restore of selected files with verification, runs with live
  progress (server-sent events), repositories (create, check, prune with a preview), tokens with scopes and
  expiry, a five-step source wizard with SSH setup, recovery kit, settings; light/dark, desktop and phone,
  English and Ukrainian (picked from the browser, switchable on the sign-in page and in Settings).
- The config file can be changed through the API (admin): atomic write, full validation, applied live.
- File search across snapshots, forget by id, restore of several paths, prune dry-run, run log and
  queued status in the history, triggers carry the token name, snapshots are tagged scheduled/manual/mcp.

## 0.1.0-beta.1 — 2026-10-30

First beta. Repository format v1.

- One-line installer (`install.sh`): downloads and verifies the release, installs it into `/opt/arca`,
  writes a minimal config with an admin token on the first run, starts the systemd service; updates and uninstalls.
- Core: directory snapshots with exclusions, content-defined chunk deduplication (FastCDC), zstd,
  AES-256-GCM, a separate password-protected key per repository (scrypt), multiple passwords.
- Storage: local folder, SFTP (via the system OpenSSH).
- Sources: local folders and folders on other machines over SSH (`ssh://user@host/path`): the server pulls
  the state with a single `find` and the contents of changed files in a single `tar` stream. The forced command
  `arca-src` limits a key to reading selected folders (docs/ssh-sources.md).
- Maintenance: retention (`forget`), garbage collection (`prune`), integrity check (`check --read-data`), locks in storage.
- Server (`arca serve`): scheduled backups, prune and check, run history, HTTP API with tokens and scopes.
- MCP for agents: browsing sources and snapshots, starting a backup and a check, restoring on the server.
- `arca-restore`: a separate binary that restores without the server or a config, only reading the storage.
