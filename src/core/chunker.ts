/**
 * Content-defined chunking (FastCDC with normalization).
 *
 * Chunk boundaries depend on the data itself, so inserting a byte at the start of a file shifts only
 * the nearby boundaries; the remaining chunks stay the same and get deduplicated.
 * The gear table is derived from a seed in the repository key: without the key boundaries cannot be
 * predicted, and a known file cannot be recognized by the chunk sizes in the storage.
 */
import { createHmac } from "node:crypto";
import type { FileHandle } from "node:fs/promises";
import type { ByteReader } from "./source";

export interface ChunkerParams {
  min: number;
  avg: number; // power of two
  max: number;
}

export const DEFAULT_CHUNKER: ChunkerParams = { min: 512 * 1024, avg: 1024 * 1024, max: 8 * 1024 * 1024 };

export function gearTable(seed: Uint8Array): Uint32Array {
  const t = new Uint32Array(256);
  for (let block = 0; block < 32; block++) {
    const h = createHmac("sha256", seed).update(Uint8Array.of(block)).digest();
    for (let j = 0; j < 8; j++) t[block * 8 + j] = h.readUInt32LE(j * 4);
  }
  return t;
}

/** Mask of the top `bits` bits (the high bits carry a longer byte history). */
function topMask(bits: number): number {
  return bits <= 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
}

export class Chunker {
  private readonly maskS: number;
  private readonly maskL: number;

  constructor(
    private readonly gear: Uint32Array,
    readonly p: ChunkerParams = DEFAULT_CHUNKER,
  ) {
    const bits = Math.round(Math.log2(p.avg));
    if (1 << bits !== p.avg) throw new Error("avg must be a power of two");
    if (!(p.min < p.avg && p.avg < p.max)) throw new Error("must be min < avg < max");
    // Level-2 normalization: before avg a boundary is harder to hit, after it easier.
    this.maskS = topMask(bits + 2);
    this.maskL = topMask(bits - 2);
  }

  /** Length of the first chunk in buf[0..n). With less than max bytes and no EOF it may return n. */
  cut(buf: Uint8Array, n: number): number {
    const { min, avg, max } = this.p;
    if (n <= min) return n;
    if (n > max) n = max;
    const normal = n < avg ? n : avg;
    const gear = this.gear;
    let fp = 0;
    let i = min - 64 > 0 ? min - 64 : 0;
    // Warm up the fingerprint on the 64 bytes before min so the boundary depends only on nearby content.
    for (; i < min; i++) fp = ((fp << 1) + gear[buf[i]!]!) >>> 0;
    for (; i < normal; i++) {
      fp = ((fp << 1) + gear[buf[i]!]!) >>> 0;
      if ((fp & this.maskS) === 0) return i + 1;
    }
    for (; i < n; i++) {
      fp = ((fp << 1) + gear[buf[i]!]!) >>> 0;
      if ((fp & this.maskL) === 0) return i + 1;
    }
    return n;
  }

  /** Chunks from an open file. */
  chunksOfFile(fh: FileHandle, readSize?: number): AsyncGenerator<Uint8Array> {
    return this.chunksOfReader({ read: async (b, o, l) => (await fh.read(b, o, l, null)).bytesRead }, readSize);
  }

  /** Chunks from a sequential stream. Each returned array is a separate copy. */
  async *chunksOfReader(r: ByteReader, readSize = 4 * 1024 * 1024): AsyncGenerator<Uint8Array> {
    const cap = this.p.max + readSize;
    const buf = new Uint8Array(cap);
    let len = 0;
    let eof = false;
    while (true) {
      while (!eof && len < this.p.max) {
        const bytesRead = await r.read(buf, len, Math.min(readSize, cap - len));
        if (bytesRead === 0) eof = true;
        len += bytesRead;
      }
      if (len === 0) return;
      // Until EOF the buffer holds at least max bytes, so cut sees the full window.
      const c = this.cut(buf, len);
      yield buf.slice(0, c);
      buf.copyWithin(0, c, len);
      len -= c;
    }
  }

  /** Same for an in-memory array (tests, small data). */
  *chunksOf(data: Uint8Array): Generator<Uint8Array> {
    let off = 0;
    while (off < data.length) {
      const c = this.cut(data.subarray(off), data.length - off);
      yield data.slice(off, off + c);
      off += c;
    }
  }
}
