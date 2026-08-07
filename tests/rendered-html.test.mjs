import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

async function render(path = "/", init = {}) {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}-${Math.random()}`);
  const { default: worker } = await import(workerUrl.href);
  return worker.fetch(
    new Request(`http://localhost${path}`, {
      ...init,
      headers: { accept: "text/html", ...init.headers },
    }),
    {
      ADMIN_PASSWORD: "test-password",
      ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) },
    },
    { waitUntil() {}, passThroughOnException() {} },
  );
}

async function adminCookie() {
  const response = await render("/admin-auth", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ password: "test-password" }),
  });
  assert.equal(response.status, 303);
  return response.headers.get("set-cookie")?.split(";", 1)[0] ?? "";
}

test("server-renders the check-in application shell", async () => {
  const response = await render("/", { headers: { cookie: await adminCookie() } });
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);
  const html = await response.text();
  assert.match(html, /<html[^>]*lang="zh-Hant"/i);
  assert.match(html, /<title>抵達｜Luma QR 報到台<\/title>/i);
  assert.match(html, /正在還原這台裝置的報到紀錄/);
});

test("provides separate admin, guest scanner, and projection routes", async () => {
  const cookie = await adminCookie();
  const [adminResponse, scanResponse, projectionResponse] = await Promise.all([
    render("/admin", { headers: { cookie } }),
    render("/scan"),
    render("/projection"),
  ]);
  assert.equal(adminResponse.status, 200);
  assert.equal(scanResponse.status, 200);
  assert.equal(projectionResponse.status, 200);
  assert.match(await adminResponse.text(), /正在還原這台裝置的報到紀錄/);
  assert.match(await scanResponse.text(), /正在準備掃描器/);
  assert.match(await projectionResponse.text(), /啟動全場能量牆/);
});

test("password-protects the control center while keeping displays public", async () => {
  const [lockedAdmin, scanResponse, projectionResponse] = await Promise.all([
    render("/admin"),
    render("/scan"),
    render("/projection"),
  ]);
  assert.equal(lockedAdmin.status, 200);
  assert.match(await lockedAdmin.text(), /工作人員密碼/);
  assert.equal(scanResponse.status, 200);
  assert.equal(projectionResponse.status, 200);

  const wrongPassword = await render("/admin-auth", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ password: "wrong-password" }),
  });
  assert.equal(wrongPassword.status, 401);
  assert.match(await wrongPassword.text(), /密碼不正確/);
});

test("wires persistence, scanner, secured projection sync, and event controls", async () => {
  const [page, scanPage, projectionPage, planetVariants, liveRoute, policy, core, auth, styles, workerSource, sampleZip, successAudio, failureAudio] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/scan/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/projection/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/planet-variants.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/live-event/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/live-event-policy.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/checkin-core.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/admin-auth.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
    readFile(new URL("../worker/index.ts", import.meta.url), "utf8"),
    readFile(new URL("../public/arrival-checkin-sample-150.zip", import.meta.url)),
    readFile(new URL("../public/audio/checkin-success.mp3", import.meta.url)),
    readFile(new URL("../public/audio/checkin-failure.mp3", import.meta.url)),
  ]);

  assert.match(page, /const MAX_ATTENDEES = 200/);
  assert.match(page, /commitScan/);
  assert.match(scanPage, /commitScan/);
  assert.doesNotMatch(page, /indexedDB\.open/);
  assert.match(core, /indexedDB\.open/);
  assert.match(core, /DB_VERSION = 2/);
  assert.match(core, /navigator\.locks/);
  assert.match(core, /applyScanToEvent/);
  assert.match(core, /ASSET_STORE_NAME/);
  assert.match(core, /x-event-writer-token/);
  assert.match(page, /writeBackgroundImageDataUrl/);
  assert.match(scanPage, /readBackgroundImageDataUrl/);
  assert.match(scanPage, /BarcodeDetector/);
  assert.match(scanPage, /deviceId: \{ exact: cameraId \}/);
  assert.match(scanPage, /報到提示音/);
  assert.match(page, /目前報到率/);
  assert.match(page, /播放登車廣播/);
  assert.match(page, /全場彩蛋/);
  assert.match(projectionPage, /arrivalQueue/);
  assert.match(projectionPage, /pendingCueRef/);
  assert.match(projectionPage, /new Set<number>/);
  assert.match(projectionPage, /checkedIn\.map/);
  assert.match(projectionPage, /type-\$\{appearance\.type\}/);
  assert.match(planetVariants, /PLANET_PALETTES/);
  assert.match(planetVariants, /PLANET_TYPES/);
  assert.match(planetVariants, /combinationIndex/);
  assert.match(liveRoute, /hasValidAdminSession/);
  assert.match(liveRoute, /isLiveEventWriterAuthorized/);
  assert.match(policy, /input\.total > 200/);
  assert.match(policy, /isStaleLiveEventSnapshot/);
  assert.match(auth, /HttpOnly/);
  assert.match(auth, /SameSite=Strict/);
  assert.match(workerSource, /ADMIN_PASSWORD/);
  assert.doesNotMatch(workerSource + auth, /llap55688/);
  assert.match(styles, /\.guest-screen\.has-custom-background\s*\{[^}]*background-size:\s*contain/s);
  assert.match(styles, /@keyframes planetFlyIn/);
  for (const type of ["rocky", "ringed", "banded", "cube", "molten", "crystal"]) {
    assert.match(styles, new RegExp(`\\.energy-planet\\.type-${type}`));
  }
  assert.ok(sampleZip.length > 10_000);
  assert.ok(successAudio.length > 1_000);
  assert.ok(failureAudio.length > 1_000);
});
