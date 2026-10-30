// Access: tokens and their scopes, creating one (shown once), connecting an MCP agent, who can do what.
import { adminTag, api, can, copyText, h, ht, icon, locale, menu, modal, raw, rel, t, tn, toast, toastError, when } from "../lib.js";

const MATRIX = [
  [t("Look through sources and snapshots"), ["read"]],
  [t("Look through runs and their details"), ["read"]],
  [t("Start a backup"), ["backup"]],
  [t("Start a check"), ["backup"]],
  [t("Restore into a new folder"), ["restore"]],
  [t("Prune a repository"), []],
  [t("Forget a snapshot"), []],
  [t("Change sources, repositories and tokens"), []],
];

export async function page(el, _params, { session }) {
  const isAdmin = can(session, "admin");
  const mcpUrl = `${location.origin}/mcp`;

  async function load() {
    let tokens = null;
    if (isAdmin) tokens = await api("/api/tokens").catch((e) => (toastError(e), []));
    draw(tokens);
  }

  function draw(tokens) {
    const never = tokens ? tokens.filter((tk) => !tk.lastUsed).length : 0;
    el.innerHTML = h`
      <div class="page-head">
        <div><h1>${t("Access")}</h1><div class="sub">${t("Tokens for the API, the web UI and MCP agents")}</div></div>
        <div class="actions"><button class="btn primary" id="new" ${isAdmin ? "" : "disabled"}>${icon("plus")}${t("New token")}</button>${isAdmin ? "" : adminTag()}</div>
      </div>
      <div class="card">
        <div class="card-head"><div>${t("Tokens")}${tokens ? h`<div class="muted small" style="font-weight:400">${never ? tn("{tokens}, {n} never used", "{tokens}, {n} never used", never, { tokens: tn("{n} Bearer token", "{n} Bearer tokens", tokens.length) }) : tn("{n} Bearer token", "{n} Bearer tokens", tokens.length)}</div>` : ""}</div></div>
        ${tokens
          ? h`<div class="show-phone">${tokens.map((tk) => h`<div class="m-row" style="padding:10px 16px"><span class="grow">${tk.name}<div class="small muted" style="font-weight:400">${tk.scopes.join(" · ")} · ${tk.lastUsed ? t("used {when}", { when: rel(tk.lastUsed) }) : t("never used")}</div></span><button class="btn ghost icon" data-menu="${tk.name}" aria-label="${t("Actions")}">${icon("ellipsis")}</button></div>`)}</div>
            <div class="table-wrap hide-phone"><table class="t"><thead><tr><th>${t("Name")}</th><th>${t("Scopes")}</th><th class="hide-phone">${t("Used by")}</th><th>${t("Last used")}</th><th class="hide-phone">${t("Created")}</th><th class="hide-phone">${t("Expires")}</th><th></th></tr></thead>
            <tbody>${tokens.map((tk) => h`<tr>
              <td class="name">${tk.name}${tk.name === session.name ? h` <span class="tag">${t("you")}</span>` : ""}</td>
              <td>${tk.scopes.map((s) => (s === "admin" ? h`<span class="admin-tag" style="color:var(--text)">${icon("shield")}admin</span> ` : h`<span class="tag" style="color:var(--text)">${s}</span> `))}</td>
              <td class="hide-phone">${tk.usedBy.length ? tk.usedBy.join(" · ") : h`<span class="muted">—</span>`}</td>
              <td class="mono nowrap">${tk.lastUsed ? when(tk.lastUsed) : h`<span class="muted">${t("never")}</span>`}</td>
              <td class="mono nowrap hide-phone">${tk.created ? new Date(tk.created).toLocaleDateString(locale, { day: "numeric", month: "short", year: "numeric" }) : h`<span class="muted">—</span>`}</td>
              <td class="mono nowrap hide-phone">${tk.expires ? (Date.parse(tk.expires) < Date.now() ? h`<span style="color:var(--danger)">${t("expired")}</span>` : rel(tk.expires)) : t("Never")}</td>
              <td style="width:44px"><button class="btn ghost icon sm" data-menu="${tk.name}" aria-label="${t("Actions")}">${icon("ellipsis")}</button></td></tr>`)}</tbody></table></div>`
          : h`<div class="empty-ok">${icon("shield")}${ht("Only tokens with the admin scope can see and manage tokens. You are signed in as {name} ({scopes}).", { name: h`<b>${session.name}</b>`, scopes: session.scopes.join(", ") })}</div>`}
      </div>
      <div class="two-col" style="grid-template-columns:1fr 1fr;align-items:start">
        <div class="card pad" style="margin-top:24px">
          <h3>${t("Connect an AI agent (MCP)")}</h3>
          <p class="muted" style="margin:-6px 0 16px">${t("Agents connect over HTTP with a Bearer token. Give each agent only the scopes it needs.")}</p>
          <div class="field"><label>${t("Server URL")}</label><div class="code" style="padding-right:90px">${mcpUrl}<button class="btn secondary sm copy" data-copy="${mcpUrl}">${icon("copy")}${t("Copy")}</button></div></div>
          <div class="field" style="margin-top:16px"><label>${t("Config for Claude Code")}</label><span class="hint">${t("Add to .mcp.json and set ARCA_TOKEN in your environment.")}</span>
            <div class="code" style="margin-top:6px">${mcpJson(mcpUrl)}<button class="btn secondary sm copy" data-copy="${mcpJson(mcpUrl)}">${icon("copy")}${t("Copy")}</button></div></div>
        </div>
        <div class="card" style="margin-top:24px">
          <div class="card-head"><div>${t("Who can do what")}<div class="muted small" style="font-weight:400">${t("Actions allowed by each scope")}</div></div></div>
          <div class="table-wrap"><table class="t"><thead><tr><th>${t("Action")}</th>${["read", "backup", "restore", "admin"].map((s) => h`<th style="text-align:center">${s}</th>`)}</tr></thead>
            <tbody>${MATRIX.map(([label, scopes]) => h`<tr><td>${label}</td>${["read", "backup", "restore", "admin"].map((s) => h`<td style="text-align:center">${s === "admin" || scopes.includes(s) ? h`<span style="color:var(--accent)">${icon("check")}</span>` : h`<span class="muted">—</span>`}</td>`)}</tr>`)}</tbody></table></div>
          <div class="notice info" style="margin:16px 24px 20px">${icon("info")}<div>${t("Scopes add up, and admin includes all the others. A token with read and backup can start backups but cannot restore or prune.")}</div></div>
        </div>
      </div>`.s;
    el.querySelector("#new").onclick = newToken;
    el.querySelectorAll("[data-copy]").forEach((b) => (b.onclick = () => copyText(b.dataset.copy)));
    el.querySelectorAll("[data-menu]").forEach((b) => (b.onclick = () => menu(b, [{ label: t("Revoke…"), icon: "x", danger: true, onClick: () => revoke(b.dataset.menu) }])));
  }

  async function revoke(name) {
    const self = name === session.name;
    let mEl;
    const ok = await modal({
      title: t("Revoke {name}?", { name }),
      body: h`<p style="margin:0">${t("Everything using this token stops working at once: scripts, agents and web sessions signed in with it.")}${self ? h` <b>${t("That includes this session.")}</b>` : ""}</p>
        <div class="field"><label for="confirm-name">${ht("Type {name} to confirm", { name: h`<b class="mono">${name}</b>` })}</label><input class="input mono" id="confirm-name" autocomplete="off" /></div>`,
      actions: [{ label: t("Revoke token"), kind: "danger", value: true }],
      onMount: (m) => {
        mEl = m;
        const btn = m.querySelector(".m-foot .btn.danger");
        btn.disabled = true;
        m.querySelector("#confirm-name").addEventListener("input", (e) => (btn.disabled = e.target.value.trim() !== name));
      },
    });
    if (!ok) return;
    try {
      await api(`/api/tokens/${encodeURIComponent(name)}`, { method: "DELETE" });
      toast(t("Token {name} revoked", { name }), "ok");
      load();
    } catch (e) {
      toastError(e);
    }
  }

  async function newToken() {
    let mEl;
    const v = await modal({
      title: t("New token"),
      body: h`<div class="field"><label for="t-name">${t("Name")}</label><input class="input big" id="t-name" placeholder="claude-code" autocomplete="off" /><span class="hint">${t("Who or what uses it: lowercase letters, digits, - and _.")}</span></div>
        <div class="field"><label>${t("Scopes")}</label><div style="display:flex;gap:16px;flex-wrap:wrap">${["read", "backup", "restore", "admin"].map((s) => h`<label class="check"><input type="checkbox" data-scope="${s}" ${s === "read" ? raw("checked") : ""} /> ${s}</label>`)}</div></div>
        <div class="field"><label for="t-exp">${t("Expires")}</label><select class="input" id="t-exp"><option value="0">${t("Never")}</option><option value="30">${t("In 30 days")}</option><option value="90">${t("In 90 days")}</option><option value="365">${t("In a year")}</option></select></div>`,
      actions: [{ label: t("Create token"), kind: "primary", icon: "plus", value: "go" }],
      onMount: (m) => {
        mEl = m;
        const go = m.querySelector(".m-foot .btn.primary");
        const sync = () => (go.disabled = !m.querySelector("#t-name").value.trim() || !m.querySelector("[data-scope]:checked"));
        m.addEventListener("input", sync);
        m.addEventListener("change", sync);
        sync();
        m.querySelector("#t-name").focus();
      },
    });
    if (v !== "go") return;
    let tk;
    try {
      tk = await api("/api/tokens", {
        method: "POST",
        body: { name: mEl.querySelector("#t-name").value.trim(), scopes: [...mEl.querySelectorAll("[data-scope]:checked")].map((c) => c.dataset.scope), expiresDays: Number(mEl.querySelector("#t-exp").value) },
      });
    } catch (e) {
      return toastError(e);
    }
    const cmd = `claude mcp add --transport http arca ${mcpUrl} --header "Authorization: Bearer ${tk.token}"`;
    await modal({
      title: h`<span style="display:flex;gap:10px;align-items:center"><span class="avatar" style="background:var(--ok-soft);color:var(--ok)">${icon("check")}</span>${t("Token created — copy it now")}</span>`,
      body: h`<div class="field"><label>${t("Token")}</label><div class="code" style="white-space:normal;word-break:break-all;padding-right:90px;font-size:var(--text-sm)">${tk.token}<button class="btn primary sm copy" data-copy="${tk.token}">${icon("copy")}${t("Copy")}</button></div></div>
        <div class="notice warn">${icon("triangle-alert")}<div>${t("You won't see it again. Arca stores only its hash.")}</div></div>
        <dl class="kv" style="grid-template-columns:repeat(3,1fr);border-top:1px solid var(--border);border-bottom:1px solid var(--border);padding:12px 0">
          <div><dt>${t("Name")}</dt><dd style="text-align:left">${tk.name}</dd></div><div><dt>${t("Scopes")}</dt><dd style="text-align:left">${tk.scopes.join(" · ")}</dd></div><div><dt>${t("Expires")}</dt><dd class="mono" style="text-align:left">${tk.expires ? rel(tk.expires) : t("never")}</dd></div></dl>
        <div class="field"><label>${t("Add to Claude Code")}</label><span class="hint">${t("This command includes the full token, so keep it private.")}</span>
          <div class="code" style="margin-top:6px;padding-right:90px">${cmd}<button class="btn secondary sm copy" data-copy="${cmd}">${icon("copy")}${t("Copy")}</button></div></div>`,
      actions: [{ label: t("Done"), kind: "secondary", value: true }],
      onMount: (m) => {
        m.querySelector(".m-foot [data-v='__cancel']").remove();
        m.querySelectorAll("[data-copy]").forEach((b) => (b.onclick = () => copyText(b.dataset.copy)));
      },
    });
    load();
  }

  await load();
}

function mcpJson(url) {
  return JSON.stringify({ mcpServers: { arca: { type: "http", url, headers: { Authorization: "Bearer ${ARCA_TOKEN}" } } } }, null, 2);
}
