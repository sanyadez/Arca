// Clients: machines running `arca client`, their state and sources; adding one with its install command; removing one.
import { adminTag, api, can, clientBadge, copyText, h, ht, icon, modal, rel, t, tn, toast, toastError, when } from "../lib.js";

const INSTALLER = "https://raw.githubusercontent.com/sanyadez/Arca/main/install.sh";
const DOCS = "https://github.com/sanyadez/Arca/blob/main/docs/clients.md";

export async function page(el, _params, { session, navigate }) {
  const isAdmin = can(session, "admin");
  let list = null;
  let timer = null;
  let stopped = false;

  async function load() {
    try {
      list = await api("/api/clients");
      if (!stopped) draw();
    } catch (e) {
      if (e.status) toastError(e);
    } finally {
      if (!stopped) timer = setTimeout(load, 5000);
    }
  }

  function draw() {
    const online = list.filter((c) => c.online).length;
    el.innerHTML = h`
      <div class="page-head">
        <div><h1>${t("Clients")}</h1><div class="sub">${list.length ? t("{clients}, {online} online", { clients: tn("{n} machine", "{n} machines", list.length), online }) : t("Machines that back up their own folders to this server")}</div></div>
        <div class="actions"><button class="btn primary" id="new" ${isAdmin ? "" : "disabled"}>${icon("plus")}${t("New client")}</button>${isAdmin ? "" : adminTag()}</div>
      </div>
      ${list.length ? table() : empty()}`.s;
    el.querySelector("#new").onclick = newClient;
    el.querySelectorAll("[data-remove]").forEach((b) => (b.onclick = () => remove(b.dataset.remove)));
  }

  function empty() {
    return h`<div class="card pad stack">
      <h3 style="margin:0">${t("No clients yet")}</h3>
      <p class="muted" style="margin:0">${t("A client suits a laptop, a VPS or a box behind NAT: anything this server cannot reach over SSH. The machine calls the server, so it needs no open port. It encrypts on the machine and can only add to the repository, never delete.")}</p>
      <div><a href="${DOCS}" target="_blank" rel="noopener">${t("How clients work")} ${icon("external-link")}</a></div>
    </div>`;
  }

  const sourceLinks = (c) =>
    c.sources.length
      ? h`<span class="chips-row">${c.sources.map((s) => h`<a class="tag" href="#/sources/${encodeURIComponent(s)}">${s}</a>`)}</span>`
      : isAdmin ? h`<a href="#/sources/new?client=${encodeURIComponent(c.name)}">${t("Add a folder")}</a>` : h`<span class="muted">—</span>`;

  function table() {
    return h`<div class="card">
      <div class="show-phone">${list.map((c) => h`<div class="m-row" style="padding:10px 16px">
        <span class="grow">${c.name}<div class="small muted" style="font-weight:400">${c.lastSeen ? t("seen {when}", { when: rel(c.lastSeen) }) : t("never connected")} · ${tn("{n} source", "{n} sources", c.sources.length)}</div></span>
        ${clientBadge(c)}${rowActions(c)}</div>`)}</div>
      <div class="table-wrap hide-phone"><table class="t"><thead><tr><th>${t("Client")}</th><th>${t("State")}</th><th>${t("Machine")}</th><th>${t("Last seen")}</th><th>${t("Version")}</th><th>${t("Sources")}</th><th></th></tr></thead>
        <tbody>${list.map((c) => h`<tr>
          <td class="name">${c.name}</td>
          <td>${clientBadge(c)}${c.running ? h` <a class="small" href="#/runs/${c.running}">${t("open run #{id}", { id: c.running })}</a>` : ""}</td>
          <td class="mono small">${c.host ?? h`<span class="muted">—</span>`}</td>
          <td class="mono nowrap">${c.lastSeen ? when(c.lastSeen) : h`<span class="muted">${t("never")}</span>`}</td>
          <td class="mono small">${c.version ?? h`<span class="muted">—</span>`}</td>
          <td>${sourceLinks(c)}</td>
          <td style="width:44px">${rowActions(c)}</td></tr>`)}</tbody></table></div></div>`;
  }

  const rowActions = (c) => (isAdmin ? h`<button class="btn ghost icon sm" data-remove="${c.name}" aria-label="${t("Remove {name}", { name: c.name })}" title="${t("Remove {name}", { name: c.name })}">${icon("x")}</button>` : "");

  async function remove(name) {
    const c = list.find((x) => x.name === name);
    if (!c) return;
    if (c.sources.length) {
      await modal({
        title: t("{name} still has sources", { name }),
        body: h`<p style="margin:0">${t("Remove these sources first. Their snapshots stay in the repository.")}</p><div class="chips-row">${c.sources.map((s) => h`<a class="tag" href="#/sources/${encodeURIComponent(s)}">${s}</a>`)}</div>`,
        actions: [],
        onMount: (m) => m.addEventListener("click", (e) => e.target.closest("a") && m.querySelector("[data-v='__cancel']").click()),
      });
      return;
    }
    const ok = await modal({
      title: t("Remove {name}?", { name }),
      body: h`<p style="margin:0">${t("Its token stops working at once, and the machine can no longer reach this server. Arca stays installed there: stop it with systemctl disable --now arca-client.")}</p>
        <div class="field"><label for="confirm-name">${ht("Type {name} to confirm", { name: h`<b class="mono">${name}</b>` })}</label><input class="input mono" id="confirm-name" autocomplete="off" /></div>`,
      actions: [{ label: t("Remove client"), kind: "danger", value: true }],
      onMount: (m) => {
        const btn = m.querySelector(".m-foot .btn.danger");
        btn.disabled = true;
        m.querySelector("#confirm-name").addEventListener("input", (e) => (btn.disabled = e.target.value.trim() !== name));
      },
    });
    if (!ok) return;
    try {
      await api(`/api/clients/${encodeURIComponent(name)}`, { method: "DELETE" });
      toast(t("Client {name} removed", { name }), "ok");
      refresh();
    } catch (e) {
      toastError(e);
    }
  }

  function refresh() {
    clearTimeout(timer);
    return load();
  }

  async function newClient() {
    let mEl;
    const v = await modal({
      title: t("New client"),
      body: h`<div class="field"><label for="c-name">${t("Name")}</label><input class="input big" id="c-name" placeholder="laptop" autocomplete="off" /><span class="hint">${t("Which machine it is: lowercase letters, digits, - and _.")}</span></div>
        <div class="field"><label for="c-server">${t("Server address")}</label><input class="input big mono" id="c-server" value="${location.origin}" spellcheck="false" /><span class="hint">${t("The address the machine reaches this server at. It goes into the install command.")}</span></div>`,
      actions: [{ label: t("Create client"), kind: "primary", icon: "plus", value: "go" }],
      onMount: (m) => {
        mEl = m;
        const go = m.querySelector(".m-foot .btn.primary");
        const sync = () => (go.disabled = !m.querySelector("#c-name").value.trim() || !/^https?:\/\/\S+$/.test(m.querySelector("#c-server").value.trim()));
        m.addEventListener("input", sync);
        sync();
        m.querySelector("#c-name").focus();
      },
    });
    if (v !== "go") return;
    const server = mEl.querySelector("#c-server").value.trim().replace(/\/+$/, "");
    let c;
    try {
      c = await api("/api/clients", { method: "POST", body: { name: mEl.querySelector("#c-name").value.trim() } });
    } catch (e) {
      return toastError(e);
    }
    refresh();
    showInstall(c, server);
  }

  async function showInstall(c, server) {
    const install = `curl -fsSL ${INSTALLER} | sudo sh -s -- --client --server ${server} --token ${c.token}`;
    const enroll = `arca client enroll --server ${server} --token ${c.token}`;
    let watching = true;
    const next = await modal({
      title: h`<span style="display:flex;gap:10px;align-items:center"><span class="avatar" style="background:var(--ok-soft);color:var(--ok)">${icon("check")}</span>${t("Client {name} created — copy the command now", { name: c.name })}</span>`,
      body: h`<div class="field"><label>${t("Run this on the machine")}</label><span class="hint">${t("It installs Arca, checks the token against this server and starts the arca-client service.")}</span>
          <div class="code" style="margin-top:6px;padding-right:130px;white-space:normal;word-break:break-all">${install}<button class="btn primary sm copy" data-copy="${install}">${icon("copy")}${t("Copy")}</button></div></div>
        <div class="field"><label>${t("Or, with Arca already installed there")}</label>
          <div class="code" style="padding-right:130px;white-space:normal;word-break:break-all">${enroll}<button class="btn secondary sm copy" data-copy="${enroll}">${icon("copy")}${t("Copy")}</button></div></div>
        <div class="notice warn">${icon("triangle-alert")}<div>${t("The commands include the token, and you won't see it again. Arca stores only its hash.")}</div></div>
        <div id="c-wait" style="display:flex;gap:8px;align-items:center" role="status">${icon("loader-circle", "spin")}<span class="muted">${t("Waiting for the machine to connect…")}</span></div>`,
      actions: [
        { label: t("Later"), kind: "secondary", value: "done" },
        { label: t("Add a folder"), kind: "primary", icon: "plus", value: "folder" },
      ],
      onMount: (m) => {
        m.querySelector(".m-foot [data-v='__cancel']").remove();
        m.querySelectorAll("[data-copy]").forEach((b) => (b.onclick = () => copyText(b.dataset.copy)));
        const box = m.querySelector("#c-wait");
        const watch = async () => {
          if (!watching) return;
          const me = await api("/api/clients").then((all) => all.find((x) => x.name === c.name)).catch(() => null);
          if (!watching) return;
          if (me?.online) {
            box.innerHTML = h`${clientBadge(me)}<span class="muted">${t("Connected from {host}", { host: me.host ?? "?" })}</span>`.s;
            return;
          }
          setTimeout(watch, 2000);
        };
        watch();
      },
    });
    watching = false;
    if (next === "folder") navigate(`sources/new?client=${encodeURIComponent(c.name)}`);
  }

  el.innerHTML = h`<div class="page-head"><div><span class="sk big" style="width:240px"></span></div></div>`.s;
  await load();
  if (new URLSearchParams(location.hash.split("?")[1] ?? "").get("new") && isAdmin) newClient();
  return () => {
    stopped = true;
    clearTimeout(timer);
  };
}
