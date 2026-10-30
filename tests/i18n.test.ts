// Every text the web UI translates has a Ukrainian entry with the same placeholders.
import { expect, test } from "bun:test";
import { Glob } from "bun";
import { UK } from "../src/ui/uk.js";

const dir = new URL("../src/ui/", import.meta.url).pathname;
const used = new Map<string, { plural: boolean; file: string }>();
for (const file of new Glob("**/*.js").scanSync(dir)) {
  if (file === "uk.js" || file === "icons.js") continue;
  const src = await Bun.file(dir + file).text();
  for (const m of src.matchAll(/\b(?:t|ht)\(\s*"((?:\\.|[^"\\])*)"/g)) used.set(JSON.parse(`"${m[1]}"`), { plural: false, file });
  for (const m of src.matchAll(/\btn\(\s*"((?:\\.|[^"\\])*)"\s*,\s*"((?:\\.|[^"\\])*)"/g)) used.set(JSON.parse(`"${m[2]}"`), { plural: true, file });
}
const dict = UK as Record<string, string | string[]>;
const holes = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(",");

test("the UI uses translated texts", () => {
  expect(used.size).toBeGreaterThan(100);
});

test("every UI text has a Ukrainian translation", () => {
  const missing = [...used].filter(([k]) => !(k in dict)).map(([k, u]) => `${u.file}: ${k}`);
  expect(missing).toEqual([]);
});

test("translations keep the placeholders and plural forms", () => {
  const bad: string[] = [];
  for (const [k, u] of used) {
    const v = dict[k];
    if (v === undefined) continue;
    if (u.plural !== Array.isArray(v) || (Array.isArray(v) && v.length !== 3)) bad.push(`${k}: wrong shape`);
    for (const s of Array.isArray(v) ? v : [v]) if (holes(s) !== holes(k)) bad.push(`${k} → ${s}`);
  }
  expect(bad).toEqual([]);
});

test("no stale translations", () => {
  expect(Object.keys(dict).filter((k) => !used.has(k))).toEqual([]);
});
