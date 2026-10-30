// Arca web UI: shell (sidebar / phone tab bar), hash router, session, theme, sign-in, connection banner.
import { SPRITE } from "./icons.js";
import { api, h, icon, onApi, raw, toast } from "./lib.js";

const NAV = [
  { path: "", label: "Overview", icon: "layout-grid" },
  { path: "sources", label: "Sources", icon: "folder-sync" },
  { path: "snapshots", label: "Snapshots", icon: "camera" },
  { path: "runs", label: "Runs", icon: "activity" },
  { path: "repositories", label: "Repositories", icon: "database" },
  { path: "access", label: "Access", icon: "key-round" },
];
const NAV_BOTTOM = [
  { path: "recovery", label: "Recovery kit", icon: "life-buoy" },
  { path: "settings", label: "Settings", icon: "settings" },
];
const TABS = [NAV[0], NAV[1], NAV[2], NAV[3], { path: "more", label: "More", icon: "ellipsis" }];

/** Route table: first matching pattern wins; `:x` captures one segment. */
const ROUTES = [
  ["", () => import("./pages/overview.js")],
  ["runs", () => import("./pages/runs.js")],
  ["runs/:id", () => import("./pages/run.js")],
  ["sources", () => import("./pages/sources.js")],
  ["sources/new", () => import("./pages/sourceform.js")],
  ["sources/:name", () => import("./pages/source.js")],
  ["sources/:name/edit", () => import("./pages/sourceform.js")],
  ["repositories", () => import("./pages/repositories.js")],
  ["access", () => import("./pages/access.js")],
  ["recovery", () => import("./pages/recovery.js")],
  ["settings", () => import("./pages/settings.js")],
  ["snapshots", () => import("./pages/snapshots.js")],
  ["snapshots/:repo/:id", () => import("./pages/snapshot.js")],
];

const app = document.getElementById("app");
let session = null;
let cleanup = null;
let reason = null; // why the sign-in screen is shown: expired / revoked

// ── theme ──

const THEME_KEY = "arca-theme";
function applyTheme(t) {
  if (t === "light" || t === "dark") document.documentElement.dataset.theme = t;
  else delete document.documentElement.dataset.theme;
}
const theme = () => localStorage.getItem(THEME_KEY) || "system";
function setTheme(t) {
  localStorage.setItem(THEME_KEY, t);
  applyTheme(t);
  document.querySelectorAll(".seg [data-theme-set]").forEach((b) => b.classList.toggle("on", b.dataset.themeSet === t));
}
applyTheme(theme());

const themeSwitch = () =>
  h`<div class="seg" role="radiogroup" aria-label="Theme">${[
    ["light", "sun", "Light"],
    ["dark", "moon", "Dark"],
    ["system", "monitor", "System"],
  ].map(([v, i, l]) => h`<button type="button" data-theme-set="${v}" class="${theme() === v ? "on" : ""}" title="${l}" aria-label="${l}">${icon(i)}</button>`)}</div>`;

// ── routing ──

function currentPath() {
  return decodeURIComponent(location.hash.replace(/^#\/?/, "").split("?")[0]).replace(/\/+$/, "");
}

function matchRoute(path) {
  const segs = path ? path.split("/") : [];
  for (const [pattern, load] of ROUTES) {
    const ps = pattern ? pattern.split("/") : [];
    if (ps.length !== segs.length) continue;
    const params = {};
    if (ps.every((p, i) => (p.startsWith(":") ? ((params[p.slice(1)] = segs[i]), true) : p === segs[i]))) return { load, params };
  }
  return null;
}

export const navigate = (path) => (location.hash = `#/${path}`);

// ── shell ──

function navLink(item, active, cls = "nav-item") {
  return h`<a class="${cls} ${active ? "active" : ""}" href="#/${item.path}">${icon(item.icon)}<span>${item.label}</span></a>`;
}

function renderShell() {
  app.innerHTML = h`
    <div class="shell">
      <aside class="sidebar">
        <a class="logo" href="#/"><span class="logo-mark">${icon("archive")}</span>Arca</a>
        <nav class="nav" id="nav"></nav>
        <div class="sidebar-bottom">
          <nav class="nav" id="nav-bottom"></nav>
          <div class="user-card">
            <button class="who btn ghost sm" id="user-menu" title="Signed in with the token “${session.name}”">
              <span class="avatar">${icon("user")}</span><span>${session.name}</span>
            </button>
            ${themeSwitch()}
          </div>
        </div>
      </aside>
      <div class="main-col">
        <header class="topbar"><span class="logo-mark">${icon("archive")}</span><span class="title" id="topbar-title"></span><span class="host">${icon("server")}${session.server.host}</span></header>
        <div id="banner"></div>
        <main class="content"><div class="page" id="page"></div></main>
        <nav class="tabbar" id="tabbar"></nav>
      </div>
    </div>`.s;
  app.addEventListener("click", (e) => {
    const t = e.target.closest("[data-theme-set]");
    if (t) setTheme(t.dataset.themeSet);
  });
  document.getElementById("user-menu").onclick = async (e) => {
    const { menu } = await import("./lib.js");
    menu(e.currentTarget, [
      { label: "Sign out", icon: "log-out", onClick: signOut },
      { label: "Sign out everywhere", icon: "log-out", onClick: () => signOut(true) },
    ]);
  };
}

function updateNav(path) {
  const top = path.split("/")[0];
  document.getElementById("nav").innerHTML = NAV.map((n) => navLink(n, n.path === top).s).join("");
  document.getElementById("nav-bottom").innerHTML = NAV_BOTTOM.map((n) => navLink(n, n.path === top).s).join("");
  const inTabs = TABS.some((t) => t.path === top);
  document.getElementById("tabbar").innerHTML = TABS.map((n) => navLink(n, n.path === top || (n.path === "more" && !inTabs), "").s).join("");
  const label = [...NAV, ...NAV_BOTTOM, ...TABS].find((n) => n.path === top)?.label ?? "Arca";
  document.getElementById("topbar-title").textContent = label;
}

async function route() {
  if (!session) return;
  const path = currentPath();
  updateNav(path);
  cleanup?.();
  cleanup = null;
  const pageEl = document.getElementById("page");
  window.scrollTo(0, 0);
  const m = matchRoute(path);
  if (path === "more") return renderMore(pageEl);
  if (!m) return renderLater(pageEl, path);
  pageEl.innerHTML = h`<div class="page-head"><div><span class="sk big" style="width:240px"></span></div></div>`.s;
  try {
    const mod = await m.load();
    if (currentPath() !== path) return; // navigated away while loading
    cleanup = (await mod.page(pageEl, m.params, { session, navigate })) ?? null;
  } catch (e) {
    pageEl.innerHTML = h`<div class="notice danger">${icon("triangle-alert")}<div>${e.message ?? e}</div></div>`.s;
  }
}

function renderMore(el) {
  el.innerHTML = h`<div class="page-head"><div><h1>More</h1></div></div>
    <div class="card">${[NAV[4], NAV[5], ...NAV_BOTTOM].map((n) => h`<a class="list-row" href="#/${n.path}">${icon(n.icon)}<span class="grow">${n.label}</span>${icon("chevron-right")}</a>`)}
    <button class="list-row btn ghost" style="width:100%;justify-content:flex-start;border-radius:0" id="more-out">${icon("log-out")}<span class="grow" style="text-align:left">Sign out</span></button></div>
    <div style="margin-top:16px">${themeSwitch()}</div>`.s;
  el.querySelector("#more-out").onclick = () => signOut();
}

/** Pages of later stages: a clear note instead of a broken screen. */
function renderLater(el, path) {
  const item = [...NAV, ...NAV_BOTTOM].find((n) => n.path === path.split("/")[0]);
  el.innerHTML = h`<div class="page-head"><div><h1>${item?.label ?? "Not found"}</h1></div></div>
    <div class="card pad"><div class="notice info">${icon("info")}<div>${
      item ? "This page is not in the web UI yet. Until then the command line has it: run arca --help on the server." : "There is no such page."
    }</div></div></div>`.s;
}

// ── connection banner ──

let retryTimer = null;
onApi("offline", () => {
  const b = document.getElementById("banner");
  if (!b) return;
  let left = 8;
  const draw = () =>
    (b.innerHTML = h`<div class="banner">${icon("unplug")}<span class="grow">Lost connection to the server. Retrying in ${left} s…</span>
      <button class="btn secondary sm" id="retry-now">Retry now</button></div>`.s);
  const tick = async () => {
    if (left <= 0) {
      left = 8;
      await fetch("/api/health").then(() => api("/api/session")).catch(() => {});
    }
    draw();
    b.querySelector("#retry-now").onclick = () => ((left = 0), tick());
    left--;
  };
  clearInterval(retryTimer);
  retryTimer = setInterval(tick, 1000);
  tick();
});
onApi("online", () => {
  clearInterval(retryTimer);
  const b = document.getElementById("banner");
  if (b) b.innerHTML = "";
  toast("Connection restored", "ok");
  route();
});
onApi("unauthorized", (r) => {
  if (!session) return;
  session = null;
  reason = r;
  cleanup?.();
  renderSignIn();
});

// ── sign-in ──

let serverHost = null;
fetch("/api/health")
  .then((r) => r.json())
  .then((j) => {
    serverHost = j.host ?? null;
    const t = document.querySelector(".signin h1");
    if (t && serverHost) t.textContent = `Sign in to ${serverHost}`;
  })
  .catch(() => {});

function renderSignIn(error) {
  const note =
    reason === "revoked"
      ? "The token of your session was revoked. Sign in with another token."
      : reason === "expired"
        ? "Your session has expired. Sign in again."
        : null;
  app.innerHTML = h`
    <div class="signin-bg">
      <form class="signin card" id="signin" autocomplete="off">
        <div class="logo"><span class="logo-mark">${icon("archive")}</span>Arca</div>
        <h1>Sign in to ${serverHost ?? "Arca"}</h1>
        ${note ? h`<div class="notice warn">${icon("triangle-alert")}<div>${note}</div></div>` : ""}
        <div class="field">
          <label for="token">Access token</label>
          <div class="input-wrap">
            <input class="input big mono" id="token" type="password" autocomplete="current-password" spellcheck="false" required ${error ? raw('aria-invalid="true" style="border-color:var(--danger)"') : ""} />
            <button type="button" class="btn ghost icon sm" id="reveal" aria-label="Show token">${icon("eye")}</button>
          </div>
          ${error ? h`<div class="err-text">${icon("triangle-alert")}<span>${error}</span></div>` : ""}
        </div>
        <label class="check"><input type="checkbox" id="remember" /> Keep me signed in on this device</label>
        <button class="btn primary lg" type="submit">Sign in</button>
      </form>
      <div class="signin-foot">
        <div>Create one on the server: <code>arca token &lt;name&gt;</code></div>
        <a href="https://github.com/sanyadez/Arca#readme" target="_blank" rel="noopener">Docs ${icon("external-link")}</a>
      </div>
    </div>`.s;
  const input = document.getElementById("token");
  input.focus();
  document.getElementById("reveal").onclick = () => {
    input.type = input.type === "password" ? "text" : "password";
  };
  document.getElementById("signin").onsubmit = async (e) => {
    e.preventDefault();
    const btn = e.target.querySelector("button[type=submit]");
    btn.disabled = true;
    try {
      await api("/api/session", { method: "POST", body: { token: input.value, remember: document.getElementById("remember").checked } });
      reason = null;
      await start();
    } catch (err) {
      renderSignIn(err.status === 401 ? "This token is not valid on this server. Check it, or create a new one with arca token <name>." : err.message);
    }
  };
}

async function signOut(everywhere = false) {
  await api(everywhere ? "/api/sessions" : "/api/session", { method: "DELETE" }).catch(() => {});
  session = null;
  cleanup?.();
  reason = null;
  renderSignIn();
}

// ── start ──

async function start() {
  try {
    session = await api("/api/session");
  } catch (e) {
    if (e.status === 401) return renderSignIn();
    app.innerHTML = h`<div class="signin-bg"><div class="notice danger">${icon("unplug")}<div>Cannot reach the Arca server: ${e.message}</div></div></div>`.s;
    return;
  }
  if (session.via === "token") {
    // A Bearer token in the browser is not a thing; treat it as signed out.
    return renderSignIn();
  }
  document.title = `Arca · ${session.server.host}`;
  renderShell();
  route();
}

document.body.insertAdjacentHTML("afterbegin", SPRITE);
window.addEventListener("hashchange", route);
start();
