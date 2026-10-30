/**
 * Streaming tar parser (ustar, GNU long names 'L', pax 'x'), sufficient for `tar -cf -` from GNU tar.
 * Member contents are read straight from the stream, without buffering the whole file.
 */
import type { ByteReader } from "../core/source";

/** Buffered reader on top of a ReadableStream. */
export class StreamBuf {
  private reader: { read(): Promise<{ value?: Uint8Array; done: boolean }>; cancel(): Promise<void> };
  private cur: Uint8Array = new Uint8Array(0);
  private pos = 0;
  private done = false;
  /** How many bytes have come from the stream. */
  total = 0;

  constructor(stream: ReadableStream<Uint8Array>) {
    this.reader = stream.getReader() as any;
  }

  private async fill(): Promise<boolean> {
    while (this.pos >= this.cur.length) {
      if (this.done) return false;
      const { value, done } = await this.reader.read();
      if (done) {
        this.done = true;
        return false;
      }
      this.cur = value!;
      this.total += value!.length;
      this.pos = 0;
    }
    return true;
  }

  /** Up to len bytes into buf; 0 means end of stream. */
  async readInto(buf: Uint8Array, off: number, len: number): Promise<number> {
    if (len === 0 || !(await this.fill())) return 0;
    const n = Math.min(len, this.cur.length - this.pos);
    buf.set(this.cur.subarray(this.pos, this.pos + n), off);
    this.pos += n;
    return n;
  }

  /** Exactly n bytes, or null if the stream ended before them (at a block boundary); otherwise an error. */
  async readExact(n: number): Promise<Uint8Array | null> {
    const out = new Uint8Array(n);
    let got = 0;
    while (got < n) {
      const k = await this.readInto(out, got, n - got);
      if (k === 0) {
        if (got === 0) return null;
        throw new Error("tar: stream ended mid-block");
      }
      got += k;
    }
    return out;
  }

  async skip(n: number) {
    const tmp = new Uint8Array(Math.min(n, 1 << 16));
    while (n > 0) {
      const k = await this.readInto(tmp, 0, Math.min(n, tmp.length));
      if (k === 0) throw new Error("tar: stream ended unexpectedly");
      n -= k;
    }
  }

  async cancel() {
    await this.reader.cancel().catch(() => {});
  }
}

const dec = new TextDecoder();

function str(b: Uint8Array, off: number, len: number): string {
  const s = b.subarray(off, off + len);
  const z = s.indexOf(0);
  return dec.decode(z >= 0 ? s.subarray(0, z) : s);
}

function num(b: Uint8Array, off: number, len: number): number {
  if (b[off]! & 0x80) {
    // base-256 (GNU) for large values
    let v = b[off]! & 0x7f;
    for (let i = 1; i < len; i++) v = v * 256 + b[off + i]!;
    return v;
  }
  const t = str(b, off, len).trim();
  return t ? parseInt(t, 8) : 0;
}

function checksumOk(h: Uint8Array): boolean {
  let sum = 0;
  for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 32 : h[i]!;
  return sum === num(h, 148, 8);
}

export interface TarMember {
  name: string;
  /** '0' is a regular file, '5' a directory, '2' a symlink, etc. */
  type: string;
  size: number;
  reader: ByteReader;
}

/** Archive members one by one. Unread contents of the previous member are skipped automatically. */
export async function* tarMembers(sb: StreamBuf): AsyncGenerator<TarMember> {
  let longName: string | undefined;
  let paxPath: string | undefined;
  let paxSize: number | undefined;
  while (true) {
    const h = await sb.readExact(512);
    if (!h) return;
    if (h.every((x) => x === 0)) return; // end of archive
    if (!checksumOk(h)) throw new Error("tar: corrupt header");
    const type = String.fromCharCode(h[156]!) || "0";
    let size = num(h, 124, 12);
    const pad = (512 - (size % 512)) % 512;
    if (type === "L" || type === "x" || type === "g") {
      const data = await sb.readExact(size);
      await sb.skip(pad);
      if (!data && size > 0) throw new Error("tar: stream ended unexpectedly");
      const text = dec.decode(data ?? new Uint8Array(0));
      if (type === "L") longName = text.replace(/\0+$/, "");
      else if (type === "x") {
        for (const rec of parsePax(text)) {
          if (rec[0] === "path") paxPath = rec[1];
          else if (rec[0] === "size") paxSize = Number(rec[1]);
        }
      }
      continue;
    }
    let name = str(h, 0, 100);
    if (str(h, 257, 6).startsWith("ustar")) {
      const prefix = str(h, 345, 155);
      if (prefix && !longName && !paxPath) name = `${prefix}/${name}`;
    }
    name = paxPath ?? longName ?? name;
    if (paxSize !== undefined) size = paxSize;
    longName = paxPath = paxSize = undefined;
    const realPad = (512 - (size % 512)) % 512;
    let left = size;
    const reader: ByteReader = {
      read: async (buf, off, len) => {
        const n = Math.min(len, left);
        if (n === 0) return 0;
        const got = await sb.readInto(buf, off, n);
        if (got === 0) throw new Error("tar: stream ended mid-file");
        left -= got;
        return got;
      },
    };
    yield { name: name.replace(/^\.\//, ""), type: type === "\0" ? "0" : type, size, reader };
    if (left > 0) await sb.skip(left);
    await sb.skip(realPad);
  }
}

function parsePax(text: string): [string, string][] {
  // Record: "<length> key=value\n", the length is in UTF-8 bytes and includes itself.
  const bytes = new TextEncoder().encode(text);
  const out: [string, string][] = [];
  let i = 0;
  while (i < bytes.length) {
    const sp = bytes.indexOf(0x20, i);
    if (sp < 0) break;
    const len = Number(dec.decode(bytes.subarray(i, sp)));
    if (!len) break;
    const rec = dec.decode(bytes.subarray(sp + 1, i + len - 1));
    const eq = rec.indexOf("=");
    if (eq > 0) out.push([rec.slice(0, eq), rec.slice(eq + 1)]);
    i += len;
  }
  return out;
}
