// Settings: what this server is and how it is set up; the web UI's own preferences; the config file.
import { api, bindLang, can, h, ht, icon, langSelect, modal, t, toast, toastError } from "../lib.js";

export async function page(el, _params, { session }) {
  const s = session.server;
  const isAdmin = can(session, "admin");
  const theme = localStorage.getItem("arca-theme") || "system";
  const [version, build] = s.version.split(" ");

  el.innerHTML = h`
    <div class="page-head"><div><h1>${t("Settings")}</h1><div class="sub">${t("Server, web interface and configuration for {host}", { host: s.host })}</div></div></div>
    <div class="side-grid">
      <div class="stack" style="gap:24px">
        <div class="card">
          <div class="card-head"><span style="display:flex;gap:8px;align-items:center">${icon("server")}${t("Server")}</span></div>
          ${row(t("Name"), t("How this server is labelled: its host name"), h`<span class="mono">${s.host}</span>`)}
          ${row(t("Time zone"), t("Schedules run in the server's local time"), h`<span class="mono">${s.timeZone ?? "—"}</span><div class="hint">${t("Change it with the TZ variable of the service.")}</div>`)}
          ${row(t("Listen address"), t("Change it in the config file; applies after a restart"), h`<span class="mono">${s.listen ? `${s.listen.host}:${s.listen.port}` : "—"}</span>`)}
          ${row("HTTPS", t("Arca serves plain HTTP; put it behind a reverse proxy for HTTPS"), h`<span class="badge ${location.protocol === "https:" ? "ok" : "never"}"><span class="dot"></span>${location.protocol === "https:" ? t("This page came over HTTPS") : t("Not over HTTPS")}</span>`)}
          ${row(t("Restore folder"), t("Restores from the web UI and MCP land below it"), h`<span class="mono">${s.restoreRoot}</span>`)}
        </div>
        <div class="card">
          <div class="card-head"><span style="display:flex;gap:8px;align-items:center">${icon("monitor")}${t("Web UI")}</span></div>
          ${row(t("Theme"), t("Applies to this browser"), h`<div class="seg wide" id="theme">${[["light", "sun", t("Light")], ["dark", "moon", t("Dark")], ["system", "monitor", t("System")]].map(([v, i, l]) => h`<button type="button" data-t="${v}" class="${theme === v ? "on" : ""}">${icon(i)}${l}</button>`)}</div>`)}
          ${row(t("Language"), t("Applies to this browser; the page reloads"), langSelect("lang-set", ""))}
          ${row(t("Session length"), t("12 hours of inactivity, or 30 days with “Keep me signed in”"), h`<span class="muted">${t("Fixed for now")}</span>`)}
          ${row(t("All sessions"), t("Ends every web session of your token, including this one. API tokens keep working."), h`<button class="btn secondary" id="out-all">${icon("log-out")}${t("Sign out everywhere")}</button>`)}
        </div>
      </div>
      <div class="stack" style="gap:24px">
        <div class="card">
          <div class="card-head"><span style="display:flex;gap:8px;align-items:center">${icon("info")}${t("Notifications")} <span class="tag">${t("Soon")}</span></span></div>
          <div style="padding:16px 24px" class="muted">${t("Coming: email, ntfy and webhooks when a backup fails. Until then the Overview shows what needs attention.")}</div>
        </div>
        <div class="card pad">
          <h3 style="display:flex;gap:8px;align-items:center">${icon("file")}${t("Config")}</h3>
          <div class="code">${s.configFile ?? t("started without a config file")}</div>
          <p class="muted small" style="margin:12px 0 0">${t("Changes made in the web UI are written to this file at once, after the whole config has been checked. Edited it by hand? Restart the service to apply it.")}</p>
        </div>
        <div class="card">
          <div class="card-head"><span style="display:flex;gap:8px;align-items:center">${icon("info")}${t("About")}</span><a class="btn secondary sm" href="https://github.com/sanyadez/Arca/releases" target="_blank" rel="noopener">${icon("refresh-cw")}${t("Check for updates")}</a></div>
          <dl class="kv" style="padding:16px 24px">
            <dt>${t("Version")}</dt><dd class="mono">Arca ${version}</dd>
            <dt>${t("Build")}</dt><dd class="mono">${(build ?? "").replace(/[()]/g, "")}</dd>
            <dt>${t("License")}</dt><dd>MIT</dd>
            <dt>${t("Source code")}</dt><dd><a href="https://github.com/sanyadez/Arca" target="_blank" rel="noopener">GitHub ${icon("external-link")}</a></dd>
            <dt>${t("Signed in as")}</dt><dd>${session.name} <span class="muted">(${session.scopes.join(", ")})</span></dd>
          </dl>
        </div>
      </div>
    </div>`.s;

  el.querySelectorAll("#theme [data-t]").forEach((b) => (b.onclick = () => {
    document.querySelector(`.seg [data-theme-set="${b.dataset.t}"]`)?.click();
    el.querySelectorAll("#theme button").forEach((x) => x.classList.toggle("on", x === b));
  }));
  bindLang(el, "lang-set");
  el.querySelector("#out-all").onclick = async () => {
    const ok = await modal({ title: t("Sign out everywhere?"), body: h`<p style="margin:0">${ht("Every web session signed in with the token {name} ends, including this one.", { name: h`<b>${session.name}</b>` })}</p>`, actions: [{ label: t("Sign out everywhere"), kind: "danger", value: true }] });
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
