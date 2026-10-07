/**
 * Dashboard protection:
 * - a per-launch admin token, written to `data/admin-token` (mode 0600) and printed at startup;
 * - `GET /?token=<token>` exchanges it for an `HttpOnly; SameSite=Strict` cookie and redirects to `/`;
 * - every request must carry a `Host` equal to the listener's own origin (`127.0.0.1:<port>` or
 *   `localhost:<port>`), which also defeats DNS rebinding and an accidental tunnel to this port;
 * - every state-changing request additionally needs the cookie and an `Origin` equal to that origin;
 *   anything else → 403. Read requests without the cookie → 401.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { chmod, mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Context, MiddlewareHandler } from "hono";
import { getCookie, setCookie } from "hono/cookie";

export const ADMIN_TOKEN_FILE = "admin-token";

/** The only host the admin listener binds to. */
export const ADMIN_BIND_HOST = "127.0.0.1";

export function adminTokenPath(dataDir: string): string {
  return join(dataDir, ADMIN_TOKEN_FILE);
}

export function generateAdminToken(): string {
  return randomBytes(32).toString("base64url");
}

/** Writes the token with mode 0600 (also when the file already existed with a wider mode). */
export async function writeAdminToken(path: string, token: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, `${token}\n`, { mode: 0o600 });
  await chmod(path, 0o600);
}

export async function removeAdminToken(path: string): Promise<void> {
  await rm(path, { force: true });
}

/** Throws unless `hostname` is the loopback address the dashboard is allowed to bind to. */
export function assertLoopbackBind(hostname: string): void {
  if (hostname !== ADMIN_BIND_HOST) {
    throw new Error(`the dashboard binds to ${ADMIN_BIND_HOST} only (refusing "${hostname}")`);
  }
}

/** Cookie name; includes the port so two bridges on one machine do not overwrite each other. */
export function adminCookieName(port: number): string {
  return `bridge_admin_${port}`;
}

export function allowedHosts(port: number): string[] {
  return [`127.0.0.1:${port}`, `localhost:${port}`];
}

export function allowedOrigins(port: number): string[] {
  return allowedHosts(port).map((h) => `http://${h}`);
}

function digest(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

/** Constant-time comparison of a presented value with the token. */
export function tokenMatches(presented: string | undefined | null, token: string): boolean {
  if (typeof presented !== "string" || presented.length === 0) return false;
  return timingSafeEqual(digest(presented), digest(token));
}

export function isStateChanging(method: string): boolean {
  return !["GET", "HEAD", "OPTIONS"].includes(method.toUpperCase());
}

export interface GuardOptions {
  token: string;
  /** The listener's port (a function: with port 0 the real port is known only after binding). */
  port: () => number;
}

function requestHost(c: Context): string {
  const header = c.req.header("host");
  if (header !== undefined && header !== "") return header.toLowerCase();
  try {
    return new URL(c.req.url).host.toLowerCase();
  } catch {
    return "";
  }
}

function forbidden(c: Context, reason: string): Response {
  return c.json({ error: "forbidden", message: reason }, 403);
}

export function hasAdminCookie(c: Context, options: GuardOptions): boolean {
  return tokenMatches(getCookie(c, adminCookieName(options.port())), options.token);
}

/**
 * Host check on every request, then Origin + cookie on state-changing requests. Read requests are
 * left to {@link requireCookieForReads} (so the token exchange on `/` can run first).
 */
export function originGuard(options: GuardOptions): MiddlewareHandler {
  return async (c, next) => {
    const port = options.port();
    if (!allowedHosts(port).includes(requestHost(c))) {
      return forbidden(c, "the dashboard answers only on its own loopback origin");
    }
    if (isStateChanging(c.req.method)) {
      const origin = c.req.header("origin");
      if (origin === undefined || !allowedOrigins(port).includes(origin.toLowerCase())) {
        return forbidden(c, "cross-origin or Origin-less state-changing request refused");
      }
      if (!hasAdminCookie(c, options)) {
        return forbidden(c, "missing or invalid dashboard cookie; open the URL printed at startup");
      }
    }
    await next();
  };
}

/** `GET /?token=…`: a valid token sets the cookie and redirects to `/` (the token leaves the address bar). */
export function tokenExchange(options: GuardOptions): MiddlewareHandler {
  return async (c, next) => {
    const presented = c.req.query("token");
    if (c.req.method !== "GET" || c.req.path !== "/" || presented === undefined) return next();
    if (!tokenMatches(presented, options.token)) {
      return c.html(notAuthorizedPage(LINK_NOT_VALID), 401);
    }
    setCookie(c, adminCookieName(options.port()), options.token, {
      httpOnly: true,
      sameSite: "Strict",
      path: "/",
    });
    return c.redirect("/", 303);
  };
}

/** Read requests (pages, assets, API GETs) need the cookie: 401 otherwise. */
export function requireCookieForReads(options: GuardOptions): MiddlewareHandler {
  return async (c, next) => {
    if (!isStateChanging(c.req.method) && !hasAdminCookie(c, options)) {
      if (c.req.path.startsWith("/api/")) {
        return c.json({ error: "unauthorized", message: "open the dashboard URL printed at startup" }, 401);
      }
      return c.html(notAuthorizedPage(NOT_SIGNED_IN), 401);
    }
    await next();
  };
}

/** Response headers for every dashboard response. */
export function securityHeaders(): MiddlewareHandler {
  return async (c, next) => {
    await next();
    c.header(
      "Content-Security-Policy",
      "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; " +
        "frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    );
    c.header("X-Frame-Options", "DENY");
    c.header("X-Content-Type-Options", "nosniff");
    c.header("Referrer-Policy", "no-referrer");
    c.header("Cache-Control", "no-store");
  };
}

interface PageMessage {
  ko: string;
  en: string;
}

const LINK_NOT_VALID: PageMessage = {
  ko: "이 링크는 지금 실행 중인 프로그램에서는 쓸 수 없습니다. 프로그램이 다시 시작되면 예전 링크는 더 이상 열리지 않습니다.",
  en: "This link does not work for the program that is running now. After the program restarts, old links stop working.",
};

const NOT_SIGNED_IN: PageMessage = {
  ko: "설정 페이지에 로그인되어 있지 않습니다.",
  en: "You are not signed in to the settings page.",
};

/**
 * The "not signed in" page. It cannot know the page language the browser chose, so it shows Korean
 * and English together, and sends the user to the opener (`Open Settings.command`), which opens a
 * fresh signed-in page. Static text only.
 */
function notAuthorizedPage(message: PageMessage): string {
  return `<!doctype html>
<html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Browser Research Bridge 설정 / Settings</title></head>
<body>
<h1>Browser Research Bridge 설정 페이지 / Settings page</h1>
<section lang="ko">
<p>${message.ko}</p>
<p>프로젝트 폴더 맨 위에 있는 <code>Open Settings.command</code> 파일을 더블클릭하세요. 로그인된 설정 페이지가 새로 열립니다.</p>
</section>
<hr>
<section lang="en">
<p>${message.en}</p>
<p>Double-click <code>Open Settings.command</code> at the top of the project folder. It opens a new, signed-in settings page.</p>
</section>
</body></html>`;
}
