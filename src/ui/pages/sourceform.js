// New / edit source: a five-step wizard (Where → What → When → Keep → Review).
import { adminTag, api, bytes, can, copyText, cronText, h, ht, icon, locale, modal, num, raw, stamp, t, tn, toast, toastError } from "../lib.js";

const STEPS = [t("Where"), t("What"), t("When"), t("Keep"), t("Review")];
const SUBTITLE = [t("Where the folder lives"), t("What to back up"), t("When to back up"), t("What to keep"), t("Check and create")];
const PRESETS = {
  caches: { label: t("Caches"), icon: "database", patterns: [".cache/", "cache/"] },
  logs: { label: t("Logs"), icon: "file", patterns: ["*.log", "logs/"] },
  node: { label: t("Node modules"), icon: "folder", patterns: ["node_modules/"] },
  temp: { label: t("Temp files"), icon: "clock", patterns: ["*.tmp", "tmp/"] },
};
const RETENTION_PRESETS = {
  default: { last: 5, hourly: 24, daily: 7, weekly: 4, monthly: 12, yearly: 2 },
  everything: {},
  minimal: { last: 3, daily: 7 },
};
const RET_KEYS = [
  ["last", t("Keep last"), t("The most recent snapshots, of any age")],
  ["hourly", t("Hourly"), t("Newest per hour")],
  ["daily", t("Daily"), t("Newest per day")],
  ["weekly", t("Weekly"), t("Newest per week")],
  ["monthly", t("Monthly"), t("Newest per month")],
  ["yearly", t("Yearly"), t("Newest per year")],
];
const DAYS = [t("Sunday"), t("Monday"), t("Tuesday"), t("Wednesday"), t("Thursday"), t("Friday"), t("Saturday")];
/** Short retention rules for the review step: "5 last, 24 hourly". */
const RET_SHORT = {
  last: (n) => t("{n} last", { n }),
  hourly: (n) => t("{n} hourly", { n }),
  daily: (n) => t("{n} daily", { n }),
  weekly: (n) => t("{n} weekly", { n }),
  monthly: (n) => t("{n} monthly", { n }),
  yearly: (n) => t("{n} yearly", { n }),
};

export async function page(el, params, { session, navigate }) {
  const editing = params.name ? decodeURIComponent(params.name) : null;
  if (!can(session, "admin")) {
    el.innerHTML = h`<div class="page-head"><div><h1>${editing ? t("Edit source") : t("New source")}</h1></div></div>
      <div class="card pad"><div class="notice info">${icon("shield")}<div>${ht("Adding and changing sources needs a token with the admin scope. You are signed in as {name}.", { name: h`<b>${session.name}</b>` })} ${adminTag()}</div></div></div>`.s;
    return;
  }
  const overview = await api("/api/overview");
  const repos = overview.repos.map((r) => r.name);
  const st = {
    step: 0,
    type: "local",
    name: "",
    nameTouched: false,
    path: "",
    host: "",
    user: "arca-src",
    port: "22",
    rpath: "",
    forced: true,
    repo: repos[0] ?? "",
    exclude: [],
    schedMode: "daily",
    time: "03:30",
    day: "0",
    cron: "30 3 * * *",
    retPreset: "default",
    retention: { ...RETENTION_PRESETS.default },
    preview: null,
    previewFor: "",
    testing: false,
  };
  let key = null;

  if (editing) {
    const d = await api(`/api/sources/${encodeURIComponent(editing)}`);
    Object.assign(st, { name: d.name, nameTouched: true, repo: d.repo, exclude: [...d.exclude], retention: d.retention ?? {}, retPreset: d.retention ? "custom" : "everything", step: 4 });
    const m = /^ssh:\/\/(?:([^@/]+)@)?([^/:]+)(?::(\d+))?(\/.*)$/.exec(d.path);
    if (m) Object.assign(st, { type: "ssh", user: m[1] ?? "", host: m[2], port: m[3] ?? "22", rpath: m[4], forced: !!d.ssh?.forced });
    else st.path = d.path;
    setSchedule(d.schedule);
  }
  if (!repos.length) {
    el.innerHTML = h`<div class="crumbs"><a href="#/sources">${t("Sources")}</a>${icon("chevron-right")}<span class="cur">${t("New source")}</span></div>
      <div class="page-head"><div><h1>${t("New source")}</h1></div></div>
      <div class="card pad"><div class="notice info">${icon("info")}<div>${ht("A source needs a repository to back up into. {a}Create a repository{aEnd} first.", { a: raw('<a href="#/repositories?new=1">'), aEnd: raw("</a>") })}</div></div></div>`.s;
    return;
  }

  function setSchedule(expr) {
    st.cron = expr ?? "";
    const [mi, ho, dom, mon, dow] = (expr ?? "").split(/\s+/);
    if (!expr) st.schedMode = "manual";
    else if (expr === "0 * * * *") st.schedMode = "hourly";
    else if (expr === "0 */6 * * *") st.schedMode = "6h";
    else if (/^\d+$/.test(mi) && /^\d+$/.test(ho) && dom === "*" && mon === "*" && dow === "*") Object.assign(st, { schedMode: "daily", time: `${ho.padStart(2, "0")}:${mi.padStart(2, "0")}` });
    else if (/^\d+$/.test(mi) && /^\d+$/.test(ho) && dom === "*" && mon === "*" && /^[0-6]$/.test(dow)) Object.assign(st, { schedMode: "weekly", time: `${ho.padStart(2, "0")}:${mi.padStart(2, "0")}`, day: dow });
    else st.schedMode = "custom";
  }

  function schedule() {
    const [hh, mm] = st.time.split(":").map(Number);
    switch (st.schedMode) {
      case "manual": return "";
      case "hourly": return "0 * * * *";
      case "6h": return "0 */6 * * *";
      case "daily": return `${mm} ${hh} * * *`;
      case "weekly": return `${mm} ${hh} * * ${st.day}`;
      default: return st.cron.trim();
    }
  }

  const sourcePath = () => (st.type === "local" ? st.path.trim() : `ssh://${st.user ? `${st.user}@` : ""}${st.host.trim()}${st.port && st.port !== "22" ? `:${st.port}` : ""}${st.rpath.trim()}`);
  const rootPath = () => (st.type === "local" ? st.path.trim() : st.rpath.trim());
  const where = () => (st.type === "local" ? st.path.trim() : st.host.trim() && st.rpath.trim().startsWith("/"));
  const sshBody = () => (st.type === "ssh" ? { forced: st.forced, identity: key?.identity, sshOptions: ["StrictHostKeyChecking=accept-new"] } : undefined);

  function autoName() {
    if (st.nameTouched) return;
    const seg = rootPath().replace(/\/+$/, "").split("/").pop() ?? "";
    st.name = seg.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 63);
  }

  // ── rendering ──

  function draw() {
    el.innerHTML = h`
      <div class="crumbs"><a href="#/sources">${t("Sources")}</a>${icon("chevron-right")}${editing ? h`<a href="#/sources/${encodeURIComponent(editing)}">${editing}</a>${icon("chevron-right")}<span class="cur">${t("Edit")}</span>` : h`<span class="cur">${t("New source")}</span>`}</div>
      <div class="page-head"><div><h1>${editing ? t("Edit {name}", { name: editing }) : t("New source")}</h1><div class="sub">${t("Step {n} of {total}", { n: st.step + 1, total: 5 })} · ${SUBTITLE[st.step]}</div></div>
        <div class="actions">${editing ? h`<button class="btn ghost" id="remove" style="color:var(--danger)">${icon("x")}${t("Remove source")}</button>` : ""}<a class="btn ghost" href="#/sources${editing ? `/${encodeURIComponent(editing)}` : ""}">${icon("x")}${t("Cancel")}</a></div></div>
      <div class="stepper">${STEPS.map((s, i) => h`<button type="button" class="stp ${i < st.step ? "done" : i === st.step ? "cur" : ""}" data-go="${i}" ${i > st.step && !canGo(i) ? "disabled" : ""}><span class="c">${i < st.step ? icon("check") : i + 1}</span><span>${s}</span></button>${i < 4 ? raw(`<span class="stp-line ${i < st.step ? "done" : ""}"></span>`) : ""}`)}</div>
      <div id="body">${[stepWhere, stepWhat, stepWhen, stepKeep, stepReview][st.step]()}</div>
      <div class="wiz-foot"><div class="grow">${footSummary()}</div>
        ${st.step > 0 ? h`<button class="btn secondary" id="back">${icon("chevron-left")}${t("Back")}</button>` : ""}
        ${st.step < 4 ? h`<button class="btn primary" id="next" ${canGo(st.step + 1) ? "" : "disabled"}>${t("Next")}${icon("arrow-right")}</button>` : h`<button class="btn primary" id="save">${icon(editing ? "check" : "plus")}${editing ? t("Save changes") : t("Create source")}</button>`}</div>`.s;
    bind();
  }

  function canGo(i) {
    if (i >= 1 && !(st.name && where() && st.repo)) return false;
    if (i >= 3 && st.schedMode === "custom" && !st.cron.trim()) return false;
    return true;
  }

  function footSummary() {
    if (st.step === 0) return where() ? h`<span class="mono small">${sourcePath()}</span>` : h`<span class="muted">${t("Choose where the folder lives")}</span>`;
    if (st.step === 1) {
      const p = st.preview;
      if (!p?.ok) return h`<span class="muted">${tn("{n} exclude pattern", "{n} exclude patterns", st.exclude.length)}</span>`;
      const ex = excludedSize();
      return h`${ht("{size} in {files}", { size: h`<span class="mono">~${bytes(p.size - ex)}</span>`, files: tn("{n} file", "{n} files", p.files) })}${ex ? h` · <span class="muted">${t("{size} excluded", { size: bytes(ex) })}</span>` : ""}`;
    }
    if (st.step === 2) return h`${t("{schedule} to {repo}", { schedule: cronText(schedule()), repo: st.repo })}`;
    if (st.step === 3) return h`${t("{rules} · this source only", { rules: Object.keys(st.retention).length ? t("Retention") : t("Keep everything") })}`;
    return h`<span class="muted">${t("Nothing is saved until you press the button.")}</span>`;
  }

  function stepWhere() {
    const card = (ty, ic, title, sub) => h`<button type="button" class="card choice ${st.type === ty ? "on" : ""}" data-type="${ty}"><span class="choice-ic">${icon(ic)}</span><span style="flex:1;text-align:left"><b>${title}</b><span class="muted">${sub}</span></span><span class="radio"></span></button>`;
    const line = key ? `restrict,from="${key.serverAddresses.join(",")}",command="/usr/local/bin/arca-src ${st.rpath || "/path"}" ${key.publicKey}` : "";
    return h`
      <div class="grid" style="grid-template-columns:1fr 1fr;margin-bottom:20px">
        ${card("local", "server", t("This server"), t("A folder on {host}, the machine Arca runs on.", { host: overview.server.host }))}
        ${card("ssh", "folder-sync", t("Another machine over SSH"), t("A folder on a different machine, read over SSH."))}
      </div>
      <div class="grid" style="grid-template-columns:${st.type === "ssh" ? "minmax(0,1fr) minmax(0,1.3fr)" : "1fr"}">
        <div class="card pad stack">
          <h3 style="margin:0">${t("Connection")}</h3>
          ${st.type === "local"
            ? h`<div class="field"><label for="f-path">${t("Path")}</label><input class="input big mono" id="f-path" value="${st.path}" placeholder="/srv/data" spellcheck="false" /></div>`
            : h`<div class="field"><label for="f-host">${t("Host")}</label><input class="input big mono" id="f-host" value="${st.host}" placeholder="git.example.lan" spellcheck="false" /></div>
              <div style="display:grid;grid-template-columns:1fr 110px;gap:12px"><div class="field"><label for="f-user">${t("User")}</label><input class="input big mono" id="f-user" value="${st.user}" spellcheck="false" /></div>
                <div class="field"><label for="f-port">${t("Port")}</label><input class="input big mono" id="f-port" value="${st.port}" inputmode="numeric" /></div></div>
              <div class="field"><label for="f-rpath">${t("Path")}</label><input class="input big mono" id="f-rpath" value="${st.rpath}" placeholder="/var/lib/gitea" spellcheck="false" /><span class="hint mono">${where() ? sourcePath() : ""}</span></div>`}
          <div class="field"><label for="f-name">${t("Name")}</label><input class="input big" id="f-name" value="${st.name}" ${editing ? raw("disabled") : ""} placeholder="my-folder" /><span class="hint">${editing ? t("The name of a source cannot change.") : t("Filled from the path; you can change it")}</span></div>
          <div class="field"><label for="f-repo">${t("Repository")}</label><select class="input big" id="f-repo">${repos.map((r) => h`<option value="${r}" ${r === st.repo ? raw("selected") : ""}>${r}</option>`)}</select><span class="hint">${t("Where the encrypted snapshots go.")} <a href="#/repositories?new=1">${t("Add a repository")}</a></span></div>
          ${st.type === "local" ? h`<div style="display:flex;gap:10px;align-items:center">${testButton()}</div>` : ""}
        </div>
        ${st.type === "ssh" ? h`<div class="card pad stack">
          <h3 style="margin:0">${st.host ? t("Allow Arca on {host}", { host: st.host }) : t("Allow Arca on the machine")}</h3>
          <p class="muted" style="margin:0">${ht("Add this line to {file} on the machine. It only lets Arca read the folders you choose.", { file: h`<span class="mono">~${st.user || "user"}/.ssh/authorized_keys</span>` })}</p>
          <label class="check"><input type="checkbox" id="f-forced" ${st.forced ? raw("checked") : ""} /> ${t("Use the read-only forced command (recommended)")}</label>
          ${st.forced
            ? h`<div class="code" style="padding-right:90px">${key ? line : t("Loading the server key…")}${key ? h`<button class="btn secondary sm copy" id="copy-line">${icon("copy")}${t("Copy")}</button>` : ""}</div>
              <p class="muted small" style="margin:0">${ht("On the machine, install the script from the release archive first: {cmd}.", { cmd: h`<span class="mono">install -m 755 arca-src.sh /usr/local/bin/arca-src</span>` })} <a href="https://github.com/sanyadez/Arca/blob/main/docs/ssh-sources.md" target="_blank" rel="noopener">${t("Step-by-step guide")}</a></p>`
            : h`<div class="code" style="padding-right:90px">${key ? key.publicKey : "…"}${key ? h`<button class="btn secondary sm copy" id="copy-line">${icon("copy")}${t("Copy")}</button>` : ""}</div>
              <div class="notice warn">${icon("triangle-alert")}<div>${st.user ? t("Without the forced command, this key can run anything on the machine as {user}.", { user: st.user }) : t("Without the forced command, this key can run anything on the machine as that user.")}</div></div>`}
          <div style="border-top:1px solid var(--border);padding-top:14px;display:flex;gap:10px;align-items:center;flex-wrap:wrap">${testButton()}</div>
        </div>` : ""}
      </div>`;
  }

  function testButton() {
    const p = st.preview && st.previewFor === sourcePath() ? st.preview : null;
    return h`<button type="button" class="btn secondary" id="test" ${where() ? "" : "disabled"}>${icon("refresh-cw", st.testing ? "spin" : "")}${t("Test connection")}</button>
      ${st.testing ? h`<span class="muted small">${t("Reading the folder…")}</span>` : p ? (p.ok ? h`<span class="badge ok"><span class="dot"></span>${t("Connected · {files}, {size} · {seconds}s", { files: tn("{n} file", "{n} files", p.files), size: bytes(p.size), seconds: p.seconds })}</span>` : h`<span class="badge error" title="${p.error}"><span class="dot"></span>${p.error.slice(0, 120)}</span>`) : ""}`;
  }

  async function runTest() {
    st.testing = true;
    draw();
    try {
      st.preview = await api("/api/sources/preview", { method: "POST", body: { path: sourcePath(), ssh: sshBody() } });
    } catch (e) {
      st.preview = { ok: false, error: e.message };
    }
    st.previewFor = sourcePath();
    st.testing = false;
    draw();
  }

  function excludedSize() {
    const p = st.preview;
    if (!p?.ok) return 0;
    return p.dirs.filter((d) => isDirExcluded(d.path) && !isDirExcluded(parentOf(d.path))).reduce((a, d) => a + d.size, 0);
  }
  const parentOf = (p) => (p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "");
  const dirPattern = (p) => `/${p}/`;
  const isDirExcluded = (p) => !!p && (st.exclude.includes(dirPattern(p)) || st.exclude.includes(`${p.split("/").pop()}/`) || isDirExcluded(parentOf(p)));

  function stepWhat() {
    const p = st.preview && st.previewFor === sourcePath() ? st.preview : null;
    const top = p?.ok ? p.dirs.filter((d) => !d.path.includes("/")) : [];
    return h`<div class="grid" style="grid-template-columns:minmax(0,1.6fr) minmax(0,1fr);align-items:start">
      <div class="card">
        <div class="card-head" style="font-weight:400"><div><b style="font-weight:600;display:block">${t("Folders to back up")}</b><span class="path" style="max-width:100%">${sourcePath()}</span></div></div>
        ${!p ? h`<div class="empty-ok">${icon("info")}<span>${t("Read the folder to pick what to include.")} <button class="btn secondary sm" id="test">${icon("refresh-cw")}${t("Read folder")}</button></span></div>`
          : !p.ok ? h`<div class="notice danger" style="margin:16px 24px">${icon("triangle-alert")}<div>${p.error}</div></div>`
          : h`<div class="table-wrap"><table class="t"><thead><tr><th>${t("Folder")}</th><th>${t("State")}</th><th class="right">${t("Files")}</th><th class="right">${t("Size")}</th></tr></thead>
            <tbody>${top.map((d) => dirRow(d, p, 0))}</tbody></table></div>
            <div class="list-row" style="border-top:1px solid var(--border)">${icon("info")}<span class="muted small">${t("Unchecking a folder adds it to Excludes. Files directly in the root are always included.")}</span></div>`}
      </div>
      <div class="card pad stack">
        <div style="display:flex;justify-content:space-between"><h3 style="margin:0">${t("Excludes")}</h3><span class="mono small muted">${tn("{n} pattern", "{n} patterns", st.exclude.length)}</span></div>
        <div class="chips-row">${st.exclude.map((x) => h`<span class="tag">${x}<button type="button" class="x" data-unex="${x}" aria-label="${t("Remove {pattern}", { pattern: x })}">${icon("x")}</button></span>`)}</div>
        <div style="display:flex;gap:8px"><input class="input mono" id="f-pattern" placeholder="${t("cache/ or *.tmp")}" /><button class="btn secondary" id="add-pattern">${icon("plus")}${t("Add pattern")}</button></div>
        <p class="muted small" style="margin:0">${ht("Patterns are relative to the source folder. {dir} matches folders anywhere, {path} only that one, {star} matches any name.", { dir: h`<span class="mono">name/</span>`, path: h`<span class="mono">/path/</span>`, star: h`<span class="mono">*</span>` })}</p>
        <div style="border-top:1px solid var(--border);padding-top:14px"><b>${t("Presets")}</b><div class="muted small">${t("Add the usual patterns for common clutter.")}</div>
          <div class="grid" style="grid-template-columns:1fr 1fr;gap:8px;margin-top:10px">${Object.entries(PRESETS).map(([k, v]) => {
            const on = v.patterns.every((x) => st.exclude.includes(x));
            return h`<button type="button" class="btn secondary preset ${on ? "on" : ""}" data-preset="${k}">${icon(on ? "check" : v.icon)}${v.label}</button>`;
          })}</div></div>
      </div></div>`;
  }

  function dirRow(d, p, depth) {
    const ex = isDirExcluded(d.path);
    const parentEx = isDirExcluded(parentOf(d.path));
    const kids = depth === 0 ? p.dirs.filter((x) => parentOf(x.path) === d.path) : [];
    const someKidEx = kids.some((k) => st.exclude.includes(dirPattern(k.path)));
    return h`<tr><td style="padding-left:${24 + depth * 24}px"><label class="check" style="font-family:var(--font-mono);font-size:var(--text-sm)">
        <input type="checkbox" data-dir="${d.path}" ${!ex ? raw("checked") : ""} ${parentEx ? raw("disabled") : ""} ${!ex && someKidEx ? raw('data-indet="1"') : ""} />${icon("folder")} ${d.path.split("/").pop()}</label></td>
      <td class="small">${ex ? h`<span class="muted">${t("Excluded")}</span> <span class="mono small muted">${st.exclude.includes(dirPattern(d.path)) ? dirPattern(d.path) : ""}</span>` : someKidEx ? t("Partly included") : t("Included")}</td>
      <td class="num">${num(d.files)}</td><td class="num">${bytes(d.size)}</td></tr>
      ${kids.map((k) => dirRow(k, p, 1))}`;
  }

  function stepWhen() {
    const modes = [["hourly", t("Every hour")], ["6h", t("Every 6 hours")], ["daily", t("Daily")], ["weekly", t("Weekly")], ["manual", t("Manual only")], ["custom", t("Custom (cron)")]];
    return h`<div class="grid" style="grid-template-columns:minmax(0,1fr) minmax(0,1fr);align-items:start">
      <div class="card pad stack"><h3 style="margin:0">${t("Schedule")}</h3>
        <div class="grid" style="grid-template-columns:1fr 1fr 1fr;gap:8px">${modes.map(([v, l]) => h`<button type="button" class="btn secondary preset ${st.schedMode === v ? "on" : ""}" data-sched="${v}">${st.schedMode === v ? icon("check") : ""}${l}</button>`)}</div>
        ${st.schedMode === "daily" || st.schedMode === "weekly" ? h`<div style="display:flex;gap:12px">${st.schedMode === "weekly" ? h`<div class="field" style="flex:1"><label for="f-day">${t("Day")}</label><select class="input" id="f-day">${DAYS.map((d, i) => h`<option value="${i}" ${String(i) === st.day ? raw("selected") : ""}>${d}</option>`)}</select></div>` : ""}
          <div class="field"><label for="f-time">${t("Time")}</label><input class="input mono" id="f-time" type="time" value="${st.time}" /></div></div>` : ""}
        ${st.schedMode === "custom" ? h`<div class="field"><label for="f-cron">${t("Cron expression")}</label><input class="input mono" id="f-cron" value="${st.cron}" placeholder="30 3 * * *" spellcheck="false" /><span class="hint">${t("minute hour day-of-month month day-of-week, in the server's local time")}</span></div>` : ""}
        <div class="notice info">${icon("info")}<div>${t("Times are the server's local time ({zone}). A backup that is still running when the next one is due is not started twice.", { zone: overview.server.timeZone ?? t("local") })}</div></div>
      </div>
      <div class="card pad"><h3>${t("Next runs")}</h3><div id="next-runs" class="stack" style="gap:0">${st.schedMode === "manual" ? h`<span class="muted">${t("Only when you press Back up now, or through the API and MCP.")}</span>` : h`<span class="muted">…</span>`}</div></div>
    </div>`;
  }

  async function loadNextRuns() {
    const box = el.querySelector("#next-runs");
    const expr = schedule();
    if (!box || !expr) return;
    const r = await api(`/api/cron?expr=${encodeURIComponent(expr)}`).catch((e) => ({ valid: false, error: e.message }));
    if (!el.contains(box)) return;
    box.innerHTML = r.valid
      ? h`<div class="muted small" style="margin-bottom:8px">${cronText(expr)} · <span class="mono">${expr}</span></div>${r.next.map((x) => h`<div class="list-row" style="padding:0"><span class="mono small grow">${stamp(Date.parse(x))}</span><span class="muted small">${new Date(x).toLocaleDateString(locale, { weekday: "long" })}</span></div>`)}`.s
      : h`<div class="err-text">${icon("triangle-alert")}<span>${r.error}</span></div>`.s;
  }

  function stepKeep() {
    const daily = st.schedMode === "daily" || st.schedMode === "weekly";
    return h`<div class="grid" style="grid-template-columns:minmax(0,1fr) minmax(0,1.2fr);align-items:start">
      <div class="card pad stack"><div><h3 style="margin:0">${t("Retention rules")}</h3><div class="muted small">${t("A snapshot stays if at least one rule keeps it.")}</div></div>
        <div class="seg wide" id="ret-preset">${[["default", t("Default")], ["everything", t("Keep everything")], ["minimal", t("Minimal")]].map(([v, l]) => h`<button type="button" data-rp="${v}" class="${st.retPreset === v ? "on" : ""}">${l}</button>`)}</div>
        ${RET_KEYS.map(([k, l, sub]) => h`<div style="display:flex;justify-content:space-between;align-items:center;gap:12px;border-top:1px solid var(--border);padding-top:12px">
          <div><div style="font-weight:500">${l}</div><div class="muted small">${sub}</div>${k === "hourly" && daily && st.retention.hourly ? h`<div class="small" style="color:var(--warn);margin-top:4px">${icon("triangle-alert")} ${st.schedMode === "weekly" ? tn("Rules count only periods that have a backup: with a weekly schedule this keeps the last {n} backup", "Rules count only periods that have a backup: with a weekly schedule this keeps the last {n} backups", st.retention.hourly) : tn("Rules count only periods that have a backup: with a daily schedule this keeps the last {n} backup", "Rules count only periods that have a backup: with a daily schedule this keeps the last {n} backups", st.retention.hourly)}</div>` : ""}</div>
          <div class="counter"><button type="button" class="btn secondary icon" data-dec="${k}" aria-label="${t("Less")}">−</button><span class="mono">${st.retention[k] ?? 0}</span><button type="button" class="btn secondary icon" data-inc="${k}" aria-label="${t("More")}">+</button></div></div>`)}
      </div>
      <div class="stack" style="gap:16px">
        <div class="card pad"><h3>${t("What stays after a year")}</h3><div id="ret-preview" class="muted">…</div></div>
        <div class="notice info">${icon("info")}<div>${t("Retention runs after each backup. Unused data is removed by the repository's prune.")}</div></div>
      </div></div>`;
  }

  async function loadRetention() {
    const box = el.querySelector("#ret-preview");
    if (!box) return;
    const expr = schedule();
    if (!Object.keys(st.retention).length) return (box.innerHTML = h`<span>${t("Every snapshot is kept until you forget it.")}</span>`.s);
    if (!expr) return (box.innerHTML = h`<span>${t("No schedule, so no forecast: retention applies to whatever backups you run.")}</span>`.s);
    const r = await api("/api/retention/preview", { method: "POST", body: { schedule: expr, retention: st.retention } }).catch(() => null);
    if (!r || !el.contains(box)) return;
    const labels = { last: t("Last"), hourly: t("Hourly"), daily: t("Daily"), weekly: t("Weekly"), monthly: t("Monthly"), yearly: t("Yearly"), within: t("Within") };
    box.innerHTML = h`<div style="color:var(--text);font-size:var(--text-lg)">${ht("About {kept} snapshots kept out of {runs} runs in a year", { kept: h`<b class="mono">${num(r.kept)}</b>`, runs: num(r.runs) })}</div>
      <div class="table-wrap" style="margin-top:12px"><table class="t"><thead><tr><th>${t("Rule")}</th><th class="right">${t("Snapshots it keeps")}</th></tr></thead>
      <tbody>${Object.entries(r.byRule).map(([k, n]) => h`<tr><td>${labels[k] ?? k}</td><td class="num">${num(n)}</td></tr>`)}</tbody></table></div>
      <p class="muted small" style="margin:10px 0 0">${t("Several rules can keep the same snapshot, so the total is smaller than the sum. Each rule counts only periods that have a backup. Forecast for {schedule}.", { schedule: cronText(expr).toLowerCase() })}</p>`.s;
  }

  function stepReview() {
    const ret = Object.entries(st.retention).filter(([, v]) => v).map(([k, v]) => (RET_SHORT[k] ? RET_SHORT[k](v) : `${v} ${k}`)).join(", ");
    const card = (title, step, rows) => h`<div class="card pad"><div style="display:flex;justify-content:space-between;align-items:center"><h3 style="margin:0">${title}</h3><button type="button" class="btn ghost sm" data-go="${step}">${icon("settings")}${t("Edit")}</button></div>
      <dl class="kv" style="margin-top:12px;grid-template-columns:140px 1fr">${rows.map(([k, v]) => h`<dt>${k}</dt><dd style="text-align:left">${v}</dd>`)}</dl></div>`;
    return h`<div class="grid" style="grid-template-columns:1fr 1fr">
      ${card(t("Where"), 0, [[t("Name"), h`<b>${st.name}</b>`], [t("Path"), h`<span class="mono small">${sourcePath()}</span>`], [t("Repository"), st.repo], ...(st.type === "ssh" ? [[t("Forced command"), st.forced ? t("On") : t("Off")]] : [])])}
      ${card(t("What"), 1, [[t("Excludes"), st.exclude.length ? h`<span class="chips-row">${st.exclude.map((x) => h`<span class="tag">${x}</span>`)}</span>` : t("Nothing excluded")]])}
      ${card(t("When"), 2, [[t("Runs"), cronText(schedule())], ...(schedule() ? [["Cron", h`<span class="mono">${schedule()}</span>`]] : [])])}
      ${card(t("Keep"), 3, [[t("Rules"), ret || t("Keep everything")]])}
    </div>`;
  }

  // ── events ──

  function bind() {
    const $ = (s) => el.querySelector(s);
    el.querySelectorAll("[data-go]").forEach((b) => (b.onclick = () => go(Number(b.dataset.go))));
    $("#back")?.addEventListener("click", () => go(st.step - 1));
    $("#next")?.addEventListener("click", () => go(st.step + 1));
    $("#save")?.addEventListener("click", saveSource);
    $("#remove")?.addEventListener("click", removeSource);
    el.querySelectorAll("[data-type]").forEach((b) => (b.onclick = () => {
      st.type = b.dataset.type;
      autoName();
      draw();
      if (st.type === "ssh") loadKey();
    }));
    const input = (id, fn) => $(id)?.addEventListener("input", (e) => {
      fn(e.target.value);
      autoName();
      const n = $("#f-name");
      if (n && !st.nameTouched) n.value = st.name;
      refreshChrome();
    });
    input("#f-path", (v) => (st.path = v));
    input("#f-host", (v) => (st.host = v));
    input("#f-user", (v) => (st.user = v));
    input("#f-port", (v) => (st.port = v));
    input("#f-rpath", (v) => (st.rpath = v));
    $("#f-name")?.addEventListener("input", (e) => {
      st.name = e.target.value.trim();
      st.nameTouched = true;
      refreshChrome();
    });
    $("#f-repo")?.addEventListener("change", (e) => (st.repo = e.target.value));
    $("#f-forced")?.addEventListener("change", (e) => {
      st.forced = e.target.checked;
      draw();
    });
    $("#copy-line")?.addEventListener("click", () => copyText(st.forced ? `restrict,from="${key.serverAddresses.join(",")}",command="/usr/local/bin/arca-src ${st.rpath}" ${key.publicKey}` : key.publicKey));
    $("#test")?.addEventListener("click", runTest);
    // What
    el.querySelectorAll("input[data-dir]").forEach((c) => {
      if (c.dataset.indet) c.indeterminate = true;
      c.onchange = () => {
        const pat = dirPattern(c.dataset.dir);
        st.exclude = c.checked ? st.exclude.filter((x) => x !== pat) : [...new Set([...st.exclude, pat])];
        draw();
      };
    });
    el.querySelectorAll("[data-unex]").forEach((b) => (b.onclick = () => ((st.exclude = st.exclude.filter((x) => x !== b.dataset.unex)), draw())));
    const addPattern = () => {
      const v = $("#f-pattern").value.trim();
      if (v && !st.exclude.includes(v)) st.exclude.push(v);
      draw();
    };
    $("#add-pattern")?.addEventListener("click", addPattern);
    $("#f-pattern")?.addEventListener("keydown", (e) => e.key === "Enter" && addPattern());
    el.querySelectorAll("[data-preset]").forEach((b) => (b.onclick = () => {
      const pats = PRESETS[b.dataset.preset].patterns;
      const on = pats.every((x) => st.exclude.includes(x));
      st.exclude = on ? st.exclude.filter((x) => !pats.includes(x)) : [...new Set([...st.exclude, ...pats])];
      draw();
    }));
    // When
    el.querySelectorAll("[data-sched]").forEach((b) => (b.onclick = () => {
      if (b.dataset.sched === "custom") st.cron = schedule() || st.cron;
      st.schedMode = b.dataset.sched;
      draw();
    }));
    $("#f-time")?.addEventListener("change", (e) => ((st.time = e.target.value || "03:30"), loadNextRuns(), refreshChrome()));
    $("#f-day")?.addEventListener("change", (e) => ((st.day = e.target.value), loadNextRuns(), refreshChrome()));
    $("#f-cron")?.addEventListener("input", (e) => {
      st.cron = e.target.value;
      clearTimeout(cronTimer);
      cronTimer = setTimeout(loadNextRuns, 300);
      refreshChrome();
    });
    // Keep
    el.querySelectorAll("[data-rp]").forEach((b) => (b.onclick = () => ((st.retPreset = b.dataset.rp), (st.retention = { ...RETENTION_PRESETS[b.dataset.rp] }), draw())));
    const bump = (k, d) => {
      const v = Math.max(0, (st.retention[k] ?? 0) + d);
      if (v) st.retention[k] = v;
      else delete st.retention[k];
      st.retPreset = "custom";
      draw();
    };
    el.querySelectorAll("[data-inc]").forEach((b) => (b.onclick = () => bump(b.dataset.inc, 1)));
    el.querySelectorAll("[data-dec]").forEach((b) => (b.onclick = () => bump(b.dataset.dec, -1)));
    if (st.step === 2) loadNextRuns();
    if (st.step === 3) loadRetention();
  }
  let cronTimer;

  /** Update the footer and the stepper without redrawing the form (keeps focus while typing). */
  function refreshChrome() {
    const foot = el.querySelector(".wiz-foot .grow");
    if (foot) foot.innerHTML = footSummary().s;
    const next = el.querySelector("#next");
    if (next) next.disabled = !canGo(st.step + 1);
    const test = el.querySelector("#test");
    if (test) test.disabled = !where();
  }

  async function go(i) {
    if (i < 0 || i > 4 || (i > st.step && !canGo(i))) return;
    st.step = i;
    draw();
    window.scrollTo(0, 0);
    if (i === 1 && !(st.preview && st.previewFor === sourcePath())) runTest();
  }

  async function loadKey() {
    if (key) return;
    try {
      key = await api("/api/ssh/key");
      if (st.step === 0) draw();
    } catch (e) {
      toastError(e);
    }
  }

  async function saveSource() {
    const body = {
      name: st.name,
      path: sourcePath(),
      repo: st.repo,
      schedule: schedule() || undefined,
      exclude: st.exclude,
      retention: st.retention,
      // a new SSH source uses the server's source key; an edited one keeps its own (the server keeps it)
      ssh: st.type === "ssh" ? { forced: st.forced, identity: editing ? undefined : key?.identity, sshOptions: ["StrictHostKeyChecking=accept-new"] } : undefined,
    };
    if (st.type === "ssh" && !editing && !key) await loadKey(), (body.ssh.identity = key?.identity);
    try {
      if (editing) await api(`/api/sources/${encodeURIComponent(editing)}`, { method: "PUT", body });
      else await api("/api/sources", { method: "POST", body });
      toast(editing ? t("Saved {name}", { name: st.name }) : t("Source {name} created", { name: st.name }), "ok");
      navigate(`sources/${encodeURIComponent(st.name)}`);
    } catch (e) {
      toastError(e);
    }
  }

  async function removeSource() {
    let mEl;
    const ok = await modal({
      title: t("Remove {name}?", { name: editing }),
      body: h`<p style="margin:0">${ht("Arca stops backing up this folder. {b}Its snapshots stay{bEnd} in {repo} until you forget them, and you can still browse and restore them.", { b: raw("<b>"), bEnd: raw("</b>"), repo: st.repo })}</p>
        <div class="field"><label for="confirm-name">${ht("Type {name} to confirm", { name: h`<b class="mono">${editing}</b>` })}</label><input class="input mono" id="confirm-name" autocomplete="off" /></div>`,
      actions: [{ label: t("Remove source"), kind: "danger", value: true }],
      onMount: (m) => {
        mEl = m;
        const btn = m.querySelector(".m-foot .btn.danger");
        btn.disabled = true;
        m.querySelector("#confirm-name").addEventListener("input", (e) => (btn.disabled = e.target.value.trim() !== editing));
      },
    });
    if (!ok) return;
    try {
      await api(`/api/sources/${encodeURIComponent(editing)}`, { method: "DELETE" });
      toast(t("{name} removed; its snapshots stay", { name: editing }), "ok");
      navigate("sources");
    } catch (e) {
      toastError(e);
    }
  }

  draw();
  if (st.type === "ssh") loadKey();
}
