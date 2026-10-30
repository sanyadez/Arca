/** Repository password for the CLI: ARCA_PASSWORD, a file (`--password-file`/ARCA_PASSWORD_FILE) or a terminal prompt. */
import { readFile } from "node:fs/promises";

export async function readSecret(promptText: string): Promise<string> {
  if (!process.stdin.isTTY) {
    for await (const line of console) return line;
    throw new Error("No password given");
  }
  process.stderr.write(promptText);
  Bun.spawnSync(["stty", "-echo"], { stdin: "inherit" });
  try {
    for await (const line of console) return line;
    return "";
  } finally {
    Bun.spawnSync(["stty", "echo"], { stdin: "inherit" });
    process.stderr.write("\n");
  }
}

export async function password(file?: string): Promise<string> {
  if (process.env.ARCA_PASSWORD) return process.env.ARCA_PASSWORD;
  const f = file ?? process.env.ARCA_PASSWORD_FILE;
  if (f) return (await readFile(f, "utf8")).replace(/\r?\n$/, "");
  return readSecret("Repository password: ");
}
