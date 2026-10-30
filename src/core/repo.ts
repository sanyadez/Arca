/**
 * Repository: an encrypted store of content-addressed blobs, plus snapshots.
 *
 * Layout in the storage (details in FORMAT.md):
 *   config              — plaintext JSON: version, id, chunker parameters
 *   keys/<id>           — master key wrapped with a password (there may be several passwords)
 *   data/<aa>/<id>      — packs: encrypted blobs + encrypted header; id = sha256 of the pack
 *   index/<id>          — encrypted index: which blobs are in which packs
 *   snapshots/<id>      — encrypted snapshots
 *
 * All files except config are immutable. Write order is packs → index → snapshot: if the process
 * dies midway, at most some extra packs remain for prune to remove; there are no dangling references.
 */
import { hostname } from "node:os";
import { type Backend, NotFoundError } from "../backends/types";
import {
  type KeyFile,
  type MasterKey,
  DecryptError,
  blobId,
  decrypt,
  encrypt,
  newMasterKey,
  randomHex,
  sha256Hex,
  unwrapMasterKey,
  wrapMasterKey,
  type KdfParams,
} from "./crypto";
import { Chunker, DEFAULT_CHUNKER, gearTable, type ChunkerParams } from "./chunker";

export const FORMAT_VERSION = 1;
export const PACK_TARGET = 16 * 1024 * 1024;

export type BlobType = "data" | "tree";

export interface RepoConfig {
  v: number;
  id: string;
  created: string;
  chunker: ChunkerParams;
}

export interface IndexEntry {
  pack: string;
  type: BlobType;
  off: number;
  len: number; // length of the encrypted blob in the pack
  raw: number; // plaintext length
}

/** Pack header and index row: [id, type, offset, length, raw size]. */
type BlobRow = [string, "d" | "t", number, number, number];

interface IndexFile {
  v: number;
  packs: { id: string; blobs: BlobRow[] }[];
  /** Indexes this one replaces (prune): they may be deleted once this one is written. */
  supersedes?: string[];
}

export interface Snapshot {
  v: number;
  time: string;
  host: string;
  source: string; // source name (usually a path)
  root: string; // absolute path of the directory the snapshot was taken from
  tree: string;
  parent?: string;
  tags: string[];
  owner: string;
  stats?: SnapshotStats;
}

export interface SnapshotStats {
  files: number;
  dirs: number;
  bytes: number; // logical size of all files
  newBlobs: number;
  newBytes: number; // plaintext bytes added to the repository
  errors: number;
  seconds: number;
}

const enc = new TextEncoder();
const dec = new TextDecoder();
const toJson = (v: unknown) => enc.encode(JSON.stringify(v));
const fromJson = <T>(u: Uint8Array): T => JSON.parse(dec.decode(u));
const typeCode = (t: BlobType) => (t === "data" ? "d" : "t");
const codeType = (c: string): BlobType => (c === "d" ? "data" : "tree");

export function packPath(id: string) {
  return `data/${id.slice(0, 2)}/${id}`;
}

class PackWriter {
  parts: Uint8Array[] = [];
  rows: BlobRow[] = [];
  size = 0;
  add(id: string, type: BlobType, encBlob: Uint8Array, raw: number) {
    this.rows.push([id, typeCode(type), this.size, encBlob.length, raw]);
    this.parts.push(encBlob);
    this.size += encBlob.length;
  }
}

export class Repository {
  readonly chunker: Chunker;
  private index = new Map<string, IndexEntry>();
  private loadedIndexFiles = new Set<string>();
  private writers: Record<BlobType, PackWriter> = { data: new PackWriter(), tree: new PackWriter() };
  private pendingIds = new Set<string>();
  private unindexed: IndexFile["packs"] = [];
  private packCache = new Map<string, Uint8Array>();
  /** How many packs to keep in memory for storages without ranged reads. */
  packCacheSize = 4;

  private constructor(
    readonly backend: Backend,
    readonly config: RepoConfig,
    private readonly key: MasterKey,
  ) {
    this.chunker = new Chunker(gearTable(key.chunker), config.chunker);
  }

  get id() {
    return this.config.id;
  }

  // ── creating and opening ──

  static async init(
    backend: Backend,
    password: string,
    opts: { chunker?: ChunkerParams; kdf?: KdfParams } = {},
  ): Promise<Repository> {
    if (await backend.exists("config")) throw new Error(`Repository already exists: ${backend.label}`);
    const config: RepoConfig = {
      v: FORMAT_VERSION,
      id: randomHex(32),
      created: new Date().toISOString(),
      chunker: opts.chunker ?? DEFAULT_CHUNKER,
    };
    const mk = newMasterKey();
    const kf = await wrapMasterKey(mk, config.id, password, opts.kdf, hostname());
    const kb = toJson(kf);
    await backend.put(`keys/${sha256Hex(kb)}`, kb);
    await backend.put("config", toJson(config));
    return new Repository(backend, config, mk);
  }

  static async open(backend: Backend, password: string): Promise<Repository> {
    let config: RepoConfig;
    try {
      config = fromJson(await backend.get("config"));
    } catch (e) {
      if (e instanceof NotFoundError) throw new Error(`No repository at ${backend.label}`);
      throw e;
    }
    if (config.v !== FORMAT_VERSION) throw new Error(`Unsupported format version: ${config.v}`);
    const keys = await backend.list("keys");
    for (const k of keys) {
      const kf = fromJson<KeyFile>(await backend.get(k.name));
      try {
        const mk = await unwrapMasterKey(kf, config.id, password);
        const repo = new Repository(backend, config, mk);
        await repo.loadIndex();
        return repo;
      } catch (e) {
        if (!(e instanceof DecryptError)) throw e;
      }
    }
    throw new Error("Wrong password");
  }

  /** Add another password for the same master key. */
  async addKey(password: string, kdf?: KdfParams): Promise<string> {
    const kb = toJson(await wrapMasterKey(this.key, this.id, password, kdf, hostname()));
    const id = sha256Hex(kb);
    await this.backend.put(`keys/${id}`, kb);
    return id;
  }

  // ── encrypted files (index, snapshots) ──

  private sealJson(v: unknown) {
    return encrypt(this.key.enc, toJson(v));
  }
  private openJson<T>(data: Uint8Array, what: string): T {
    return fromJson<T>(decrypt(this.key.enc, data, what));
  }

  /** Encrypted JSON at an arbitrary path (locks). */
  async putSealedAt(path: string, v: unknown) {
    await this.backend.put(path, this.sealJson(v));
  }
  async getSealed<T>(path: string): Promise<T> {
    return this.openJson<T>(await this.backend.get(path), path);
  }

  /** Write encrypted JSON named sha256(contents). */
  private async putSealed(dir: string, v: unknown): Promise<string> {
    const data = this.sealJson(v);
    const id = sha256Hex(data);
    await this.backend.put(`${dir}/${id}`, data);
    return id;
  }

  // ── index ──

  /** Load index files not seen yet. */
  async loadIndex() {
    const files = await this.backend.list("index");
    for (const f of files) {
      const id = f.name.slice("index/".length);
      if (this.loadedIndexFiles.has(id)) continue;
      const ix = this.openJson<IndexFile>(await this.backend.get(f.name), `index ${id}`);
      for (const p of ix.packs) this.indexPack(p.id, p.blobs);
      this.loadedIndexFiles.add(id);
    }
  }

  /**
   * Reload the index from scratch. A long-lived process (the server) must do this before every backup:
   * if prune from another process deleted packs, the stale in-memory index would claim the blobs still exist,
   * and the new snapshot would reference missing data.
   */
  async reloadIndex() {
    if (this.pendingIds.size > 0 || this.unindexed.length > 0) throw new Error("There are unwritten blobs; call flush() first");
    this.index.clear();
    this.loadedIndexFiles.clear();
    this.packCache.clear();
    await this.loadIndex();
  }

  private indexPack(pack: string, rows: BlobRow[]) {
    for (const [id, t, off, len, raw] of rows) {
      if (!this.index.has(id)) this.index.set(id, { pack, type: codeType(t), off, len, raw });
    }
  }

  has(id: string) {
    return this.index.has(id) || this.pendingIds.has(id);
  }

  lookup(id: string) {
    return this.index.get(id);
  }

  /** All index entries (for check/prune). */
  entries(): IterableIterator<[string, IndexEntry]> {
    return this.index.entries();
  }

  /** Drop blobs from the in-memory index so saveBlob writes them again (repacking). */
  forgetBlobs(ids: Iterable<string>) {
    for (const id of ids) this.index.delete(id);
  }

  indexFileIds() {
    return [...this.loadedIndexFiles];
  }

  // ── blobs ──

  blobId(plain: Uint8Array) {
    return blobId(this.key.mac, plain);
  }

  /** Save a blob unless it already exists. Returns the id and whether anything was actually added. */
  async saveBlob(type: BlobType, plain: Uint8Array, knownId?: string): Promise<{ id: string; added: boolean }> {
    const id = knownId ?? this.blobId(plain);
    if (this.has(id)) return { id, added: false };
    const w = this.writers[type];
    w.add(id, type, this.sealBlob(plain), plain.length);
    this.pendingIds.add(id);
    if (w.size >= PACK_TARGET) await this.flushPack(type);
    return { id, added: true };
  }

  private sealBlob(plain: Uint8Array): Uint8Array {
    let body = plain;
    let flag = 0;
    if (plain.length >= 64) {
      const z = Bun.zstdCompressSync(plain, { level: 3 });
      if (z.length < plain.length * 0.97) {
        body = z;
        flag = 1;
      }
    }
    const framed = new Uint8Array(body.length + 1);
    framed[0] = flag;
    framed.set(body, 1);
    return encrypt(this.key.enc, framed);
  }

  private openBlob(id: string, sealed: Uint8Array): Uint8Array {
    const framed = decrypt(this.key.enc, sealed, `blob ${id.slice(0, 12)}`);
    const body = framed.subarray(1);
    let plain: Uint8Array;
    if (framed[0] === 0) plain = body.slice();
    else if (framed[0] === 1) plain = new Uint8Array(Bun.zstdDecompressSync(body));
    else throw new Error(`Unknown blob encoding ${id}`);
    if (this.blobId(plain) !== id) throw new Error(`Blob ${id} is corrupted: content does not match id`);
    return plain;
  }

  private async flushPack(type: BlobType) {
    const w = this.writers[type];
    if (w.rows.length === 0) return;
    this.writers[type] = new PackWriter();
    const header = this.sealJson(w.rows);
    const trailer = new Uint8Array(4);
    new DataView(trailer.buffer).setUint32(0, header.length, true);
    const pack = new Uint8Array(w.size + header.length + 4);
    let off = 0;
    for (const p of w.parts) {
      pack.set(p, off);
      off += p.length;
    }
    pack.set(header, off);
    pack.set(trailer, off + header.length);
    const id = sha256Hex(pack);
    await this.backend.put(packPath(id), pack);
    this.indexPack(id, w.rows);
    for (const r of w.rows) this.pendingIds.delete(r[0]);
    this.unindexed.push({ id, blobs: w.rows });
  }

  /** Write out all pending packs and their index. Call before saving a snapshot. */
  async flush() {
    await this.flushPack("data");
    await this.flushPack("tree");
    if (this.unindexed.length === 0) return;
    const id = await this.putSealed("index", { v: FORMAT_VERSION, packs: this.unindexed } satisfies IndexFile);
    this.loadedIndexFiles.add(id);
    this.unindexed = [];
  }

  async loadBlob(id: string): Promise<Uint8Array> {
    const e = this.index.get(id);
    if (!e) throw new Error(`Blob ${id} is not in the index`);
    let sealed: Uint8Array;
    if (this.backend.ranged) {
      sealed = await this.backend.get(packPath(e.pack), { offset: e.off, length: e.len });
    } else {
      sealed = (await this.loadPack(e.pack)).subarray(e.off, e.off + e.len);
    }
    return this.openBlob(id, sealed);
  }

  private async loadPack(id: string): Promise<Uint8Array> {
    let p = this.packCache.get(id);
    if (p) {
      this.packCache.delete(id);
      this.packCache.set(id, p);
      return p;
    }
    p = await this.backend.get(packPath(id));
    this.packCache.set(id, p);
    while (this.packCache.size > this.packCacheSize) this.packCache.delete(this.packCache.keys().next().value!);
    return p;
  }

  /** Read and verify a whole pack: header, every blob, sha256. For check --read-data. */
  async verifyPack(id: string, data?: Uint8Array): Promise<BlobRow[]> {
    const pack = data ?? (await this.backend.get(packPath(id)));
    if (sha256Hex(pack) !== id) throw new Error(`Pack ${id}: sha256 does not match the name`);
    const rows = this.readPackHeader(id, pack);
    for (const [bid, , off, len] of rows) this.openBlob(bid, pack.subarray(off, off + len));
    return rows;
  }

  readPackHeader(id: string, pack: Uint8Array): BlobRow[] {
    if (pack.length < 4) throw new Error(`Pack ${id} is truncated`);
    const hlen = new DataView(pack.buffer, pack.byteOffset + pack.length - 4, 4).getUint32(0, true);
    const start = pack.length - 4 - hlen;
    if (start < 0) throw new Error(`Pack ${id} is truncated`);
    return this.openJson<BlobRow[]>(pack.subarray(start, pack.length - 4), `pack header ${id.slice(0, 12)}`);
  }

  /** Plaintext blobs of a pack (for repacking in prune). */
  async *packBlobs(id: string): AsyncGenerator<{ id: string; type: BlobType; plain: Uint8Array }> {
    const pack = await this.backend.get(packPath(id));
    for (const [bid, t, off, len] of this.readPackHeader(id, pack))
      yield { id: bid, type: codeType(t), plain: this.openBlob(bid, pack.subarray(off, off + len)) };
  }

  /** Write a new full index replacing the current ones (prune). The caller deletes the old files. */
  async writeFullIndex(keep: (blob: string, e: IndexEntry) => boolean): Promise<{ id: string; replaced: string[] }> {
    const byPack = new Map<string, BlobRow[]>();
    for (const [bid, e] of this.index) {
      if (!keep(bid, e)) continue;
      let rows = byPack.get(e.pack);
      if (!rows) byPack.set(e.pack, (rows = []));
      rows.push([bid, typeCode(e.type), e.off, e.len, e.raw]);
    }
    const replaced = [...this.loadedIndexFiles];
    const id = await this.putSealed("index", {
      v: FORMAT_VERSION,
      packs: [...byPack].map(([pid, blobs]) => ({ id: pid, blobs })),
      supersedes: replaced,
    } satisfies IndexFile);
    // Rebuild the in-memory index for the new state.
    this.index.clear();
    for (const [pid, rows] of byPack) this.indexPack(pid, rows);
    this.loadedIndexFiles = new Set([id]);
    return { id, replaced };
  }

  // ── snapshots ──

  async saveSnapshot(s: Snapshot): Promise<string> {
    await this.flush();
    return this.putSealed("snapshots", s);
  }

  /** Snapshot files never change, so decrypted snapshots are kept; only new ones are fetched. */
  private snapCache = new Map<string, Snapshot>();

  async listSnapshots(): Promise<{ id: string; snapshot: Snapshot }[]> {
    const files = await this.backend.list("snapshots");
    const ids = new Set<string>();
    const out = [];
    for (const f of files) {
      const id = f.name.slice("snapshots/".length);
      ids.add(id);
      let snapshot = this.snapCache.get(id);
      if (!snapshot) {
        snapshot = this.openJson<Snapshot>(await this.backend.get(f.name), `snapshot ${id.slice(0, 12)}`);
        this.snapCache.set(id, snapshot);
      }
      out.push({ id, snapshot });
    }
    for (const id of this.snapCache.keys()) if (!ids.has(id)) this.snapCache.delete(id);
    return out.sort((a, b) => a.snapshot.time.localeCompare(b.snapshot.time));
  }

  /** Snapshot by id or id prefix (at least 4 characters), or "latest". */
  async findSnapshot(ref: string, filter?: (s: Snapshot) => boolean): Promise<{ id: string; snapshot: Snapshot }> {
    const all = (await this.listSnapshots()).filter((x) => !filter || filter(x.snapshot));
    if (ref === "latest") {
      const last = all.at(-1);
      if (!last) throw new Error("The repository has no snapshots yet");
      return last;
    }
    if (ref.length < 4) throw new Error("Specify at least 4 characters of the snapshot id");
    const m = all.filter((x) => x.id.startsWith(ref));
    if (m.length === 0) throw new Error(`Snapshot ${ref} not found`);
    if (m.length > 1) throw new Error(`Prefix ${ref} is ambiguous`);
    return m[0]!;
  }

  async deleteSnapshot(id: string) {
    await this.backend.delete(`snapshots/${id}`);
    this.snapCache.delete(id);
  }

  async close() {
    await this.backend.close();
  }
}
