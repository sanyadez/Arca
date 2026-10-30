/**
 * 5-field cron schedule (min hour day month weekday) in the process's local time, plus @hourly,
 * @daily, @weekly, @monthly, @yearly. As in classic cron: if both day of month and day of week
 * are restricted, either one matches.
 */

const ALIASES: Record<string, string> = {
  "@hourly": "0 * * * *",
  "@daily": "0 0 * * *",
  "@midnight": "0 0 * * *",
  "@weekly": "0 0 * * 0",
  "@monthly": "0 0 1 * *",
  "@yearly": "0 0 1 1 *",
  "@annually": "0 0 1 1 *",
};

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const DAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

interface Field {
  set: Set<number>;
  any: boolean;
}

function parseField(src: string, min: number, max: number, names?: string[], nameBase = 0): Field {
  const set = new Set<number>();
  const val = (s: string) => {
    const i = names?.indexOf(s.toLowerCase()) ?? -1;
    const n = i >= 0 ? i + nameBase : Number(s);
    if (!Number.isInteger(n) || n < min || n > max) throw new Error(`Invalid value "${s}" in schedule`);
    return n;
  };
  for (const part of src.split(",")) {
    const [range, stepS] = part.split("/");
    const step = stepS === undefined ? 1 : Number(stepS);
    if (!Number.isInteger(step) || step < 1) throw new Error(`Invalid step "${stepS}" in schedule`);
    let lo: number, hi: number;
    if (range === "*") [lo, hi] = [min, max];
    else if (range!.includes("-")) {
      const [a, b] = range!.split("-");
      [lo, hi] = [val(a!), val(b!)];
      if (lo > hi) throw new Error(`Invalid range "${range}" in schedule`);
    } else {
      lo = val(range!);
      hi = stepS === undefined ? lo : max;
    }
    for (let v = lo; v <= hi; v += step) set.add(v);
  }
  return { set, any: src === "*" };
}

export class Cron {
  private f: Field[];
  constructor(readonly expr: string) {
    const e = ALIASES[expr.trim().toLowerCase()] ?? expr.trim();
    const parts = e.split(/\s+/);
    if (parts.length !== 5) throw new Error(`Schedule must have 5 fields: "${expr}"`);
    const dow = parseField(parts[4]!, 0, 7, DAYS);
    if (dow.set.delete(7)) dow.set.add(0);
    this.f = [
      parseField(parts[0]!, 0, 59),
      parseField(parts[1]!, 0, 23),
      parseField(parts[2]!, 1, 31),
      parseField(parts[3]!, 1, 12, MONTHS, 1),
      dow,
    ];
  }

  matches(d: Date): boolean {
    const [mi, h, dom, mon, dow] = this.f as [Field, Field, Field, Field, Field];
    if (!mi.set.has(d.getMinutes()) || !h.set.has(d.getHours()) || !mon.set.has(d.getMonth() + 1)) return false;
    const domOk = dom.set.has(d.getDate());
    const dowOk = dow.set.has(d.getDay());
    if (dom.any || dow.any) return domOk && dowOk;
    return domOk || dowOk;
  }

  /** Next matching minute after `from`; null if there is none within ~4 years. */
  next(from = new Date()): Date | null {
    const d = new Date(from);
    d.setSeconds(0, 0);
    d.setMinutes(d.getMinutes() + 1);
    for (let i = 0; i < 4 * 366 * 24 * 60; i++) {
      if (this.matches(d)) return d;
      d.setMinutes(d.getMinutes() + 1);
    }
    return null;
  }
}
