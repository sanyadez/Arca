# Changelog

Versions follow [semver](https://semver.org/). While on 0.x, the storage format and the API may change;
a format change always bumps `FORMAT_VERSION` and is mentioned here.

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
