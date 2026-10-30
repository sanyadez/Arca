// Runs: what is running now and the history of every backup, prune, check and restore.
import { api, badge, h, icon, num, runDuration, sourcePath, t, tn, toast, toastError, trigger, when, duration } from "../lib.js";
import { progressOf } from "./overview.js";

const PAGE = 25;
const DAYS = 7;
const KIND_ICON = { backup: "upload", prune: "scissors", check: "shield", restore: "history", forget: "scissors" };
const KIND_LABEL = { backup: t("Backup"), prune: t("Prune"), check: t("Check"), restore: t("Restore"), forget: t("Forget") };

export async function page(el, _params, { navigate }) {
  const qs = new URLSearchParams(location.hash.split("?")[1] ?? "");
  const f = { kind: qs.get("kind") ?? "", status: qs.get("status") ?? "", trigger: qs.get("trigger") ?? "", q: qs.get("q") ?? "", source: qs.get("source") ?? "", offset: 0 };
  let timer = null;
  let stopped = false;
  let sources = new Map();

  el.innerHTML = h`
    <div class="page-head">
      <div><h1>${t("Runs")}</h1><div class="sub" id="runs-sub">${tn("Every backup, prune, check and restore in the last {n} day", "Every backup, prune, check and restore in the last {n} days", DAYS)}</div></div>
      <div class="actions"><label class="search">${icon("search")}<input class="input" id="q" type="search" placeholder="${t("Search source, token or summary")}" value="${f.q}" /></label></div>
    </div>
    <div id="active"></div>
    <div class="card" style="margin-top:24px">
      <div class="filters" id="filters"></div>
      <div id="table"></div>
    </div>`.s;

  let qTimer;
  el.querySelector("#q").addEventListener("input", (e) => {
    clearTimeout(qTimer);
    qTimer = setTimeout(() => {
      f.q = e.target.value.trim();
      f.offset = 0;
      reload();
    }, 250);
  });

  async function load() {
    const p = new URLSearchParams({ days: String(DAYS), limit: String(PAGE), offset: String(f.offset) });
    for (const k of ["kind", "status", "trigger", "q", "source"]) if (f[k]) p.set(k, f[k]);
    try {
      const [data, overview] = await Promise.all([api(`/api/runs?${p}`), sources.size ? null : api("/api/sources").catch(() => [])]);
      if (overview) sources = new Map(overview.map((s) => [s.name, s]));
      if (stopped) return;
      draw(data);
    } catch (e) {
      if (e.status) toastError(e);
    } finally {
      if (!stopped) timer = setTimeout(load, 4000);
    }
  }
  const reload = () => {
    clearTimeout(timer);
    load();
  };

  function draw(d) {
    const running = d.active.filter((a) => a.status === "running").length;
    const queued = d.active.length - running;
    el.querySelector("#active").innerHTML = d.active.length
      ? h`<h2 class="section" style="margin-top:0">${t("Running now")} <span class="muted">${queued ? t("{running} running, {queued} queued", { running, queued }) : t("{n} running", { n: running })}</span></h2>
        <div class="card">${d.active.map(activeRow)}</div>`.s
      : "";
    el.querySelector("#filters").innerHTML = h`
      ${f.source ? h`<div class="chip-group"><span class="label">${t("Source")}</span><button class="chip on" data-clear-source>${f.source} ${icon("x")}</button></div>` : ""}
      ${chips(t("Type"), "kind", [["", t("All")], ["backup", t("Backup")], ["prune", t("Prune")], ["check", t("Check")], ["restore", t("Restore")]])}
      ${chips(t("Status"), "status", [["", t("All")], ["error", t("Failed"), "danger"], ["warning", t("Warning"), "warn"], ["running", t("Running"), "info"], ["interrupted", t("Interrupted"), "interrupted"]], d.statusCounts)}
      ${chips(t("Trigger"), "trigger", [["", t("All")], ["schedule", t("Schedule")], ["api", "API"], ["mcp", "MCP"]])}`.s;
    el.querySelector("#table").innerHTML = (d.runs.length ? h`<div class="hide-phone">${table(d.runs)}</div><div class="show-phone" style="padding:0 12px 12px">${phoneRuns(d.runs)}</div>` : h`<div class="empty-ok">${icon("info")}${tn("No runs match these filters in the last {n} day.", "No runs match these filters in the last {n} days.", DAYS)}</div>`).s +
      h`<div class="pager"><span>${tn("{shown} of {n} run in the last {days} days.", "{shown} of {n} runs in the last {days} days.", d.total, { shown: num(Math.min(d.total, f.offset + d.runs.length)), days: DAYS })}</span>
        <div class="btns"><button class="btn secondary" id="prev" ${f.offset === 0 ? "disabled" : ""}>${icon("chevron-left")}${t("Previous")}</button>
        <button class="btn secondary" id="next" ${f.offset + PAGE >= d.total ? "disabled" : ""}>${t("Next")}${icon("chevron-right")}</button></div></div>`.s;

    el.querySelectorAll("[data-f]").forEach((b) => (b.onclick = () => {
      f[b.dataset.f] = b.dataset.v;
      f.offset = 0;
      reload();
    }));
    el.querySelector("[data-clear-source]")?.addEventListener("click", () => {
      f.source = "";
      reload();
    });
    el.querySelector("#prev").onclick = () => ((f.offset = Math.max(0, f.offset - PAGE)), reload());
    el.querySelector("#next").onclick = () => ((f.offset += PAGE), reload());
    el.querySelectorAll("tr[data-id], .list-row[data-id]").forEach((r) => (r.onclick = (e) => !e.target.closest("button") && navigate(`runs/${r.dataset.id}`)));
    el.querySelectorAll("[data-cancel]").forEach((b) => (b.onclick = async () => {
      try {
        await api(`/api/runs/${b.dataset.cancel}/cancel`, { method: "POST" });
        toast(t("Run #{id} is being cancelled", { id: b.dataset.cancel }));
        reload();
      } catch (e) {
        toastError(e);
      }
    }));
  }

  function chips(label, key, opts, counts) {
    return h`<div class="chip-group"><span class="label">${label}</span>${opts.map(([v, l, color]) => {
      const n = counts && v ? counts[v] : null;
      return h`<button class="chip ${f[key] === v ? "on" : ""}" data-f="${key}" data-v="${v}">${color ? h`<span class="dot" style="background:var(--${color})"></span>` : ""}${l}${n ? h` <span class="count">${n}</span>` : ""}</button>`;
    })}</div>`;
  }

  function target(r) {
    const isSource = r.kind === "backup" || (r.kind === "restore" && r.source);
    return h`<span class="nowrap">${icon(isSource ? "folder" : "database")} ${r.source ?? r.repo}</span>`;
  }

  function activeRow(a) {
    const pr = progressOf(a.progress);
    const src = a.source && sources.get(a.source);
    return h`<div class="list-row" data-id="${a.id}" style="height:auto;padding:16px 24px;gap:20px;cursor:pointer;flex-wrap:wrap">
      <span style="width:110px">${badge(a.status)}</span>
      <div style="flex:1 1 260px;min-width:0"><div>${icon(KIND_ICON[a.kind])} <b>${a.source ?? a.repo}</b> <span class="muted">${a.source ? t("{kind} to {repo}", { kind: (KIND_LABEL[a.kind] ?? a.kind).toLowerCase(), repo: a.repo }) : (KIND_LABEL[a.kind] ?? a.kind).toLowerCase()}</span> <span class="mono small muted">#${a.id}</span></div>
        <div style="margin-top:2px">${src ? sourcePath(src.path) : h`<span class="path">${a.repo}</span>`}</div></div>
      <div style="flex:1 1 260px">${a.status === "queued" ? h`<span class="muted small">${t("Waits for the previous job on {repo}", { repo: a.repo })}</span>`
        : h`<div style="display:flex;justify-content:space-between" class="mono small"><span>${pr.pct === null ? "…" : `${pr.pct}%`}</span></div>
           <div class="bar ${pr.pct === null ? "indeterminate" : ""}" style="margin:6px 0"><span style="width:${pr.pct ?? 0}%"></span></div>
           <div class="mono small muted">${pr.line}${pr.files ? `, ${pr.files}` : ""}</div>`}</div>
      <span class="tag mono">${trigger(a.trigger)}</span>
      <button class="btn secondary" data-cancel="${a.id}">${icon("x")}${t("Cancel")}</button>
    </div>`;
  }

  function phoneRuns(runs) {
    let lastDay = "";
    return runs.map((r) => {
      const day = dayGroup(r.started);
      const head = day !== lastDay ? h`<div class="m-day">${day}</div>` : "";
      lastDay = day;
      return h`${head}<a class="card m-card" href="#/runs/${r.id}" style="margin-top:8px">
        <div class="top">${badge(r.status)}<span class="meta">${when(r.started)} · ${duration(runDuration(r))}</span></div>
        <div class="top"><span class="ttl">${KIND_LABEL[r.kind] ?? r.kind} · ${r.source ?? r.repo}</span>${icon("chevron-right")}</div>
        ${r.summary ? h`<div class="meta" style="white-space:normal">${r.summary}</div>` : ""}</a>`;
    });
  }

  function table(runs) {
    return h`<div class="table-wrap"><table class="t">
      <thead><tr><th>${t("Status")}</th><th>${t("Type")}</th><th>${t("Target")}</th><th class="hide-phone">${t("Trigger")}</th><th>${t("Started")}</th><th class="right hide-phone">${t("Duration")}</th><th class="hide-phone">${t("Summary")}</th></tr></thead>
      <tbody>${runs.map((r) => h`<tr class="click ${r.status === "error" ? "err" : ""}" data-id="${r.id}">
        <td>${badge(r.status)}</td>
        <td class="nowrap">${icon(KIND_ICON[r.kind] ?? "activity")} ${KIND_LABEL[r.kind] ?? r.kind}</td>
        <td class="name">${target(r)}</td>
        <td class="hide-phone"><span class="tag mono">${trigger(r.trigger)}</span></td>
        <td class="mono nowrap">${when(r.started)}</td>
        <td class="num hide-phone">${duration(runDuration(r))}</td>
        <td class="mono hide-phone" style="max-width:420px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${r.summary ?? ""}">${r.summary ?? ""}</td>
      </tr>`)}</tbody></table></div>`;
  }

  await load();
  return () => {
    stopped = true;
    clearTimeout(timer);
  };
}

function dayGroup(iso) {
  const d = new Date(iso);
  if (d.toDateString() === new Date().toDateString()) return t("Today");
  if (d.toDateString() === new Date(Date.now() - 86400_000).toDateString()) return t("Yesterday");
  return t("Earlier");
}
