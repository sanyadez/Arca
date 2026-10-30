// Snapshot browser: folder tree, files with new/changed marks against the parent snapshot, restore.
import { api, bytes, can, clock, duration, h, icon, modal, modeString, num, raw, stamp, toast, toastError } from "../lib.js";

const PAGE = 200;

export async function page(el, { repo, id }, { session, navigate }) {
  const qs = new URLSearchParams(location.hash.split("?")[1] ?? "");
  const snap = await api(`/api/repos/${encodeURIComponent(repo)}/snapshots/${encodeURIComponent(id)}`);
  let compare = !!snap.parent;
  let path = qs.get("path") ?? "";
  let listing = null;
  const selected = new Map(); // path → item
  const expanded = new Set([""]);
  const treeCache = new Map(); // path → items (dirs only) of that folder
  const st = snap.stats ?? {};

  el.innerHTML = h`
    <div class="crumbs"><a href="#/snapshots">Snapshots</a>${icon("chevron-right")}<a href="#/sources/${encodeURIComponent(snap.source)}">${snap.source}</a>${icon("chevron-right")}<span class="cur mono">${snap.id.slice(0, 8)}</span></div>
    <div class="page-head">
      <div><h1>Snapshot <span class="mono" style="font-weight:600">${snap.id.slice(0, 8)}</span></h1>
        <div class="meta-line"><span class="mono">${stamp(Date.parse(snap.time))}</span>·<span>host <span class="mono">${snap.host}</span></span>·<span><span class="mono">${num(st.files)}</span> files</span>·<span class="mono">${bytes(st.bytes ?? null)}</span>·<span><span class="mono">${bytes(st.newBytes ?? null, { plus: true })}</span> new</span>·<span class="mono">${duration(st.seconds)}</span>${snap.tags.length ? h`·<span>tags ${snap.tags.map((t) => h`<span class="tag">${t}</span> `)}</span>` : ""}</div></div>
      <div class="actions">
        ${snap.parent ? h`<label class="switch"><input type="checkbox" id="cmp" ${compare ? raw("checked") : ""} />Compare with previous</label>` : ""}
        <button class="btn secondary" id="restore-all" ${can(session, "restore") ? "" : "disabled"}>${icon("history")}Restore whole snapshot…</button>
      </div>
    </div>
    <div class="browser">
      <div class="card tree-pane">
        <label class="search">${icon("search")}<input class="input" id="find" type="search" placeholder="Find in this snapshot…" /></label>
        <div id="tree"></div>
      </div>
      <div class="card" id="folder"></div>
    </div>
    <div id="bulk"></div>`.s;

  el.querySelector("#cmp")?.addEventListener("change", (e) => {
    compare = e.target.checked;
    treeCache.clear();
    openFolder(path);
  });
  el.querySelector("#restore-all").onclick = () => restoreDialog([]);
  let ft;
  el.querySelector("#find").addEventListener("input", (e) => {
    clearTimeout(ft);
    ft = setTimeout(() => find(e.target.value.trim()), 350);
  });

  async function fetchFolder(p, offset = 0) {
    const q = new URLSearchParams({ path: p, limit: String(PAGE), offset: String(offset) });
    if (compare) q.set("compare", "1");
    return api(`/api/repos/${encodeURIComponent(repo)}/snapshots/${encodeURIComponent(snap.id)}/browse?${q}`);
  }

  async function openFolder(p) {
    path = p;
    // expand all ancestors so the tree shows where we are
    let acc = "";
    for (const seg of p.split("/").filter(Boolean)) {
      acc = acc ? `${acc}/${seg}` : seg;
      expanded.add(acc);
    }
    el.querySelector("#folder").innerHTML = h`<div class="empty-ok">${icon("loader-circle", "spin")}Loading…</div>`.s;
    try {
      listing = await fetchFolder(p);
      treeCache.set(p, listing.items.filter((i) => i.type === "dir"));
      drawFolder();
      await drawTree();
    } catch (e) {
      el.querySelector("#folder").innerHTML = h`<div class="notice danger">${icon("triangle-alert")}<div>${e.message}</div></div>`.s;
    }
  }

  const full = (name) => (path ? `${path}/${name}` : name);
  const root = () => snap.root.replace(/^ssh:\/\/[^/]+/, "");
  const shownPath = (p) => (root() + (p ? `/${p}` : "")).replace(/\/+/g, "/");

  function drawFolder() {
    const l = listing;
    el.querySelector("#folder").innerHTML = h`
      <div class="card-head" style="font-weight:400;flex-wrap:wrap"><span><span class="mono" style="font-weight:600">${shownPath(path)}</span> <span class="muted small">· ${num(l.total)} items</span></span>
        ${l.comparedWith ? h`<span class="muted small">Compared with <span class="mono" style="color:var(--text)">${l.comparedWith.id.slice(0, 8)}</span> ${stamp(Date.parse(l.comparedWith.time))}</span>` : ""}</div>
      ${path ? h`<button class="list-row btn ghost" id="up" style="width:100%;justify-content:flex-start;border-radius:0">${icon("chevron-left")}<span class="mono small">..</span></button>` : ""}
      <div class="table-wrap"><table class="t">
        <thead><tr><th class="cb"><input type="checkbox" class="cbx" id="all" aria-label="Select all" /></th><th>Name</th>${compare ? raw("<th>Change</th>") : ""}<th class="right">Size</th><th>Modified</th><th class="hide-phone">Permissions</th><th class="hide-phone">Owner</th></tr></thead>
        <tbody>${l.items.map((it) => {
          const p = full(it.name);
          const sel = selected.has(p);
          return h`<tr class="${it.type === "dir" ? "click" : ""} ${sel ? "sel" : ""}" data-p="${p}" data-dir="${it.type === "dir" ? "1" : ""}">
            <td class="cb"><input type="checkbox" class="cbx" data-sel="${p}" ${sel ? raw("checked") : ""} aria-label="Select ${it.name}" /></td>
            <td class="mono" style="font-size:var(--text-sm)">${icon(it.type === "dir" ? "folder" : it.type === "symlink" ? "link" : "file")} ${it.name}${it.type === "dir" ? "/" : ""}${it.target ? h` <span class="muted">→ ${it.target}</span>` : ""}</td>
            ${compare ? h`<td>${it.change === "new" ? h`<span class="tag new">new</span>` : it.change === "changed" ? h`<span class="tag changed">changed</span>` : ""}${it.type === "dir" && it.added ? h` <span class="mono small muted">${bytes(it.added, { plus: true })}</span>` : ""}</td>` : ""}
            <td class="num">${it.type === "dir" ? "—" : bytes(it.size ?? 0)}</td>
            <td class="mono nowrap">${stamp(it.mtime)}</td>
            <td class="mono muted hide-phone">${modeString(it.mode, it.type)}</td>
            <td class="mono muted hide-phone">${it.uid}:${it.gid}</td></tr>`;
        })}</tbody></table></div>
      <div class="pager"><span>${num(l.items.length)} of ${num(l.total)} in this folder</span>
        <div class="btns">${l.items.length < l.total ? h`<button class="btn secondary" id="load-more">${icon("chevron-down")}Load more</button>` : ""}</div></div>`.s;
    const f = el.querySelector("#folder");
    f.querySelector("#up")?.addEventListener("click", () => openFolder(path.split("/").slice(0, -1).join("/")));
    f.querySelectorAll("tr[data-dir='1']").forEach((r) => (r.onclick = (e) => !e.target.closest("input") && openFolder(r.dataset.p)));
    f.querySelectorAll("input[data-sel]").forEach((c) => (c.onchange = () => {
      const it = listing.items.find((i) => full(i.name) === c.dataset.sel);
      c.checked ? selected.set(c.dataset.sel, it) : selected.delete(c.dataset.sel);
      c.closest("tr").classList.toggle("sel", c.checked);
      drawBulk();
    }));
    const allBox = f.querySelector("#all");
    const inFolder = listing.items.filter((i) => selected.has(full(i.name))).length;
    allBox.checked = inFolder > 0 && inFolder === listing.items.length;
    allBox.indeterminate = inFolder > 0 && inFolder < listing.items.length;
    allBox.onchange = () => {
      for (const it of listing.items) allBox.checked ? selected.set(full(it.name), it) : selected.delete(full(it.name));
      drawFolder();
      drawBulk();
    };
    f.querySelector("#load-more")?.addEventListener("click", async () => {
      const more = await fetchFolder(path, listing.items.length);
      listing.items.push(...more.items);
      drawFolder();
    });
  }

  async function drawTree() {
    const box = el.querySelector("#tree");
    const lines = [];
    const walk = async (p, depth) => {
      let kids = treeCache.get(p);
      if (!kids) {
        kids = (await fetchFolder(p)).items.filter((i) => i.type === "dir");
        treeCache.set(p, kids);
      }
      for (const k of kids) {
        const kp = p ? `${p}/${k.name}` : k.name;
        const open = expanded.has(kp);
        lines.push(h`<div class="tnode ${kp === path ? "cur" : ""}" data-tp="${kp}" style="padding-left:${8 + depth * 16}px">
          <span class="tw" data-tog="${kp}">${icon(open ? "chevron-down" : "chevron-right")}</span>${icon("folder")}<span class="nm">${k.name}</span>${compare && k.added ? h`<span class="ad">${bytes(k.added, { plus: true })}</span>` : ""}</div>`);
        if (open) await walk(kp, depth + 1);
      }
    };
    lines.push(h`<div class="tnode ${path === "" ? "cur" : ""}" data-tp=""><span class="tw">${icon("chevron-down")}</span>${icon("folder")}<span class="nm">${shownPath("")}</span></div>`);
    await walk("", 1);
    box.innerHTML = lines.map((l) => l.s).join("");
    box.querySelectorAll("[data-tog]").forEach((t) => (t.onclick = async (e) => {
      e.stopPropagation();
      const p = t.dataset.tog;
      expanded.has(p) ? expanded.delete(p) : expanded.add(p);
      await drawTree();
    }));
    box.querySelectorAll("[data-tp]").forEach((n) => (n.onclick = () => openFolder(n.dataset.tp)));
  }

  async function find(q) {
    if (q.length < 2) return drawTree();
    const box = el.querySelector("#tree");
    box.innerHTML = h`<div class="empty-ok">${icon("loader-circle", "spin")}Searching…</div>`.s;
    try {
      const r = await api(`/api/search?${new URLSearchParams({ q, repo, snapshot: snap.id })}`);
      box.innerHTML = r.hits.length
        ? r.hits.map((x) => h`<div class="tnode" data-hit="${x.path}" title="${x.path}">${icon(x.type === "dir" ? "folder" : "file")}<span class="nm">${x.path}</span></div>`.s).join("")
        : h`<div class="empty-ok">No match.</div>`.s;
      box.querySelectorAll("[data-hit]").forEach((n) => (n.onclick = () => {
        const p = n.dataset.hit;
        const hit = r.hits.find((x) => x.path === p);
        openFolder(hit.type === "dir" ? p : p.split("/").slice(0, -1).join("/"));
      }));
    } catch (e) {
      box.innerHTML = h`<div class="notice danger">${icon("triangle-alert")}<div>${e.message}</div></div>`.s;
    }
  }

  function drawBulk() {
    const box = el.querySelector("#bulk");
    if (!selected.size) return (box.innerHTML = "");
    const items = [...selected.values()];
    const size = items.reduce((a, i) => a + (i.type === "dir" ? 0 : (i.size ?? 0)), 0);
    box.innerHTML = h`<div class="bulkbar"><b>${items.length} item${items.length === 1 ? "" : "s"}</b><span class="mono small muted">${bytes(size)}${items.some((i) => i.type === "dir") ? " + folders" : ""}</span>
      <span class="grow"></span><button class="btn ghost" id="clear">${icon("x")}Clear</button>
      <button class="btn primary" id="restore-sel" ${can(session, "restore") ? "" : "disabled"}>${icon("history")}Restore selected…</button></div>`.s;
    box.querySelector("#clear").onclick = () => {
      selected.clear();
      drawFolder();
      drawBulk();
    };
    box.querySelector("#restore-sel").onclick = () => restoreDialog([...selected.keys()]);
  }

  async function restoreDialog(paths) {
    const items = paths.map((p) => [p, selected.get(p)]);
    const total = items.reduce((a, [, i]) => a + (i?.type === "dir" ? 0 : (i?.size ?? 0)), 0);
    const defName = `${snap.source}-${snap.id.slice(0, 8)}`.replace(/[^\w.-]+/g, "-");
    const rootDir = snap.restoreRoot.replace(/\/+$/, "");
    let mEl = null;
    const label = paths.length ? `Restore ${paths.length} item${paths.length === 1 ? "" : "s"}` : "Restore snapshot";
    const v = await modal({
      title: h`Restore from <span class="mono">${snap.id.slice(0, 8)}</span>`,
      body: h`<div class="muted" style="margin-top:-8px">${snap.source} on ${snap.host}, ${stamp(Date.parse(snap.time))}</div>
        <div><div style="display:flex;justify-content:space-between"><b>What</b><span class="mono small muted">${paths.length ? `${paths.length} items, ${bytes(total)}` : `${num(st.files)} files, ${bytes(st.bytes ?? null)}`}</span></div>
          <div class="what-list" style="margin-top:8px">${paths.length ? items.map(([p, i]) => h`<div><span>${shownPath(p)}${i?.type === "dir" ? "/" : ""}</span><span>${i?.type === "dir" ? "folder" : bytes(i?.size ?? 0)}</span></div>`) : h`<div><span>${shownPath("")} — the whole snapshot</span></div>`}</div></div>
        <div class="field"><b>Where</b>
          <label for="target" style="display:flex;justify-content:space-between;font-weight:500">Target folder <span class="muted small" style="font-weight:400">on this server · generated, editable</span></label>
          <div class="prefix-input">${icon("folder")}<span class="pre">${rootDir}/</span><input id="target" value="${defName}" spellcheck="false" /></div>
          <span class="hint">Arca never overwrites: the folder must be new or empty.</span></div>
        <label class="check"><input type="checkbox" id="owners" checked /> Keep permissions and owners</label>
        <label class="check"><input type="checkbox" id="verify" checked /> Verify after restore</label>
        <div class="notice info">${icon("info")}<div>Need it on another machine? Copy the folder from this server, or use <span class="mono">arca-restore</span> there.</div></div>`,
      actions: [{ label, kind: "primary", icon: "history", value: "go" }],
      onMount: (m) => {
        mEl = m;
        m.querySelector("#target").addEventListener("input", (e) => (m.dataset.target = e.target.value));
        m.dataset.target = defName;
        m.querySelector("#owners").onchange = (e) => (m.dataset.owners = e.target.checked ? "1" : "0");
        m.querySelector("#verify").onchange = (e) => (m.dataset.verify = e.target.checked ? "1" : "0");
      },
    });
    const m = mEl;
    if (v !== "go") return;
    try {
      const r = await api(`/api/repos/${encodeURIComponent(repo)}/snapshots/${encodeURIComponent(snap.id)}/restore`, {
        method: "POST",
        body: { paths: paths.length ? paths : undefined, target: (m.dataset.target ?? defName).trim(), owners: m.dataset.owners !== "0", verify: m.dataset.verify !== "0" },
      });
      toast(h`Restore started · <a href="#/runs/${r.runId}">open run #${r.runId}</a>`, "ok");
      navigate(`runs/${r.runId}`);
    } catch (e) {
      toastError(e);
    }
  }

  await openFolder(path);
  if (qs.get("restore") === "all") restoreDialog([]);
}

export { clock };
