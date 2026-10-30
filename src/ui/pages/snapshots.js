// Snapshots of all repositories: filters, per-day chart, grouping by day, file search, bulk forget.
import { adminTag, api, bytes, can, clock, duration, h, icon, menu, modal, num, raw, select, stamp, toast, toastError } from "../lib.js";

const DAY_PAGE = 7; // days shown at first; "Load older days" adds more

export async function page(el, _params, { session, navigate }) {
  const qs = new URLSearchParams(location.hash.split("?")[1] ?? "");
  const f = { source: qs.get("source") ?? "", repo: qs.get("repo") ?? "", host: "", tag: "" };
  let all = [];
  let days = DAY_PAGE;
  const selected = new Map(); // key repo/id → row
  let searchCtl = null;

  el.innerHTML = h`
    <div class="page-head">
      <div><h1>Snapshots</h1><div class="sub" id="sub">&nbsp;</div></div>
      <div class="actions"><a class="btn primary" href="#/sources">${icon("play")}Back up now…</a></div>
    </div>
    <div class="toolbar" id="toolbar"></div>
    <div id="results"></div>
    <div class="card pad" id="chart" style="margin-bottom:16px"></div>
    <div class="card" id="list"></div>
    <div id="more"></div>
    <div id="bulk"></div>`.s;

  try {
    all = await api("/api/snapshots");
  } catch (e) {
    el.querySelector("#list").innerHTML = h`<div class="notice danger">${icon("triangle-alert")}<div>${e.message}</div></div>`.s;
    return;
  }

  function filtered() {
    return all.filter((s) => (!f.source || s.source === f.source) && (!f.repo || s.repo === f.repo) && (!f.host || s.host === f.host) && (!f.tag || s.tags.includes(f.tag)));
  }

  function toolbar() {
    const uniq = (k) => [...new Set(all.flatMap((s) => (Array.isArray(s[k]) ? s[k] : [s[k]])))].sort();
    el.querySelector("#toolbar").innerHTML = h`
      ${select("f-source", "Source", [["", "All"], ...uniq("source").map((v) => [v, v])], f.source)}
      ${select("f-repo", "Repository", [["", "All"], ...uniq("repo").map((v) => [v, v])], f.repo)}
      ${select("f-host", "Host", [["", "All"], ...uniq("host").map((v) => [v, v])], f.host)}
      ${select("f-tag", "Tag", [["", "Any"], ...uniq("tags").map((v) => [v, v])], f.tag)}
      <label class="search">${icon("search")}<input class="input" id="find" type="search" placeholder="Find a file in snapshots…" /></label>`.s;
    for (const k of ["source", "repo", "host", "tag"])
      el.querySelector(`#f-${k}`).onchange = (e) => {
        f[k] = e.target.value;
        days = DAY_PAGE;
        draw();
      };
    let t;
    el.querySelector("#find").addEventListener("input", (e) => {
      clearTimeout(t);
      t = setTimeout(() => search(e.target.value.trim()), 350);
    });
  }

  async function search(q) {
    const box = el.querySelector("#results");
    searchCtl?.abort();
    if (q.length < 2) return (box.innerHTML = "");
    searchCtl = new AbortController();
    box.innerHTML = h`<div class="card" style="margin-bottom:16px"><div class="empty-ok">${icon("loader-circle", "spin")}Searching for “${q}”…</div></div>`.s;
    const p = new URLSearchParams({ q });
    if (f.source) p.set("source", f.source);
    if (f.repo) p.set("repo", f.repo);
    try {
      const r = await api(`/api/search?${p}`, { signal: searchCtl.signal });
      box.innerHTML = h`<div class="card hits" style="margin-bottom:16px">
        <div class="card-head"><span>Files matching “${q}”</span><span class="muted small" style="font-weight:400">${num(r.hits.length)}${r.truncated ? "+" : ""} found · newest first</span></div>
        ${r.hits.length ? r.hits.map((x) => h`<a class="list-row" href="#/snapshots/${x.repo}/${x.snapshot}?path=${encodeURIComponent(parentOf(x.path))}">
            ${icon(x.type === "dir" ? "folder" : "file")}<span class="grow mono small">${x.path}</span>
            <span class="muted small hide-phone">${x.source} · ${x.snapshot.slice(0, 8)} · ${stamp(Date.parse(x.time))}${x.alsoIn ? ` · also in ${x.alsoIn} older` : ""}</span>
            <span class="mono small">${x.size !== undefined ? bytes(x.size) : ""}</span></a>`)
          : h`<div class="empty-ok">${icon("info")}No file or folder name contains “${q}”.</div>`}</div>`.s;
    } catch (e) {
      if (e.name !== "AbortError") box.innerHTML = h`<div class="notice danger" style="margin-bottom:16px">${icon("triangle-alert")}<div>${e.message}</div></div>`.s;
    }
  }

  function draw() {
    const rows = filtered();
    const repos = new Set(all.map((s) => s.repo));
    el.querySelector("#sub").textContent = `${num(rows.length)}${rows.length !== all.length ? ` of ${num(all.length)}` : ""} in ${repos.size} repositor${repos.size === 1 ? "y" : "ies"}`;
    drawChart(rows);
    const groups = [];
    for (const s of rows) {
      const k = new Date(s.time).toDateString();
      if (groups.at(-1)?.key !== k) groups.push({ key: k, rows: [] });
      groups.at(-1).rows.push(s);
    }
    const shown = groups.slice(0, days);
    const nShown = shown.reduce((a, g) => a + g.rows.length, 0);
    el.querySelector("#list").innerHTML = (rows.length
      ? h`<div class="table-wrap"><table class="t">
        <thead><tr><th class="cb"></th><th>Status</th><th>ID</th><th>Time</th><th>Source</th><th class="hide-phone">Host</th><th class="hide-phone">Tags</th><th class="right hide-phone">Files</th><th class="right">Size</th><th class="right">Added</th><th class="right hide-phone">Duration</th><th></th></tr></thead>
        <tbody>${shown.map((g) => h`<tr class="day-row"><td colspan="12"><b>${dayTitle(g.key)}</b> <span class="muted">${new Date(g.key).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" })} · ${g.rows.length} snapshot${g.rows.length === 1 ? "" : "s"}, ${bytes(g.rows.reduce((a, s) => a + (s.stats?.newBytes ?? 0), 0), { plus: true })} added</span></td></tr>
          ${g.rows.map(row)}`)}</tbody></table></div>`
      : h`<div class="empty-ok">${icon("info")}${all.length ? "No snapshot matches these filters." : "No snapshots yet: they appear after the first backup."}</div>`).s;
    el.querySelector("#more").innerHTML = rows.length
      ? h`<div style="display:flex;justify-content:space-between;align-items:center;margin-top:16px"><span class="mono small muted">${num(nShown)} of ${num(rows.length)}</span>
        ${shown.length < groups.length ? h`<button class="btn secondary" id="older">${icon("chevron-down")}Load older days</button>` : ""}</div>`.s
      : "";
    el.querySelector("#older")?.addEventListener("click", () => ((days += DAY_PAGE), draw()));
    el.querySelectorAll("tr[data-k]").forEach((r) => (r.onclick = (e) => {
      if (e.target.closest("button,input")) return;
      const s = byKey(r.dataset.k);
      navigate(`snapshots/${s.repo}/${s.id}`);
    }));
    el.querySelectorAll("input[data-sel]").forEach((c) => (c.onchange = () => {
      const s = byKey(c.dataset.sel);
      c.checked ? selected.set(c.dataset.sel, s) : selected.delete(c.dataset.sel);
      c.closest("tr").classList.toggle("sel", c.checked);
      drawBulk();
    }));
    el.querySelectorAll("[data-menu]").forEach((b) => (b.onclick = () => {
      const s = byKey(b.dataset.menu);
      menu(b, [
        { label: "Browse files", icon: "folder-search", onClick: () => navigate(`snapshots/${s.repo}/${s.id}`) },
        { label: "Restore…", icon: "history", onClick: () => navigate(`snapshots/${s.repo}/${s.id}?restore=all`) },
        ...(can(session, "admin") ? ["-", { label: "Forget…", icon: "x", danger: true, onClick: () => forget([s]) }] : []),
      ]);
    }));
    drawBulk();
  }

  const key = (s) => `${s.repo}/${s.id}`;
  const byKey = (k) => all.find((s) => key(s) === k);

  function row(s) {
    const errs = s.stats?.errors ?? 0;
    const k = key(s);
    return h`<tr class="click ${selected.has(k) ? "sel" : ""}" data-k="${k}">
      <td class="cb"><input type="checkbox" class="cbx" data-sel="${k}" ${selected.has(k) ? raw("checked") : ""} aria-label="Select ${s.id.slice(0, 8)}" /></td>
      <td>${errs ? h`<span class="badge warning"><span class="dot"></span>${errs} error${errs === 1 ? "" : "s"}</span>` : h`<span class="badge ok"><span class="dot"></span>OK</span>`}</td>
      <td class="mono">${s.id.slice(0, 8)}</td>
      <td class="mono" title="${new Date(s.time).toLocaleString()}">${clock(s.time)}</td>
      <td class="name">${s.source}</td>
      <td class="mono muted hide-phone">${s.host}</td>
      <td class="hide-phone">${s.tags.map((t) => h`<span class="tag">${t}</span> `)}</td>
      <td class="num hide-phone">${num(s.stats?.files)}</td>
      <td class="num">${bytes(s.stats?.bytes ?? null)}</td>
      <td class="num">${bytes(s.stats?.newBytes ?? null, { plus: true })}</td>
      <td class="num hide-phone">${duration(s.stats?.seconds)}</td>
      <td style="width:44px"><button class="btn ghost icon sm" data-menu="${k}" aria-label="Actions">${icon("ellipsis")}</button></td></tr>`;
  }

  function drawChart(rows) {
    const N = 35;
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    start.setDate(start.getDate() - (N - 1));
    const buckets = Array.from({ length: N }, () => ({ ok: 0, err: 0 }));
    for (const s of rows) {
      const i = Math.floor((Date.parse(s.time) - start.getTime()) / 86400_000);
      if (i >= 0 && i < N) buckets[i][s.stats?.errors ? "err" : "ok"]++;
    }
    const max = Math.max(1, ...buckets.map((b) => b.ok + b.err));
    const W = 1100, H = 150, B = 120, bw = W / N;
    let svg = `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Snapshots per day">`;
    buckets.forEach((b, i) => {
      const x = i * bw + 3;
      const tot = b.ok + b.err;
      svg += `<rect x="${x}" y="${B - 1}" width="${bw - 6}" height="2" fill="var(--border)"/>`;
      if (!tot) return;
      const hOk = (b.ok / max) * (B - 24), hErr = (b.err / max) * (B - 24);
      svg += `<rect class="barr" x="${x}" y="${B - hOk}" width="${bw - 6}" height="${hOk}" rx="2"><title>${tot} snapshot(s)</title></rect>`;
      if (b.err) svg += `<rect class="barr err" x="${x}" y="${B - hOk - hErr}" width="${bw - 6}" height="${hErr}" rx="2"/>`;
      svg += `<text x="${x + (bw - 6) / 2}" y="${B - hOk - hErr - 6}" text-anchor="middle" style="fill:var(--text)">${tot}</text>`;
    });
    for (let i = 0; i < N; i += 7) {
      const d = new Date(start.getTime() + i * 86400_000);
      svg += `<text x="${i * bw + 3}" y="${H - 6}">${d.toLocaleDateString(undefined, { month: "short", day: "numeric" })}</text>`;
    }
    el.querySelector("#chart").innerHTML = h`<div style="display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap"><div><h3 style="margin:0">Snapshots per day, last 5 weeks</h3>
      <div class="muted small" style="margin-top:4px">Older days thin out under each source's retention.</div></div>
      <div class="legend"><span><i style="background:var(--accent)"></i>Snapshots</span><span><i style="background:var(--warn)"></i>With read errors</span></div></div>${raw(svg + "</svg>")}`.s;
    el.querySelectorAll("#chart .legend i").forEach((i) => Object.assign(i.style, { width: "8px", height: "8px", borderRadius: "2px", display: "inline-block" }));
  }

  function drawBulk() {
    const box = el.querySelector("#bulk");
    if (!selected.size) return (box.innerHTML = "");
    const list = [...selected.values()];
    const isAdmin = can(session, "admin");
    box.innerHTML = h`<div class="bulkbar"><b>${list.length} selected</b>
      <span class="mono small muted">${list.length === 1 ? `${list[0].id.slice(0, 8)} ${list[0].source}, ${bytes(list[0].stats?.bytes ?? null)}` : bytes(list.reduce((a, s) => a + (s.stats?.bytes ?? 0), 0))}</span>
      <span class="grow"></span><span class="muted small hide-phone">Forget frees space at the next prune</span>
      <button class="btn ghost" id="clear">${icon("x")}Clear</button>
      <button class="btn danger" id="forget" ${isAdmin ? "" : "disabled"}>${icon("x")}Forget…</button>${isAdmin ? "" : adminTag()}</div>`.s;
    box.querySelector("#clear").onclick = () => {
      selected.clear();
      draw();
    };
    box.querySelector("#forget").onclick = () => forget(list);
  }

  async function forget(list) {
    const ok = await modal({
      title: `Forget ${list.length} snapshot${list.length === 1 ? "" : "s"}?`,
      body: h`<div class="notice warn">${icon("triangle-alert")}<div>Forgotten snapshots cannot be restored. Their data is freed at the next prune of the repository; files still used by other snapshots stay.</div></div>
        <div class="what-list">${list.map((s) => h`<div><span>${s.id.slice(0, 8)} · ${s.source} · ${stamp(Date.parse(s.time))}</span><span>${s.repo}</span></div>`)}</div>
        <div class="field"><label for="confirm-word">Type <b class="mono">forget</b> to confirm</label><input class="input mono" id="confirm-word" autocomplete="off" /></div>`,
      actions: [{ label: "Forget", kind: "danger", value: true }],
      onMount: (m) => {
        const btn = m.querySelector(".m-foot .btn.danger");
        btn.disabled = true;
        m.querySelector("#confirm-word").addEventListener("input", (e) => (btn.disabled = e.target.value.trim() !== "forget"));
        m.querySelector("#confirm-word").focus();
      },
    });
    if (!ok) return;
    const byRepo = new Map();
    for (const s of list) byRepo.set(s.repo, [...(byRepo.get(s.repo) ?? []), s.id]);
    try {
      let n = 0;
      for (const [repo, ids] of byRepo) n += (await api(`/api/repos/${encodeURIComponent(repo)}/forget`, { method: "POST", body: { ids } })).removed.length;
      toast(`${n} snapshot${n === 1 ? "" : "s"} forgotten`, "ok");
      for (const s of list) selected.delete(key(s));
      all = await api("/api/snapshots");
      draw();
    } catch (e) {
      toastError(e);
    }
  }

  toolbar();
  draw();
}

function dayTitle(k) {
  const d = new Date(k);
  if (d.toDateString() === new Date().toDateString()) return "Today";
  if (d.toDateString() === new Date(Date.now() - 86400_000).toDateString()) return "Yesterday";
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function parentOf(p) {
  const i = p.lastIndexOf("/");
  return i > 0 ? p.slice(0, i) : "";
}
