/**
 * The web UI: static files embedded into the binary (text imports), served from memory.
 * Routing is hash-based (#/runs/12), so the only HTML page is "/".
 */
import * as indexHtmlM from "../ui/index.html" with { type: "text" };
import * as tokensCssM from "../ui/tokens.css" with { type: "text" };
import * as appCssM from "../ui/app.css" with { type: "text" };
import * as iconsJsM from "../ui/icons.js" with { type: "text" };
import * as libJsM from "../ui/lib.js" with { type: "text" };
import * as appJsM from "../ui/app.js" with { type: "text" };
import * as overviewJsM from "../ui/pages/overview.js" with { type: "text" };
import * as runsJsM from "../ui/pages/runs.js" with { type: "text" };
import * as runJsM from "../ui/pages/run.js" with { type: "text" };
import { VERSION_STRING } from "../version";

/** A text import as a string (the TS types of .js/.html modules do not know about `type: "text"`). */
const txt = (m: unknown): string => (m as { default: string }).default;
const [indexHtml, tokensCss, appCss, iconsJs, libJs, appJs, overviewJs, runsJs, runJs] = [
  indexHtmlM, tokensCssM, appCssM, iconsJsM, libJsM, appJsM, overviewJsM, runsJsM, runJsM,
].map(txt) as [string, string, string, string, string, string, string, string, string];

const ASSETS: Record<string, [string, string]> = {
  "/assets/tokens.css": [tokensCss, "text/css"],
  "/assets/app.css": [appCss, "text/css"],
  "/assets/icons.js": [iconsJs, "text/javascript"],
  "/assets/lib.js": [libJs, "text/javascript"],
  "/assets/app.js": [appJs, "text/javascript"],
  "/assets/pages/overview.js": [overviewJs, "text/javascript"],
  "/assets/pages/runs.js": [runsJs, "text/javascript"],
  "/assets/pages/run.js": [runJs, "text/javascript"],
};

const ETAG = `"${Bun.hash(VERSION_STRING + Object.values(ASSETS).map((a) => a[0]).join("")).toString(36)}"`;

const SECURITY = {
  "Content-Security-Policy":
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
};

export function serveUi(path: string, req: Request): Response {
  const asset = path === "/" || path === "/index.html" ? ([indexHtml, "text/html; charset=utf-8"] as const) : ASSETS[path];
  if (!asset) return new Response("Not found", { status: 404 });
  if (req.headers.get("if-none-match") === ETAG) return new Response(null, { status: 304, headers: { ETag: ETAG } });
  return new Response(asset[0], {
    headers: { "Content-Type": asset[1].includes("charset") ? asset[1] : `${asset[1]}; charset=utf-8`, ETag: ETAG, "Cache-Control": "no-cache", ...SECURITY },
  });
}
