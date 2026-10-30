# Repository format (version 1)

This description exists so that data can be restored without Arca — even with your own script.

## Files in storage

| Path | Contents | Changes |
|---|---|---|
| `config` | plaintext JSON `{v, id, created, chunker:{min,avg,max}}` | no |
| `keys/<sha256>` | JSON `KeyFile`: master key wrapped with a password | no (new ones are added) |
| `data/<first 2 characters>/<id>` | pack; `id` = sha256 of the whole file | no |
| `index/<sha256>` | encrypted index JSON | no (prune replaces with a new one) |
| `snapshots/<sha256>` | encrypted snapshot JSON | no (forget deletes) |
| `locks/<random>` | encrypted lock JSON | refreshed every 5 min |

Writes are atomic (temporary name `*.tmp-*` → rename); files with `.tmp-` in the name are ignored.

## Keys

`KeyFile = {v:1, created, host, kdf:"scrypt", N, r, p, salt(base64), data(base64)}`.

KEK = scrypt(password in NFC, salt, N, r, p, 32 bytes). `data` = JSON encrypted with the KEK
`{repo, enc, mac, chunker}` (base64 keys of 32 bytes each). `repo` must match `config.id`.

## Encryption

Everything encrypted uses AES-256-GCM: `nonce(12) ‖ ciphertext ‖ tag(16)`, random nonce, key `enc`.
Encrypted JSON files (index, snapshots, locks, pack headers) are simply `encrypt(enc, UTF-8 JSON)`.

## Blobs

A blob is a chunk of a file (`data`) or a directory tree (`tree`).

- `id` = HMAC-SHA256(`mac`, plaintext), hex.
- Stored form: `encrypt(enc, flag ‖ body)`, where flag 0 means the body is as is, 1 means the body is zstd-compressed.
- On read, the id is recomputed and verified.

File chunks are cut by FastCDC (normalization level 2) with a 32-bit gear fingerprint
`fp = (fp << 1) + gear[byte]` and masks taken from the high bits (log2(avg)+2 before avg, log2(avg)−2 after).
Gear table: 32 times HMAC-SHA256(`chunker`, [block number 0..31]), each yielding 8 uint32 LE numbers.
The chunker is not needed for restoring — only for deduplicating new snapshots.

## Pack

```
blob₁ ‖ blob₂ ‖ … ‖ header ‖ uint32 LE header length
```

The header is an encrypted JSON array of rows `[id, "d"|"t", offset, length, raw size]`
(offset and length are in bytes of the encrypted blob within the pack). Data blobs and tree blobs live in different packs.

## Index

`{v:1, packs:[{id, blobs:[rows as in the pack header]}], supersedes?:[index ids]}`.
The full repository index is the union of all files in `index/`. If a blob is in several packs, any of them will do.

## Tree

`{nodes:[TreeNode]}`, nodes sorted by name:
`{name, type:"file"|"dir"|"symlink", mode, uid, gid, mtime(ms), size?, inode?, content?:[id], subtree?:id, target?}`.
A file's contents are the concatenation of the `content` blobs in order. Names do not contain `/` and are not equal to `.`/`..`.

## Snapshot

`{v:1, time(ISO), host, source, root, tree, parent?, tags:[], owner, stats?}`.

## Write order and failures

Packs → index → snapshot. Prune: new full index → delete old indexes → delete packs.
A failure midway leaves only extra files (prune will clean them up), but never references to missing data.
