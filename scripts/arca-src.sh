#!/bin/sh
# arca-src: forced command for an Arca SSH source (read-only).
#
# Installation on the source machine (details in docs/ssh-sources.md):
#   install -m 755 arca-src.sh /usr/local/bin/arca-src
#   in ~/.ssh/authorized_keys of the reader user, on one line:
#   restrict,from="192.0.2.10",command="/usr/local/bin/arca-src /srv/data /etc/nginx" ssh-ed25519 AAAA… arca
#
# Arguments are the directories allowed to be read. The server sends only
#   arca-src list <dir in base64url>   — state of all files (find -printf, NUL separators)
#   arca-src read <dir in base64url>   — contents of the files listed on stdin (tar)
# Everything else is rejected. What can actually be read is limited by this user's permissions anyway.
set -eu
die() { echo "arca-src: $*" >&2; exit 2; }

[ $# -ge 1 ] || die "no allowed directories given (arguments of the command in authorized_keys)"
cmd=${SSH_ORIGINAL_COMMAND:-}
case "$cmd" in
  "arca-src list "*) op=list; enc=${cmd#arca-src list } ;;
  "arca-src read "*) op=read; enc=${cmd#arca-src read } ;;
  *) die "command not allowed" ;;
esac
case "$enc" in "" | *[!A-Za-z0-9_-]*) die "invalid path" ;; esac
while [ $(( ${#enc} % 4 )) -ne 0 ]; do enc="$enc="; done
root=$(printf '%s' "$enc" | tr '_-' '/+' | base64 -d) || die "invalid path"

case "$root" in /*) ;; *) die "path must be absolute" ;; esac
case "/$root/" in */../* | */./*) die "paths with . or .. are not allowed" ;; esac
ok=
for allowed in "$@"; do
  allowed=${allowed%/}
  case "$root" in "$allowed" | "$allowed"/*) ok=1 ;; esac
done
[ -n "$ok" ] || die "directory not allowed: $root"
[ -d "$root" ] || die "no such directory: $root"

# The commands must match src/sources/ssh.ts (FIND_PRINTF, TAR_FLAGS).
export LC_ALL=C
if [ "$op" = list ]; then
  exec find "$root" -mindepth 1 -printf '%y %m %U %G %T@ %s %i\0%P\0%l\0'
else
  cd "$root"
  exec tar --null --no-recursion --hard-dereference --warning=no-file-changed -T - -cf -
fi
