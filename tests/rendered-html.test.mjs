import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  CAMERA_CODE_RELEASE_MS,
  EMPTY_CAMERA_SCAN_STATE,
  advanceCameraScanState,
} from "../app/camera-scan-state.ts";

async function render(path = "/", init = {}, envOverrides = {}) {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}-${Math.random()}`);
  const { default: worker } = await import(workerUrl.href);
  return worker.fetch(
    new Request(`http://localhost${path}`, {
      ...init,
      headers: {
        accept: "text/html",
        ...(init.method === "POST" ? { origin: "http://localhost" } : {}),
        ...init.headers,
      },
    }),
    {
      ADMIN_PASSWORD: "test-password",
      ADMIN_USERNAME: "test-admin",
      SESSION_SECRET: "test-session-secret-with-at-least-32-characters",
      ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) },
      ...envOverrides,
    },
    { waitUntil() {}, passThroughOnException() {} },
  );
}

async function adminCookie() {
  const response = await render("/admin-auth", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ username: "test-admin", password: "test-password" }),
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
  assert.match(html, /<title>Checkin Pod｜活動報到輔助機<\/title>/i);
  assert.match(html, /loading-brand-mark[^>]*>P</);
  assert.match(html, /正在還原這台裝置的報到紀錄/);
  assert.doesNotMatch(html, /loading-mark[^>]*>到</);
});

test("provides separate admin and public benchmark, scanner, and projection routes", async () => {
  const cookie = await adminCookie();
  const [adminResponse, benchmarkResponse, scanResponse, projectionResponse] = await Promise.all([
    render("/admin", { headers: { cookie } }),
    render("/benchmark"),
    render("/scan"),
    render("/projection"),
  ]);
  assert.equal(adminResponse.status, 200);
  assert.equal(benchmarkResponse.status, 200);
  assert.equal(scanResponse.status, 200);
  assert.equal(projectionResponse.status, 200);
  assert.match(await adminResponse.text(), /正在還原這台裝置的報到紀錄/);
  const benchmarkHtml = await benchmarkResponse.text();
  assert.match(benchmarkHtml, /10,000 位來賓/);
  assert.match(benchmarkHtml, /50 個入口/);
  assert.match(benchmarkHtml, /23\/23/);
  assert.doesNotMatch(benchmarkHtml, /工作人員密碼/);
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
  assert.match(await lockedAdmin.text(), /管理員密碼/);
  assert.equal(scanResponse.status, 200);
  assert.equal(projectionResponse.status, 200);

  const wrongPassword = await render("/admin-auth", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ username: "test-admin", password: "wrong-password" }),
  });
  assert.equal(wrongPassword.status, 401);
  assert.match(await wrongPassword.text(), /密碼不正確/);
});

test("accepts same-origin browser login metadata when Origin is unavailable", async () => {
  const loginBody = new URLSearchParams({ username: "test-admin", password: "test-password" });
  const sameOriginResponse = await render("/admin-auth", {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      origin: "",
      "sec-fetch-site": "same-origin",
    },
    body: loginBody,
  });
  assert.equal(sameOriginResponse.status, 303);

  const crossSiteResponse = await render("/admin-auth", {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      origin: "",
      "sec-fetch-site": "cross-site",
    },
    body: loginBody,
  });
  assert.equal(crossSiteResponse.status, 403);

  const conflictingOriginResponse = await render("/admin-auth", {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      origin: "https://attacker.example",
      "sec-fetch-site": "same-origin",
    },
    body: loginBody,
  });
  assert.equal(conflictingOriginResponse.status, 403);

  const loginPage = await render("/admin");
  assert.equal(loginPage.headers.get("referrer-policy"), "same-origin");
  const loginHtml = await loginPage.text();
  const csrfToken = loginHtml.match(/name="csrf_token" type="hidden" value="([a-f0-9]+)"/)?.[1] ?? "";
  const csrfCookie = loginPage.headers.get("set-cookie")?.split(";", 1)[0] ?? "";
  assert.ok(csrfToken);
  assert.ok(csrfCookie);

  const isolatedBrowserResponse = await render("/admin-auth", {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      origin: "null",
      cookie: csrfCookie,
    },
    body: new URLSearchParams({
      username: "test-admin",
      password: "test-password",
      csrf_token: csrfToken,
    }),
  });
  assert.equal(isolatedBrowserResponse.status, 303);
});

test("logging out ends the public projection without deleting browser records", async () => {
  const cookie = await adminCookie();
  let disabledSharedProjection = false;
  const database = {
    prepare(sql) {
      const isSharedDisable = /UPDATE checkin_events SET active = 0/.test(sql);
      const isAudit = /checkin_admin_audit/.test(sql);
      assert.ok(isSharedDisable || isAudit, `unexpected logout SQL: ${sql}`);
      return {
        bind() {
          if (isSharedDisable) disabledSharedProjection = true;
          return this;
        },
        async run() {
          return { meta: { changes: 1 } };
        },
      };
    },
  };

  const response = await render("/admin-auth/logout", {
    method: "POST",
    headers: { cookie },
  }, { DB: database });

  assert.equal(response.status, 303);
  assert.equal(response.headers.get("location"), "/admin");
  assert.match(response.headers.get("set-cookie") ?? "", /Max-Age=0/);
  assert.equal(disabledSharedProjection, true);
});

test("an unauthenticated logout request cannot clear the public projection", async () => {
  const response = await render("/admin-auth/logout", { method: "POST" }, {
    DB: {
      prepare() {
        assert.fail("the live event must not be deleted without an admin session");
      },
    },
  });

  assert.equal(response.status, 303);
  assert.match(response.headers.get("set-cookie") ?? "", /Max-Age=0/);
});

test("logout only accepts same-origin POST requests", async () => {
  const getResponse = await render("/admin-auth/logout");
  assert.equal(getResponse.status, 405);
  assert.equal(getResponse.headers.get("allow"), "POST");
  const crossOriginResponse = await render("/admin-auth/logout", {
    method: "POST",
    headers: { origin: "https://attacker.example" },
  });
  assert.equal(crossOriginResponse.status, 403);
});

test("adds browser security headers to public and administrative routes", async () => {
  const response = await render("/projection");
  assert.match(response.headers.get("content-security-policy") ?? "", /frame-ancestors 'none'/);
  assert.equal(response.headers.get("referrer-policy"), "no-referrer");
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.equal(response.headers.get("x-frame-options"), "DENY");
  assert.match(response.headers.get("permissions-policy") ?? "", /camera=\(self\)/);
});

test("wires persistence, scanner, secured projection feed, and event controls", async () => {
  const [page, scanPage, projectionPage, planetVariants, sharedRoute, sharedSql, sharedClient, core, auth, laneAuth, styles, benchmarkStyles, workerSource, viteConfig, stressScript, sampleZip, largeSampleZip, successAudio, failureAudio] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/scan/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/projection/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/planet-variants.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/shared-checkin/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/shared-checkin-sql.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/shared-checkin.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/checkin-core.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/admin-auth.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/lane-auth.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
    readFile(new URL("../app/benchmark/benchmark.module.css", import.meta.url), "utf8"),
    readFile(new URL("../worker/index.ts", import.meta.url), "utf8"),
    readFile(new URL("../vite.config.ts", import.meta.url), "utf8"),
    readFile(new URL("../scripts/stress-multi-client.mjs", import.meta.url), "utf8"),
    readFile(new URL("../public/checkin-pod-sample-150.zip", import.meta.url)),
    readFile(new URL("../public/checkin-pod-sample-10000.zip", import.meta.url)),
    readFile(new URL("../public/audio/checkin-success.mp3", import.meta.url)),
    readFile(new URL("../public/audio/checkin-failure.mp3", import.meta.url)),
  ]);

  assert.match(page, /MAX_ATTENDEES = MAX_SHARED_ATTENDEES/);
  assert.match(page, /MAX_ROSTER_FILE_SIZE = 50 \* 1024 \* 1024/);
  assert.match(page, /GUESTS_PER_PAGE = 100/);
  assert.match(page, /新增報到工作站/);
  assert.match(page, /checkin-pod-sample-150\.zip/);
  assert.match(page, /checkin-pod-sample-10000\.zip/);
  assert.match(page, /兩份範例共用同一組測試 QR Code/);
  assert.match(page, /登出中控台/);
  assert.match(page, /單機報到/);
  assert.match(page, /每次報到立即寫入伺服器/);
  assert.doesNotMatch(page, /每 5 分鐘|立即同步/);
  assert.match(page, /活動歷史/);
  assert.match(page, /載入活動/);
  assert.match(page, /改活動名稱/);
  assert.match(page, /renameSharedEvent/);
  assert.match(page, /fetchSharedEventHistory/);
  assert.match(page, /永久刪除活動/);
  assert.match(page, /onPaste/);
  assert.match(page, /importMode.*single/s);
  assert.match(page, /Checkin Pod/);
  assert.doesNotMatch(page, /commitScan|scan-queue/);
  assert.doesNotMatch(scanPage, /commitScan|scan-queue|pendingScans/);
  assert.match(scanPage, /scanSharedEvent/);
  assert.match(scanPage, /LANE_SESSION_KEY/);
  const laneActivationIndex = scanPage.indexOf("await activateSharedLane(bootstrapSession)");
  const localEventReadIndex = scanPage.indexOf("saved = await readSavedEvent()");
  assert.ok(laneActivationIndex >= 0, "the scanner must activate a workstation link");
  assert.ok(localEventReadIndex >= 0, "the scanner must retain its local event fallback");
  assert.ok(laneActivationIndex < localEventReadIndex, "a new workstation link must activate before reading IndexedDB");
  assert.match(scanPage, /applyRemoteLane\(preparedSession, metadata\);[\s\S]*history\.replaceState/);
  assert.doesNotMatch(page, /indexedDB\.open/);
  assert.match(core, /indexedDB\.open/);
  assert.match(core, /DB_VERSION = 2/);
  assert.match(core, /const DB_NAME = "checkin-pod"/);
  assert.match(core, /const LEGACY_DB_NAME = "arrival-checkin"/);
  assert.match(core, /CHANNEL_NAME = "checkin-pod-event-changes"/);
  assert.match(core, /WRITE_LOCK_NAME = "checkin-pod-write"/);
  assert.match(core, /navigator\.locks/);
  assert.match(core, /applyScanToEvent/);
  assert.match(core, /ASSET_STORE_NAME/);
  assert.doesNotMatch(core + page + projectionPage, /\/api\/live-event|x-event-writer-token/);
  assert.match(page, /writeBackgroundImageDataUrl/);
  assert.match(scanPage, /readBackgroundImageDataUrl/);
  assert.match(scanPage, /BarcodeDetector/);
  assert.match(scanPage, /advanceCameraScanState/);
  let cameraTransition = advanceCameraScanState(EMPTY_CAMERA_SCAN_STATE, "QR-001", 0);
  assert.equal(cameraTransition.codeToScan, "QR-001");
  cameraTransition = advanceCameraScanState(cameraTransition.state, "QR-001", 220);
  assert.equal(cameraTransition.codeToScan, null);
  cameraTransition = advanceCameraScanState(cameraTransition.state, "", 440);
  assert.equal(cameraTransition.state.code, "QR-001");
  cameraTransition = advanceCameraScanState(
    cameraTransition.state,
    "",
    220 + CAMERA_CODE_RELEASE_MS,
  );
  assert.equal(cameraTransition.state.code, "");
  cameraTransition = advanceCameraScanState(cameraTransition.state, "QR-001", 2_000);
  assert.equal(cameraTransition.codeToScan, "QR-001");
  cameraTransition = advanceCameraScanState(cameraTransition.state, "QR-002", 2_220);
  assert.equal(cameraTransition.codeToScan, "QR-002");
  assert.match(scanPage, /deviceId: \{ exact: cameraId \}/);
  assert.match(scanPage, /報到提示音/);
  assert.match(scanPage, /scanInputTimerRef/);
  assert.match(scanPage, /onInput=\{handleScanInput\}/);
  assert.match(scanPage, /inputRef\.current\.value = ""/);
  assert.doesNotMatch(scanPage, /setScanText/);
  assert.doesNotMatch(scanPage, /value=\{scanText\}/);
  assert.match(scanPage, /guest-camera-panel/);
  assert.match(scanPage, /鏡頭持續顯示，可直接掃描下一位/);
  assert.match(scanPage, /<video ref=\{videoRef\}[\s\S]*\{!result \? \(/);
  assert.doesNotMatch(scanPage, /!cameraActive \|\| result \|\| !barcodeDetectorRef/);
  assert.match(page, /目前報到率/);
  assert.match(page, /播放登車廣播/);
  assert.match(page, /全場彩蛋/);
  assert.match(projectionPage, /arrivalQueue/);
  assert.match(projectionPage, /CHECKIN POD · LIVE ENERGY WALL/);
  assert.match(projectionPage, /pendingCueRef/);
  assert.match(projectionPage, /new Set<number>/);
  assert.match(projectionPage, /activeEntrance \? \(\(\) =>/);
  assert.match(projectionPage, /energy-planet-canvas/);
  assert.match(projectionPage, /drawSettledPlanet/);
  assert.match(projectionPage, /sharedEvent\.eventName/);
  assert.match(projectionPage, /void syncProjection\(\);/);
  assert.match(projectionPage, /const synced = await syncProjection\(\)/);
  assert.ok(
    projectionPage.indexOf("const synced = await syncProjection()") < projectionPage.indexOf("setActivated(true)"),
    "projection activation must wait for a fresh server snapshot",
  );
  assert.match(projectionPage, /snapshot \? checkedIn\.length : "—"/);
  assert.match(projectionPage, /正在從中控台取得目前報到數據/);
  assert.match(projectionPage, /type-\$\{appearance\.type\}/);
  assert.match(planetVariants, /PLANET_PALETTES/);
  assert.match(planetVariants, /PLANET_TYPES/);
  assert.match(planetVariants, /combinationIndex/);
  assert.match(sharedRoute, /hasValidAdminSession/);
  assert.match(sharedRoute, /sha256Hex\(laneToken\)/);
  assert.match(sharedRoute, /SHARED_CHANGE_PAGE_SIZE \+ 1/);
  assert.doesNotMatch(sharedRoute, /sync_single/);
  assert.match(sharedRoute, /sync_mode/);
  assert.match(sharedRoute, /case "events"/);
  assert.match(sharedRoute, /activate_event/);
  assert.match(sharedRoute, /rename_event/);
  assert.match(sharedRoute, /event_name/);
  assert.match(sharedRoute, /deactivate_event/);
  assert.match(sharedRoute, /deletion_confirmation_mismatch/);
  assert.match(sharedRoute, /isEventDeletionConfirmed/);
  assert.match(sharedRoute, /laneAttendeeFromRow/);
  assert.match(sharedRoute, /publicProjectionName/);
  assert.match(sharedRoute, /projection_privacy/);
  assert.match(sharedRoute, /purgeExpiredEvents/);
  assert.match(sharedRoute, /readLimitedText\(request, 4_000_000\)/);
  assert.match(sharedRoute, /utf8ByteLength\(originalJson\)/);
  assert.match(sharedClient, /attendeeForServerImport/);
  assert.match(sharedRoute, /attendeeForServerImport/);
  assert.match(sharedRoute, /attendeeId !== minimized\.id/);
  assert.match(sharedRoute, /function importedOriginalRow/);
  assert.match(sharedRoute, /ATOMIC_SCAN_ACTIVITY_SQL/);
  assert.match(sharedRoute, /IDEMPOTENT_SET_ACTIVITY_SQL/);
  assert.match(sharedRoute, /database\.batch/);
  const laneResultBuilder = sharedRoute.slice(
    sharedRoute.indexOf("function laneAttendeeFromRow"),
    sharedRoute.indexOf("async function scanResponse"),
  );
  assert.doesNotMatch(laneResultBuilder, /email:|phone:|approvalStatus:/);
  const scanClient = sharedClient.slice(
    sharedClient.indexOf("export async function scanSharedEvent("),
    sharedClient.indexOf("export async function setSharedAttendeeCheckIn"),
  );
  assert.doesNotMatch(scanClient, /laneToken/);
  assert.doesNotMatch(sharedClient, /scanSharedEventWithRetry|syncSingleCheckInState/);
  assert.match(laneAuth, /HttpOnly/);
  assert.match(laneAuth, /SameSite=Strict/);
  assert.match(sharedSql, /checked_in_at IS NULL/);
  assert.match(sharedSql, /CHECK\(total >= 0 AND total <= 10000\)/);
  assert.match(sharedSql, /event_name/);
  const changesHandler = sharedRoute.slice(
    sharedRoute.indexOf("async function handleChangesGet"),
    sharedRoute.indexOf("async function handleProjectionGet"),
  );
  assert.doesNotMatch(changesHandler, /SET active/);
  const projectionMetadata = sharedRoute.slice(
    sharedRoute.indexOf("function projectionEventMetadata"),
    sharedRoute.indexOf("async function findAdminEvent"),
  );
  assert.match(projectionMetadata, /eventId:/);
  assert.match(projectionMetadata, /eventName:/);
  assert.doesNotMatch(projectionMetadata, /fileName:/);
  const getHandler = sharedRoute.slice(sharedRoute.indexOf("export async function GET"));
  assert.doesNotMatch(getHandler, /ensureSchema|purgeExpiredEvents/);
  assert.match(sharedClient, /action: "initialize"/);
  assert.match(auth, /HttpOnly/);
  assert.match(auth, /SameSite=Strict/);
  assert.match(auth, /SESSION_MAX_AGE_SECONDS/);
  assert.match(auth, /HMAC/);
  assert.match(auth, /__Host-checkin_pod_admin_session/);
  assert.match(workerSource, /ADMIN_PASSWORD/);
  assert.match(workerSource, /ADMIN_USERS_JSON/);
  assert.match(workerSource, /href="\/benchmark"/);
  assert.match(workerSource, /Content-Security-Policy/i);
  assert.match(workerSource, /readLimitedText\(request, 4_096\)/);
  assert.match(workerSource, /deactivateSharedProjection/);
  assert.match(workerSource, /scheduled\(/);
  assert.doesNotMatch(workerSource, /live_event_state/);
  assert.match(viteConfig, /LOGIN_RATE_LIMITER/);
  assert.match(viteConfig, /UNKNOWN_SCAN_RATE_LIMITER/);
  assert.match(viteConfig, /SCAN_IP_RATE_LIMITER/);
  assert.match(viteConfig, /UNKNOWN_SCAN_IP_RATE_LIMITER/);
  assert.match(viteConfig, /disableTypes/);
  const stressScanBody = stressScript.slice(
    stressScript.indexOf("function scanBody"),
    stressScript.indexOf("async function writeReport"),
  );
  assert.doesNotMatch(stressScanBody, /laneToken/);
  assert.doesNotMatch(stressScript, /mode: "lane"[^}]*token:/s);
  assert.match(stressScript, /activate_lane/);
  assert.match(stressScript, /responseCookie/);
  assert.doesNotMatch(workerSource + auth, /llap55688/);
  const sub18PxFontSize = /font-size:\s*(?:(?:[0-9]|1[0-7])(?:\.[0-9]+)?px|clamp\((?:[0-9]|1[0-7])(?:\.[0-9]+)?px)/;
  assert.doesNotMatch(styles + benchmarkStyles + workerSource, sub18PxFontSize);
  assert.match(styles + benchmarkStyles + workerSource, /font-size:\s*18px/);
  assert.match(styles, /\.guest-screen\.has-custom-background\s*\{[^}]*background-size:\s*contain/s);
  assert.match(styles, /\.guest-scan-content\.has-camera/);
  assert.match(styles, /\.camera-scan-status\.success/);
  assert.match(styles, /@keyframes planetFlyIn/);
  for (const type of ["rocky", "ringed", "banded", "cube", "molten", "crystal"]) {
    assert.match(styles, new RegExp(`\\.energy-planet\\.type-${type}`));
  }
  assert.ok(sampleZip.length > 10_000);
  assert.ok(largeSampleZip.length > 100_000);
  assert.ok(successAudio.length > 1_000);
  assert.ok(failureAudio.length > 1_000);
});
