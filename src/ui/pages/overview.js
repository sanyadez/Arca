// Overview: is everything protected, and what to do if not. First run shows a checklist instead.
import { api, badge, bytes, can, clock, h, ht, icon, locale, num, rel, sourcePath, stripe, t, tn, toast, toastError, when } from "../lib.js";

const KIND = { backup: t("Backup"), prune: t("Prune"), check: t("Check"), restore: t("Restore"), forget: t("Forget") };
const kindTag = (k) => (KIND[k] ?? k).toLowerCase();

const REFRESH_MS = 5000;

export async function page(el, _params, { session, navigate }) {
  let timer = null;
  let stopped = false;

  async function load() {
    try {
      const o = await api("/api/overview");
      if (stopped) return;
      draw(o);
    } catch (e) {
      if (e.status) toastError(e);
    } finally {
      if (!stopped) timer = setTimeout(load, REFRESH_MS);
    }
  }

  function draw(o) {
    if (o.repos.length === 0) return drawFirstRun(o);
    const m = o.metrics;
    const canBackup = can(session, "backup");
    el.innerHTML = h`
      <div class="page-head">
        <div><h1>${t("Overview")}</h1><div class="sub">${o.server.host} · Arca ${o.server.version.split(" ")[0]} · ${t("all times local")}</div></div>
        <div class="actions">
          <button class="btn secondary" id="check-all" ${canBackup ? "" : "disabled"}>${icon("shield-check")}${t("Check repositories")}</button>
          <button class="btn primary" id="backup-all" ${canBackup && o.sources.length ? "" : "disabled"}>${icon("play")}${t("Back up all now")}</button>
        </div>
      </div>
      ${phoneBanner(o.attention)}
      <div class="grid metrics">
        ${metric(t("Sources"), num(m.sources.total), [t("{n} OK", { n: m.sources.ok }), m.sources.running && t("{n} running", { n: m.sources.running }), m.sources.issues && tn("{n} issue", "{n} issues", m.sources.issues)])}
        ${metric(t("Protected data"), bytes(m.protected), [t("{size} stored", { size: bytes(m.stored) }), m.dedup && t("dedup {x}×", { x: m.dedup })])}
        ${metric(t("Last 24 h"), tn("{n} run", "{n} runs", m.runs24h.total), [t("{n} ok", { n: m.runs24h.ok }), m.runs24h.warning && t("{n} warning", { n: m.runs24h.warning }), m.runs24h.error && t("{n} error", { n: m.runs24h.error })])}
        ${metric(t("Next run"), m.next ? rel(m.next.at) : "—", [m.next ? m.next.name : t("no schedule")])}
      </div>

      <div class="two-col">
        <div>
          <h2 class="section">${t("Needs attention")}</h2>
          <div class="stack">${o.attention.length ? o.attention.map(attentionItem) : h`<div class="card empty-ok">${icon("check")}${t("Nothing needs attention: every source's last backup went fine.")}</div>`}</div>
        </div>
        <div>
          <h2 class="section">${t("Running now")}</h2>
          <div class="stack">${o.running.length ? o.running.map((r) => runningCard(r, o)) : h`<div class="card empty-ok">${icon("clock")}<span>${m.next ? ht("Nothing is running. Next: {name} {when}", { name: m.next.name, when: when(m.next.at) }) : t("Nothing is running")}</span></div>`}</div>
        </div>
      </div>

      <div class="section-row"><h2 class="section">${t("Sources")}</h2>
        <div class="legend hide-phone">${t("Oldest to newest")}
          ${[["ok", t("OK")], ["warning", t("Warning")], ["error", t("Error")], ["interrupted", t("Interrupted")], ["running", t("Running")]].map(([c, l]) => h`<span><i class="stripe-dot" style="background:var(--${c === "warning" ? "warn" : c === "error" ? "danger" : c === "running" ? "info" : c})"></i>${l}</span>`)}
        </div>
      </div>
      <div class="card hide-phone">${sourcesTable(o.sources)}</div>
      <div class="card show-phone">${phoneSources(o.sources)}</div>

      <div class="two-col">
        <div><h2 class="section">${t("Repositories")}</h2><div class="grid" style="grid-template-columns:repeat(auto-fill,minmax(280px,1fr))">${o.repos.map(repoCard)}</div></div>
        <div><div class="section-row"><h2 class="section">${t("Upcoming")}</h2><span class="muted small">${tn("Next {n} run", "Next {n} runs", o.upcoming.length)}</span></div>
          <div class="card">${o.upcoming.length ? o.upcoming.map(upcomingRow) : h`<div class="empty-ok">${t("No schedules yet.")}</div>`}</div></div>
      </div>`.s;

    el.querySelectorAll(".legend i").forEach((i) => Object.assign(i.style, { width: "8px", height: "8px", borderRadius: "2px", display: "inline-block" }));
    el.querySelector("#backup-all").onclick = () => runAll("backup", o.sources.map((s) => s.name));
    el.querySelector("#check-all").onclick = () => runAll("check", o.repos.map((r) => r.name));
    el.querySelectorAll("[data-retry]").forEach((b) => (b.onclick = () => runAll("backup", [b.dataset.retry])));
    el.querySelectorAll("[data-cancel]").forEach((b) => (b.onclick = () => cancel(b.dataset.cancel)));
    el.querySelectorAll("tr[data-href],[data-href].card").forEach((r) => (r.onclick = (e) => !e.target.closest("button,a") && navigate(r.dataset.href)));
  }

  function drawFirstRun(o) {
    el.innerHTML = h`
      <div class="page-head">
        <div><h1>${t("Welcome to Arca")}</h1><div class="sub">${t("Nothing is backed up yet. Three steps to set up backups you can restore.")}</div></div>
        <div class="actions"><span class="mono small muted">${o.server.host} · Arca ${o.server.version.split(" ")[0]}</span></div>
      </div>
      <div class="two-col">
        <div class="card checklist">
          <div class="card-head"><span>${t("Get started")}</span><span class="mono small muted" style="font-weight:400">${t("{done} of {total} done", { done: 0, total: 3 })}</span></div>
          ${step(1, "current", t("Create a repository"), t("Where encrypted backups live"), h`<a class="btn primary" href="#/repositories?new=1">${icon("plus")}${t("Create repository")}</a>`)}
          ${step(2, "", t("Add a source"), t("A folder here or on another machine"), h`<span class="muted small">${t("After step 1")}</span>`)}
          ${step(3, "", t("Keep the recovery kit"), ht("{cmd} and the password, away from this server", { cmd: h`<span class="mono">arca-restore</span>` }), h`<span class="muted small">${t("After step 1")}</span>`)}
        </div>
        <div class="card pad how">
          <b style="font-weight:600">${t("How Arca works")}</b>
          <div class="item">${icon("archive")}<div><b>${t("Encrypts before upload")}</b><span>${t("AES-256-GCM. Storage only ever holds ciphertext.")}</span></div></div>
          <div class="item">${icon("database")}<div><b>${t("Stores each chunk once")}</b><span>${t("Data repeated across snapshots takes no extra space.")}</span></div></div>
          <div class="item">${icon("life-buoy")}<div><b>${t("Restores without the server")}</b><span>${ht("via {cmd}", { cmd: h`<span class="mono">arca-restore</span>` })}</span></div></div>
        </div>
      </div>
      <p class="muted small" style="margin-top:20px">${ht("Prefer the command line? {init}, then {backup}.", { init: h`<span class="mono">arca init</span>`, backup: h`<span class="mono">arca backup</span>` })}</p>`.s;
  }

  async function runAll(kind, names) {
    let ok = 0;
    for (const n of names) {
      try {
        await api(kind === "backup" ? `/api/sources/${encodeURIComponent(n)}/backup` : `/api/repos/${encodeURIComponent(n)}/check`, { method: "POST", body: {} });
        ok++;
      } catch (e) {
        toastError(e);
      }
    }
    if (ok) {
      const msg = kind === "backup"
        ? ok === 1 ? t("Backup queued for {name}", { name: names[0] }) : tn("Backup queued for {n} source", "Backup queued for {n} sources", ok)
        : ok === 1 ? t("Check queued for {name}", { name: names[0] }) : tn("Check queued for {n} repository", "Check queued for {n} repositories", ok);
      toast(msg, "ok");
    }
    clearTimeout(timer);
    load();
  }

  async function cancel(id) {
    try {
      await api(`/api/runs/${id}/cancel`, { method: "POST" });
      toast(t("Run #{id} is being cancelled", { id }), "info");
    } catch (e) {
      toastError(e);
    }
  }

  el.innerHTML = h`<div class="page-head"><div><h1>${t("Overview")}</h1><div class="sub"><span class="sk" style="width:220px"></span></div></div></div>
    <div class="grid metrics">${[1, 2, 3, 4].map(() => h`<div class="card metric"><span class="sk" style="width:60px"></span><span class="sk big"></span><span class="sk" style="width:120px"></span></div>`)}</div>`.s;
  await load();
  return () => {
    stopped = true;
    clearTimeout(timer);
  };
}

const ORDER = { error: 0, warning: 1, running: 2, queued: 3, interrupted: 4, never: 5, ok: 6 };

function phoneBanner(attention) {
  const src = attention.filter((a) => a.kind === "source");
  if (!src.length) return "";
  const e = src.filter((a) => a.status === "error").length;
  const w = src.length - e;
  return h`<a class="problem-banner show-phone" href="#/sources/${encodeURIComponent(src[0].name)}" style="${e ? "" : "background:var(--warn-soft)"}">${icon("triangle-alert")}
    <div class="grow"><b>${[e && tn("{n} error", "{n} errors", e), w && tn("{n} warning", "{n} warnings", w)].filter(Boolean).join(" · ")}</b><div class="small ellipsis">${src.map((a) => a.name).join(" · ")}</div></div>${icon("chevron-right")}</a>`;
}

function phoneSources(sources) {
  if (!sources.length) return h`<div class="empty-ok">${t("No sources yet.")}</div>`;
  const label = { ok: t("OK"), warning: t("Warning"), error: t("Error"), running: t("Running"), queued: t("Queued"), interrupted: t("Interrupted"), never: t("Never run") };
  return [...sources].sort((a, b) => (ORDER[a.status] ?? 9) - (ORDER[b.status] ?? 9)).map((s) => {
    const pr = s.status === "running" ? progressOf(s.progress) : null;
    return h`<a class="m-row" href="#/sources/${encodeURIComponent(s.name)}"><span class="dot ${s.status}"></span><span class="grow">${s.name}</span>
      <span class="small">${label[s.status] ?? s.status}</span><span class="mono small muted" style="width:76px;text-align:right">${pr ? (pr.pct === null ? "…" : `${pr.pct}%`) : s.lastBackup ? rel(s.lastBackup) : t("never")}</span>${icon("chevron-right")}</a>`;
  });
}

function metric(label, value, notes) {
  return h`<div class="card metric"><div class="label">${label}</div><div class="value">${value}</div><div class="note">${notes.filter(Boolean).join(" · ")}</div></div>`;
}

function attentionItem(a) {
  const isRepo = a.kind === "repo";
  const title = isRepo ? t("Check failed") : a.status === "error" ? t("Last backup failed") : t("Last backup finished with warnings");
  return h`<div class="card alert-item ${a.status}">
    <div class="body">
      <div class="title">${a.name} ${badge(a.status)}</div>
      <div class="detail">${title}${a.at ? h` · ${when(a.at)}` : ""}</div>
      ${a.summary ? h`<div class="err" title="${a.summary}">${a.summary}</div>` : ""}
    </div>
    <div class="acts">
      ${!isRepo && a.status === "error" ? h`<button class="btn secondary" data-retry="${a.name}">${icon("rotate-cw")}${t("Retry")}</button>` : ""}
      ${a.runId ? h`<a class="btn ${a.status === "error" && !isRepo ? "ghost" : "secondary"}" href="#/runs/${a.runId}">${icon(a.status === "warning" ? "folder-search" : "arrow-right")}${a.status === "warning" ? t("View files") : t("Open")}</a>` : ""}
    </div>
  </div>`;
}

export function progressOf(p) {
  if (!p) return { pct: null, line: "" };
  if (p.stage === "scan") return { pct: null, line: t("Scanning… {n} files so far", { n: num(p.filesTotal) }) };
  if (p.stage === "write" || p.stage === "done") return { pct: 100, line: t("Writing the snapshot") };
  const pct = p.bytesToRead ? Math.min(100, Math.floor((p.bytesRead / p.bytesToRead) * 100)) : 100;
  return { pct, line: t("{done} of {total}", { done: bytes(p.bytesRead), total: bytes(p.bytesToRead) }), files: t("{done} of {total} files", { done: num(p.filesRead), total: num(p.toRead) }) };
}

function runningCard(r, o) {
  const src = r.source && o.sources.find((s) => s.name === r.source);
  const pr = progressOf(r.progress);
  return h`<div class="card running-card" data-href="runs/${r.id}" style="cursor:pointer">
    <div class="row"><b>${r.source ?? r.repo}</b>${badge(r.status)}</div>
    ${src ? h`<div>${sourcePath(src.path)}</div>` : h`<div class="muted small">${kindTag(r.kind)} · ${r.repo}</div>`}
    ${r.status === "queued"
      ? h`<div class="muted small">${t("Waits for the previous job on {repo}", { repo: r.repo })}</div>`
      : h`<div class="row"><span class="mono" style="font-size:22px">${pr.pct === null ? "…" : `${pr.pct}%`}</span></div>
        <div class="bar ${pr.pct === null ? "indeterminate" : ""}"><span style="width:${pr.pct ?? 0}%"></span></div>
        <div class="row mono small muted"><span>${pr.line}</span><span>${pr.files ?? ""}</span></div>`}
    <div class="row" style="justify-content:flex-end"><button class="btn secondary" data-cancel="${r.id}">${icon("x")}${t("Cancel")}</button></div>
  </div>`;
}

function sourcesTable(sources) {
  if (!sources.length) return h`<div class="empty-ok">${icon("info")}${t("No sources yet. Add one to the config (or the Sources page, coming soon).")}</div>`;
  return h`<div class="table-wrap"><table class="t">
    <thead><tr><th>${t("Status")}</th><th>${t("Name")}</th><th class="hide-phone">${t("Repository")}</th><th class="hide-phone">${t("Next")}</th><th>${t("Last backup")}</th><th class="right hide-phone">${t("Size")}</th><th class="hide-phone">${t("Last 14 runs")}</th></tr></thead>
    <tbody>${sources.map((s) => {
      const isErr = s.status === "error";
      return h`<tr class="click ${isErr ? "err" : ""}" data-href="runs?source=${encodeURIComponent(s.name)}">
        <td>${badge(s.status)}</td>
        <td><div class="name">${s.name}</div><div class="sub">${sourcePath(s.path)}</div>${isErr && s.lastRun?.summary ? h`<div class="sub err">${s.lastRun.summary}</div>` : ""}</td>
        <td class="mono hide-phone nowrap">${s.repo}</td>
        <td class="mono hide-phone nowrap">${s.next ? when(s.next) : h`<span class="muted">${t("manual")}</span>`}</td>
        <td class="mono nowrap">${s.status === "running" ? t("in progress") : s.lastBackup ? when(s.lastBackup) : h`<span class="muted">${t("never")}</span>`}</td>
        <td class="num hide-phone">${s.size !== null ? bytes(s.size) : "—"}</td>
        <td class="hide-phone">${stripe(s.runs)}</td>
      </tr>`;
    })}</tbody></table></div>`;
}

function repoCard(r) {
  const st = r.stats;
  const u = st?.usage;
  const pct = u && u.total ? Math.round((u.used / u.total) * 100) : null;
  const status = r.lastCheck?.status === "error" ? "error" : pct !== null && pct >= 85 ? "warning" : r.lastCheck ? r.lastCheck.status : "ok";
  return h`<div class="card pad" style="display:flex;flex-direction:column;gap:10px">
    <div style="display:flex;justify-content:space-between;align-items:center"><b>${r.name}</b>${badge(status === "running" || status === "queued" ? "ok" : status)}</div>
    <div class="path" style="max-width:100%">${r.url}</div>
    ${u ? h`<div class="row" style="display:flex;justify-content:space-between;font-size:var(--text-sm)"><span class="muted">${t("Disk")}</span><span class="mono small">${pct}% · ${t("{done} of {total}", { done: bytes(u.used), total: bytes(u.total) })}</span></div>
      <div class="bar ${pct >= 85 ? "warn" : "neutral"}"><span style="width:${pct}%"></span></div>` : ""}
    <dl class="kv">
      <dt>${t("Stored")}</dt><dd class="mono">${st ? bytes(st.stored) : h`<span class="sk" style="width:60px"></span>`}</dd>
      <dt>${t("Dedup")}</dt><dd class="mono">${st?.dedup ? `${st.dedup}×` : "—"}</dd>
      <dt>${t("Snapshots")}</dt><dd class="mono">${st ? num(st.snapshots) : "—"}</dd>
      <dt>${t("Last check")}</dt><dd class="mono">${r.lastCheck ? h`${when(r.lastCheck.finished)} · ${r.lastCheck.status === "ok" ? t("OK") : r.lastCheck.status}` : h`<span class="muted">${t("never")}</span>`}</dd>
    </dl>
  </div>`;
}

function upcomingRow(u) {
  const d = new Date(u.at);
  const today = new Date().toDateString() === d.toDateString();
  const day = today ? "" : d.toLocaleDateString(locale, { weekday: "short" }) + " ";
  return h`<div class="list-row"><span class="mono small" style="width:84px">${day}${clock(u.at)}</span>
    <span class="grow">${u.name}${u.kind !== "backup" ? h` <span class="tag">${kindTag(u.kind)}</span>` : ""}</span><span class="mono small muted">${rel(u.at)}</span></div>`;
}

function step(n, state, title, sub, action) {
  return h`<div class="step ${state}"><span class="num-c">${n}</span><div><div class="t1">${title}</div><div class="t2">${sub}</div></div><div>${action}</div></div>`;
}
