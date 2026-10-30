// Overview: is everything protected, and what to do if not. First run shows a checklist instead.
import { api, badge, bytes, can, clock, h, icon, num, rel, sourcePath, stripe, toast, toastError, when } from "../lib.js";

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
        <div><h1>Overview</h1><div class="sub">${o.server.host} · Arca ${o.server.version.split(" ")[0]} · all times local</div></div>
        <div class="actions">
          <button class="btn secondary" id="check-all" ${canBackup ? "" : "disabled"}>${icon("shield-check")}Check repositories</button>
          <button class="btn primary" id="backup-all" ${canBackup && o.sources.length ? "" : "disabled"}>${icon("play")}Back up all now</button>
        </div>
      </div>
      <div class="grid metrics">
        ${metric("Sources", num(m.sources.total), [`${m.sources.ok} OK`, m.sources.running && `${m.sources.running} running`, m.sources.issues && `${m.sources.issues} issue${m.sources.issues > 1 ? "s" : ""}`])}
        ${metric("Protected data", bytes(m.protected), [`${bytes(m.stored)} stored`, m.dedup && `dedup ${m.dedup}×`])}
        ${metric("Last 24 h", `${num(m.runs24h.total)} run${m.runs24h.total === 1 ? "" : "s"}`, [`${m.runs24h.ok} ok`, m.runs24h.warning && `${m.runs24h.warning} warning`, m.runs24h.error && `${m.runs24h.error} error`])}
        ${metric("Next run", m.next ? rel(m.next.at) : "—", [m.next ? m.next.name : "no schedule"])}
      </div>

      <div class="two-col">
        <div>
          <h2 class="section">Needs attention</h2>
          <div class="stack">${o.attention.length ? o.attention.map(attentionItem) : h`<div class="card empty-ok">${icon("check")}Nothing needs attention: every source's last backup went fine.</div>`}</div>
        </div>
        <div>
          <h2 class="section">Running now</h2>
          <div class="stack">${o.running.length ? o.running.map((r) => runningCard(r, o)) : h`<div class="card empty-ok">${icon("clock")}<span>Nothing is running${m.next ? h`. Next: ${m.next.name} ${when(m.next.at)}` : ""}</span></div>`}</div>
        </div>
      </div>

      <div class="section-row"><h2 class="section">Sources</h2>
        <div class="legend hide-phone">Oldest to newest
          ${[["ok", "OK"], ["warning", "Warning"], ["error", "Error"], ["interrupted", "Interrupted"], ["running", "Running"]].map(([c, l]) => h`<span><i class="stripe-dot" style="background:var(--${c === "warning" ? "warn" : c === "error" ? "danger" : c === "running" ? "info" : c})"></i>${l}</span>`)}
        </div>
      </div>
      <div class="card">${sourcesTable(o.sources)}</div>

      <div class="two-col">
        <div><h2 class="section">Repositories</h2><div class="grid" style="grid-template-columns:repeat(auto-fill,minmax(280px,1fr))">${o.repos.map(repoCard)}</div></div>
        <div><div class="section-row"><h2 class="section">Upcoming</h2><span class="muted small">Next ${o.upcoming.length} runs</span></div>
          <div class="card">${o.upcoming.length ? o.upcoming.map(upcomingRow) : h`<div class="empty-ok">No schedules yet.</div>`}</div></div>
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
        <div><h1>Welcome to Arca</h1><div class="sub">Nothing is backed up yet. Three steps to set up backups you can restore.</div></div>
        <div class="actions"><span class="mono small muted">${o.server.host} · Arca ${o.server.version.split(" ")[0]}</span></div>
      </div>
      <div class="two-col">
        <div class="card checklist">
          <div class="card-head"><span>Get started</span><span class="mono small muted" style="font-weight:400">0 of 3 done</span></div>
          ${step(1, "current", "Create a repository", "Where encrypted backups live", h`<a class="btn primary" href="#/repositories?new=1">${icon("plus")}Create repository</a>`)}
          ${step(2, "", "Add a source", "A folder here or on another machine", h`<span class="muted small">After step 1</span>`)}
          ${step(3, "", "Keep the recovery kit", h`<span class="mono">arca-restore</span> and the password, away from this server`, h`<span class="muted small">After step 1</span>`)}
        </div>
        <div class="card pad how">
          <b style="font-weight:600">How Arca works</b>
          <div class="item">${icon("archive")}<div><b>Encrypts before upload</b><span>AES-256-GCM. Storage only ever holds ciphertext.</span></div></div>
          <div class="item">${icon("database")}<div><b>Stores each chunk once</b><span>Data repeated across snapshots takes no extra space.</span></div></div>
          <div class="item">${icon("life-buoy")}<div><b>Restores without the server</b><span>via <span class="mono">arca-restore</span></span></div></div>
        </div>
      </div>
      <p class="muted small" style="margin-top:20px">Prefer the command line? <span class="mono">arca init</span>, then <span class="mono">arca backup</span>.</p>`.s;
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
    if (ok) toast(`${kind === "backup" ? "Backup" : "Check"} queued for ${ok === 1 ? names[0] : `${ok} ${kind === "backup" ? "sources" : "repositories"}`}`, "ok");
    clearTimeout(timer);
    load();
  }

  async function cancel(id) {
    try {
      await api(`/api/runs/${id}/cancel`, { method: "POST" });
      toast(`Run #${id} is being cancelled`, "info");
    } catch (e) {
      toastError(e);
    }
  }

  el.innerHTML = h`<div class="page-head"><div><h1>Overview</h1><div class="sub"><span class="sk" style="width:220px"></span></div></div></div>
    <div class="grid metrics">${[1, 2, 3, 4].map(() => h`<div class="card metric"><span class="sk" style="width:60px"></span><span class="sk big"></span><span class="sk" style="width:120px"></span></div>`)}</div>`.s;
  await load();
  return () => {
    stopped = true;
    clearTimeout(timer);
  };
}

function metric(label, value, notes) {
  return h`<div class="card metric"><div class="label">${label}</div><div class="value">${value}</div><div class="note">${notes.filter(Boolean).join(" · ")}</div></div>`;
}

function attentionItem(a) {
  const isRepo = a.kind === "repo";
  const title = isRepo ? "Check failed" : a.status === "error" ? "Last backup failed" : "Last backup finished with warnings";
  return h`<div class="card alert-item ${a.status}">
    <div class="body">
      <div class="title">${a.name} ${badge(a.status)}</div>
      <div class="detail">${title}${a.at ? h` · ${when(a.at)}` : ""}</div>
      ${a.summary ? h`<div class="err" title="${a.summary}">${a.summary}</div>` : ""}
    </div>
    <div class="acts">
      ${!isRepo && a.status === "error" ? h`<button class="btn secondary" data-retry="${a.name}">${icon("rotate-cw")}Retry</button>` : ""}
      ${a.runId ? h`<a class="btn ${a.status === "error" && !isRepo ? "ghost" : "secondary"}" href="#/runs/${a.runId}">${icon(a.status === "warning" ? "folder-search" : "arrow-right")}${a.status === "warning" ? "View files" : "Open"}</a>` : ""}
    </div>
  </div>`;
}

export function progressOf(p) {
  if (!p) return { pct: null, line: "" };
  if (p.stage === "scan") return { pct: null, line: `Scanning… ${num(p.filesTotal)} files so far` };
  if (p.stage === "write" || p.stage === "done") return { pct: 100, line: "Writing the snapshot" };
  const pct = p.bytesToRead ? Math.min(100, Math.floor((p.bytesRead / p.bytesToRead) * 100)) : 100;
  return { pct, line: `${bytes(p.bytesRead)} of ${bytes(p.bytesToRead)}`, files: `${num(p.filesRead)} of ${num(p.toRead)} files` };
}

function runningCard(r, o) {
  const src = r.source && o.sources.find((s) => s.name === r.source);
  const pr = progressOf(r.progress);
  return h`<div class="card running-card" data-href="runs/${r.id}" style="cursor:pointer">
    <div class="row"><b>${r.source ?? r.repo}</b>${badge(r.status)}</div>
    ${src ? h`<div>${sourcePath(src.path)}</div>` : h`<div class="muted small">${r.kind} · ${r.repo}</div>`}
    ${r.status === "queued"
      ? h`<div class="muted small">Waits for the previous job on ${r.repo}</div>`
      : h`<div class="row"><span class="mono" style="font-size:22px">${pr.pct === null ? "…" : `${pr.pct}%`}</span></div>
        <div class="bar ${pr.pct === null ? "indeterminate" : ""}"><span style="width:${pr.pct ?? 0}%"></span></div>
        <div class="row mono small muted"><span>${pr.line}</span><span>${pr.files ?? ""}</span></div>`}
    <div class="row" style="justify-content:flex-end"><button class="btn secondary" data-cancel="${r.id}">${icon("x")}Cancel</button></div>
  </div>`;
}

function sourcesTable(sources) {
  if (!sources.length) return h`<div class="empty-ok">${icon("info")}No sources yet. Add one to the config (or the Sources page, coming soon).</div>`;
  return h`<div class="table-wrap"><table class="t">
    <thead><tr><th>Status</th><th>Name</th><th class="hide-phone">Repository</th><th class="hide-phone">Next</th><th>Last backup</th><th class="right hide-phone">Size</th><th class="hide-phone">Last 14 runs</th></tr></thead>
    <tbody>${sources.map((s) => {
      const isErr = s.status === "error";
      return h`<tr class="click ${isErr ? "err" : ""}" data-href="runs?source=${encodeURIComponent(s.name)}">
        <td>${badge(s.status)}</td>
        <td><div class="name">${s.name}</div><div class="sub">${sourcePath(s.path)}</div>${isErr && s.lastRun?.summary ? h`<div class="sub err">${s.lastRun.summary}</div>` : ""}</td>
        <td class="mono hide-phone nowrap">${s.repo}</td>
        <td class="mono hide-phone nowrap">${s.next ? when(s.next) : h`<span class="muted">manual</span>`}</td>
        <td class="mono nowrap">${s.status === "running" ? "in progress" : s.lastBackup ? when(s.lastBackup) : h`<span class="muted">never</span>`}</td>
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
    ${u ? h`<div class="row" style="display:flex;justify-content:space-between;font-size:var(--text-sm)"><span class="muted">Disk</span><span class="mono small">${pct}% · ${bytes(u.used)} of ${bytes(u.total)}</span></div>
      <div class="bar ${pct >= 85 ? "warn" : "neutral"}"><span style="width:${pct}%"></span></div>` : ""}
    <dl class="kv">
      <dt>Stored</dt><dd class="mono">${st ? bytes(st.stored) : h`<span class="sk" style="width:60px"></span>`}</dd>
      <dt>Dedup</dt><dd class="mono">${st?.dedup ? `${st.dedup}×` : "—"}</dd>
      <dt>Snapshots</dt><dd class="mono">${st ? num(st.snapshots) : "—"}</dd>
      <dt>Last check</dt><dd class="mono">${r.lastCheck ? h`${when(r.lastCheck.finished)} · ${r.lastCheck.status === "ok" ? "OK" : r.lastCheck.status}` : h`<span class="muted">never</span>`}</dd>
    </dl>
  </div>`;
}

function upcomingRow(u) {
  const d = new Date(u.at);
  const today = new Date().toDateString() === d.toDateString();
  const day = today ? "" : d.toLocaleDateString(undefined, { weekday: "short" }) + " ";
  return h`<div class="list-row"><span class="mono small" style="width:84px">${day}${clock(u.at)}</span>
    <span class="grow">${u.name}${u.kind !== "backup" ? h` <span class="tag">${u.kind}</span>` : ""}</span><span class="mono small muted">${rel(u.at)}</span></div>`;
}

function step(n, state, title, sub, action) {
  return h`<div class="step ${state}"><span class="num-c">${n}</span><div><div class="t1">${title}</div><div class="t2">${sub}</div></div><div>${action}</div></div>`;
}
