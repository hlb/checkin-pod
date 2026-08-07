/** Cloudflare Worker entry point for the vinext-starter template. */
import { handleImageOptimization, DEFAULT_DEVICE_SIZES, DEFAULT_IMAGE_SIZES } from "vinext/server/image-optimization";
import handler from "vinext/server/app-router-entry";
import {
  adminCookie,
  adminSessionToken,
  clearAdminCookies,
  hasValidAdminSession,
  sha256Hex,
  constantTimeEqual,
} from "../app/admin-auth";

interface Env {
  ADMIN_PASSWORD?: string;
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

function isAdminPath(pathname: string) {
  return pathname === "/" || pathname === "/admin" || pathname.startsWith("/admin/");
}

function redirectToAdmin(cookies?: string | string[]) {
  const headers = new Headers({ location: "/admin", "cache-control": "no-store" });
  for (const cookie of typeof cookies === "string" ? [cookies] : cookies ?? []) {
    headers.append("set-cookie", cookie);
  }
  return new Response(null, { status: 303, headers });
}

async function clearPublishedLiveEvent(database: D1Database) {
  await database
    .prepare("DELETE FROM live_event_state WHERE id = ?")
    .bind(1)
    .run();
  try {
    await database
      .prepare("UPDATE checkin_events SET active = 0, updated_at = ? WHERE active = 1")
      .bind(new Date().toISOString())
      .run();
  } catch {
    // Older databases may not have the shared check-in tables yet.
  }
}

function adminLoginPage(message = "", status = 200) {
  const error = message
    ? `<p class="error" role="alert">${message}</p>`
    : `<p class="hint">輸入現場工作人員密碼後繼續</p>`;
  const html = `<!doctype html>
<html lang="zh-Hant">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta name="theme-color" content="#173b2a" />
  <title>Checkin Pod｜中控台登入</title>
  <style>
    *{box-sizing:border-box}body{min-height:100vh;margin:0;display:grid;place-items:center;padding:24px;color:#172019;background:#f4f1e8;font-family:Inter,system-ui,-apple-system,"Noto Sans TC","PingFang TC",sans-serif}.card{width:min(420px,100%);padding:38px;background:#fff;border:1px solid #d8d9ce;border-radius:24px 24px 24px 8px;box-shadow:0 24px 80px rgba(29,48,34,.12)}.mark{width:48px;height:48px;display:grid;place-items:center;color:#fff;background:#f46f3a;border-radius:15px 15px 15px 4px;font-size:24px;font-weight:900;transform:rotate(-2deg)}.eyebrow{margin:26px 0 8px;color:#d75225;font-size:11px;font-weight:900;letter-spacing:.18em;text-transform:uppercase}h1{margin:0;font-family:Georgia,"Noto Serif TC",serif;font-size:34px}.hint,.error{min-height:24px;margin:10px 0 22px;color:#6f776f;font-size:13px}.error{color:#a43e2e;font-weight:750}label{display:block;margin-bottom:8px;font-size:12px;font-weight:850}input{width:100%;height:50px;padding:0 14px;border:1px solid #cfd4cc;border-radius:11px;background:#fbfaf5;font:inherit;outline:none}input:focus{border-color:#285a40;box-shadow:0 0 0 3px rgba(40,90,64,.13)}button{width:100%;height:50px;margin-top:14px;border:0;border-radius:11px;color:#fff;background:#173b2a;font:inherit;font-weight:850;cursor:pointer}button:hover{background:#0e2d1e}.public-links{margin:24px 0 0;padding-top:20px;border-top:1px solid #e5e4dc;display:flex;gap:18px}.public-links a{color:#526157;font-size:12px;font-weight:750;text-decoration:none}.public-links a:hover{color:#173b2a}
  </style>
</head>
<body>
  <main class="card">
    <div class="mark" aria-hidden="true">P</div>
    <p class="eyebrow">Pod access</p>
    <h1>Checkin Pod</h1>
    ${error}
    <form method="post" action="/admin-auth">
      <label for="password">工作人員密碼</label>
      <input id="password" name="password" type="password" autocomplete="current-password" maxlength="128" required autofocus />
      <button type="submit">進入中控台</button>
    </form>
    <nav class="public-links" aria-label="公開畫面">
      <a href="/scan">來賓畫面 ↗</a>
      <a href="/projection">投影畫面 ↗</a>
    </nav>
  </main>
</body>
</html>`;
  return new Response(html, {
    status,
    headers: {
      "cache-control": "no-store, max-age=0",
      "content-type": "text/html; charset=utf-8",
      "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
      "x-frame-options": "DENY",
    },
  });
}

// Image security config. SVG sources with .svg extension auto-skip the
// optimization endpoint on the client side (served directly, no proxy).
// To route SVGs through the optimizer (with security headers), set
// dangerouslyAllowSVG: true in next.config.js and uncomment below:
// const imageConfig: ImageConfig = { dangerouslyAllowSVG: true };

const worker = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/admin-auth/logout") {
      if (
        env.ADMIN_PASSWORD &&
        (await hasValidAdminSession(request, env.ADMIN_PASSWORD))
      ) {
        try {
          await clearPublishedLiveEvent(env.DB);
        } catch {
          return adminLoginPage("無法結束公開投影，請稍後再試。", 503);
        }
      }
      return redirectToAdmin(clearAdminCookies(url.protocol === "https:"));
    }

    if (url.pathname === "/admin-auth") {
      if (request.method !== "POST") return redirectToAdmin();
      if (!env.ADMIN_PASSWORD) return adminLoginPage("中控台密碼尚未設定。", 503);
      const contentLength = Number(request.headers.get("content-length") ?? 0);
      if (contentLength > 4_096) return adminLoginPage("登入資料過大。", 413);
      const formData = await request.formData().catch(() => null);
      const suppliedPassword = formData?.get("password");
      const suppliedHash = await sha256Hex(typeof suppliedPassword === "string" ? suppliedPassword : "");
      const expectedHash = await sha256Hex(env.ADMIN_PASSWORD);
      if (!constantTimeEqual(suppliedHash, expectedHash)) {
        return adminLoginPage("密碼不正確，請再試一次。", 401);
      }
      const token = await adminSessionToken(env.ADMIN_PASSWORD);
      return redirectToAdmin(adminCookie(token, url.protocol === "https:"));
    }

    if (isAdminPath(url.pathname)) {
      if (!env.ADMIN_PASSWORD) return adminLoginPage("中控台密碼尚未設定。", 503);
      if (!(await hasValidAdminSession(request, env.ADMIN_PASSWORD))) return adminLoginPage();
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
  },
};

export default worker;
