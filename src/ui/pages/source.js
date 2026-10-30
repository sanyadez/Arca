// One source: size history, recent snapshots, the last run, schedule, retention, excludes, repository, connection.
import { api, badge, bytes, can, copyText, cronText, duration, h, icon, menu, num, raw, rel, toast, toastError, when, clock, stamp } from "../lib.js";

export async function page(el, { name }, { session, navigate }) {
  name = decodeURIComponent(name);
  let timer = null;
  let stopped = false;
  let tableView = false;
  let d = null;

  async function load() {
    try {
      d = await api(`/api/sources/${encodeURIComponent(name)}`);
      if (!stopped) draw();
    } catch (e) {
      if (e.status === 404) {
        el.innerHTML = h`<div class="notice danger">${icon("triangle-alert")}<div>There is no source “${name}”.</div></div>`.s;
        return;
      }
      if (e.status) toastError(e);
    } finally {
      if (!stopped && d) timer = setTimeout(load, d.status === "running" || d.status === "queued" ? 3000 : 15000);
    }
  }

  function draw() {
    const snaps = d.snapshots; // newest first
    el.innerHTML = h`
      <div class="crumbs"><a href="#/sources">Sources</a>${icon("chevron-right")}<span class="cur">${d.name}</span></div>
      <div class="page-head">
        <div><h1>${d.name} ${badge(d.status)}</h1>
          <div class="sub" style="display:flex;align-items:center;gap:6px"><span class="mono small">${d.path}</span><button class="btn ghost icon sm" id="copy-path" aria-label="Copy path">${icon("copy")}</button></div></div>
        <div class="actions">
          <button class="btn primary" id="backup" ${can(session, "backup") && d.status !== "running" && d.status !== "queued" ? "" : "disabled"}>${icon("play")}Back up now</button>
          <a class="btn secondary" href="#/sources/${encodeURIComponent(d.name)}/edit">${icon("settings")}Edit</a>
          <button class="btn secondary icon" id="more" aria-label="More">${icon("ellipsis")}</button>
        </div>
      </div>
      ${d.status === "running" && d.runId ? h`<div class="notice info" style="margin-bottom:16px">${icon("loader-circle", "spin")}<div>A backup is running now. <a href="#/runs/${d.runId}">Watch it live</a>.</div></div>` : ""}
      <div class="side-grid">
        <div class="stack" style="gap:24px">
          <div class="card pad">${chartCard(snaps)}</div>
          <div class="card">
            <div class="card-head"><span>Recent snapshots</span><a class="btn ghost" href="#/snapshots?source=${encodeURIComponent(d.name)}">${icon("camera")}All ${num(snaps.length)} snapshots</a></div>
            ${snaps.length ? snapTable(snaps.slice(0, 8)) : h`<div class="empty-ok">${icon("info")}No snapshots yet.</div>`}
          </div>
          ${d.lastRun ? lastRunCard(d.lastRun) : ""}
        </div>
        <div class="stack" style="gap:16px">
          <div class="card pad side-card"><h3>Schedule</h3><dl class="kv">
            <dt>Runs</dt><dd>${cronText(d.schedule)}</dd>
            ${d.schedule ? h`<dt>Cron</dt><dd class="mono">${d.schedule}</dd><dt>Next run</dt><dd class="mono">${when(d.next)}</dd>` : ""}
          </dl></div>
          <div class="card pad side-card"><h3>Retention</h3>${retention(d)}</div>
          <div class="card pad side-card"><h3>Excludes</h3>${d.exclude.length ? h`<div class="chips-row">${d.exclude.map((x) => h`<span class="tag">${x}</span>`)}</div>` : h`<span class="muted">Nothing is excluded.</span>`}</div>
          <div class="card pad side-card"><h3>Repository</h3>
            <div style="display:flex;align-items:center;gap:6px">${icon("database")}<a href="#/repositories">${d.repoInfo.name}</a></div>
            <div class="path" style="max-width:100%;margin:4px 0 12px">${d.repoInfo.url}</div>
            <dl class="kv">
              <dt>Stored</dt><dd class="mono">${d.repoInfo.stats ? bytes(d.repoInfo.stats.stored) : "—"}</dd>
              <dt>Dedup</dt><dd class="mono">${d.repoInfo.stats?.dedup ? `${d.repoInfo.stats.dedup}×` : "—"}</dd>
              <dt>Last check</dt><dd>${d.repoInfo.lastCheck ? h`<span class="mono small">${when(d.repoInfo.lastCheck.finished)}</span> ${badge(d.repoInfo.lastCheck.status)}` : h`<span class="muted">never</span>`}</dd>
            </dl></div>
          ${d.ssh ? h`<div class="card pad side-card"><h3>Connection</h3><dl class="kv">
            <dt>Transport</dt><dd>SSH</dd>
            <dt>Forced command</dt><dd>${d.ssh.forced ? h`<span class="badge ok"><span class="dot"></span>On</span>` : h`<span class="muted">Off</span>`}</dd>
            <dt>Key</dt><dd class="small">${d.ssh.identity ? "own key file" : "the server user's key"}</dd>
            <dt>Last connected</dt><dd class="mono">${d.ssh.lastConnected ? when(d.ssh.lastConnected) : "—"}</dd>
          </dl>${d.ssh.forced ? "" : h`<p class="muted small" style="margin:12px 0 0">Without a forced command the key can run anything on the source. <a href="https://github.com/sanyadez/Arca/blob/main/docs/ssh-sources.md" target="_blank" rel="noopener">How to limit it</a>.</p>`}</div>` : ""}
        </div>
      </div>`.s;

    el.querySelector("#copy-path").onclick = () => copyText(d.path);
    el.querySelector("#backup").onclick = backupNow;
    el.querySelector("#more").onclick = (e) =>
      menu(e.currentTarget, [
        { label: "Runs of this source", icon: "activity", onClick: () => navigate(`runs?source=${encodeURIComponent(d.name)}`) },
        { label: "Snapshots", icon: "camera", onClick: () => navigate(`snapshots?source=${encodeURIComponent(d.name)}`) },
      ]);
    el.querySelector("#tbl-toggle")?.addEventListener("click", () => ((tableView = !tableView), draw()));
    el.querySelectorAll("tr[data-snap]").forEach((r) => (r.onclick = (e) => !e.target.closest("button") && navigate(`snapshots/${d.repo}/${r.dataset.snap}`)));
    el.querySelectorAll("[data-snap-menu]").forEach((b) => (b.onclick = () =>
      menu(b, [
        { label: "Browse files", icon: "folder-search", onClick: () => navigate(`snapshots/${d.repo}/${b.dataset.snapMenu}`) },
        { label: "Restore…", icon: "history", onClick: () => navigate(`snapshots/${d.repo}/${b.dataset.snapMenu}?restore=all`) },
      ])));
  }

  function chartCard(snaps) {
    const since = Date.now() - 30 * 86400_000;
    const recent = snaps.filter((s) => Date.parse(s.time) >= since).reverse(); // oldest first
    const now = snaps[0]?.stats?.bytes ?? 0;
    const first = recent[0]?.stats?.bytes ?? now;
    const added = recent.reduce((a, s) => a + (s.stats?.newBytes ?? 0), 0);
    const head = h`<div style="display:flex;justify-content:space-between;align-items:flex-start;gap:12px">
      <div><h3 style="margin:0">Snapshot size &amp; new data, 30 days</h3>
      <div class="muted small" style="margin-top:4px">${bytes(now)} now${recent.length > 1 ? `, ${now >= first ? "up" : "down"} ${bytes(Math.abs(now - first))} since ${new Date(recent[0].time).toLocaleDateString(undefined, { month: "short", day: "numeric" })}` : ""} · ${bytes(added)} of new data written</div></div>
      <button class="btn ghost" id="tbl-toggle">${icon(tableView ? "activity" : "layout-grid")}${tableView ? "Chart" : "Table"}</button></div>`;
    if (!recent.length) return h`${head}<div class="empty-ok" style="padding:24px 0 0">${icon("info")}No snapshots in the last 30 days.</div>`;
    if (tableView)
      return h`${head}<div class="table-wrap" style="margin-top:12px;max-height:320px;overflow:auto"><table class="t"><thead><tr><th>Time</th><th class="right">Size</th><th class="right">New data</th></tr></thead>
        <tbody>${[...recent].reverse().map((s) => h`<tr><td class="mono">${stamp(Date.parse(s.time))}</td><td class="num">${bytes(s.stats?.bytes ?? 0)}</td><td class="num">${bytes(s.stats?.newBytes ?? 0, { plus: true })}</td></tr>`)}</tbody></table></div>`;
    return h`${head}${raw(sizeChart(recent))}`;
  }

  function retention(d) {
    const r = d.retention;
    if (!r) return h`<p class="muted" style="margin:0">No retention: every snapshot is kept until you forget it.</p><dl class="kv" style="margin-top:12px"><dt>Currently kept</dt><dd class="mono">${num(d.kept)} snapshots</dd></dl>`;
    const keys = [["last", "last"], ["hourly", "hourly"], ["daily", "daily"], ["weekly", "weekly"], ["monthly", "monthly"], ["yearly", "yearly"], ["withinDays", "days, all"]];
    return h`<div class="ret-grid">${keys.filter(([k]) => r[k]).map(([k, l]) => h`<div><b>${r[k]}</b><span>${l}</span></div>`)}</div>
      <dl class="kv" style="margin-top:14px"><dt>Currently kept</dt><dd class="mono">${num(d.kept)} snapshots</dd></dl>`;
  }

  function snapTable(rows) {
    return h`<div class="table-wrap"><table class="t"><thead><tr><th>ID</th><th>Time</th><th class="right hide-phone">Files</th><th class="right">Size</th><th class="right">Added</th><th class="right hide-phone">Duration</th><th class="right hide-phone">Errors</th><th></th></tr></thead>
      <tbody>${rows.map((s) => h`<tr class="click" data-snap="${s.id}">
        <td class="mono">${s.id.slice(0, 8)}</td><td class="mono nowrap" title="${new Date(s.time).toLocaleString()}">${dayLabel(s.time)} ${clock(s.time)}</td>
        <td class="num hide-phone">${num(s.stats?.files)}</td><td class="num">${bytes(s.stats?.bytes ?? null)}</td>
        <td class="num">${bytes(s.stats?.newBytes ?? null, { plus: true })}</td><td class="num hide-phone">${duration(s.stats?.seconds)}</td>
        <td class="num hide-phone">${s.stats?.errors ? h`<span style="color:var(--warn)">${icon("triangle-alert")}</span> ${s.stats.errors}` : h`<span class="muted">0</span>`}</td>
        <td style="width:44px"><button class="btn ghost icon sm" data-snap-menu="${s.id}" aria-label="Actions">${icon("ellipsis")}</button></td></tr>`)}</tbody></table></div>`;
  }

  function lastRunCard(r) {
    const errs = r.errors ?? [];
    return h`<div class="card pad">
      <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:12px">
        <div><h3 style="margin:0;display:flex;gap:8px;align-items:center">Last run ${badge(r.status)}</h3>
          <div class="mono small muted" style="margin-top:4px">${stamp(Date.parse(r.started))} · ${rel(r.finished ?? r.started)} · started by ${r.trigger.replace(":", ": ")}</div></div>
        <a class="btn ghost" href="#/runs/${r.id}">${icon("activity")}View run</a></div>
      ${r.summary ? h`<div class="notice ${r.status === "error" ? "danger" : errs.length ? "warn" : "info"}" style="margin-top:14px">${icon(r.status === "ok" ? "check" : "triangle-alert")}<div>
        ${errs.length ? h`<b>${errs.length} file${errs.length === 1 ? "" : "s"} unreadable</b><div>The snapshot was saved without ${errs.length === 1 ? "this file" : "these files"}. Give the source user read access, or exclude ${errs.length === 1 ? "it" : "them"}, then back up again.</div>` : h`<span class="mono">${r.summary}</span>`}</div></div>` : ""}
      ${errs.length ? h`<div class="mono small" style="margin-top:12px;display:flex;flex-direction:column;gap:6px">${errs.slice(0, 10).map((e) => h`<div title="${e.error}">${e.path || "/"} <span class="muted">— ${e.error}</span></div>`)}${errs.length > 10 ? h`<a href="#/runs/${r.id}">${errs.length - 10} more…</a>` : ""}</div>` : ""}
    </div>`;
  }

  async function backupNow() {
    try {
      const r = await api(`/api/sources/${encodeURIComponent(name)}/backup`, { method: "POST" });
      toast(h`Backup queued · <a href="#/runs/${r.runId}">open run #${r.runId}</a>`, "ok");
      clearTimeout(timer);
      load();
    } catch (e) {
      toastError(e);
    }
  }

  el.innerHTML = h`<div class="page-head"><div><span class="sk big" style="width:240px"></span></div></div>`.s;
  await load();
  return () => {
    stopped = true;
    clearTimeout(timer);
  };
}

function dayLabel(iso) {
  const d = new Date(iso);
  const today = new Date();
  const y = new Date(Date.now() - 86400_000);
  if (d.toDateString() === today.toDateString()) return "Today";
  if (d.toDateString() === y.toDateString()) return "Yesterday";
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/** SVG: total size (line, top) and new data per day (bars, bottom) over 30 days. */
function sizeChart(snaps) {
  const W = 760, H = 330, L = 64, R = 86, top = 30, mid = 190, bottom = 290;
  const t0 = Date.now() - 30 * 86400_000;
  const x = (t) => L + ((t - t0) / (30 * 86400_000)) * (W - L - R);
  const sizes = snaps.map((s) => s.stats?.bytes ?? 0);
  let lo = Math.min(...sizes), hi = Math.max(...sizes);
  if (hi === lo) (lo = lo * 0.9), (hi = hi * 1.1 || 1);
  const pad = (hi - lo) * 0.15;
  lo = Math.max(0, lo - pad);
  hi += pad;
  const y1 = (v) => top + (1 - (v - lo) / (hi - lo)) * (mid - top - 20);
  const days = new Map();
  for (const s of snaps) {
    const k = new Date(s.time).toDateString();
    days.set(k, (days.get(k) ?? 0) + (s.stats?.newBytes ?? 0));
  }
  const maxNew = Math.max(1, ...days.values());
  const y2 = (v) => bottom - (v / maxNew) * (bottom - mid - 24);
  const pts = snaps.map((s) => `${x(Date.parse(s.time)).toFixed(1)},${y1(s.stats?.bytes ?? 0).toFixed(1)}`).join(" ");
  const last = snaps[snaps.length - 1];
  let svg = `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Snapshot size and new data per day">`;
  let prevLabel = "";
  for (let i = 0; i <= 3; i++) {
    const v = lo + ((hi - lo) * i) / 3;
    const yy = y1(v);
    const label = fmtShort(v);
    svg += `<line class="grid-l" x1="${L}" x2="${W - R}" y1="${yy}" y2="${yy}"/>`;
    // a narrow range rounds to equal labels: show each value once
    if (label !== prevLabel) svg += `<text x="${L - 8}" y="${yy + 4}" text-anchor="end">${label}</text>`;
    prevLabel = label;
  }
  svg += `<polyline class="line" points="${pts}"/>`;
  if (last) svg += `<circle cx="${x(Date.parse(last.time))}" cy="${y1(last.stats?.bytes ?? 0)}" r="4" fill="var(--accent)"/><text x="${x(Date.parse(last.time)) + 10}" y="${y1(last.stats?.bytes ?? 0) + 4}" style="fill:var(--text)">${fmtShort(last.stats?.bytes ?? 0)}</text>`;
  svg += `<line class="grid-l" x1="${L}" x2="${W - R}" y1="${bottom}" y2="${bottom}"/><text x="${L - 8}" y="${bottom + 4}" text-anchor="end">0</text><text x="${L - 8}" y="${y2(maxNew) + 4}" text-anchor="end">${fmtShort(maxNew)}</text>`;
  svg += `<text x="${L}" y="${mid - 2}" style="fill:var(--text)">■ New data per day</text><text x="${L}" y="${top - 12}" style="fill:var(--text)">— Total size</text>`;
  const bw = Math.max(4, (W - L - R) / 30 - 6);
  for (const [k, v] of days) {
    const cx = x(new Date(k).getTime() + 43200_000);
    svg += `<rect class="barr" x="${cx - bw / 2}" y="${y2(v)}" width="${bw}" height="${Math.max(1, bottom - y2(v))}" rx="2"><title>${k}: +${fmtShort(v)}</title></rect>`;
  }
  for (let i = 0; i <= 4; i++) {
    const t = t0 + i * 7.5 * 86400_000;
    svg += `<text x="${x(t)}" y="${H - 8}" text-anchor="middle">${new Date(t).toLocaleDateString(undefined, { month: "short", day: "numeric" })}</text>`;
  }
  return svg + "</svg>";
}

function fmtShort(n) {
  return bytes(n).replace(" ", " ");
}
