#!/bin/sh
# Arca installer.
#
#   curl -fsSL https://raw.githubusercontent.com/sanyadez/Arca/main/install.sh | sudo sh
#
# What it does: downloads the release for this machine from GitHub, checks it against the release's
# SHA256SUMS, unpacks it into /opt/arca/releases/<version>, points /opt/arca/current at it and links
# `arca` and `arca-restore` into /usr/local/bin. On the first install it writes a minimal config to
# /etc/arca/config.json with a new admin token (printed once at the end) and starts the `arca` systemd
# service. Running it again updates Arca to the newest release and keeps the config and the data.
#
# With --client it sets the machine up as a client of an Arca server instead (docs/clients.md): it saves
# the server address and the client token to /etc/arca/client.json and starts the `arca-client` service.
# Get the full command on the server with  arca client add <name>.
#
# Options (after `sh -s --`):
#   --version <tag>   install this release instead of the newest (also: ARCA_VERSION), e.g. v0.1.0-beta.1
#   --port <number>   port for the API and MCP on the first install (default: 7350)
#   --client          set up a client: needs --server <url> and --token <client token>
#   --no-service      install the binaries only; do not touch systemd
#   --uninstall       remove the binaries and the services; /etc/arca and /var/lib/arca are kept
#
# ARCA_DOWNLOAD_URL overrides where the files are taken from (a directory URL holding the release
# archive and SHA256SUMS) — for mirrors and for testing.

set -eu

REPO="sanyadez/Arca"
VERSION="${ARCA_VERSION:-latest}"
PORT=7350
SERVICE=1
UNINSTALL=0
CLIENT=0
SERVER_URL=""
CLIENT_TOKEN=""
PREFIX=/opt/arca
CONF_DIR=/etc/arca
DATA_DIR=/var/lib/arca
KEEP_RELEASES=3

say() { printf '%s\n' "$*"; }
step() { printf '\n==> %s\n' "$*"; }
die() {
  printf 'Error: %s\n' "$*" >&2
  exit 1
}

while [ $# -gt 0 ]; do
  case "$1" in
    --version)
      [ $# -ge 2 ] || die "--version needs a release tag"
      VERSION="$2"
      shift
      ;;
    --port)
      [ $# -ge 2 ] || die "--port needs a number"
      PORT="$2"
      shift
      ;;
    --client) CLIENT=1 ;;
    --server)
      [ $# -ge 2 ] || die "--server needs the server address, e.g. http://backup.lan:7350"
      SERVER_URL="$2"
      shift
      ;;
    --token)
      [ $# -ge 2 ] || die "--token needs the client token"
      CLIENT_TOKEN="$2"
      shift
      ;;
    --no-service) SERVICE=0 ;;
    --uninstall) UNINSTALL=1 ;;
    -h | --help)
      sed -n '2,27p' "$0" 2>/dev/null | sed 's/^# \{0,1\}//' || true
      exit 0
      ;;
    *) die "unknown option: $1" ;;
  esac
  shift
done

if [ "$CLIENT" -eq 1 ] && [ "$UNINSTALL" -eq 0 ]; then
  [ -n "$SERVER_URL" ] && [ -n "$CLIENT_TOKEN" ] || die "--client needs --server <url> and --token <token> (see: arca client add on the server)."
fi
[ "$(uname -s)" = "Linux" ] || die "Arca runs on Linux; this is $(uname -s)."
[ "$(id -u)" -eq 0 ] || die "this needs root: put sudo before sh."
HAVE_SYSTEMD=0
command -v systemctl >/dev/null 2>&1 && [ -d /run/systemd/system ] && HAVE_SYSTEMD=1

# --- Uninstall ------------------------------------------------------------------------------------

if [ "$UNINSTALL" -eq 1 ]; then
  step "Removing Arca"
  if [ "$HAVE_SYSTEMD" -eq 1 ]; then
    for unit in arca arca-client; do
      [ -f "/etc/systemd/system/$unit.service" ] || continue
      systemctl disable --now "$unit" >/dev/null 2>&1 || true
      rm -f "/etc/systemd/system/$unit.service"
    done
    systemctl daemon-reload
  fi
  rm -f /usr/local/bin/arca /usr/local/bin/arca-restore
  rm -rf "$PREFIX"
  say "Removed the binaries and the service. Kept the config ($CONF_DIR) and the data ($DATA_DIR);"
  say "delete them yourself if they are no longer needed. Backups in the repositories are not touched."
  exit 0
fi

# --- What machine is this -------------------------------------------------------------------------

case "$(uname -m)" in
  x86_64 | amd64) ARCH="x64" ;;
  aarch64 | arm64) ARCH="arm64" ;;
  *) die "unsupported processor: $(uname -m). Arca is built for x86_64 and arm64." ;;
esac

# the binaries are linked against glibc
if ldd --version 2>&1 | grep -qi musl; then
  die "this system uses musl (Alpine); there is no Arca build for it yet."
fi

if command -v curl >/dev/null 2>&1; then
  fetch() { curl -fsSL --retry 3 -o "$2" "$1"; }
elif command -v wget >/dev/null 2>&1; then
  fetch() { wget -q -O "$2" "$1"; }
else
  die "curl or wget is needed to download Arca."
fi
for tool in sha256sum tar; do
  command -v "$tool" >/dev/null 2>&1 || die "$tool is needed."
done

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT INT TERM

# --- Which release --------------------------------------------------------------------------------

if [ -n "${ARCA_DOWNLOAD_URL:-}" ]; then
  BASE="${ARCA_DOWNLOAD_URL%/}"
else
  if [ "$VERSION" = "latest" ]; then
    # The newest release, pre-releases included (GitHub's "latest" skips those).
    fetch "https://api.github.com/repos/$REPO/releases?per_page=1" "$TMP/releases.json" ||
      die "could not ask GitHub for the newest release."
    VERSION="$(sed -n 's/.*"tag_name": *"\([^"]*\)".*/\1/p' "$TMP/releases.json" | head -n 1)"
    [ -n "$VERSION" ] || die "GitHub returned no releases for $REPO."
  fi
  BASE="https://github.com/$REPO/releases/download/$VERSION"
fi

# --- Download and verify --------------------------------------------------------------------------

if [ "$VERSION" = "latest" ]; then step "Downloading Arca"; else step "Downloading Arca $VERSION"; fi
fetch "$BASE/SHA256SUMS" "$TMP/SHA256SUMS" || die "could not download $BASE/SHA256SUMS"
FILE="$(awk '{ sub(/^\*/, "", $2); print $2 }' "$TMP/SHA256SUMS" | grep -E "^arca-.+-linux-$ARCH\.tar\.gz$" | head -n 1)"
[ -n "$FILE" ] || die "the release has no archive for linux-$ARCH."
fetch "$BASE/$FILE" "$TMP/$FILE" || die "could not download $BASE/$FILE"

EXPECTED="$(awk -v f="$FILE" '$2 == f || $2 == "*" f { print $1 }' "$TMP/SHA256SUMS")"
ACTUAL="$(sha256sum "$TMP/$FILE" | awk '{ print $1 }')"
[ "$EXPECTED" = "$ACTUAL" ] || die "the download is damaged or was tampered with: checksum of $FILE does not match."

tar -xzf "$TMP/$FILE" -C "$TMP"
DIR="$TMP/${FILE%.tar.gz}"
[ -x "$DIR/arca" ] || die "the archive does not contain the arca binary."
NEW_VERSION="${FILE#arca-}"
NEW_VERSION="${NEW_VERSION%-linux-$ARCH.tar.gz}"
say "Arca $("$DIR/arca" --version | sed 's/^arca //'), checksum OK."

# --- Install the files ----------------------------------------------------------------------------

step "Installing into $PREFIX"
mkdir -p "$PREFIX/releases"
rm -rf "$PREFIX/releases/$NEW_VERSION"
mv "$DIR" "$PREFIX/releases/$NEW_VERSION"
ln -sfn "releases/$NEW_VERSION" "$PREFIX/current.new" && mv -T "$PREFIX/current.new" "$PREFIX/current"
ln -sfn "$PREFIX/current/arca" /usr/local/bin/arca
ln -sfn "$PREFIX/current/arca-restore" /usr/local/bin/arca-restore

# keep the newest few releases for a quick rollback
ls -1t "$PREFIX/releases" | tail -n +$((KEEP_RELEASES + 1)) | while read -r old; do
  [ "$old" = "$NEW_VERSION" ] || rm -rf "${PREFIX:?}/releases/$old"
done

# --- Client: save the server address and the token, start arca-client -----------------------------

if [ "$CLIENT" -eq 1 ]; then
  step "Connecting to $SERVER_URL"
  mkdir -p "$CONF_DIR"
  chmod 700 "$CONF_DIR"
  /usr/local/bin/arca client enroll --server "$SERVER_URL" --token "$CLIENT_TOKEN" --client-config "$CONF_DIR/client.json" ||
    die "could not connect with this token; check the address and the token."
  if [ "$SERVICE" -eq 1 ] && [ "$HAVE_SYSTEMD" -eq 1 ]; then
    step "Starting the arca-client service"
    [ -f "$PREFIX/current/arca-client.service" ] || die "this release has no arca-client.service; install a newer one."
    cp "$PREFIX/current/arca-client.service" /etc/systemd/system/arca-client.service
    systemctl daemon-reload
    systemctl enable -q arca-client
    systemctl restart arca-client
    sleep 1
    systemctl is-active -q arca-client || die "the client did not start; see: journalctl -u arca-client"
    say "The client is running and waits for jobs from the server."
  elif [ "$SERVICE" -eq 1 ]; then
    say "systemd was not found: start the client yourself with  arca client run"
  fi
  step "Arca $NEW_VERSION is installed as a client"
  say "Add this machine's folders on the server as sources with the path client://<client name>/<folder>."
  exit 0
fi

# --- First install: config and token --------------------------------------------------------------

TOKEN=""
mkdir -p "$DATA_DIR"
if [ ! -f "$CONF_DIR/config.json" ]; then
  step "Writing a minimal config to $CONF_DIR/config.json"
  mkdir -p "$CONF_DIR"
  chmod 700 "$CONF_DIR"
  TOKEN_JSON="$(/usr/local/bin/arca token admin --json)"
  TOKEN="$(printf '%s' "$TOKEN_JSON" | sed -n 's/.*"token": *"\([^"]*\)".*/\1/p' | head -n 1)"
  SHA="$(printf '%s' "$TOKEN_JSON" | sed -n 's/.*"sha256": *"\([0-9a-f]*\)".*/\1/p' | head -n 1)"
  [ -n "$TOKEN" ] && [ -n "$SHA" ] || die "could not create the admin token."
  umask 077
  cat >"$CONF_DIR/config.json" <<EOF
{
  "listen": { "host": "0.0.0.0", "port": $PORT },
  "dataDir": "$DATA_DIR",
  "restoreRoot": "$DATA_DIR/restore",
  "tokens": [
    { "name": "admin", "sha256": "$SHA", "scopes": ["admin"] }
  ],
  "repos": {},
  "sources": {}
}
EOF
else
  say "Keeping the existing config $CONF_DIR/config.json."
fi

# --- Service --------------------------------------------------------------------------------------

if [ "$SERVICE" -eq 1 ] && [ "$HAVE_SYSTEMD" -eq 1 ]; then
  step "Starting the arca service"
  cp "$PREFIX/current/arca.service" /etc/systemd/system/arca.service
  systemctl daemon-reload
  systemctl enable -q arca
  systemctl restart arca
  sleep 1
  systemctl is-active -q arca || die "the service did not start; see: journalctl -u arca"
  say "The service is running."
elif [ "$SERVICE" -eq 1 ]; then
  say "systemd was not found: start the server yourself with  arca serve $CONF_DIR/config.json"
fi

# --- Done -----------------------------------------------------------------------------------------

step "Arca $NEW_VERSION is installed"
if [ -n "$TOKEN" ]; then
  say "Admin token for the API and MCP (shown only once, keep it safe):"
  say ""
  say "    $TOKEN"
  say ""
  say "Next: create a repository and add it with a source to $CONF_DIR/config.json, e.g."
  say "    echo 'a long password' > $CONF_DIR/main.pass && chmod 600 $CONF_DIR/main.pass"
  say "    arca init --repo /mnt/backup/arca --password-file $CONF_DIR/main.pass"
  say "then restart the service:  systemctl restart arca"
  say "Docs: https://github.com/$REPO#readme"
fi
