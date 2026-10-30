/**
 * Storage is a flat space of files addressed by relative paths (`data/ab/abcd…`, `index/…`).
 * The core only writes immutable files under new names, so storage needs only put/get/list/delete,
 * and put must be atomic: the file is either there in full or not at all.
 */
export interface FileInfo {
  name: string; // path relative to the repository root
  size: number;
}

export interface Backend {
  /** Human-readable description for logs, without secrets. */
  readonly label: string;
  /** Whether get can read part of a file without downloading all of it. */
  readonly ranged: boolean;
  put(path: string, data: Uint8Array): Promise<void>;
  /** NotFoundError if the file does not exist. */
  get(path: string, range?: { offset: number; length: number }): Promise<Uint8Array>;
  /** Recursive: all files under directory `dir` (e.g. "snapshots", "data"). Empty if the directory does not exist. */
  list(dir: string): Promise<FileInfo[]>;
  delete(path: string): Promise<void>;
  exists(path: string): Promise<boolean>;
  /** Space on the underlying disk, if the storage can tell. */
  usage?(): Promise<{ total: number; used: number } | null>;
  close(): Promise<void>;
}

export class NotFoundError extends Error {
  constructor(path: string) {
    super(`File not found: ${path}`);
    this.name = "NotFoundError";
  }
}

/** Relative path without `..`, absolute parts or empty segments. */
export function checkPath(path: string): string {
  const parts = path.split("/");
  if (!path || parts.some((p) => p === "" || p === "." || p === ".." || p.includes("\\") || p.includes("\0")))
    throw new Error(`Invalid storage path: ${path}`);
  return path;
}
