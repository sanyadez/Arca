// Access: tokens and their scopes, creating one (shown once), connecting an MCP agent, who can do what.
import { adminTag, api, can, copyText, h, icon, menu, modal, raw, rel, toast, toastError, when } from "../lib.js";

const MATRIX = [
  ["Look through sources and snapshots", ["read"]],
  ["Look through runs and their details", ["read"]],
  ["Start a backup", ["backup"]],
  ["Start a check", ["backup"]],
  ["Restore into a new folder", ["restore"]],
  ["Prune a repository", []],
  ["Forget a snapshot", []],
  ["Change sources, repositories and tokens", []],
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
    const never = tokens ? tokens.filter((t) => !t.lastUsed).length : 0;
    el.innerHTML = h`
      <div class="page-head">
        <div><h1>Access</h1><div class="sub">Tokens for the API, the web UI and MCP agents</div></div>
        <div class="actions"><button class="btn primary" id="new" ${isAdmin ? "" : "disabled"}>${icon("plus")}New token</button>${isAdmin ? "" : adminTag()}</div>
      </div>
      <div class="card">
        <div class="card-head"><div>Tokens${tokens ? h`<div class="muted small" style="font-weight:400">${tokens.length} Bearer token${tokens.length === 1 ? "" : "s"}${never ? `, ${never} never used` : ""}</div>` : ""}</div></div>
        ${tokens
          ? h`<div class="table-wrap"><table class="t"><thead><tr><th>Name</th><th>Scopes</th><th class="hide-phone">Used by</th><th>Last used</th><th class="hide-phone">Created</th><th class="hide-phone">Expires</th><th></th></tr></thead>
            <tbody>${tokens.map((t) => h`<tr>
              <td class="name">${t.name}${t.name === session.name ? h` <span class="tag">you</span>` : ""}</td>
              <td>${t.scopes.map((s) => (s === "admin" ? h`<span class="admin-tag" style="color:var(--text)">${icon("shield")}admin</span> ` : h`<span class="tag" style="color:var(--text)">${s}</span> `))}</td>
              <td class="hide-phone">${t.usedBy.length ? t.usedBy.join(" · ") : h`<span class="muted">—</span>`}</td>
              <td class="mono nowrap">${t.lastUsed ? when(t.lastUsed) : h`<span class="muted">never</span>`}</td>
              <td class="mono nowrap hide-phone">${t.created ? new Date(t.created).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" }) : h`<span class="muted">—</span>`}</td>
              <td class="mono nowrap hide-phone">${t.expires ? (Date.parse(t.expires) < Date.now() ? h`<span style="color:var(--danger)">expired</span>` : rel(t.expires)) : "Never"}</td>
              <td style="width:44px"><button class="btn ghost icon sm" data-menu="${t.name}" aria-label="Actions">${icon("ellipsis")}</button></td></tr>`)}</tbody></table></div>`
          : h`<div class="empty-ok">${icon("shield")}Only tokens with the admin scope can see and manage tokens. You are signed in as <b>${session.name}</b> (${session.scopes.join(", ")}).</div>`}
      </div>
      <div class="two-col" style="grid-template-columns:1fr 1fr;align-items:start">
        <div class="card pad" style="margin-top:24px">
          <h3>Connect an AI agent (MCP)</h3>
          <p class="muted" style="margin:-6px 0 16px">Agents connect over HTTP with a Bearer token. Give each agent only the scopes it needs.</p>
          <div class="field"><label>Server URL</label><div class="code" style="padding-right:90px">${mcpUrl}<button class="btn secondary sm copy" data-copy="${mcpUrl}">${icon("copy")}Copy</button></div></div>
          <div class="field" style="margin-top:16px"><label>Config for Claude Code</label><span class="hint">Add to .mcp.json and set ARCA_TOKEN in your environment.</span>
            <div class="code" style="margin-top:6px">${mcpJson(mcpUrl)}<button class="btn secondary sm copy" data-copy="${mcpJson(mcpUrl)}">${icon("copy")}Copy</button></div></div>
        </div>
        <div class="card" style="margin-top:24px">
          <div class="card-head"><div>Who can do what<div class="muted small" style="font-weight:400">Actions allowed by each scope</div></div></div>
          <div class="table-wrap"><table class="t"><thead><tr><th>Action</th>${["read", "backup", "restore", "admin"].map((s) => h`<th style="text-align:center">${s}</th>`)}</tr></thead>
            <tbody>${MATRIX.map(([label, scopes]) => h`<tr><td>${label}</td>${["read", "backup", "restore", "admin"].map((s) => h`<td style="text-align:center">${s === "admin" || scopes.includes(s) ? h`<span style="color:var(--accent)">${icon("check")}</span>` : h`<span class="muted">—</span>`}</td>`)}</tr>`)}</tbody></table></div>
          <div class="notice info" style="margin:16px 24px 20px">${icon("info")}<div>Scopes add up, and admin includes all the others. A token with read and backup can start backups but cannot restore or prune.</div></div>
        </div>
      </div>`.s;
    el.querySelector("#new").onclick = newToken;
    el.querySelectorAll("[data-copy]").forEach((b) => (b.onclick = () => copyText(b.dataset.copy)));
    el.querySelectorAll("[data-menu]").forEach((b) => (b.onclick = () => menu(b, [{ label: "Revoke…", icon: "x", danger: true, onClick: () => revoke(b.dataset.menu) }])));
  }

  async function revoke(name) {
    const self = name === session.name;
    let mEl;
    const ok = await modal({
      title: `Revoke ${name}?`,
      body: h`<p style="margin:0">Everything using this token stops working at once: scripts, agents and web sessions signed in with it.${self ? h` <b>That includes this session.</b>` : ""}</p>
        <div class="field"><label for="confirm-name">Type <b class="mono">${name}</b> to confirm</label><input class="input mono" id="confirm-name" autocomplete="off" /></div>`,
      actions: [{ label: "Revoke token", kind: "danger", value: true }],
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
      toast(`Token ${name} revoked`, "ok");
      load();
    } catch (e) {
      toastError(e);
    }
  }

  async function newToken() {
    let mEl;
    const v = await modal({
      title: "New token",
      body: h`<div class="field"><label for="t-name">Name</label><input class="input big" id="t-name" placeholder="claude-code" autocomplete="off" /><span class="hint">Who or what uses it: lowercase letters, digits, - and _.</span></div>
        <div class="field"><label>Scopes</label><div style="display:flex;gap:16px;flex-wrap:wrap">${["read", "backup", "restore", "admin"].map((s) => h`<label class="check"><input type="checkbox" data-scope="${s}" ${s === "read" ? raw("checked") : ""} /> ${s}</label>`)}</div></div>
        <div class="field"><label for="t-exp">Expires</label><select class="input" id="t-exp"><option value="0">Never</option><option value="30">In 30 days</option><option value="90">In 90 days</option><option value="365">In a year</option></select></div>`,
      actions: [{ label: "Create token", kind: "primary", icon: "plus", value: "go" }],
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
    let t;
    try {
      t = await api("/api/tokens", {
        method: "POST",
        body: { name: mEl.querySelector("#t-name").value.trim(), scopes: [...mEl.querySelectorAll("[data-scope]:checked")].map((c) => c.dataset.scope), expiresDays: Number(mEl.querySelector("#t-exp").value) },
      });
    } catch (e) {
      return toastError(e);
    }
    const cmd = `claude mcp add --transport http arca ${mcpUrl} --header "Authorization: Bearer ${t.token}"`;
    await modal({
      title: h`<span style="display:flex;gap:10px;align-items:center"><span class="avatar" style="background:var(--ok-soft);color:var(--ok)">${icon("check")}</span>Token created — copy it now</span>`,
      body: h`<div class="field"><label>Token</label><div class="code" style="white-space:normal;word-break:break-all;padding-right:90px;font-size:var(--text-sm)">${t.token}<button class="btn primary sm copy" data-copy="${t.token}">${icon("copy")}Copy</button></div></div>
        <div class="notice warn">${icon("triangle-alert")}<div>You won't see it again. Arca stores only its hash.</div></div>
        <dl class="kv" style="grid-template-columns:repeat(3,1fr);border-top:1px solid var(--border);border-bottom:1px solid var(--border);padding:12px 0">
          <div><dt>Name</dt><dd style="text-align:left">${t.name}</dd></div><div><dt>Scopes</dt><dd style="text-align:left">${t.scopes.join(" · ")}</dd></div><div><dt>Expires</dt><dd class="mono" style="text-align:left">${t.expires ? rel(t.expires) : "never"}</dd></div></dl>
        <div class="field"><label>Add to Claude Code</label><span class="hint">This command includes the full token, so keep it private.</span>
          <div class="code" style="margin-top:6px;padding-right:90px">${cmd}<button class="btn secondary sm copy" data-copy="${cmd}">${icon("copy")}Copy</button></div></div>`,
      actions: [{ label: "Done", kind: "secondary", value: true }],
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
