#!/bin/sh
# Build a release of the current version (package.json): scripts/release.sh [target...]
# Targets of bun build --compile; linux-x64 linux-arm64 by default.
# Output in dist/release/v<version>/:
#   arca-<version>-<target>.tar.gz   — arca (CLI + serve), arca-restore, documentation, example config,
#                                      systemd unit, arca-src.sh (for SSH sources)
#   arca-restore-<version>-<target>  — the restore utility as a separate file
#   SHA256SUMS
# Requires a clean working tree (what is committed gets built); ALLOW_DIRTY=1 builds despite changes (marked -dirty).
set -e
cd "$(dirname "$0")/.."
VERSION=$(bun -e 'console.log((await Bun.file("package.json").json()).version)')
COMMIT=$(git rev-parse --short HEAD)
if [ -n "$(git status --porcelain)" ]; then
  [ "$ALLOW_DIRTY" = 1 ] || { echo "There are uncommitted changes (set ALLOW_DIRTY=1 to build anyway)" >&2; exit 1; }
  COMMIT="$COMMIT-dirty"
fi
TARGETS=${*:-linux-x64 linux-arm64}
OUT=dist/release/v$VERSION
rm -rf "$OUT" && mkdir -p "$OUT"
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

for t in $TARGETS; do
  ext=""; case "$t" in windows*) ext=".exe";; esac
  stage="$TMP/arca-$VERSION-$t"
  mkdir -p "$stage"
  for entry in cli:arca restore-cli:arca-restore; do
    src=${entry%%:*}; name=${entry##*:}
    bun build "src/$src.ts" --compile --minify --target="bun-$t" \
      --define "BUILD_COMMIT=\"$COMMIT\"" --outfile "$stage/$name$ext" >/dev/null
  done
  cp README.md README.uk.md FORMAT.md CHANGELOG.md config.example.json scripts/arca.service scripts/arca-client.service scripts/arca-src.sh docs/ssh-sources.md docs/clients.md "$stage/"
  tar -C "$TMP" -czf "$OUT/arca-$VERSION-$t.tar.gz" "arca-$VERSION-$t"
  cp "$stage/arca-restore$ext" "$OUT/arca-restore-$VERSION-$t$ext"
  echo "built $t"
done
(cd "$OUT" && sha256sum -- * > SHA256SUMS)
echo "Release v$VERSION ($COMMIT) in $OUT:"
ls -la "$OUT"
