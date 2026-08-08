import assert from "node:assert/strict";
import test from "node:test";
import { disableTypes, imageSize } from "image-size";

import {
  adminCookie,
  adminSessionFromRequest,
  createAdminSessionToken,
} from "../app/admin-auth.ts";
import { laneSessionCookie } from "../app/lane-auth.ts";
import { readLimitedText, utf8ByteLength } from "../app/request-body.ts";

const sessionSecret = "unit-test-session-secret-with-at-least-32-characters";

test("admin sessions are random, signed, and expire after eight hours", async () => {
  const now = Date.parse("2026-08-08T00:00:00.000Z");
  const first = await createAdminSessionToken(sessionSecret, "alice", now);
  const second = await createAdminSessionToken(sessionSecret, "alice", now);
  assert.notEqual(first, second);

  const request = new Request("https://example.test/admin", {
    headers: { cookie: `__Host-checkin_pod_admin_session=${first}` },
  });
  assert.equal((await adminSessionFromRequest(request, sessionSecret, now + 1_000))?.sub, "alice");
  assert.equal(await adminSessionFromRequest(request, sessionSecret, now + 8 * 60 * 60 * 1_000), null);

  const tampered = new Request("https://example.test/admin", {
    headers: { cookie: `__Host-checkin_pod_admin_session=${first.slice(0, -1)}x` },
  });
  assert.equal(await adminSessionFromRequest(tampered, sessionSecret, now + 1_000), null);
});

test("administrative and lane cookies use strict browser protections", async () => {
  const token = await createAdminSessionToken(sessionSecret, "alice");
  assert.match(adminCookie(token, true), /^__Host-checkin_pod_admin_session=/);
  assert.match(adminCookie(token, true), /HttpOnly; SameSite=Strict; Max-Age=28800; Secure/);
  assert.match(laneSessionCookie("lane-secret", true), /^__Host-checkin_pod_lane_session=/);
  assert.match(laneSessionCookie("lane-secret", true), /HttpOnly; SameSite=Strict; Max-Age=604800; Secure/);
});

test("disables image parsers affected by upstream infinite-loop advisories", () => {
  disableTypes(["heif", "icns", "jxl", "jxl-stream"]);
  const craftedIcns = Buffer.alloc(16);
  craftedIcns.write("icns", 0, "ascii");
  craftedIcns.writeUInt32BE(16, 4);
  craftedIcns.write("TOC ", 8, "ascii");
  craftedIcns.writeUInt32BE(0, 12);
  assert.throws(() => imageSize(craftedIcns), /disabled file type: icns/);
});

test("enforces request and UTF-8 field limits from actual bytes", async () => {
  assert.equal(utf8ByteLength("來賓"), 6);
  const oversized = await readLimitedText(new Request("https://example.test/api", {
    method: "POST",
    body: "來賓",
  }), 5);
  assert.deepEqual(oversized, { ok: false, reason: "too_large" });

  const accepted = await readLimitedText(new Request("https://example.test/api", {
    method: "POST",
    body: JSON.stringify({ ok: true }),
  }), 32);
  assert.deepEqual(accepted, { ok: true, value: '{"ok":true}' });
});
