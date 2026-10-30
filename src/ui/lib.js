// Shared helpers of the web UI: HTML templating with escaping, translations, formatting, API calls, toasts, modals, menus.
import { UK } from "./uk.js";

// ── HTML ──

class Raw {
  constructor(s) {
    this.s = s;
  }
  toString() {
    return this.s;
  }
}

/** Trusted HTML that `h` inserts as is. */
export const raw = (s) => new Raw(String(s));

const ESC = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
export const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ESC[c]);

function part(v) {
  if (v === null || v === undefined || v === false) return "";
  if (v instanceof Raw) return v.s;
  if (Array.isArray(v)) return v.map(part).join("");
  return esc(v);
}

/** Tagged template: values are escaped, arrays joined, raw() and nested h`` kept. */
export function h(strings, ...values) {
  let out = strings[0];
  for (let i = 0; i < values.length; i++) out += part(values[i]) + strings[i + 1];
  return new Raw(out);
}

// ── languages ──
//
// The English text is the key: t("Sources") → "Джерела". Placeholders are {name}. Every key must be a string
// literal at the call site (tests/i18n.test.ts checks that each one has a Ukrainian translation).

export const LANGS = [
  ["en", "English"],
  ["uk", "Українська"],
];
const LANG_KEY = "arca-lang";
const DICTS = { uk: UK };

function pickLang() {
  const saved = localStorage.getItem(LANG_KEY);
  if (LANGS.some(([c]) => c === saved)) return saved;
  return (navigator.languages ?? [navigator.language]).some((l) => /^uk\b/i.test(l ?? "")) ? "uk" : "en";
}

export const lang = pickLang();
/** The locale for dates and times; English keeps the browser's English variant (en-GB, en-US…). */
export const locale = lang === "uk" ? "uk-UA" : /^en\b/i.test(navigator.language ?? "") ? navigator.language : "en-GB";
document.documentElement.lang = lang;

export function setLang(code) {
  localStorage.setItem(LANG_KEY, code);
  location.reload();
}

const fill = (s, params) => (params ? s.replace(/\{(\w+)\}/g, (m, k) => (k in params ? String(params[k]) : m)) : s);

/** Translated plain text. */
export const t = (s, params) => fill(DICTS[lang]?.[s] ?? s, params);

/** Translated text as HTML: the text is escaped, raw()/h`` params are kept as they are. */
export function ht(s, params) {
  const tpl = DICTS[lang]?.[s] ?? s;
  return new Raw(tpl.split(/(\{\w+\})/).map((p) => {
    const k = /^\{(\w+)\}$/.exec(p)?.[1];
    return k && params && k in params ? part(params[k]) : esc(p);
  }).join(""));
}

const PLURAL = new Intl.PluralRules(lang);
/**
 * A count with the noun in the right form: tn("{n} source", "{n} sources", 3) → "3 sources" / "3 джерела".
 * The Ukrainian entry of the plural key is [one, few, many].
 */
export function tn(one, other, n, params) {
  const forms = DICTS[lang]?.[other];
  const cat = PLURAL.select(n);
  const s = Array.isArray(forms) ? forms[cat === "one" ? 0 : cat === "few" ? 1 : cat === "many" ? 2 : 1] : n === 1 ? one : other;
  return fill(s, { n: num(n), ...params });
}

export const icon = (name, cls = "") => raw(`<svg class="i ${cls}" aria-hidden="true"><use href="#i-${name}"/></svg>`);

// ── formatting ──

const THIN = " ";

/** 1 412 — thin-space digit groups. */
export function num(n) {
  if (n === null || n === undefined || Number.isNaN(n)) return "—";
  return Math.round(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, THIN);
}

/** Binary sizes with three significant digits: 612 GiB, 84.6 GiB, 4.1 GiB, 1.94 TiB. */
export function bytes(n, { plus = false } = {}) {
  if (n === null || n === undefined) return "—";
  const sign = plus && n > 0 ? "+" : "";
  if (Math.abs(n) < 1024) return `${sign}${n} ${t("B")}`;
  const units = [t("KiB"), t("MiB"), t("GiB"), t("TiB"), t("PiB")];
  let v = Math.abs(n) / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  const s = v >= 100 ? Math.round(v).toString() : v >= 10 ? v.toFixed(1) : v.toFixed(2);
  const trimmed = s.includes(".") ? s.replace(/0+$/, "").replace(/\.$/, "") : s;
  return `${sign}${n < 0 ? "-" : ""}${lang === "uk" ? trimmed.replace(".", ",") : trimmed} ${units[i]}`;
}

/** Relative time: "14 min ago", "in 18 h", "3 d ago". */
export function rel(iso, now = Date.now()) {
  if (!iso) return "—";
  const d = (Date.parse(iso) - now) / 1000;
  const a = Math.abs(d);
  let s;
  if (a < 45) return d < 0 ? t("just now") : t("in a moment");
  if (a < 3600) s = t("{n} min", { n: Math.round(a / 60) });
  else if (a < 86400) s = t("{n} h", { n: Math.round(a / 3600) });
  else if (a < 86400 * 60) s = t("{n} d", { n: Math.round(a / 86400) });
  else return new Date(iso).toLocaleDateString(locale, { day: "numeric", month: "short", year: "numeric" });
  return d < 0 ? t("{time} ago", { time: s }) : t("in {time}", { time: s });
}

/** Exact local time for a title attribute. */
export const exact = (iso) => (iso ? new Date(iso).toLocaleString(locale) : "");

/** Relative time in a <time> with the exact time on hover. */
export const when = (iso) => h`<time datetime="${iso ?? ""}" title="${exact(iso)}">${rel(iso)}</time>`;

/** 6m 41s, 1h 08m, 38s. */
export function duration(sec) {
  if (sec === null || sec === undefined || Number.isNaN(sec)) return "—";
  sec = Math.max(0, Math.round(sec));
  if (sec < 60) return t("{s}s", { s: sec });
  if (sec < 3600) return t("{m}m {s}s", { m: Math.floor(sec / 60), s: String(sec % 60).padStart(2, "0") });
  return t("{h}h {m}m", { h: Math.floor(sec / 3600), m: String(Math.floor((sec % 3600) / 60)).padStart(2, "0") });
}

export function runDuration(run, now = Date.now()) {
  if (!run.started || run.status === "queued") return null;
  return ((run.finished ? Date.parse(run.finished) : now) - Date.parse(run.started)) / 1000;
}

export const clock = (iso) => (iso ? new Date(iso).toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit", hour12: false }) : "");

/** "api:admin-laptop" → "api: admin-laptop". */
export const trigger = (t) => (t ? t.replace(/^(api|mcp):/, "$1: ") : "");

// ── status badges ──

const LABELS = { ok: t("OK"), warning: t("Warning"), error: t("Error"), running: t("Running"), queued: t("Queued"), interrupted: t("Interrupted"), never: t("Never run") };

export function badge(status) {
  const s = status in LABELS ? status : "never";
  const mark =
    s === "running" ? icon("loader-circle", "spin") : s === "queued" ? icon("clock") : raw('<span class="dot"></span>');
  return h`<span class="badge ${s}">${mark}${LABELS[s]}</span>`;
}

export const stripe = (statuses, n = 14) =>
  h`<span class="stripe" aria-label="${t("Last {n} runs", { n })}">${Array.from({ length: n }, (_, i) => {
    const s = statuses[statuses.length - n + i];
    return h`<i class="${s ?? ""}" title="${s ? LABELS[s] ?? s : t("no run")}"></i>`;
  })}</span>`;

/** A source path: ssh sources show the host and then the path. */
export function sourcePath(path) {
  const m = /^ssh:\/\/(?:([^@/]+)@)?([^/:]+)(?::\d+)?(\/.*)$/.exec(path ?? "");
  if (!m) return h`<span class="path" title="${path}">${path}</span>`;
  return h`<span class="path" title="${path}">${icon("server")}<b>${m[2]}</b>${m[3]}</span>`;
}

// ── API ──

export class ApiError extends Error {
  constructor(status, message, body) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

const listeners = { unauthorized: [], offline: [], online: [] };
export const onApi = (event, fn) => listeners[event].push(fn);
let offline = false;

function setOffline(v) {
  if (offline === v) return;
  offline = v;
  for (const fn of listeners[v ? "offline" : "online"]) fn();
}

export async function api(path, { method = "GET", body, signal } = {}) {
  let res;
  try {
    res = await fetch(path, {
      method,
      signal,
      credentials: "same-origin",
      headers: { "X-Arca-Request": "1", ...(body !== undefined ? { "Content-Type": "application/json" } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch (e) {
    if (e.name === "AbortError") throw e;
    setOffline(true);
    throw new ApiError(0, t("Lost connection to the server"));
  }
  setOffline(false);
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && path !== "/api/session") for (const fn of listeners.unauthorized) fn(data.reason);
  if (!res.ok) throw new ApiError(res.status, data.error ?? `HTTP ${res.status}`, data);
  return data;
}

export const isOffline = () => offline;

// ── toasts ──

function toastsEl() {
  let el = document.querySelector(".toasts");
  if (!el) {
    el = document.createElement("div");
    el.className = "toasts";
    el.setAttribute("role", "status");
    document.body.append(el);
  }
  return el;
}

export function toast(message, kind = "info") {
  const el = document.createElement("div");
  el.className = `toast ${kind}`;
  el.innerHTML = h`${icon(kind === "ok" ? "check" : kind === "error" ? "triangle-alert" : "info")}<div class="grow">${message}</div>
    <button class="btn ghost icon sm" aria-label="${t("Dismiss")}">${icon("x")}</button>`.s;
  const box = toastsEl();
  while (box.children.length >= 3) box.firstElementChild.remove();
  box.append(el);
  const close = () => {
    el.classList.add("out");
    setTimeout(() => el.remove(), 150);
  };
  el.querySelector("button").onclick = close;
  // Errors stay until dismissed; others go after 6 s unless hovered.
  if (kind !== "error") {
    let t = setTimeout(close, 6000);
    el.onmouseenter = () => clearTimeout(t);
    el.onmouseleave = () => (t = setTimeout(close, 6000));
  }
}

export const toastError = (e) => toast(e?.message ?? String(e), "error");

// ── modal ──

/**
 * Show a modal. `body` is h`` content; `actions` — [{label, kind, value}] from left to right.
 * Resolves with the value of the pressed action, or null on Cancel/Escape.
 */
export function modal({ title, body, actions = [{ label: t("OK"), kind: "primary", value: true }], onMount }) {
  return new Promise((resolve) => {
    const scrim = document.createElement("div");
    scrim.className = "scrim";
    const plainTitle = String(title).replace(/<[^>]*>/g, "");
    scrim.innerHTML = h`<div class="modal" role="dialog" aria-modal="true" aria-label="${plainTitle}">
      <div class="m-head">${title}</div>
      <div class="m-body">${body}</div>
      <div class="m-foot">
        <button class="btn secondary" data-v="__cancel">${t("Cancel")}</button>
        ${actions.map((a, i) => h`<button class="btn ${a.kind ?? "primary"}" data-i="${i}">${a.icon ? icon(a.icon) : ""}${a.label}</button>`)}
      </div></div>`.s;
    const done = (v) => {
      document.removeEventListener("keydown", onKey);
      scrim.remove();
      resolve(v);
    };
    const onKey = (e) => e.key === "Escape" && done(null);
    document.addEventListener("keydown", onKey);
    scrim.addEventListener("click", (e) => {
      if (e.target === scrim) return done(null);
      const b = e.target.closest("button[data-i],button[data-v]");
      if (!b) return;
      done(b.dataset.v === "__cancel" ? null : actions[Number(b.dataset.i)].value);
    });
    document.body.append(scrim);
    onMount?.(scrim.querySelector(".modal"));
    (scrim.querySelector(".m-foot .btn:last-child") ?? scrim).focus();
  });
}

// ── menu ──

/** A popup menu under `anchor`: items [{label, icon, danger, onClick}] or "-" for a divider. */
export function menu(anchor, items) {
  document.querySelector(".menu")?.remove();
  const el = document.createElement("div");
  el.className = "menu";
  el.setAttribute("role", "menu");
  el.innerHTML = items
    .map((it, i) => (it === "-" ? "<hr>" : h`<button role="menuitem" data-i="${i}" class="${it.danger ? "danger" : ""}">${it.icon ? icon(it.icon) : ""}${it.label}</button>`.s))
    .join("");
  document.body.append(el);
  const r = anchor.getBoundingClientRect();
  const w = el.offsetWidth;
  el.style.top = `${Math.min(r.bottom + 4, innerHeight - el.offsetHeight - 8)}px`;
  el.style.left = `${Math.max(8, Math.min(r.right - w, innerWidth - w - 8))}px`;
  const close = () => {
    el.remove();
    document.removeEventListener("mousedown", outside, true);
  };
  const outside = (e) => !el.contains(e.target) && close();
  setTimeout(() => document.addEventListener("mousedown", outside, true));
  el.addEventListener("click", (e) => {
    const b = e.target.closest("button[data-i]");
    if (!b) return;
    close();
    items[Number(b.dataset.i)].onClick?.();
  });
}

// ── misc ──

export function copyText(text) {
  return navigator.clipboard
    .writeText(text)
    .then(() => toast(t("Copied"), "ok"))
    .catch(() => toast(t("Could not copy: the browser blocked the clipboard"), "error"));
}

export const can = (session, scope) => session.scopes.includes("admin") || session.scopes.includes(scope);

export const adminTag = () => h`<span class="admin-tag">${icon("shield")}admin</span>`;

// ── schedules and file modes ──

const WEEKLY = [
  (time) => t("Every Sunday at {time}", { time }),
  (time) => t("Every Monday at {time}", { time }),
  (time) => t("Every Tuesday at {time}", { time }),
  (time) => t("Every Wednesday at {time}", { time }),
  (time) => t("Every Thursday at {time}", { time }),
  (time) => t("Every Friday at {time}", { time }),
  (time) => t("Every Saturday at {time}", { time }),
];
const pad2 = (n) => String(n).padStart(2, "0");

/** Cron in words for the common shapes; anything else is shown as is. */
export function cronText(expr) {
  if (!expr) return t("Manual only");
  const alias = { "@hourly": "0 * * * *", "@daily": "0 0 * * *", "@midnight": "0 0 * * *", "@weekly": "0 0 * * 0", "@monthly": "0 0 1 * *", "@yearly": "0 0 1 1 *", "@annually": "0 0 1 1 *" }[expr.trim()];
  const [mi, ho, dom, mon, dow] = (alias ?? expr).trim().split(/\s+/);
  const isNum = (x) => /^\d+$/.test(x ?? "");
  if (dom === "*" && mon === "*" && dow === "*") {
    if (isNum(mi) && isNum(ho)) return t("Every day at {time}", { time: `${pad2(ho)}:${pad2(mi)}` });
    if (isNum(mi) && ho === "*") return mi === "0" ? t("Every hour") : t("Every hour at :{m}", { m: pad2(mi) });
    if (isNum(mi) && /^\*\/\d+$/.test(ho)) return tn("Every hour", "Every {n} hours", Number(ho.slice(2)));
    if (/^\*\/\d+$/.test(mi) && ho === "*") return tn("Every minute", "Every {n} minutes", Number(mi.slice(2)));
  }
  if (isNum(mi) && isNum(ho) && dom === "*" && mon === "*" && /^[0-7]$/.test(dow)) return WEEKLY[Number(dow) % 7](`${pad2(ho)}:${pad2(mi)}`);
  if (isNum(mi) && isNum(ho) && isNum(dom) && mon === "*" && dow === "*") return t("Monthly on day {day} at {time}", { day: dom, time: `${pad2(ho)}:${pad2(mi)}` });
  return expr;
}

/** 0o755 and a type → "drwxr-xr-x". */
export function modeString(mode, type) {
  const t = type === "dir" ? "d" : type === "symlink" ? "l" : "-";
  let s = "";
  for (const shift of [6, 3, 0]) {
    const b = (mode >> shift) & 7;
    s += (b & 4 ? "r" : "-") + (b & 2 ? "w" : "-") + (b & 1 ? "x" : "-");
  }
  return t + s;
}

/** "2026-10-29 18:47" in local time. */
export function stamp(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/** A labelled select that looks like the filter buttons of the design. */
export const select = (id, label, options, value) =>
  h`<label class="sel"><span class="muted">${label}</span><select id="${id}">${options.map(([v, l]) => h`<option value="${v}" ${v === value ? raw("selected") : ""}>${l}</option>`)}</select>${icon("chevron-down")}</label>`;

/** The language picker; the page reloads in the chosen language. Wire it up with bindLang(). */
export const langSelect = (id = "lang", label = t("Language")) => select(id, label, LANGS, lang);
export function bindLang(root, id = "lang") {
  const s = root.querySelector(`#${id}`);
  if (s) s.onchange = () => setLang(s.value);
}

export function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
