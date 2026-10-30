// Recovery kit: what to keep away from this server so the data can be read back without it.
import { api, bytes, can, copyText, h, icon, raw, toast, toastError, when } from "../lib.js";

export async function page(el, _params, { session }) {
  const isAdmin = can(session, "admin");
  let k = await api("/api/recovery");
  const host = session.server.host;

  function draw() {
    const saved = k.repos.filter((r) => k.state.saved[r.name]).length;
    const left = (k.restoreBinary ? 0 : 0) + (saved < k.repos.length ? 1 : 0) + (k.state.testedAt ? 0 : 1);
    const first = k.repos[0];
    el.innerHTML = h`
      <div class="page-head">
        <div><h1>Recovery kit</h1><div class="sub">If ${host} is gone: three things to do now, while it still works</div></div>
        <div class="actions">${left ? h`<span class="badge warning"><span class="dot"></span>${left} step${left === 1 ? "" : "s"} left</span>` : h`<span class="badge ok"><span class="dot"></span>Ready</span>`}</div>
      </div>
      <div class="notice info" style="padding:20px 24px;margin-bottom:24px;display:grid;grid-template-columns:auto 1fr auto;gap:16px">
        ${icon("life-buoy")}
        <div><b style="font-size:var(--text-lg)">Your backups don't live on ${host}</b>
          <p style="margin:6px 0 0">This server runs the schedule and keeps the run history. The data itself sits in ${k.repos.length === 1 ? "one repository" : `${k.repos.length} repositories`}${k.repos.length ? h`: ${k.repos.map((r) => r.name).join(", ")}` : ""}. If ${host} dies, you lose the schedule and the history, not the data: any Linux machine reads it back with <span class="mono">arca-restore</span>. Arca can't reset a lost repository password, and neither can anyone else.</p></div>
        <div class="hide-phone"><span class="muted small">To get your data back you need</span>
          <div style="margin-top:8px;display:flex;flex-direction:column;gap:6px">${[["file", "The arca-restore program"], ["link", "The repository address"], ["key-round", "The repository password"]].map(([i, l]) => h`<div>${icon(i)} ${l}</div>`)}</div></div>
      </div>
      <div class="side-grid">
        <div class="card checklist">
          ${step(1, "Keep arca-restore", h`A single program that restores backups without the Arca server. Keep a copy off this server, on your laptop or a USB stick. Version ${k.version}, the same as this server.`,
            k.restoreBinary
              ? h`<div class="list-row" style="padding:12px 0;height:auto;border-top:1px solid var(--border);margin-top:14px">
                  <div class="grow"><div class="mono small">arca-restore-${k.version}</div><div class="mono small muted" style="word-break:break-all;white-space:normal">sha256 ${k.restoreBinary.sha256}</div></div>
                  <a class="btn secondary" href="/api/recovery/arca-restore" download>${icon("upload")}Download (${bytes(k.restoreBinary.size)})</a></div>
                <p class="muted small" style="margin:8px 0 0">Other platforms: <a href="https://github.com/sanyadez/Arca/releases" target="_blank" rel="noopener">GitHub releases</a>, checked against their SHA256SUMS.</p>`
              : h`<p class="muted" style="margin:12px 0 0">Get it from <a href="https://github.com/sanyadez/Arca/releases" target="_blank" rel="noopener">GitHub releases</a> (a file per platform, with SHA256SUMS to check it).</p>`)}
          ${step(2, "Keep the repository address and password away from this server", h`The address says where the data is. The password unlocks it. Keep both somewhere that survives losing ${host}, such as a password manager or paper in a drawer. Don't keep the password only inside a backup it protects.`,
            h`<div class="table-wrap" style="margin-top:14px"><table class="t" style="font-size:var(--text-sm)"><thead><tr><th>Repository</th><th>Address</th><th>Password saved offline?</th></tr></thead>
              <tbody>${k.repos.map((r) => h`<tr><td><div class="name">${r.name}</div><div class="sub mono">${r.id ?? ""}</div></td><td class="mono small" style="word-break:break-all">${r.url}</td>
                <td><label class="check"><input type="checkbox" data-saved="${r.name}" ${k.state.saved[r.name] ? raw("checked") : ""} ${isAdmin ? "" : "disabled"} /> ${k.state.saved[r.name] ? "Yes, saved" : "Not yet"}</label></td></tr>`)}</tbody></table></div>
              <div style="margin-top:12px;display:flex;gap:10px;align-items:center;flex-wrap:wrap"><span class="badge ${saved === k.repos.length ? "ok" : "warning"}"><span class="dot"></span>${saved} of ${k.repos.length} confirmed</span><span class="muted small">Arca can't check this. The tick is your own reminder.</span></div>`)}
          ${step(3, "Try it once", h`Run this on another machine, such as your laptop. It asks for the password and lists your snapshots. It only reads, so it can't change anything. If you see your snapshots, you're covered.`,
            first
              ? h`<div class="code" style="margin-top:14px;padding-right:90px">arca-restore snapshots --repo ${first.url}<button class="btn secondary sm copy" data-copy="arca-restore snapshots --repo ${first.url}">${icon("copy")}Copy</button></div>
                ${k.repos.slice(1).map((r) => h`<p class="muted small" style="margin:8px 0 0">For ${r.name}: <span class="mono">--repo ${r.url}</span></p>`)}
                <div style="margin-top:14px;display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap"><span class="badge ${k.state.testedAt ? "ok" : "warning"}"><span class="dot"></span>Last tested: ${k.state.testedAt ? when(k.state.testedAt) : "never"}</span>
                  <button class="btn secondary" id="tested" ${isAdmin ? "" : "disabled"}>${icon("check")}Mark as tested</button></div>`
              : h`<p class="muted" style="margin:12px 0 0">Add a repository first.</p>`)}
        </div>
        <div class="card pad">
          <h3>Printable sheet</h3>
          <p class="muted" style="margin:-4px 0 16px">One page with everything except the password. You write that in by hand, then keep the page away from ${host}.</p>
          <div class="sheet" id="sheet">
            <b>Arca recovery sheet</b><div class="mono small muted">${host} · Arca ${k.version} · ${new Date().toLocaleDateString()}</div>
            ${k.repos.map((r) => h`<div class="sheet-repo"><div style="display:flex;justify-content:space-between"><b>${r.name}</b><span class="mono small muted">${r.id ? `id ${r.id}` : ""}</span></div>
              <div class="mono small">${r.url}</div><div class="small muted">Password (write by hand)</div><div class="sheet-line"></div></div>`)}
            <div class="small muted" style="margin-top:12px">Command</div><div class="mono small">arca-restore snapshots --repo &lt;address&gt;</div>
            <div class="small" style="margin-top:12px"><b>To restore</b><ol style="margin:4px 0 0;padding-left:18px"><li>Get arca-restore on any Linux machine (github.com/sanyadez/Arca/releases).</li><li>Run the command above for each repository.</li><li>Enter the password, then: arca-restore restore latest --target &lt;folder&gt;.</li></ol></div>
          </div>
          <button class="btn primary lg" id="print" style="margin-top:16px">${icon("file")}Print</button>
          <p class="muted small" style="text-align:center;margin:10px 0 0">Print it again whenever you add a repository.</p>
        </div>
      </div>`.s;
    el.querySelectorAll("[data-copy]").forEach((b) => (b.onclick = () => copyText(b.dataset.copy)));
    el.querySelectorAll("[data-saved]").forEach((c) => (c.onchange = () => update({ saved: { [c.dataset.saved]: c.checked } })));
    el.querySelector("#tested")?.addEventListener("click", () => update({ tested: true }, "Marked as tested"));
    el.querySelector("#print").onclick = () => {
      document.body.classList.add("print-sheet");
      window.print();
      setTimeout(() => document.body.classList.remove("print-sheet"), 500);
    };
  }

  async function update(body, msg) {
    try {
      k.state = await api("/api/recovery", { method: "PUT", body });
      if (msg) toast(msg, "ok");
      draw();
    } catch (e) {
      toastError(e);
    }
  }

  draw();
}

function step(n, title, sub, extra) {
  return h`<div class="step" style="grid-template-columns:32px 1fr"><span class="num-c" style="background:var(--accent-soft);border-color:var(--accent-soft);color:var(--accent)">${n}</span>
    <div><div class="t1" style="font-weight:600;color:var(--text);font-size:var(--text-lg)">${title}</div><div class="t2">${sub}</div>${extra}</div></div>`;
}
