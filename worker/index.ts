/** Cloudflare Worker entry point for Checkin Pod. */
import { handleImageOptimization, DEFAULT_DEVICE_SIZES, DEFAULT_IMAGE_SIZES } from "vinext/server/image-optimization";
import handler from "vinext/server/app-router-entry";
import {
  adminCookie,
  adminSessionFromRequest,
  clearAdminCookies,
  createAdminSessionToken,
  hasValidAdminSession,
  sha256Hex,
  constantTimeEqual,
} from "../app/admin-auth";
import { readLimitedText } from "../app/request-body";

type RateLimiter = { limit(options: { key: string }): Promise<{ success: boolean }> };

interface Env {
  ADMIN_PASSWORD?: string;
  ADMIN_USERNAME?: string;
  ADMIN_USERS_JSON?: string;
  SESSION_SECRET?: string;
  LOGIN_RATE_LIMITER?: RateLimiter;
  ASSETS: Fetcher;
  DB: D1Database;
  IMAGES: {
    input(stream: ReadableStream): {
      transform(options: Record<string, unknown>): {
        output(options: { format: string; quality: number }): Promise<{ response(): Response }>;
      };
    };
  };
}

interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException(): void;
}

type LocalRateWindow = { startedAt: number; count: number };
const localRateWindows = new Map<string, LocalRateWindow>();

function isAdminPath(pathname: string) {
  return pathname === "/" || pathname === "/admin" || pathname.startsWith("/admin/");
}

function hasSameOrigin(request: Request, url: URL) {
  const origin = request.headers.get("origin")?.trim();
  if (origin && origin !== "null") {
    try {
      return new URL(origin).origin === url.origin;
    } catch {
      return false;
    }
  }

  const referer = request.headers.get("referer")?.trim();
  if (referer) {
    try {
      return new URL(referer).origin === url.origin;
    } catch {
      return false;
    }
  }

  return request.headers.get("sec-fetch-site")?.toLowerCase() === "same-origin";
}

function hasExplicitCrossSiteSource(request: Request, url: URL) {
  const origin = request.headers.get("origin")?.trim();
  if (origin && origin !== "null") {
    try {
      return new URL(origin).origin !== url.origin;
    } catch {
      return true;
    }
  }

  const referer = request.headers.get("referer")?.trim();
  if (referer) {
    try {
      return new URL(referer).origin !== url.origin;
    } catch {
      return true;
    }
  }

  return request.headers.get("sec-fetch-site")?.toLowerCase() === "cross-site";
}

function loginCsrfCookieName(secure: boolean) {
  return secure ? "__Host-checkin_pod_login_csrf" : "checkin_pod_login_csrf";
}

function loginCsrfCookie(token: string, secure: boolean, maxAge = 600) {
  return `${loginCsrfCookieName(secure)}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure ? "; Secure" : ""}`;
}

function requestCookie(request: Request, name: string) {
  for (const part of (request.headers.get("cookie") ?? "").split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0 || part.slice(0, separator).trim() !== name) continue;
    return part.slice(separator + 1).trim();
  }
  return "";
}

function newLoginCsrfToken() {
  return `${crypto.randomUUID().replaceAll("-", "")}${crypto.randomUUID().replaceAll("-", "")}`;
}

async function hasValidLoginCsrf(request: Request, formData: URLSearchParams, secure: boolean) {
  const supplied = (formData.get("csrf_token") ?? "").slice(0, 128);
  const expected = requestCookie(request, loginCsrfCookieName(secure)).slice(0, 128);
  if (!supplied || !expected) return false;
  const [suppliedHash, expectedHash] = await Promise.all([sha256Hex(supplied), sha256Hex(expected)]);
  return constantTimeEqual(suppliedHash, expectedHash);
}

function redirectToAdmin(cookies?: string | string[]) {
  const headers = new Headers({ location: "/admin", "cache-control": "no-store" });
  for (const cookie of typeof cookies === "string" ? [cookies] : cookies ?? []) {
    headers.append("set-cookie", cookie);
  }
  return new Response(null, { status: 303, headers });
}

function localRateLimit(key: string, limit: number, periodMs: number) {
  const now = Date.now();
  const current = localRateWindows.get(key);
  if (!current || now - current.startedAt >= periodMs) {
    localRateWindows.set(key, { startedAt: now, count: 1 });
    return true;
  }
  current.count += 1;
  if (localRateWindows.size > 5_000) {
    for (const [candidate, window] of localRateWindows) {
      if (now - window.startedAt >= periodMs) localRateWindows.delete(candidate);
    }
  }
  return current.count <= limit;
}

function clientAddress(request: Request) {
  return request.headers.get("cf-connecting-ip")?.trim().slice(0, 64) || "unknown";
}

async function withinRateLimit(
  binding: RateLimiter | undefined,
  key: string,
  fallbackLimit: number,
  fallbackPeriodMs: number,
) {
  if (binding) return (await binding.limit({ key })).success;
  return localRateLimit(key, fallbackLimit, fallbackPeriodMs);
}

function configuredAdminCredential(env: Env, username: string) {
  if (env.ADMIN_USERS_JSON) {
    try {
      const users = JSON.parse(env.ADMIN_USERS_JSON) as unknown;
      if (users && typeof users === "object" && !Array.isArray(users)) {
        const password = (users as Record<string, unknown>)[username];
        if (typeof password === "string" && password.length) return { username, password };
      }
    } catch {
      return null;
    }
  }
  if (env.ADMIN_USERNAME && env.ADMIN_PASSWORD) {
    return { username: env.ADMIN_USERNAME, password: env.ADMIN_PASSWORD };
  }
  return null;
}

function hasAdminCredentials(env: Env) {
  return Boolean(env.ADMIN_USERS_JSON || env.ADMIN_USERNAME && env.ADMIN_PASSWORD);
}

async function deactivateSharedProjection(database: D1Database) {
  try {
    await database.prepare("UPDATE checkin_events SET active = 0, updated_at = ? WHERE active = 1")
      .bind(new Date().toISOString()).run();
  } catch {
    // Older local databases may not have the shared check-in tables yet.
  }
}

async function purgeExpiredSharedEvents(database: D1Database) {
  const result = await database.prepare(`DELETE FROM checkin_events
    WHERE expires_at <> '' AND expires_at <= ?`).bind(new Date().toISOString()).run();
  console.log("retention_cleanup_complete", { deleted: result.meta.changes });
}

async function recordWorkerAudit(database: D1Database, actor: string, action: string, request: Request) {
  try {
    await database.prepare(`CREATE TABLE IF NOT EXISTS checkin_admin_audit (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      actor TEXT NOT NULL,
      action TEXT NOT NULL,
      event_id TEXT,
      occurred_at TEXT NOT NULL,
      request_id TEXT NOT NULL,
      details_json TEXT NOT NULL DEFAULT '{}'
    )`).run();
    await database.prepare(`INSERT INTO checkin_admin_audit
        (actor, action, event_id, occurred_at, request_id, details_json)
      VALUES (?, ?, NULL, ?, ?, ?)`)
      .bind(
        actor.slice(0, 120),
        action,
        new Date().toISOString(),
        crypto.randomUUID(),
        JSON.stringify({ sourceHash: await sha256Hex(clientAddress(request)) }),
      ).run();
  } catch {
    // Authentication remains available if the audit store is temporarily unavailable.
  }
}

function adminLoginPage(message = "", status = 200, extraHeaders?: HeadersInit, secure = false) {
  const csrfToken = newLoginCsrfToken();
  const error = message
    ? `<p class="error" role="alert">${message}</p>`
    : `<p class="hint">輸入管理員帳號與密碼後繼續</p>`;
  const html = `<!doctype html>
<html lang="zh-Hant">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta name="theme-color" content="#0e0f12" />
  <title>Checkin Pod｜中控台登入</title>
  <style>
    *{box-sizing:border-box}body{min-height:100vh;margin:0;display:grid;place-items:center;padding:24px;color:#f4f1e8;background:#0e0f12;font-family:Inter,"Noto Sans TC",system-ui,-apple-system,"PingFang TC",sans-serif;font-feature-settings:"ss01","ss04","ss07","cv01"}.card{width:min(420px,100%);padding:38px;background:#15171b;border:1px solid #2a2e35;border-radius:20px;box-shadow:0 24px 80px rgba(0,0,0,.35)}.mark{width:48px;height:48px;display:grid;place-items:center;overflow:hidden;color:#ff9e1b;background:#0e0f12;border:1px solid #3a3e45;border-radius:10px;font-size:24px;font-weight:900;position:relative}.mark:after{content:"";position:absolute;inset:50% 0 auto;border-top:1px solid rgba(244,241,232,.16);box-shadow:0 1px rgba(0,0,0,.6)}.eyebrow{margin:26px 0 8px;color:#ff9e1b;font-size: 18px;font-weight:900;letter-spacing:.18em;text-transform:uppercase}h1{margin:0;font-size:34px;font-weight:585;letter-spacing:-.03em}.hint,.error{min-height:24px;margin:10px 0 22px;color:#b9b3a7;font-size: 18px}.error{color:#ff6b5e;font-weight:750}label{display:block;margin:12px 0 8px;font-size: 18px;font-weight:850}input{width:100%;height:50px;padding:0 14px;color:#f4f1e8;border:1px solid #3a3e45;border-radius:10px;background:#1c1f24;font:inherit;outline:none}input:focus{border-color:#ff9e1b;box-shadow:0 0 0 3px rgba(255,158,27,.2)}button{width:100%;height:50px;margin-top:18px;border:0;border-radius:10px;color:#1a1200;background:#ff9e1b;font:inherit;font-weight:850;cursor:pointer}button:hover{background:#ffd23f}.public-links{margin:24px 0 0;padding-top:20px;border-top:1px solid #2a2e35;display:flex;gap:18px}.public-links a{color:#b9b3a7;font-size: 18px;font-weight:750;text-decoration:none}.public-links a:hover{color:#f4f1e8}
  </style>
</head>
<body>
  <main class="card">
    <div class="mark" aria-hidden="true">P</div>
    <p class="eyebrow">Pod access</p>
    <h1>Checkin Pod</h1>
    ${error}
    <form method="post" action="/admin-auth">
      <input name="csrf_token" type="hidden" value="${csrfToken}" />
      <label for="username">管理員帳號</label>
      <input id="username" name="username" type="text" autocomplete="username" maxlength="120" required />
      <label for="password">管理員密碼</label>
      <input id="password" name="password" type="password" autocomplete="current-password" maxlength="128" required />
      <button type="submit">進入中控台</button>
    </form>
    <nav class="public-links" aria-label="公開畫面">
      <a href="/benchmark">效能實測 ↗</a>
      <a href="/scan">來賓畫面 ↗</a>
      <a href="/projection">投影畫面 ↗</a>
    </nav>
  </main>
</body>
</html>`;
  const headers = new Headers(extraHeaders);
  headers.append("set-cookie", loginCsrfCookie(csrfToken, secure));
  headers.set("cache-control", "no-store, max-age=0");
  headers.set("content-type", "text/html; charset=utf-8");
  headers.set("content-security-policy", "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'");
  headers.set("referrer-policy", "no-referrer");
  headers.set("x-content-type-options", "nosniff");
  headers.set("x-frame-options", "DENY");
  return new Response(html, { status, headers });
}

function withSecurityHeaders(response: Response, request: Request) {
  const headers = new Headers(response.headers);
  if (!headers.has("content-security-policy")) {
    headers.set("content-security-policy", [
      "default-src 'self'",
      "base-uri 'self'",
      "object-src 'none'",
      "frame-ancestors 'none'",
      "form-action 'self'",
      "script-src 'self' 'unsafe-inline'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob:",
      "media-src 'self' blob:",
      "connect-src 'self'",
      "worker-src 'self' blob:",
      "manifest-src 'self'",
    ].join("; "));
  }
  headers.set("referrer-policy", "no-referrer");
  headers.set("x-content-type-options", "nosniff");
  headers.set("x-frame-options", "DENY");
  headers.set("permissions-policy", "camera=(self), microphone=(), geolocation=(), payment=(), usb=(), serial=()");
  headers.set("cross-origin-opener-policy", "same-origin");
  headers.set("cross-origin-resource-policy", "same-origin");
  if (new URL(request.url).protocol === "https:") {
    headers.set("strict-transport-security", "max-age=31536000; includeSubDomains");
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

async function handleRequest(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const url = new URL(request.url);
  const secure = url.protocol === "https:";

  if (url.pathname === "/admin-auth/logout") {
    if (request.method !== "POST") {
      return new Response("Method Not Allowed", { status: 405, headers: { allow: "POST" } });
    }
    if (!hasSameOrigin(request, url)) return new Response("Forbidden", { status: 403 });
    const session = await adminSessionFromRequest(request, env.SESSION_SECRET);
    if (session) {
      try {
        await deactivateSharedProjection(env.DB);
        await recordWorkerAudit(env.DB, session.sub, "admin.logout", request);
      } catch {
        return adminLoginPage("無法結束公開投影，請稍後再試。", 503, undefined, secure);
      }
    }
    return redirectToAdmin(clearAdminCookies(secure));
  }

  if (url.pathname === "/admin-auth") {
    if (request.method !== "POST") return redirectToAdmin();
    if (hasExplicitCrossSiteSource(request, url)) {
      return adminLoginPage("登入來源無效。", 403, undefined, secure);
    }
    const sameOrigin = hasSameOrigin(request, url);
    if (!hasAdminCredentials(env)) {
      return adminLoginPage("管理員帳號或密碼尚未設定。", 503, undefined, secure);
    }
    if (!env.SESSION_SECRET || env.SESSION_SECRET.length < 32) {
      return adminLoginPage("SESSION_SECRET 需要至少 32 個字元。", 503, undefined, secure);
    }
    if (!(request.headers.get("content-type") ?? "").toLowerCase().startsWith("application/x-www-form-urlencoded")) {
      return adminLoginPage("登入資料格式無效。", 415, undefined, secure);
    }
    const rawForm = await readLimitedText(request, 4_096);
    if (!rawForm.ok) {
      return adminLoginPage(
        rawForm.reason === "too_large" ? "登入資料過大。" : "登入資料無效。",
        rawForm.reason === "too_large" ? 413 : 400,
        undefined,
        secure,
      );
    }
    const formData = new URLSearchParams(rawForm.value);
    if (!sameOrigin && !(await hasValidLoginCsrf(request, formData, secure))) {
      return adminLoginPage("登入來源無效。", 403, undefined, secure);
    }
    const suppliedUsername = (formData.get("username") ?? "").trim().slice(0, 120);
    const rateKeys = [
      `admin-login:account:${suppliedUsername.toLowerCase() || "unknown"}`,
      `admin-login:ip:${clientAddress(request)}`,
    ];
    const rateChecks = await Promise.all(rateKeys.map((key) =>
      withinRateLimit(env.LOGIN_RATE_LIMITER, key, 10, 60_000)));
    if (rateChecks.some((allowed) => !allowed)) {
      return adminLoginPage("登入嘗試次數已達上限，請在 60 秒後再試。", 429, { "retry-after": "60" }, secure);
    }
    const suppliedPassword = formData.get("password");
    const credential = configuredAdminCredential(env, suppliedUsername);
    const [suppliedPasswordHash, expectedPasswordHash] = await Promise.all([
      sha256Hex(suppliedPassword ?? ""),
      sha256Hex(credential?.password ?? env.SESSION_SECRET),
    ]);
    if (!credential || !constantTimeEqual(suppliedPasswordHash, expectedPasswordHash)) {
      return adminLoginPage("帳號或密碼不正確，請再試一次。", 401, undefined, secure);
    }
    const token = await createAdminSessionToken(env.SESSION_SECRET, credential.username);
    await recordWorkerAudit(env.DB, credential.username, "admin.login", request);
    return redirectToAdmin([adminCookie(token, secure), loginCsrfCookie("", secure, 0)]);
  }

  if (isAdminPath(url.pathname)) {
    if (!hasAdminCredentials(env) || !env.SESSION_SECRET) {
      return adminLoginPage("管理員登入設定尚未完成。", 503, undefined, secure);
    }
    if (!(await hasValidAdminSession(request, env.SESSION_SECRET))) return adminLoginPage("", 200, undefined, secure);
  }

  if (url.pathname === "/_vinext/image") {
    const allowedWidths = [...DEFAULT_DEVICE_SIZES, ...DEFAULT_IMAGE_SIZES];
    return handleImageOptimization(request, {
      fetchAsset: (path) => env.ASSETS.fetch(new Request(new URL(path, request.url))),
      transformImage: async (body, { width, format, quality }) => {
        const result = await env.IMAGES.input(body).transform(width > 0 ? { width } : {}).output({ format, quality });
        return result.response();
      },
    }, allowedWidths);
  }

  return handler.fetch(request, env, ctx);
}

const worker = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    return withSecurityHeaders(await handleRequest(request, env, ctx), request);
  },
  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(purgeExpiredSharedEvents(env.DB));
  },
};

export default worker;
