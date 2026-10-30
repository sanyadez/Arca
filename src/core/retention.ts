/**
 * Snapshot retention. Same policy as restic: for each bucket (last N, hourly, daily…)
 * keep the newest snapshot of each of the N most recent periods that have snapshots.
 * A snapshot is kept if at least one bucket keeps it. Grouped by host and source.
 * Periods are computed in the process's local time (TZ).
 */
import type { Snapshot } from "./repo";

export interface RetentionPolicy {
  last?: number;
  hourly?: number;
  daily?: number;
  weekly?: number;
  monthly?: number;
  yearly?: number;
  /** Keep everything younger than this many days. */
  withinDays?: number;
}

export function isEmptyPolicy(p: RetentionPolicy) {
  return !Object.values(p).some((v) => typeof v === "number" && v > 0);
}

/** ISO week: year and week number. */
function isoWeek(d: Date): string {
  const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const day = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - day); // the Thursday of this week determines the year
  const yearStart = Date.UTC(t.getUTCFullYear(), 0, 1);
  const week = Math.ceil(((t.getTime() - yearStart) / 86400000 + 1) / 7);
  return `${t.getUTCFullYear()}-W${week}`;
}

const BUCKETS: [keyof RetentionPolicy, (d: Date) => string][] = [
  ["hourly", (d) => `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}-${d.getHours()}`],
  ["daily", (d) => `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`],
  ["weekly", isoWeek],
  ["monthly", (d) => `${d.getFullYear()}-${d.getMonth()}`],
  ["yearly", (d) => `${d.getFullYear()}`],
];

export interface RetentionDecision<T> {
  keep: { item: T; reasons: string[] }[];
  remove: T[];
}

export function applyRetention<T extends { snapshot: Snapshot }>(
  items: T[],
  p: RetentionPolicy,
  now = new Date(),
): RetentionDecision<T> {
  if (isEmptyPolicy(p)) throw new Error("An empty retention policy would remove everything; refusing");
  const groups = new Map<string, T[]>();
  for (const it of items) {
    const k = `${it.snapshot.host}\0${it.snapshot.source}`;
    let g = groups.get(k);
    if (!g) groups.set(k, (g = []));
    g.push(it);
  }
  const res: RetentionDecision<T> = { keep: [], remove: [] };
  for (const g of groups.values()) {
    const sorted = [...g].sort((a, b) => b.snapshot.time.localeCompare(a.snapshot.time)); // newest first
    const reasons = new Map<T, string[]>();
    const add = (it: T, r: string) => {
      let l = reasons.get(it);
      if (!l) reasons.set(it, (l = []));
      l.push(r);
    };
    if (p.last) sorted.slice(0, p.last).forEach((it) => add(it, "last"));
    if (p.withinDays) {
      const cut = now.getTime() - p.withinDays * 86400000;
      for (const it of sorted) if (Date.parse(it.snapshot.time) >= cut) add(it, "within");
    }
    for (const [name, key] of BUCKETS) {
      const n = p[name];
      if (!n) continue;
      const seen = new Set<string>();
      for (const it of sorted) {
        const k = key(new Date(it.snapshot.time));
        if (seen.has(k)) continue;
        if (seen.size >= n) break;
        seen.add(k);
        add(it, name);
      }
    }
    for (const it of sorted) {
      const r = reasons.get(it);
      if (r) res.keep.push({ item: it, reasons: r });
      else res.remove.push(it);
    }
  }
  return res;
}
