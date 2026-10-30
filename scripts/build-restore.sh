#!/bin/sh
# Build the standalone restore utility: scripts/build-restore.sh [target...]
# Targets of bun build --compile: linux-x64 (default), linux-arm64, darwin-arm64, darwin-x64, windows-x64.
# Output: dist/arca-restore-<target>[.exe]. No other files are needed to run it (SFTP uses the system ssh/sftp).
set -e
cd "$(dirname "$0")/.."
TARGETS=${*:-linux-x64}
mkdir -p dist
for t in $TARGETS; do
  ext=""; case "$t" in windows*) ext=".exe";; esac
  bun build src/restore-cli.ts --compile --minify --target="bun-$t" --outfile "dist/arca-restore-$t$ext"
done
ls -la dist/
