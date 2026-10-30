// Repositories: storage state, check and prune (with a dry-run preview), history, adding a repository.
import { adminTag, api, badge, bytes, can, copyText, cronText, duration, h, ht, icon, menu, modal, num, raw, runDuration, t, tn, toast, toastError, when } from "../lib.js";

export async function page(el, _params, { session, navigate }) {
  const isAdmin = can(session, "admin");
  let data = null;
  let history = [];
  let stopped = false;
  let timer = null;

  async function load() {
    try {
      const [o, runs] = await Promise.all([api("/api/overview"), api("/api/runs?kind=check,prune&limit=8")]);
      data = o;
      history = runs.runs;
      if (!stopped) draw();
    } catch (e) {
      if (e.status) toastError(e);
    } finally {
      if (!stopped) timer = setTimeout(load, 10000);
    }
  }

  function draw() {
    const repos = data.repos;
    const attention = repos.filter((r) => repoStatus(r) !== "ok").length;
    el.innerHTML = h`
      <div class="page-head">
        <div><h1>${t("Repositories")}</h1><div class="sub">${attention
          ? tn("Encrypted storage for {host}: {repos}, {n} needs attention", "Encrypted storage for {host}: {repos}, {n} need attention", attention, { host: data.server.host, repos: tn("{n} repository", "{n} repositories", repos.length) })
          : t("Encrypted storage for {host}: {repos}", { host: data.server.host, repos: tn("{n} repository", "{n} repositories", repos.length) })}</div></div>
        <div class="actions"><button class="btn primary" id="add" ${isAdmin ? "" : "disabled"}>${icon("plus")}${t("Add repository")}</button>${isAdmin ? "" : adminTag()}</div>
      </div>
      ${repos.length ? h`<div class="grid" style="grid-template-columns:repeat(auto-fill,minmax(440px,1fr))">${repos.map((r) => repoCard(r))}</div>` : h`<div class="card pad"><div class="notice info">${icon("info")}<div>${t("No repository yet. A repository is where encrypted backups live: a local disk or an SFTP server.")}</div></div></div>`}
      <div class="card" style="margin-top:24px">
        <div class="card-head"><div>${t("Maintenance history")}<div class="muted small" style="font-weight:400">${t("Latest check and prune runs")}</div></div><a class="btn ghost" href="#/runs?kind=check">${icon("activity")}${t("View all runs")}</a></div>
        ${history.length ? h`<div class="table-wrap"><table class="t"><thead><tr><th>${t("Status")}</th><th>${t("Operation")}</th><th>${t("Repository")}</th><th class="hide-phone">${t("Summary")}</th><th>${t("When · trigger")}</th><th class="right">${t("Duration")}</th></tr></thead>
          <tbody>${history.map((r) => h`<tr class="click" data-run="${r.id}"><td>${badge(r.status)}</td><td>${r.kind === "check" ? t("Check") : t("Prune")}</td><td class="mono">${r.repo}</td>
            <td class="hide-phone muted">${r.summary ?? ""}</td><td class="mono small nowrap">${when(r.started)} · ${r.trigger === "schedule" ? t("schedule") : r.trigger.split(":")[0]}</td><td class="num">${duration(runDuration(r))}</td></tr>`)}</tbody></table></div>`
          : h`<div class="empty-ok">${icon("info")}${t("No checks or prunes yet.")}</div>`}
      </div>
      <div class="card pad" style="margin-top:24px;display:grid;grid-template-columns:1fr 1fr;gap:32px">
        <div><h3 style="display:flex;gap:8px;align-items:center">${icon("key-round")}${t("Encryption")}</h3><div class="mono">AES-256-GCM</div>
          <div class="notice warn" style="margin-top:14px">${icon("triangle-alert")}<div>${t("A lost password cannot be recovered. Keep the recovery kit.")}<div style="margin-top:6px"><a href="#/recovery">${t("Open recovery kit")} ${icon("arrow-right")}</a></div></div></div></div>
        <div><b>${t("Passwords by repository")}</b><div style="margin-top:10px">${repos.map((r) => h`<div class="list-row" style="padding:0">${icon("key-round")}<span class="mono small">${r.name}</span><span class="muted small">${t("stored in a password file next to the config")}</span></div>`)}</div></div>
      </div>`.s;

    el.querySelector("#add").onclick = () => addRepo();
    el.querySelectorAll("tr[data-run]").forEach((r) => (r.onclick = () => navigate(`runs/${r.dataset.run}`)));
    el.querySelectorAll("[data-check]").forEach((b) => (b.onclick = () => checkMenu(b, b.dataset.check)));
    el.querySelectorAll("[data-prune]").forEach((b) => (b.onclick = () => pruneDialog(b.dataset.prune)));
    el.querySelectorAll("[data-more]").forEach((b) => (b.onclick = () => repoMenu(b, b.dataset.more)));
  }

  function repoStatus(r) {
    const u = r.stats?.usage;
    const pct = u?.total ? (u.used / u.total) * 100 : 0;
    if (r.lastCheck?.status === "error") return "error";
    if (pct >= 85 || r.lastCheck?.status === "warning") return "warning";
    return "ok";
  }

  function repoCard(r) {
    const st = r.stats;
    const u = st?.usage;
    const pct = u?.total ? Math.round((u.used / u.total) * 100) : null;
    const status = repoStatus(r);
    const sftp = r.url.startsWith("sftp://");
    const conf = data.repoConf?.[r.name];
    const sources = data.sources.filter((s) => s.repo === r.name).length;
    return h`<div class="card pad" style="display:flex;flex-direction:column;gap:14px">
      <div style="display:flex;justify-content:space-between;align-items:center;gap:8px"><div style="display:flex;gap:8px;align-items:center"><b style="font-size:18px">${r.name}</b><span class="tag">${sftp ? "SFTP" : t("Local folder")}</span></div>
        ${status === "warning" && pct >= 85 ? h`<span class="badge warning"><span class="dot"></span>${t("Warning: disk {pct}% full", { pct })}</span>` : badge(status)}</div>
      <div class="path" style="max-width:100%;margin-top:-8px">${r.url}</div>
      ${u ? h`<div><div style="display:flex;justify-content:space-between;font-size:var(--text-sm)"><span class="muted">${t("Disk usage")}</span><span class="mono small">${t("{used} of {total} · {pct}%", { used: bytes(u.used), total: bytes(u.total), pct })}</span></div>
        <div class="bar ${pct >= 85 ? "warn" : "neutral"}" style="margin-top:8px"><span style="width:${pct}%"></span></div></div>` : ""}
      <div class="grid" style="grid-template-columns:repeat(3,1fr);gap:14px 16px">
        ${big(t("Stored"), st ? bytes(st.stored) : "—")}${big(t("Logical"), st ? bytes(st.protected) : "—")}${big(t("Dedup"), st?.dedup ? `${st.dedup}×` : "—")}
        ${big(t("Snapshots"), st ? num(st.snapshots) : "—")}${big(t("Sources"), num(sources))}${big(t("Packs"), st ? num(st.packs) : "—")}
      </div>
      <div style="border-top:1px solid var(--border);padding-top:14px;display:flex;flex-direction:column;gap:8px;font-size:var(--text-sm)">
        <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap">${icon("shield")}<b style="width:52px;font-weight:500">${t("Check")}</b><span class="mono small">${cronText(r.schedules?.check)}</span>
          ${r.lastCheck ? h`<span class="muted small">· ${ht("last {when}", { when: when(r.lastCheck.finished) })}</span> ${badge(r.lastCheck.status)}` : h`<span class="muted small">· ${t("never ran")}</span>`}</div>
        <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap">${icon("scissors")}<b style="width:52px;font-weight:500">${t("Prune")}</b><span class="mono small">${cronText(r.schedules?.prune)}</span></div>
      </div>
      <div style="display:flex;gap:8px;align-items:center">
        <button class="btn secondary" data-check="${r.name}" ${can(session, "backup") ? "" : "disabled"}>${icon("shield-check")}${t("Check now")}${icon("chevron-down")}</button>
        <button class="btn secondary" data-prune="${r.name}" ${isAdmin ? "" : "disabled"}>${icon("scissors")}${t("Prune now")}</button>${isAdmin ? "" : adminTag()}
        <span style="flex:1"></span><button class="btn secondary icon" data-more="${r.name}" aria-label="${t("More")}">${icon("ellipsis")}</button>
      </div>
    </div>`;
  }

  const big = (l, v) => h`<div><div class="muted small">${l}</div><div class="mono" style="font-size:22px;margin-top:2px">${v}</div></div>`;

  function checkMenu(anchor, name) {
    const st = data.repos.find((r) => r.name === name)?.stats;
    const run = async (readData, msg) => {
      try {
        const r = await api(`/api/repos/${encodeURIComponent(name)}/check`, { method: "POST", body: { readData } });
        toast(msg({ name, link: h`<a href="#/runs/${r.runId}">${t("open run #{id}", { id: r.runId })}</a>` }), "ok");
        load();
      } catch (e) {
        toastError(e);
      }
    };
    menu(anchor, [
      { label: t("Quick — metadata only"), icon: "check", onClick: () => run(0, (p) => ht("Quick check of {name} queued · {link}", p)) },
      { label: st ? t("Read 10% ({size})", { size: bytes(st.stored * 0.1) }) : t("Read 10%"), icon: "shield", onClick: () => run(0.1, (p) => ht("Check of {name} queued · {link}", p)) },
      { label: st ? t("Read all ({size})", { size: bytes(st.stored) }) : t("Read all"), icon: "database", onClick: () => run(1, (p) => ht("Full check of {name} queued · {link}", p)) },
    ]);
  }

  function repoMenu(anchor, name) {
    const r = data.repos.find((x) => x.name === name);
    menu(anchor, [
      { label: t("Copy address"), icon: "copy", onClick: () => copyText(r.url) },
      { label: t("Snapshots"), icon: "camera", onClick: () => navigate(`snapshots?repo=${encodeURIComponent(name)}`) },
      ...(isAdmin ? ["-", { label: t("Forget this repository…"), icon: "x", danger: true, onClick: () => removeRepo(name) }] : []),
    ]);
  }

  async function removeRepo(name) {
    const ok = await modal({
      title: t("Forget {name}?", { name }),
      body: h`<p style="margin:0">${ht("The server stops using this repository. {b}, and it can be connected again with its password.", { b: h`<b>${t("The data in the storage is not deleted")}</b>` })}</p>`,
      actions: [{ label: t("Forget repository"), kind: "danger", value: true }],
    });
    if (!ok) return;
    try {
      await api(`/api/repos/${encodeURIComponent(name)}`, { method: "DELETE" });
      toast(t("{name} removed from the config", { name }), "ok");
      load();
    } catch (e) {
      toastError(e);
    }
  }

  async function pruneDialog(name) {
    let mEl;
    const p = modal({
      title: t("Prune {name}?", { name }),
      body: h`<p class="muted" style="margin:-6px 0 0">${t("Removes data no snapshot uses any more. Snapshots stay. Backups to {name} wait while it runs.", { name })}</p>
        <div class="card" style="background:var(--surface-2);border:0;padding:16px 20px" id="preview"><div style="display:flex;justify-content:space-between"><b>${t("Preview")}</b><span class="muted small">${t("Dry run")}</span></div>
          <div class="empty-ok" style="padding:12px 0 0">${icon("loader-circle", "spin")}${t("Counting what can be freed…")}</div></div>
        <div class="field"><label for="confirm-name">${ht("Type {name} to confirm", { name: h`<b class="mono">${name}</b>` })}</label><input class="input mono" id="confirm-name" autocomplete="off" /></div>`,
      actions: [{ label: t("Prune {name}", { name }), kind: "danger", icon: "scissors", value: true }],
      onMount: (m) => {
        mEl = m;
        const btn = m.querySelector(".m-foot .btn.danger");
        btn.disabled = true;
        m.querySelector("#confirm-name").addEventListener("input", (e) => (btn.disabled = e.target.value.trim() !== name));
        m.querySelector("#confirm-name").focus();
      },
    });
    api(`/api/repos/${encodeURIComponent(name)}/prune-preview`, { method: "POST" })
      .then((r) => {
        const box = mEl?.querySelector("#preview");
        if (!box) return;
        box.innerHTML = h`<div style="display:flex;justify-content:space-between"><b>${t("Preview")}</b><span class="muted small">${t("Dry-run result")}</span></div>
          <dl class="kv" style="margin-top:10px"><dt>${t("Space to free")}</dt><dd class="mono">${bytes(r.bytesFreed)}</dd>
          <dt>${t("Packs to delete")}</dt><dd class="mono">${num(r.packsDeleted)}</dd><dt>${t("Packs to repack")}</dt><dd class="mono">${num(r.packsRepacked)}</dd>
          <dt>${t("Snapshots affected")}</dt><dd class="mono"><span style="color:var(--ok)">${icon("check")}</span> ${t("0 of {total}", { total: num(r.snapshots) })}</dd></dl>`.s;
      })
      .catch((e) => {
        const box = mEl?.querySelector("#preview");
        if (box) box.innerHTML = h`<div class="err-text">${icon("triangle-alert")}<span>${e.message}</span></div>`.s;
      });
    if (!(await p)) return;
    try {
      const r = await api(`/api/repos/${encodeURIComponent(name)}/prune`, { method: "POST" });
      toast(ht("Prune of {name} queued · {link}", { name, link: h`<a href="#/runs/${r.runId}">${t("open run #{id}", { id: r.runId })}</a>` }), "ok");
      load();
    } catch (e) {
      toastError(e);
    }
  }

  await load();
  if (new URLSearchParams(location.hash.split("?")[1] ?? "").get("new") === "1" && isAdmin) addRepo();
  return () => {
    stopped = true;
    clearTimeout(timer);
  };

  async function addRepo() {
    const r = await repoDialog();
    if (r) {
      toast(r.created ? t("Repository {name} created", { name: r.name }) : t("Repository {name} connected", { name: r.name }), "ok");
      load();
    }
  }
}

/** Passphrase from the browser's CSPRNG: 5 groups of 5 base32 characters (125 bits). */
export function passphrase() {
  const A = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const b = crypto.getRandomValues(new Uint8Array(25));
  const s = [...b].map((x) => A[x % 32]).join("");
  return s.match(/.{5}/g).join("-");
}

/** Create or connect a repository. Resolves with the API result or null. */
export async function repoDialog() {
  let mEl;
  let pass = passphrase();
  const v = await modal({
    title: t("Add repository"),
    body: h`<div class="muted" style="margin-top:-8px">${t("Where encrypted backups live")}</div>
      <div class="field"><label>${t("Type")}</label><div class="seg wide" id="type"><button type="button" data-t="local" class="on">${icon("folder")}${t("Local folder")}</button><button type="button" data-t="sftp">${icon("server")}SFTP</button></div></div>
      <div class="field"><label>${t("Mode")}</label><div class="seg wide" id="mode"><button type="button" data-m="create" class="on">${t("Create new")}</button><button type="button" data-m="connect">${t("Connect existing")}</button></div></div>
      <div class="field"><label for="r-name">${t("Name")}</label><input class="input big" id="r-name" placeholder="nas" autocomplete="off" /></div>
      <div class="field"><label for="r-url">${t("Address")}</label><input class="input big mono" id="r-url" placeholder="/mnt/backup/arca" autocomplete="off" />
        <div style="display:flex;gap:10px;align-items:center;margin-top:6px"><button type="button" class="btn secondary" id="test">${icon("refresh-cw")}${t("Test connection")}</button><span id="test-res"></span></div></div>
      <div class="field" id="pass-new"><label>${t("Password")}</label>
        <div class="card" style="background:var(--surface-2);padding:14px 16px;display:flex;flex-direction:column;gap:8px">
          <div style="display:flex;justify-content:space-between;align-items:center"><span class="muted small">${t("Generated passphrase")}</span>
            <span style="display:flex;gap:6px"><button type="button" class="btn ghost sm" id="regen">${icon("refresh-cw")}${t("New")}</button><button type="button" class="btn secondary sm" id="copy-pass">${icon("copy")}${t("Copy")}</button></span></div>
          <div class="mono" id="pass" style="font-size:16px;word-break:break-all"></div>
          <span class="small" style="color:var(--ok)">${t("Strong · 125 random bits")}</span></div></div>
      <div class="field hidden" id="pass-old"><label for="r-pass">${t("Password of the existing repository")}</label><input class="input big mono" id="r-pass" type="password" autocomplete="off" /></div>
      <div class="notice warn" id="warn">${icon("triangle-alert")}<div>${t("Arca cannot recover a lost password. Without it the data in this repository cannot be read by anyone.")}</div></div>
      <label class="check" id="saved-row"><input type="checkbox" id="saved" /> ${t("I saved the password somewhere away from this server")}</label>
      <div class="err-text hidden" id="err"></div>`,
    actions: [{ label: t("Create repository"), kind: "primary", icon: "plus", value: "go" }],
    onMount: (m) => {
      mEl = m;
      const $ = (s) => m.querySelector(s);
      const go = $(".m-foot .btn.primary");
      const state = { type: "local", mode: "create" };
      const sync = () => {
        $("#pass").textContent = pass;
        const create = state.mode === "create";
        $("#pass-new").classList.toggle("hidden", !create);
        $("#pass-old").classList.toggle("hidden", create);
        $("#warn").classList.toggle("hidden", !create);
        $("#saved-row").classList.toggle("hidden", !create);
        $("#r-url").placeholder = state.type === "sftp" ? "sftp://user@storage.example/srv/arca" : "/mnt/backup/arca";
        go.innerHTML = h`${icon("plus")}${create ? t("Create repository") : t("Connect repository")}`.s;
        go.disabled = !$("#r-name").value.trim() || !$("#r-url").value.trim() || (create ? !$("#saved").checked : $("#r-pass").value.length < 8);
        m.dataset.type = state.type;
        m.dataset.mode = state.mode;
      };
      m.querySelectorAll("#type [data-t]").forEach((b) => (b.onclick = () => {
        state.type = b.dataset.t;
        m.querySelectorAll("#type button").forEach((x) => x.classList.toggle("on", x === b));
        sync();
      }));
      m.querySelectorAll("#mode [data-m]").forEach((b) => (b.onclick = () => {
        state.mode = b.dataset.m;
        m.querySelectorAll("#mode button").forEach((x) => x.classList.toggle("on", x === b));
        sync();
      }));
      $("#regen").onclick = () => ((pass = passphrase()), sync());
      $("#copy-pass").onclick = () => copyText(pass);
      m.addEventListener("input", sync);
      $("#test").onclick = async () => {
        $("#test-res").innerHTML = h`${icon("loader-circle", "spin")}`.s;
        try {
          const r = await api("/api/repos/test", { method: "POST", body: { url: $("#r-url").value.trim() } });
          $("#test-res").innerHTML = (r.reachable
            ? h`<span class="badge ${r.isRepo || r.empty ? "ok" : "warning"}"><span class="dot"></span>${r.isRepo ? t("Reachable · a repository is here") : r.empty ? t("Reachable · empty folder") : t("Reachable · folder is not empty")}</span>`
            : h`<span class="badge error"><span class="dot"></span>${r.error}</span>`).s;
          if (r.isRepo) $('#mode [data-m="connect"]').click();
        } catch (e) {
          $("#test-res").innerHTML = h`<span class="badge error"><span class="dot"></span>${e.message}</span>`.s;
        }
      };
      sync();
      $("#r-name").focus();
    },
  });
  if (v !== "go") return null;
  const $ = (s) => mEl.querySelector(s);
  const create = mEl.dataset.mode === "create";
  try {
    return await api("/api/repos", { method: "POST", body: { name: $("#r-name").value.trim(), url: $("#r-url").value.trim(), password: create ? pass : $("#r-pass").value, create } });
  } catch (e) {
    toastError(e);
    return null;
  }
}

export { raw };
