export const ADMIN_COOKIE_NAME = "checkin_pod_admin_session";

const ADMIN_COOKIE_SALT = "checkin-pod-admin-v1";
const LEGACY_ADMIN_COOKIE_NAME = "arrival_admin_session";
const LEGACY_ADMIN_COOKIE_SALT = "arrival-checkin-admin-v1";
const encoder = new TextEncoder();

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

async function sessionToken(password: string, salt: string) {
  return sha256Hex(`${salt}:${password}`);
}

export async function adminSessionToken(password: string) {
  return sessionToken(password, ADMIN_COOKIE_SALT);
}

export async function hasValidAdminSession(request: Request, password?: string) {
  if (!password) return false;
  const suppliedToken = cookieValue(request, ADMIN_COOKIE_NAME);
  if (suppliedToken) {
    return constantTimeEqual(suppliedToken, await adminSessionToken(password));
  }
  const legacyToken = cookieValue(request, LEGACY_ADMIN_COOKIE_NAME) ?? "";
  return constantTimeEqual(
    legacyToken,
    await sessionToken(password, LEGACY_ADMIN_COOKIE_SALT),
  );
}

export function adminCookie(token: string, secure: boolean) {
  return `${ADMIN_COOKIE_NAME}=${token}; Path=/; HttpOnly; SameSite=Strict${secure ? "; Secure" : ""}`;
}

export function clearAdminCookies(secure: boolean) {
  const suffix = `; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secure ? "; Secure" : ""}`;
  return [
    `${ADMIN_COOKIE_NAME}=${suffix}`,
    `${LEGACY_ADMIN_COOKIE_NAME}=${suffix}`,
  ];
}
