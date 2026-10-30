// One run: live progress with stages, counters and log (SSE), or the result with per-file errors.
import { api, badge, bytes, can, clock, copyText, duration, h, icon, num, raw, runDuration, toast, toastError, trigger } from "../lib.js";

const KIND_LABEL = { backup: "Backup", prune: "Prune", check: "Check", restore: "Restore", forget: "Forget" };

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
    <div class="crumbs"><a href="#/runs">Runs</a>${icon("chevron-right")}<span class="cur mono">#${run.id}</span></div>
    <div class="page-head">
      <div><h1 id="h1"></h1><div class="sub" id="sub"></div></div>
      <div class="actions" id="actions"></div>
    </div>
    <div class="side-grid">
      <div>
        <div class="card" id="main"></div>
        <div id="errors"></div>
        <div class="section-row" style="margin-top:28px"><h2 class="section" style="margin:0">Log <span class="muted" id="log-state"></span></h2>
          <div class="actions" style="display:flex;gap:8px"><button class="btn ghost" id="pause">${icon("pause")}Pause</button><button class="btn ghost" id="copy">${icon("copy")}Copy log</button></div></div>
        <div class="log" id="log" style="margin-top:12px"></div>
      </div>
      <div class="card pad" id="details"></div>
    </div>`.s;

  const $ = (s) => el.querySelector(s);
  $("#pause").onclick = () => {
    paused = !paused;
    $("#pause").innerHTML = h`${icon(paused ? "play" : "pause")}${paused ? "Follow" : "Pause"}`.s;
    drawLog();
  };
  $("#copy").onclick = () => copyText(state.log.map((l) => `${clock(l.t)} ${l.stage.padEnd(7)} ${l.text}`).join("\n"));

  function live() {
    return state.status === "running" || state.status === "queued";
  }

  function drawHead() {
    const r = state.run;
    $("#h1").innerHTML = h`${KIND_LABEL[r.kind] ?? r.kind} · ${r.source ?? r.repo} ${badge(state.status)}`.s;
    $("#sub").innerHTML = h`${r.status === "queued" && state.status === "queued" ? "Queued" : "Started"} <span class="mono">${clock(r.started)}</span> by ${trigger(r.trigger)}${
      !live() && r.finished ? h` · took ${duration(runDuration(r))}` : ""}`.s;
    $("#actions").innerHTML = live() && can(session, "backup") ? h`<button class="btn secondary" id="cancel">${icon("x")}Cancel run</button>`.s : "";
    $("#cancel")?.addEventListener("click", async () => {
      try {
        await api(`/api/runs/${r.id}/cancel`, { method: "POST" });
        toast("Cancelling…");
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
      ${state.status === "queued" ? h`<div class="notice info">${icon("clock")}<div>Waiting for the previous job on <b>${r.repo}</b> to finish.</div></div>`
        : h`<div class="notice ${state.status === "error" ? "danger" : state.status === "warning" ? "warn" : "info"}">${icon(state.status === "ok" ? "check" : state.status === "running" ? "loader-circle" : "info")}<div class="mono">${r.summary ?? "In progress…"}</div></div>`}
      ${st ? statsGrid(st) : ""}
    </div>`.s;
  }

  function statsGrid(st) {
    return h`<div class="counters" style="grid-template-columns:1fr"><div class="grp" style="grid-template-columns:repeat(4,1fr)">
      <div><div class="v">${num(st.files)}</div><div class="l">files</div></div>
      <div><div class="v">${bytes(st.bytes)}</div><div class="l">total size</div></div>
      <div><div class="v">${bytes(st.newBytes)}</div><div class="l">new data</div></div>
      <div><div class="v">${num(st.errors)}</div><div class="l">read errors</div></div></div></div>`;
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
      ["Scan files", `${num(p.filesTotal ?? 0)} files`],
      ["Read changed", `${bytes(p.bytesRead ?? 0)} of ${bytes(p.bytesToRead ?? 0)}`],
      ["Upload new chunks", bytes(p.newBytes ?? 0)],
      ["Write snapshot", finished && state.run.snapshot ? state.run.snapshot.slice(0, 8) : "—"],
    ];
    $("#main").innerHTML = h`<div class="run-main">
      <div class="run-top">
        <div class="pct">${pct === null ? "…" : `${pct}%`}</div>
        <div class="of"><span>${bytes(p.bytesRead ?? 0)} of ${bytes(p.bytesToRead ?? 0)}</span><span class="muted">${num(p.filesTotal ?? 0)} files</span></div>
        <div class="stats">
          <div class="stat"><div class="label">Speed</div><div class="v">${speed && !finished ? `${bytes(speed)}/s` : "—"}</div></div>
          <div class="stat"><div class="label">ETA</div><div class="v">${eta !== null ? duration(eta) : finished ? "done" : "—"}</div></div>
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
          <div class="st">${done ? "Done" : active ? "In progress" : stage === "queued" ? "Queued" : "Waiting"}</div></div>`;
      })}</div>
      <div class="counters">
        <div class="grp"><div class="head">Files</div>
          <div><div class="v">${num(p.filesNew ?? 0)}</div><div class="l">new</div></div>
          <div><div class="v">${num(p.filesChanged ?? 0)}</div><div class="l">changed</div></div>
          <div><div class="v">${num(p.filesUnchanged ?? 0)}</div><div class="l">unchanged</div></div></div>
        <div class="grp two"><div class="head">Chunks</div>
          <div><div class="v">${num(p.chunksNew ?? 0)}</div><div class="l">new</div></div>
          <div><div class="v">${num(p.chunksReused ?? 0)}</div><div class="l">reused</div></div></div>
      </div>
      ${finished && state.run.summary ? h`<div class="notice ${state.status === "error" ? "danger" : state.status === "warning" ? "warn" : state.status === "ok" ? "info" : "warn"}" style="margin-top:20px">${icon(state.status === "ok" ? "check" : "info")}<div class="mono">${state.run.summary}</div></div>` : ""}
    </div>`.s;
  }

  function drawErrors() {
    const errs = state.run.details?.errors ?? [];
    $("#errors").innerHTML = errs.length
      ? h`<h2 class="section">Files that could not be read <span class="muted">${errs.length}</span></h2>
        <div class="card"><div class="table-wrap"><table class="t"><thead><tr><th>Path</th><th>Error</th></tr></thead>
        <tbody>${errs.map((e) => h`<tr><td class="mono">${e.path || "/"}</td><td class="mono muted">${e.error}</td></tr>`)}</tbody></table></div></div>
        <div class="notice info" style="margin-top:12px">${icon("info")}<div>Files the source user cannot read are skipped, the rest of the snapshot is saved. Give read access to them or exclude them from the source.</div></div>`.s
      : "";
  }

  function drawLog() {
    const box = $("#log");
    const lines = state.log;
    $("#log-state").innerHTML = live() ? (paused ? "Paused" : h`<span style="color:var(--info)">●</span> Following new lines`.s) : `${lines.length} lines`;
    box.innerHTML = lines.length
      ? lines.map((l, i) => h`<div class="line ${i === lines.length - 1 && live() ? "last" : ""} ${/^(Cannot|Failed)/.test(l.text) ? "fail" : ""}"><span class="t">${clock(l.t)}:${new Date(l.t).getSeconds().toString().padStart(2, "0")}</span><span class="s">${l.stage}</span><span class="x">${l.text}</span></div>`.s).join("")
      : h`<span class="muted">No log lines.</span>`.s;
    if (live() && !paused) box.scrollTop = box.scrollHeight;
  }

  function drawDetails() {
    const r = state.run;
    const rows = [
      r.source && ["Source", h`<span>${r.source}</span>`],
      src && ["Path", h`<span class="mono small" style="word-break:break-all">${src.path}</span>`],
      ["Repository", h`<span>${r.repo}</span>`],
      ["Run", h`<span class="mono small">#${r.id}</span>`],
      r.snapshot && ["Snapshot", h`<span class="mono small">${r.snapshot.slice(0, 8)}</span>`],
      src && ["Retention", src.retention ? h`<span>${badge("ok")}</span>` : h`<span class="muted">Off</span>`],
    ].filter(Boolean);
    const ret = src?.retention ? Object.entries(src.retention).map(([k, v]) => `${k} ${v}`).join(", ") : "";
    $("#details").innerHTML = h`<b style="font-weight:600">Details</b>
      <dl class="kv" style="margin-top:14px">${rows.map(([k, v]) => h`<dt>${k}</dt><dd>${v}</dd>`)}</dl>
      ${ret ? h`<p class="muted small" style="margin:14px 0 0">After the snapshot, retention keeps: ${ret}.</p>` : ""}`.s;
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

