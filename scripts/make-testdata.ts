/**
 * Generate a synthetic directory for manual tests:
 * `bun scripts/make-testdata.ts <dir> [MB=50]`. Contains no real data.
 * Running it again on the same directory "changes" some files, so the next snapshot has something to add.
 */
import { mkdir, readdir, writeFile, appendFile, symlink } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

const root = process.argv[2];
if (!root) throw new Error("Specify a directory");
const totalMb = Number(process.argv[3] ?? 50);

const words = "backup snapshot cipher key pack index tree folder file storage copy restore retention".split(" ");
const text = (n: number) => Array.from({ length: n }, () => words[Math.floor(Math.random() * words.length)]).join(" ") + "\n";

if (!existsSync(root)) {
  await mkdir(root, { recursive: true });
  let left = totalMb * 1024 * 1024;
  const dirs = ["configs", "configs/nginx", "db", "media/photos", "projects/app/src", "projects/app/node_modules/lib", "logs", ".cache"];
  for (const d of dirs) await mkdir(join(root, d), { recursive: true });
  for (let i = 0; i < 40; i++) await writeFile(join(root, `configs/conf-${i}.ini`), `[s${i}]\n` + text(50));
  for (let i = 0; i < 10; i++) await writeFile(join(root, `configs/nginx/site-${i}.conf`), text(200));
  for (let i = 0; i < 100; i++) await writeFile(join(root, `projects/app/src/m${i}.ts`), `// module ${i}\n` + text(300));
  for (let i = 0; i < 20; i++) await writeFile(join(root, `projects/app/node_modules/lib/f${i}.js`), text(100));
  for (let i = 0; i < 5; i++) await writeFile(join(root, `logs/app-${i}.log`), text(2000));
  await writeFile(join(root, ".cache/blob"), randomBytes(256 * 1024));
  await symlink("configs/conf-0.ini", join(root, "current.ini"));
  // The "database" and "media" make up the bulk: random data does not compress, so the real size shows.
  const db = Math.floor(left * 0.4);
  await writeFile(join(root, "db/app.sqlite"), randomBytes(db));
  left -= db;
  for (let i = 0; left > 0; i++) {
    const n = Math.min(left, (1 + Math.floor(Math.random() * 4)) * 1024 * 1024);
    await writeFile(join(root, `media/photos/img-${i}.jpg`), randomBytes(n));
    left -= n;
  }
  // A duplicate, to check deduplication.
  const photos = await readdir(join(root, "media/photos"));
  const { copyFile } = await import("node:fs/promises");
  await copyFile(join(root, "media/photos", photos[0]!), join(root, "media/copy-of-first.jpg"));
  console.log(`Created ${root} (~${totalMb} MB)`);
} else {
  // Changes: append to a few files, add a new one, modify a chunk of the "database".
  for (let i = 0; i < 3; i++) await appendFile(join(root, `configs/conf-${Math.floor(Math.random() * 40)}.ini`), text(5));
  await writeFile(join(root, `projects/app/src/new-${Date.now()}.ts`), text(100));
  const { open } = await import("node:fs/promises");
  const fh = await open(join(root, "db/app.sqlite"), "r+");
  const { size } = await fh.stat();
  await fh.write(randomBytes(64 * 1024), 0, 64 * 1024, Math.floor(Math.random() * (size - 64 * 1024)));
  await fh.close();
  console.log(`Modified ${root}`);
}
