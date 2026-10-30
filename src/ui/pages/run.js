// One run: live progress with stages, counters and log (SSE), or the result with per-file errors.
import { api, badge, bytes, can, clock, copyText, duration, h, ht, icon, num, raw, runDuration, t, tn, toast, toastError, trigger } from "../lib.js";

const KIND_LABEL = { backup: t("Backup"), prune: t("Prune"), check: t("Check"), restore: t("Restore"), forget: t("Forget") };

export async function page(el, { id }, { session }) {
  const run = await api(`/api/runs/${id}`);
  const sources = await api("/api/sources").catch(() => []);
  const src = run.source ? sources.find((s) => s.name === run.source) : null;
  let state = { run, status: run.status, progress: run.progress, log: run.log ?? [] };
  let es = null;
  let paused = false;
  let speed = null; // bytes/s, smoothed
  let lastSample = null;

  el.innerHTML = h`
    <div class="crumbs"><a href="#/runs">${t("Runs")}</a>${icon("chevron-right")}<span class="cur mono">#${run.id}</span></div>
    <div class="page-head">
      <div><h1 id="h1"></h1><div class="sub" id="sub"></div></div>
      <div class="actions" id="actions"></div>
    </div>
    <div class="side-grid">
      <div>
        <div class="card" id="main"></div>
        <div id="errors"></div>
        <div class="section-row" style="margin-top:28px"><h2 class="section" style="margin:0">${t("Log")} <span class="muted" id="log-state"></span></h2>
          <div class="actions" style="display:flex;gap:8px"><button class="btn ghost" id="pause">${icon("pause")}${t("Pause")}</button><button class="btn ghost" id="copy">${icon("copy")}${t("Copy log")}</button></div></div>
        <div class="log" id="log" style="margin-top:12px"></div>
      </div>
      <div class="card pad" id="details"></div>
    </div>`.s;

  const $ = (s) => el.querySelector(s);
  $("#pause").onclick = () => {
    paused = !paused;
    $("#pause").innerHTML = h`${icon(paused ? "play" : "pause")}${paused ? t("Follow") : t("Pause")}`.s;
    drawLog();
  };
  $("#copy").onclick = () => copyText(state.log.map((l) => `${clock(l.t)} ${l.stage.padEnd(7)} ${l.text}`).join("\n"));

  function live() {
    return state.status === "running" || state.status === "queued";
  }

  function drawHead() {
    const r = state.run;
    $("#h1").innerHTML = h`${KIND_LABEL[r.kind] ?? r.kind} · ${r.source ?? r.repo} ${badge(state.status)}`.s;
    const at = h`<span class="mono">${clock(r.started)}</span>`;
    $("#sub").innerHTML = h`${r.status === "queued" && state.status === "queued" ? ht("Queued {time} by {trigger}", { time: at, trigger: trigger(r.trigger) }) : ht("Started {time} by {trigger}", { time: at, trigger: trigger(r.trigger) })}${
      !live() && r.finished ? h` · ${t("took {duration}", { duration: duration(runDuration(r)) })}` : ""}`.s;
    $("#actions").innerHTML = live() && can(session, "backup") ? h`<button class="btn secondary" id="cancel">${icon("x")}${t("Cancel run")}</button>`.s : "";
    $("#cancel")?.addEventListener("click", async () => {
      try {
        await api(`/api/runs/${r.id}/cancel`, { method: "POST" });
        toast(t("Cancelling…"));
      } catch (e) {
        toastError(e);
      }
    });
  }

  function drawMain() {
    const r = state.run;
    const p = state.progress;
    if (r.kind === "backup" && (live() || p)) return drawBackupProgress(p);
    const st = r.details?.stats;
    $("#main").innerHTML = h`<div class="run-main">
      ${state.status === "queued" ? h`<div class="notice info">${icon("clock")}<div>${ht("Waiting for the previous job on {repo} to finish.", { repo: h`<b>${r.repo}</b>` })}</div></div>`
        : h`<div class="notice ${state.status === "error" ? "danger" : state.status === "warning" ? "warn" : "info"}">${icon(state.status === "ok" ? "check" : state.status === "running" ? "loader-circle" : "info")}<div class="mono">${r.summary ?? t("In progress…")}</div></div>`}
      ${st ? statsGrid(st) : ""}
    </div>`.s;
  }

  function statsGrid(st) {
    return h`<div class="counters" style="grid-template-columns:1fr"><div class="grp" style="grid-template-columns:repeat(4,1fr)">
      <div><div class="v">${num(st.files)}</div><div class="l">${t("files")}</div></div>
      <div><div class="v">${bytes(st.bytes)}</div><div class="l">${t("total size")}</div></div>
      <div><div class="v">${bytes(st.newBytes)}</div><div class="l">${t("new data")}</div></div>
      <div><div class="v">${num(st.errors)}</div><div class="l">${t("read errors")}</div></div></div></div>`;
  }

  function drawBackupProgress(p) {
    p = p ?? {};
    const stage = state.status === "queued" ? "queued" : p.stage ?? "scan";
    const finished = !live();
    const pct = finished ? 100 : stage === "read" ? (p.bytesToRead ? Math.min(100, Math.floor((p.bytesRead / p.bytesToRead) * 100)) : 100) : stage === "write" || stage === "done" ? 100 : null;
    const remaining = (p.bytesToRead ?? 0) - (p.bytesRead ?? 0);
    const eta = speed && stage === "read" && remaining > 0 ? remaining / speed : null;
    const order = ["scan", "read", "upload", "write"];
    const idx = finished ? 4 : stage === "scan" ? 0 : stage === "read" ? 1 : 3;
    const stageInfo = [
      [t("Scan files"), tn("{n} file", "{n} files", p.filesTotal ?? 0)],
      [t("Read changed"), t("{done} of {total}", { done: bytes(p.bytesRead ?? 0), total: bytes(p.bytesToRead ?? 0) })],
      [t("Upload new chunks"), bytes(p.newBytes ?? 0)],
      [t("Write snapshot"), finished && state.run.snapshot ? state.run.snapshot.slice(0, 8) : "—"],
    ];
    $("#main").innerHTML = h`<div class="run-main">
      <div class="run-top">
        <div class="pct">${pct === null ? "…" : `${pct}%`}</div>
        <div class="of"><span>${t("{done} of {total}", { done: bytes(p.bytesRead ?? 0), total: bytes(p.bytesToRead ?? 0) })}</span><span class="muted">${tn("{n} file", "{n} files", p.filesTotal ?? 0)}</span></div>
        <div class="stats">
          <div class="stat"><div class="label">${t("Speed")}</div><div class="v">${speed && !finished ? t("{size}/s", { size: bytes(speed) }) : "—"}</div></div>
          <div class="stat"><div class="label">${t("ETA")}</div><div class="v">${eta !== null ? duration(eta) : finished ? t("done") : "—"}</div></div>
        </div>
      </div>
      <div class="bar ${pct === null ? "indeterminate" : ""}"><span style="width:${pct ?? 0}%;${finished && state.status === "ok" ? "background:var(--ok)" : ""}"></span></div>
      <div class="stages">${order.map((s, i) => {
        // "upload" runs alongside "read": both are active during the read pass.
        const done = i < idx && !(s === "upload" && idx === 1);
        const active = !finished && (i === idx || (s === "upload" && idx === 1));
        return h`<div class="stage ${done ? "done" : active ? "active" : ""}">
          <div class="mark"><span class="c">${done ? icon("check") : active ? icon("loader-circle", "spin") : i + 1}</span>${i < 3 ? raw('<span class="line"></span>') : ""}</div>
          <div class="name">${stageInfo[i][0]}</div><div class="val">${stageInfo[i][1]}</div>
          <div class="st">${done ? t("Done") : active ? t("In progress") : stage === "queued" ? t("Queued") : t("Waiting")}</div></div>`;
      })}</div>
      <div class="counters">
        <div class="grp"><div class="head">${t("Files")}</div>
          <div><div class="v">${num(p.filesNew ?? 0)}</div><div class="l">${t("new")}</div></div>
          <div><div class="v">${num(p.filesChanged ?? 0)}</div><div class="l">${t("changed")}</div></div>
          <div><div class="v">${num(p.filesUnchanged ?? 0)}</div><div class="l">${t("unchanged")}</div></div></div>
        <div class="grp two"><div class="head">${t("Chunks")}</div>
          <div><div class="v">${num(p.chunksNew ?? 0)}</div><div class="l">${t("new")}</div></div>
          <div><div class="v">${num(p.chunksReused ?? 0)}</div><div class="l">${t("reused")}</div></div></div>
      </div>
      ${finished && state.run.summary ? h`<div class="notice ${state.status === "error" ? "danger" : state.status === "warning" ? "warn" : state.status === "ok" ? "info" : "warn"}" style="margin-top:20px">${icon(state.status === "ok" ? "check" : "info")}<div class="mono">${state.run.summary}</div></div>` : ""}
    </div>`.s;
  }

  function drawErrors() {
    const errs = state.run.details?.errors ?? [];
    $("#errors").innerHTML = errs.length
      ? h`<h2 class="section">${t("Files that could not be read")} <span class="muted">${errs.length}</span></h2>
        <div class="card"><div class="table-wrap"><table class="t"><thead><tr><th>${t("Path")}</th><th>${t("Error")}</th><th></th></tr></thead>
        <tbody>${errs.map((e) => h`<tr><td class="mono">${e.path || "/"}</td><td class="mono muted">${e.error}</td>
          <td class="right">${state.run.source && e.path && can(session, "admin") ? h`<button class="btn secondary sm" data-exclude="${e.path}">${icon("plus")}${t("Add exclude")}</button>` : ""}</td></tr>`)}</tbody></table></div></div>
        <div class="notice info" style="margin-top:12px">${icon("info")}<div>${t("Files the source user cannot read are skipped, the rest of the snapshot is saved. Give read access to them or exclude them from the source.")}</div></div>`.s
      : "";
    $("#errors").querySelectorAll("[data-exclude]").forEach((b) => (b.onclick = async () => {
      const pattern = `/${b.dataset.exclude}`;
      try {
        await api(`/api/sources/${encodeURIComponent(state.run.source)}/exclude`, { method: "POST", body: { pattern } });
        toast(ht("Excluded {pattern} from {source}; the next backup skips it", { pattern: h`<span class="mono">${pattern}</span>`, source: state.run.source }), "ok");
        b.disabled = true;
        b.innerHTML = h`${icon("check")}${t("Excluded")}`.s;
      } catch (e) {
        toastError(e);
      }
    }));
  }

  function drawLog() {
    const box = $("#log");
    const lines = state.log;
    $("#log-state").innerHTML = live() ? (paused ? t("Paused") : h`<span style="color:var(--info)">●</span> ${t("Following new lines")}`.s) : tn("{n} line", "{n} lines", lines.length);
    box.innerHTML = lines.length
      ? lines.map((l, i) => h`<div class="line ${i === lines.length - 1 && live() ? "last" : ""} ${/^(Cannot|Failed)/.test(l.text) ? "fail" : ""}"><span class="t">${clock(l.t)}:${new Date(l.t).getSeconds().toString().padStart(2, "0")}</span><span class="s">${l.stage}</span><span class="x">${l.text}</span></div>`.s).join("")
      : h`<span class="muted">${t("No log lines.")}</span>`.s;
    if (live() && !paused) box.scrollTop = box.scrollHeight;
  }

  function drawDetails() {
    const r = state.run;
    const rows = [
      r.source && [t("Source"), h`<span>${r.source}</span>`],
      src && [t("Path"), h`<span class="mono small" style="word-break:break-all">${src.path}</span>`],
      [t("Repository"), h`<span>${r.repo}</span>`],
      [t("Run"), h`<span class="mono small">#${r.id}</span>`],
      r.snapshot && [t("Snapshot"), h`<span class="mono small">${r.snapshot.slice(0, 8)}</span>`],
      src && [t("Retention"), src.retention ? h`<span>${badge("ok")}</span>` : h`<span class="muted">${t("Off")}</span>`],
    ].filter(Boolean);
    const ret = src?.retention ? Object.entries(src.retention).map(([k, v]) => `${k} ${v}`).join(", ") : "";
    $("#details").innerHTML = h`<b style="font-weight:600">${t("Details")}</b>
      <dl class="kv" style="margin-top:14px">${rows.map(([k, v]) => h`<dt>${k}</dt><dd>${v}</dd>`)}</dl>
      ${ret ? h`<p class="muted small" style="margin:14px 0 0">${t("After the snapshot, retention keeps: {rules}.", { rules: ret })}</p>` : ""}`.s;
  }

  function drawAll() {
    drawHead();
    drawMain();
    drawErrors();
    drawLog();
    drawDetails();
  }

  function sampleSpeed(p) {
    if (!p || p.stage !== "read") return;
    const now = performance.now();
    if (lastSample && now > lastSample.t) {
      const v = ((p.bytesRead - lastSample.b) * 1000) / (now - lastSample.t);
      if (v >= 0) speed = speed === null ? v : speed * 0.7 + v * 0.3;
    }
    lastSample = { t: now, b: p.bytesRead };
  }

  drawAll();
  if (live()) {
    es = new EventSource(`/api/runs/${id}/events`);
    es.addEventListener("init", (e) => {
      const d = JSON.parse(e.data);
      state = { run: d.run, status: d.status, progress: d.progress, log: d.log };
      drawAll();
    });
    es.addEventListener("state", (e) => {
      state.status = JSON.parse(e.data).status;
      drawHead();
      drawMain();
    });
    es.addEventListener("progress", (e) => {
      state.progress = JSON.parse(e.data).progress;
      sampleSpeed(state.progress);
      drawMain();
    });
    es.addEventListener("log", (e) => {
      state.log.push(JSON.parse(e.data).line);
      if (state.log.length > 1000) state.log.shift();
      drawLog();
    });
    es.addEventListener("done", async () => {
      es.close();
      const full = await api(`/api/runs/${id}`).catch(() => null);
      if (full) state = { run: full, status: full.status, progress: state.progress, log: full.log ?? state.log };
      else state.status = "ok";
      drawAll();
    });
  }
  return () => es?.close();
}

