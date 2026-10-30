// Settings: what this server is and how it is set up; the web UI's own preferences; the config file.
import { api, can, h, icon, modal, toast, toastError } from "../lib.js";

export async function page(el, _params, { session }) {
  const s = session.server;
  const isAdmin = can(session, "admin");
  const theme = localStorage.getItem("arca-theme") || "system";
  const [version, build] = s.version.split(" ");

  el.innerHTML = h`
    <div class="page-head"><div><h1>Settings</h1><div class="sub">Server, web interface and configuration for ${s.host}</div></div></div>
    <div class="side-grid">
      <div class="stack" style="gap:24px">
        <div class="card">
          <div class="card-head"><span style="display:flex;gap:8px;align-items:center">${icon("server")}Server</span></div>
          ${row("Name", "How this server is labelled: its host name", h`<span class="mono">${s.host}</span>`)}
          ${row("Time zone", "Schedules run in the server's local time", h`<span class="mono">${s.timeZone ?? "—"}</span><div class="hint">Change it with the TZ variable of the service.</div>`)}
          ${row("Listen address", "Change it in the config file; applies after a restart", h`<span class="mono">${s.listen ? `${s.listen.host}:${s.listen.port}` : "—"}</span>`)}
          ${row("HTTPS", "Arca serves plain HTTP; put it behind a reverse proxy for HTTPS", h`<span class="badge ${location.protocol === "https:" ? "ok" : "never"}"><span class="dot"></span>${location.protocol === "https:" ? "This page came over HTTPS" : "Not over HTTPS"}</span>`)}
          ${row("Restore folder", "Restores from the web UI and MCP land below it", h`<span class="mono">${s.restoreRoot}</span>`)}
        </div>
        <div class="card">
          <div class="card-head"><span style="display:flex;gap:8px;align-items:center">${icon("monitor")}Web UI</span></div>
          ${row("Theme", "Applies to this browser", h`<div class="seg wide" id="theme">${[["light", "sun", "Light"], ["dark", "moon", "Dark"], ["system", "monitor", "System"]].map(([v, i, l]) => h`<button type="button" data-t="${v}" class="${theme === v ? "on" : ""}">${icon(i)}${l}</button>`)}</div>`)}
          ${row("Session length", "12 hours of inactivity, or 30 days with “Keep me signed in”", h`<span class="muted">Fixed for now</span>`)}
          ${row("All sessions", "Ends every web session of your token, including this one. API tokens keep working.", h`<button class="btn secondary" id="out-all">${icon("log-out")}Sign out everywhere</button>`)}
        </div>
      </div>
      <div class="stack" style="gap:24px">
        <div class="card">
          <div class="card-head"><span style="display:flex;gap:8px;align-items:center">${icon("info")}Notifications <span class="tag">Soon</span></span></div>
          <div style="padding:16px 24px" class="muted">Coming: email, ntfy and webhooks when a backup fails. Until then the Overview shows what needs attention.</div>
        </div>
        <div class="card pad">
          <h3 style="display:flex;gap:8px;align-items:center">${icon("file")}Config</h3>
          <div class="code">${s.configFile ?? "started without a config file"}</div>
          <p class="muted small" style="margin:12px 0 0">Changes made in the web UI are written to this file at once, after the whole config has been checked. Edited it by hand? Restart the service to apply it.</p>
        </div>
        <div class="card">
          <div class="card-head"><span style="display:flex;gap:8px;align-items:center">${icon("info")}About</span><a class="btn secondary sm" href="https://github.com/sanyadez/Arca/releases" target="_blank" rel="noopener">${icon("refresh-cw")}Check for updates</a></div>
          <dl class="kv" style="padding:16px 24px">
            <dt>Version</dt><dd class="mono">Arca ${version}</dd>
            <dt>Build</dt><dd class="mono">${(build ?? "").replace(/[()]/g, "")}</dd>
            <dt>License</dt><dd>MIT</dd>
            <dt>Source</dt><dd><a href="https://github.com/sanyadez/Arca" target="_blank" rel="noopener">GitHub ${icon("external-link")}</a></dd>
            <dt>Signed in as</dt><dd>${session.name} <span class="muted">(${session.scopes.join(", ")})</span></dd>
          </dl>
        </div>
      </div>
    </div>`.s;

  el.querySelectorAll("#theme [data-t]").forEach((b) => (b.onclick = () => {
    document.querySelector(`.seg [data-theme-set="${b.dataset.t}"]`)?.click();
    el.querySelectorAll("#theme button").forEach((x) => x.classList.toggle("on", x === b));
  }));
  el.querySelector("#out-all").onclick = async () => {
    const ok = await modal({ title: "Sign out everywhere?", body: h`<p style="margin:0">Every web session signed in with the token <b>${session.name}</b> ends, including this one.</p>`, actions: [{ label: "Sign out everywhere", kind: "danger", value: true }] });
    if (!ok) return;
    try {
      await api("/api/sessions", { method: "DELETE" });
      location.reload();
    } catch (e) {
      toastError(e);
    }
  };
  void isAdmin;
  void toast;
}

function row(label, hint, control) {
  return h`<div style="display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1.4fr);gap:24px;padding:16px 24px;border-top:1px solid var(--border);align-items:center">
    <div><div style="font-weight:500">${label}</div><div class="muted small">${hint}</div></div><div>${control}</div></div>`;
}
