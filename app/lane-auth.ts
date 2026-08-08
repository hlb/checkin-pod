import { cookieValue } from "./admin-auth.ts";

const LANE_COOKIE_NAME = "checkin_pod_lane_session";
const SECURE_LANE_COOKIE_NAME = "__Host-checkin_pod_lane_session";
const LANE_SESSION_MAX_AGE_SECONDS = 7 * 24 * 60 * 60;

export function laneTokenFromRequest(request: Request) {
  return cookieValue(request, SECURE_LANE_COOKIE_NAME)
    ?? cookieValue(request, LANE_COOKIE_NAME)
    ?? "";
}

export function laneSessionCookie(token: string, secure: boolean) {
  const name = secure ? SECURE_LANE_COOKIE_NAME : LANE_COOKIE_NAME;
  return `${name}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${LANE_SESSION_MAX_AGE_SECONDS}${secure ? "; Secure" : ""}`;
}

export function clearLaneSessionCookies(secure: boolean) {
  const suffix = `; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secure ? "; Secure" : ""}`;
  return [
    `${LANE_COOKIE_NAME}=${suffix}`,
    `${SECURE_LANE_COOKIE_NAME}=${suffix}`,
  ];
}
