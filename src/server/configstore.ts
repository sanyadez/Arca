/**
 * Editing the config file from the API. Every change goes through one queue: read the file,
 * change the raw JSON, validate the whole config, write it atomically (temporary file + rename,
 * mode 600), and only then apply it to the running service. A config that does not validate is
 * never written.
 */
import { mkdir, readFile, rename, writeFile, chmod } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { type Config, validateConfig } from "./config";

export class ConfigStore {
  readonly path: string;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(path: string) {
    this.path = resolve(path);
  }

  get dir() {
    return dirname(this.path);
  }

  async readRaw(): Promise<any> {
    return JSON.parse(await readFile(this.path, "utf8"));
  }

  /** Apply `change` to the raw config and save it; resolves with the validated new config. */
  update(change: (raw: any) => void | Promise<void>): Promise<Config> {
    const next = this.queue.catch(() => {}).then(async () => {
      const raw = await this.readRaw();
      await change(raw);
      const cfg = validateConfig(raw, this.dir);
      await mkdir(this.dir, { recursive: true });
      const tmp = `${this.path}.tmp-${randomBytes(4).toString("hex")}`;
      await writeFile(tmp, JSON.stringify(raw, null, 2) + "\n", { mode: 0o600 });
      await chmod(tmp, 0o600);
      await rename(tmp, this.path);
      return cfg;
    });
    this.queue = next;
    return next;
  }

  /** Write a secret next to the config (repository passwords); returns the absolute path. */
  async writeSecret(name: string, value: string): Promise<string> {
    const p = resolve(this.dir, name);
    await writeFile(p, value + "\n", { mode: 0o600, flag: "wx" });
    return p;
  }
}
