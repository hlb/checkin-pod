const ADMIN_COOKIE_NAME = "checkin_pod_admin_session";
const SECURE_ADMIN_COOKIE_NAME = "__Host-checkin_pod_admin_session";
const LEGACY_ADMIN_COOKIE_NAMES = ["arrival_admin_session"] as const;
const SESSION_VERSION = 2;
const SESSION_MAX_AGE_SECONDS = 8 * 60 * 60;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

export type AdminSessionClaims = {
  v: 2;
  sub: string;
  iat: number;
  exp: number;
  nonce: string;
};

export function cookieValue(request: Request, name: string) {
  const cookieHeader = request.headers.get("cookie") ?? "";
  for (const part of cookieHeader.split(";")) {
    const [cookieName, ...valueParts] = part.trim().split("=");
    if (cookieName === name) return valueParts.join("=");
  }
  return null;
}

export function constantTimeEqual(left: string, right: string) {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return difference === 0;
}

export async function sha256Hex(value: string) {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function base64UrlEncode(bytes: Uint8Array) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function base64UrlDecode(value: string) {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

async function hmacSignature(secret: string, payload: string) {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return base64UrlEncode(new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(payload))));
}

export async function createAdminSessionToken(
  sessionSecret: string,
  subject: string,
  now = Date.now(),
) {
  const issuedAt = Math.floor(now / 1000);
  const claims: AdminSessionClaims = {
    v: SESSION_VERSION,
    sub: subject.slice(0, 120) || "admin",
    iat: issuedAt,
    exp: issuedAt + SESSION_MAX_AGE_SECONDS,
    nonce: crypto.randomUUID(),
  };
  const payload = base64UrlEncode(encoder.encode(JSON.stringify(claims)));
  return `${payload}.${await hmacSignature(sessionSecret, payload)}`;
}

export async function adminSessionFromRequest(
  request: Request,
  sessionSecret?: string,
  now = Date.now(),
): Promise<AdminSessionClaims | null> {
  if (!sessionSecret || sessionSecret.length < 32) return null;
  const token = cookieValue(request, SECURE_ADMIN_COOKIE_NAME)
    ?? cookieValue(request, ADMIN_COOKIE_NAME);
  if (!token) return null;
  const [payload, suppliedSignature, ...extra] = token.split(".");
  if (!payload || !suppliedSignature || extra.length) return null;
  const expectedSignature = await hmacSignature(sessionSecret, payload);
  if (!constantTimeEqual(suppliedSignature, expectedSignature)) return null;
  try {
    const claims = JSON.parse(decoder.decode(base64UrlDecode(payload))) as Partial<AdminSessionClaims>;
    const current = Math.floor(now / 1000);
    if (
      claims.v !== SESSION_VERSION
      || typeof claims.sub !== "string"
      || typeof claims.iat !== "number"
      || typeof claims.exp !== "number"
      || typeof claims.nonce !== "string"
      || claims.iat > current + 60
      || claims.exp <= current
      || claims.exp - claims.iat > SESSION_MAX_AGE_SECONDS
    ) return null;
    return claims as AdminSessionClaims;
  } catch {
    return null;
  }
}

export async function hasValidAdminSession(request: Request, sessionSecret?: string) {
  return Boolean(await adminSessionFromRequest(request, sessionSecret));
}

export function adminCookie(token: string, secure: boolean) {
  const name = secure ? SECURE_ADMIN_COOKIE_NAME : ADMIN_COOKIE_NAME;
  return `${name}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${SESSION_MAX_AGE_SECONDS}${secure ? "; Secure" : ""}`;
}

export function clearAdminCookies(secure: boolean) {
  const suffix = `; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secure ? "; Secure" : ""}`;
  return [
    `${ADMIN_COOKIE_NAME}=${suffix}`,
    `${SECURE_ADMIN_COOKIE_NAME}=${suffix}`,
    ...LEGACY_ADMIN_COOKIE_NAMES.map((name) => `${name}=${suffix}`),
  ];
}
