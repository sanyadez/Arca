/**
 * Who is calling: a Bearer token (API, MCP, scripts) or a session cookie of the web UI.
 *
 * The UI signs in with a token once and gets an HttpOnly cookie; the session stores only the
 * sha256 of the cookie and the sha256 of the token, and is checked against the config on every
 * request, so removing a token from the config signs its sessions out at once.
 * Cookie-authenticated writes must carry `X-Arca-Request: 1`: a cross-site form cannot set a
 * custom header, which together with SameSite=Strict closes CSRF.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { TokenConf } from "./config";
import type { RunsDb } from "./db";

export const SESSION_COOKIE = "arca_session";
export const CSRF_HEADER = "x-arca-request";
const SHORT_TTL = 12 * 3600_000; // idle limit of a browser session
const LONG_TTL = 30 * 86400_000; // "keep me signed in"

export function hashToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

function findToken(tokens: TokenConf[], sha: string): TokenConf | null {
  const h = Buffer.from(sha, "hex");
  for (const t of tokens) {
    const want = Buffer.from(t.sha256, "hex");
    if (want.length === h.length && timingSafeEqual(want, h)) return t;
  }
  return null;
}

export function tokenFromSecret(tokens: TokenConf[], secret: string): TokenConf | null {
  return findToken(tokens, hashToken(secret.trim()));
}

/** Bearer header only (kept for MCP clients and tests). */
export function authenticate(tokens: TokenConf[], header: string | null): TokenConf | null {
  const m = /^Bearer\s+(.+)$/i.exec(header ?? "");
  return m ? tokenFromSecret(tokens, m[1]!) : null;
}

export type AuthResult =
  | { ok: true; who: TokenConf; via: "token" | "session"; sessionId?: string }
  | { ok: false; reason: "missing" | "invalid" | "expired" | "revoked" | "csrf" };

function cookieValue(req: Request, name: string): string | null {
  for (const part of (req.headers.get("cookie") ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return null;
}

export function resolveCaller(req: Request, tokens: TokenConf[], db: RunsDb): AuthResult {
  const header = req.headers.get("authorization");
  if (header) {
    const who = authenticate(tokens, header);
    return who ? { ok: true, who, via: "token" } : { ok: false, reason: "invalid" };
  }
  const cookie = cookieValue(req, SESSION_COOKIE);
  if (!cookie) return { ok: false, reason: "missing" };
  const id = hashToken(cookie);
  const s = db.getSession(id);
  if (!s) return { ok: false, reason: "expired" };
  const now = Date.now();
  if (Date.parse(s.expires) < now) {
    db.deleteSession(id);
    return { ok: false, reason: "expired" };
  }
  const who = findToken(tokens, s.tokenSha);
  if (!who) {
    db.deleteSession(id);
    return { ok: false, reason: "revoked" };
  }
  if (req.method !== "GET" && req.method !== "HEAD" && req.headers.get(CSRF_HEADER) !== "1") return { ok: false, reason: "csrf" };
  // Sliding expiry, written at most once a minute.
  if (now - Date.parse(s.lastSeen) > 60_000)
    db.touchSession(id, new Date(now).toISOString(), new Date(now + (s.persistent ? LONG_TTL : SHORT_TTL)).toISOString());
  return { ok: true, who, via: "session", sessionId: id };
}

function secureRequest(req: Request) {
  return new URL(req.url).protocol === "https:" || req.headers.get("x-forwarded-proto") === "https";
}

/** Create a session for a token; returns the Set-Cookie header value. */
export function startSession(db: RunsDb, req: Request, who: TokenConf, remember: boolean): string {
  const value = randomBytes(32).toString("base64url");
  const now = Date.now();
  db.deleteExpiredSessions(new Date(now).toISOString());
  db.createSession({
    id: hashToken(value),
    tokenSha: who.sha256,
    tokenName: who.name,
    created: new Date(now).toISOString(),
    lastSeen: new Date(now).toISOString(),
    expires: new Date(now + (remember ? LONG_TTL : SHORT_TTL)).toISOString(),
    persistent: remember,
  });
  const attrs = [`${SESSION_COOKIE}=${value}`, "Path=/", "HttpOnly", "SameSite=Strict"];
  if (remember) attrs.push(`Max-Age=${LONG_TTL / 1000}`);
  if (secureRequest(req)) attrs.push("Secure");
  return attrs.join("; ");
}

export function clearCookie(req: Request): string {
  return [`${SESSION_COOKIE}=`, "Path=/", "HttpOnly", "SameSite=Strict", "Max-Age=0", ...(secureRequest(req) ? ["Secure"] : [])].join("; ");
}
