// Sources: every folder Arca backs up, with its schedule and the state of its last backup.
import { api, badge, bytes, can, clock, cronText, h, icon, menu, num, rel, sourcePath, toast, toastError, when } from "../lib.js";
import { progressOf } from "./overview.js";

const ORDER = { error: 0, warning: 1, running: 2, queued: 3, interrupted: 4, never: 5, ok: 6 };

export async function page(el, _params, { session, navigate }) {
  let filter = "all";
  let q = "";
  let data = null;
  let timer = null;
  let stopped = false;

  el.innerHTML = h`
    <div class="page-head">
      <div><h1>Sources</h1><div class="sub" id="sub">&nbsp;</div></div>
      <div class="actions">
        <label class="search">${icon("search")}<input class="input" id="q" type="search" placeholder="Search sources" /></label>
        <div class="chip-group" id="chips"></div>
        <a class="btn primary" href="#/sources/new" title="Add a folder to back up">${icon("plus")}New source</a>
      </div>
    </div>
    <div class="card" id="list"></div>`.s;
  el.querySelector("#q").addEventListener("input", (e) => {
    q = e.target.value.trim().toLowerCase();
    draw();
  });

  async function load() {
    try {
      data = await api("/api/overview");
      if (!stopped) draw();
    } catch (e) {
      if (e.status) toastError(e);
    } finally {
      if (!stopped) timer = setTimeout(load, 5000);
    }
  }

  const isSsh = (s) => s.path.startsWith("ssh://");
  const failing = (s) => s.status === "error" || s.status === "warning";
  const running = (s) => s.status === "running" || s.status === "queued";

  function draw() {
    if (!data) return;
    const all = data.sources;
    el.querySelector("#sub").textContent = `${all.length} source${all.length === 1 ? "" : "s"} · ${data.repos.length} repositor${data.repos.length === 1 ? "y" : "ies"}`;
    const counts = { all: all.length, failing: all.filter(failing).length, running: all.filter(running).length, local: all.filter((s) => !isSsh(s)).length, ssh: all.filter(isSsh).length };
    el.querySelector("#chips").innerHTML = [["all", "All"], ["failing", "Failing"], ["running", "Running"], ["local", "Local"], ["ssh", "SSH"]]
      .map(([k, l]) => h`<button class="chip ${filter === k ? "on" : ""}" data-k="${k}">${l} <span class="count">${counts[k]}</span></button>`.s)
      .join("");
    el.querySelectorAll("#chips [data-k]").forEach((b) => (b.onclick = () => ((filter = b.dataset.k), draw())));

    const shown = all
      .filter((s) => filter === "all" || (filter === "failing" && failing(s)) || (filter === "running" && running(s)) || (filter === "local" && !isSsh(s)) || (filter === "ssh" && isSsh(s)))
      .filter((s) => !q || s.name.toLowerCase().includes(q) || s.path.toLowerCase().includes(q))
      .sort((a, b) => (ORDER[a.status] ?? 9) - (ORDER[b.status] ?? 9) || a.name.localeCompare(b.name));

    el.querySelector("#list").innerHTML = (shown.length
      ? h`<div class="show-phone">${shown.map((s) => h`<a class="m-row" href="#/sources/${encodeURIComponent(s.name)}"><span class="dot ${s.status}"></span><span class="grow">${s.name}<div class="mono small muted ellipsis" style="font-weight:400">${s.path}</div></span><span class="mono small muted">${s.lastBackup ? rel(s.lastBackup) : "never"}</span>${icon("chevron-right")}</a>`)}</div>
        <div class="table-wrap hide-phone"><table class="t">
        <thead><tr><th>Status ↓</th><th>Source</th><th class="hide-phone">Repository</th><th class="hide-phone">Schedule</th><th>Last backup</th><th class="hide-phone">Next</th><th class="right hide-phone">Size</th><th></th></tr></thead>
        <tbody>${shown.map(row)}</tbody></table></div>`
      : h`<div class="empty-ok">${icon("info")}${all.length ? "No source matches." : h`No sources yet. <a href="#/sources/new">Add the first one</a>.`}</div>`).s;
    el.querySelectorAll("tr[data-name]").forEach((r) => (r.onclick = (e) => !e.target.closest("button,a") && navigate(`sources/${encodeURIComponent(r.dataset.name)}`)));
    el.querySelectorAll("[data-menu]").forEach((b) => (b.onclick = () => rowMenu(b, b.dataset.menu)));
  }

  function row(s) {
    const pr = s.progress ? progressOf(s.progress) : null;
    const msgKind = s.status === "error" ? "err" : s.status === "warning" ? "warn" : null;
    return h`<tr class="click ${s.status === "error" ? "err" : ""}" data-name="${s.name}">
      <td style="vertical-align:top;padding-top:14px">${badge(s.status)}</td>
      <td style="padding-top:10px;padding-bottom:10px">
        <div class="name">${s.name}</div><div class="sub">${sourcePath(s.path)}</div>
        ${msgKind && s.lastRun?.summary ? h`<div class="row-msg ${msgKind}" title="${s.lastRun.summary}">${icon("triangle-alert")}<span class="mono small ellipsis">${s.lastRun.summary}</span></div>` : ""}
        ${s.status === "running" && pr ? h`<div class="inline-bar"><div class="bar ${pr.pct === null ? "indeterminate" : ""}"><span style="width:${pr.pct ?? 0}%"></span></div><b>${pr.pct === null ? "…" : `${pr.pct}%`}</b><span class="muted">${pr.line}${pr.files ? ` · ${pr.files}` : ""}</span></div>` : ""}
      </td>
      <td class="hide-phone nowrap" style="vertical-align:top;padding-top:14px">${icon("database")} ${s.repo}</td>
      <td class="hide-phone nowrap" style="vertical-align:top;padding-top:12px"><div>${cronText(s.schedule)}</div>${s.schedule ? h`<div class="sub mono">${s.schedule}</div>` : ""}</td>
      <td class="mono nowrap" style="vertical-align:top;padding-top:12px">${
        s.status === "running" ? h`<div>Running now</div>` : s.lastBackup ? h`<div>${when(s.lastBackup)}</div>` : h`<div class="muted">never</div>`}
        ${s.status === "error" ? h`<div class="sub">attempt failed</div>` : s.newBytes ? h`<div class="sub">${bytes(s.newBytes, { plus: true })} new</div>` : ""}</td>
      <td class="mono nowrap hide-phone" style="vertical-align:top;padding-top:12px">${s.next ? h`<div>${rel(s.next)}</div><div class="sub">${clock(s.next)}</div>` : h`<span class="muted">manual</span>`}</td>
      <td class="num hide-phone" style="vertical-align:top;padding-top:14px">${s.size !== null ? bytes(s.size) : "—"}</td>
      <td style="vertical-align:top;padding-top:8px;width:44px"><button class="btn ghost icon sm" data-menu="${s.name}" aria-label="Actions">${icon("ellipsis")}</button></td>
    </tr>`;
  }

  function rowMenu(anchor, name) {
    const items = [];
    if (can(session, "backup")) items.push({ label: "Back up now", icon: "play", onClick: () => backupNow(name) });
    items.push({ label: "Edit", icon: "settings", onClick: () => navigate(`sources/${encodeURIComponent(name)}/edit`) });
    items.push({ label: "Snapshots", icon: "camera", onClick: () => navigate(`snapshots?source=${encodeURIComponent(name)}`) });
    items.push({ label: "Runs", icon: "activity", onClick: () => navigate(`runs?source=${encodeURIComponent(name)}`) });
    menu(anchor, items);
  }

  async function backupNow(name) {
    try {
      const r = await api(`/api/sources/${encodeURIComponent(name)}/backup`, { method: "POST" });
      toast(h`Backup of ${name} queued · <a href="#/runs/${r.runId}">open run #${r.runId}</a>`, "ok");
      clearTimeout(timer);
      load();
    } catch (e) {
      toastError(e);
    }
  }

  await load();
  return () => {
    stopped = true;
    clearTimeout(timer);
  };
}

export { num };
