/**
 * Repository cryptography.
 *
 * - Blob: AES-256-GCM, format `nonce(12) ‖ ciphertext ‖ tag(16)`, random nonce.
 * - Blob id is HMAC-SHA256(macKey, plaintext): identical content gives an identical id
 *   (deduplication), but without the key an id cannot be used to confirm a guess about the content.
 * - The repository master key (enc + mac + chunker seed) is random; on disk it is stored only
 *   wrapped with a key derived from the password via scrypt (files `keys/<id>`).
 */
import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, scrypt } from "node:crypto";

export const NONCE_LEN = 12;
export const TAG_LEN = 16;
export const OVERHEAD = NONCE_LEN + TAG_LEN;

export interface MasterKey {
  enc: Uint8Array; // 32 bytes, AES-256-GCM
  mac: Uint8Array; // 32 bytes, HMAC-SHA256 for blob ids
  chunker: Uint8Array; // 32 bytes, seed of the FastCDC gear table
}

export interface KdfParams {
  N: number;
  r: number;
  p: number;
}

/** Defaults: ~0.7 s on a modern CPU, 128 MB of memory. */
export const DEFAULT_KDF: KdfParams = { N: 1 << 17, r: 8, p: 1 };

export function newMasterKey(): MasterKey {
  return { enc: randomBytes(32), mac: randomBytes(32), chunker: randomBytes(32) };
}

export function encrypt(key: Uint8Array, plain: Uint8Array): Uint8Array {
  const nonce = randomBytes(NONCE_LEN);
  const c = createCipheriv("aes-256-gcm", key, nonce);
  const body = c.update(plain);
  const fin = c.final();
  const tag = c.getAuthTag();
  const out = new Uint8Array(NONCE_LEN + body.length + fin.length + TAG_LEN);
  out.set(nonce, 0);
  out.set(body, NONCE_LEN);
  out.set(fin, NONCE_LEN + body.length);
  out.set(tag, out.length - TAG_LEN);
  return out;
}

export class DecryptError extends Error {
  constructor(what = "data") {
    super(`Failed to decrypt ${what}: wrong key or corrupted data`);
  }
}

export function decrypt(key: Uint8Array, data: Uint8Array, what?: string): Uint8Array {
  if (data.length < OVERHEAD) throw new DecryptError(what);
  const d = createDecipheriv("aes-256-gcm", key, data.subarray(0, NONCE_LEN));
  d.setAuthTag(data.subarray(data.length - TAG_LEN));
  try {
    const a = d.update(data.subarray(NONCE_LEN, data.length - TAG_LEN));
    const b = d.final();
    if (b.length === 0) return a;
    const out = new Uint8Array(a.length + b.length);
    out.set(a);
    out.set(b, a.length);
    return out;
  } catch {
    throw new DecryptError(what);
  }
}

export function blobId(macKey: Uint8Array, plain: Uint8Array): string {
  return createHmac("sha256", macKey).update(plain).digest("hex");
}

export function sha256Hex(data: Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

export function randomHex(bytes = 16): string {
  return randomBytes(bytes).toString("hex");
}

export function deriveKek(password: string, salt: Uint8Array, p: KdfParams): Promise<Uint8Array> {
  return new Promise((resolve, reject) =>
    scrypt(password.normalize("NFC"), salt, 32, { N: p.N, r: p.r, p: p.p, maxmem: 256 * p.N * p.r + (16 << 20) }, (err, key) =>
      err ? reject(err) : resolve(key),
    ),
  );
}

const b64 = (u: Uint8Array) => Buffer.from(u).toString("base64");
const unb64 = (s: string) => new Uint8Array(Buffer.from(s, "base64"));

/** Contents of a `keys/<id>` file. */
export interface KeyFile {
  v: 1;
  created: string;
  host?: string;
  kdf: "scrypt";
  N: number;
  r: number;
  p: number;
  salt: string;
  data: string; // base64(encrypt(kek, JSON MasterKey + repo id))
}

export async function wrapMasterKey(
  mk: MasterKey,
  repoId: string,
  password: string,
  kdf: KdfParams = DEFAULT_KDF,
  host?: string,
): Promise<KeyFile> {
  const salt = randomBytes(32);
  const kek = await deriveKek(password, salt, kdf);
  const plain = new TextEncoder().encode(
    JSON.stringify({ repo: repoId, enc: b64(mk.enc), mac: b64(mk.mac), chunker: b64(mk.chunker) }),
  );
  return {
    v: 1,
    created: new Date().toISOString(),
    host,
    kdf: "scrypt",
    ...kdf,
    salt: b64(salt),
    data: b64(encrypt(kek, plain)),
  };
}

/** Unwrap the key; throws DecryptError on a wrong password. */
export async function unwrapMasterKey(kf: KeyFile, repoId: string, password: string): Promise<MasterKey> {
  const kek = await deriveKek(password, unb64(kf.salt), kf);
  const j = JSON.parse(new TextDecoder().decode(decrypt(kek, unb64(kf.data), "key")));
  if (j.repo !== repoId) throw new Error("Key belongs to a different repository");
  return { enc: unb64(j.enc), mac: unb64(j.mac), chunker: unb64(j.chunker) };
}
