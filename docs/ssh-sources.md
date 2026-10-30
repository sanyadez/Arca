# SSH sources

The Arca server connects to the machine itself and pulls the folder. Nothing is installed as a service on the source:
all it needs is an OpenSSH server, GNU find (or bfs), GNU tar and `base64` (coreutils). A regular Debian or Ubuntu will do.
Alpine and BusyBox will not: their `find` and `tar` lack the required options.

For one snapshot the server makes two requests:

1. `find -printf` returns the state of all files: type, permissions, owner, modification time, size, inode and symlink target.
2. `tar -cf -` returns the contents of only the changed files in a single stream. Unchanged files (same size, mtime and inode)
   are taken from the previous snapshot.

Encryption and deduplication happen on the server. Repository keys never reach the source.

## Setup (recommended: a dedicated user + a forced command)

Below, `192.0.2.10` is the address of the Arca server and `/srv/data` is the folder to back up.

**1. On the Arca server**, create a dedicated key for sources:

```sh
ssh-keygen -t ed25519 -N '' -C arca-src -f /etc/arca/source_ed25519
```

**2. On the source**, create a user without a password and give it read access to only what is needed:

```sh
useradd --system --create-home --shell /bin/sh arca-src
# If the files are not world-readable, grant read access via ACL (apt install acl):
setfacl -R -m u:arca-src:rX /srv/data
setfacl -R -d -m u:arca-src:rX /srv/data   # and for new files
```

Install the forced-command script (`arca-src.sh` is included in the release archive):

```sh
install -m 755 arca-src.sh /usr/local/bin/arca-src
```

Add the public key from step 1 to `~arca-src/.ssh/authorized_keys` **as a single line**:

```
restrict,from="192.0.2.10",command="/usr/local/bin/arca-src /srv/data" ssh-ed25519 AAAA… arca-src
```

After `command=`, list the folders that may be read, separated by spaces (one or more).
`restrict` disables the terminal and all forwarding, and `from=` allows connections only from the Arca server's address.

**3. On the server**, accept the host key once and check:

```sh
ssh -i /etc/arca/source_ed25519 -o StrictHostKeyChecking=accept-new arca-src@source-host true
# expected: "arca-src: command not allowed" — so the forced command works
arca backup ssh://arca-src@source-host/srv/data --ssh-forced -i /etc/arca/source_ed25519 --repo …
```

**4. In the server config:**

```json
"sources": {
  "web-data": {
    "path": "ssh://arca-src@source-host/srv/data",
    "repo": "main",
    "schedule": "15 3 * * *",
    "ssh": { "forced": true, "identity": "/etc/arca/source_ed25519" }
  }
}
```

## Without a forced command

If `ssh.forced` is not set, the server sends `find` and `tar` as a regular command, so any
SSH access with a shell will do. This is simpler for testing, but then the key holder can run anything on the source.

## What the forced command guarantees, and what it does not

- The key gives no shell, no port forwarding and no writes: only `list` and `read` of the allowed folders.
- The limit of what can be **read** is the permissions of the `arca-src` user. The script checks the root,
  but `tar` reads the paths it is sent. So the user should be given access only to the folders needed,
  and should not be root or a member of broad groups.
- Files the user cannot read end up in the snapshot's errors (status `warning`) rather than stopping it.
- The snapshot records file ownership (uid/gid), so when restoring as root, ownership is restored.
