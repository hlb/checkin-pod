import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

async function render(path = "/", init = {}) {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
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

test("server-renders the local check-in application shell", async () => {
  const response = await render("/", { headers: { cookie: await adminCookie() } });
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);

  const html = await response.text();
  assert.match(html, /<html[^>]*lang="zh-Hant"/i);
  assert.match(html, /<title>抵達｜Luma QR 報到台<\/title>/i);
  assert.match(html, /正在還原這台裝置的報到紀錄/);
  assert.doesNotMatch(html, /codex-preview|Your site is taking shape|react-loading-skeleton/i);
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

  const [adminHtml, scanHtml, projectionHtml] = await Promise.all([
    adminResponse.text(),
    scanResponse.text(),
    projectionResponse.text(),
  ]);
  assert.match(adminHtml, /正在還原這台裝置的報到紀錄/);
  assert.match(scanHtml, /正在準備掃描器/);
  assert.match(projectionHtml, /啟動全場能量牆/);
});

test("password-protects the control center while keeping guest displays public", async () => {
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

  const cookie = await adminCookie();
  const unlockedAdmin = await render("/admin", { headers: { cookie } });
  assert.equal(unlockedAdmin.status, 200);
  assert.match(await unlockedAdmin.text(), /正在還原這台裝置的報到紀錄/);
});

test("includes local persistence, Luma columns, scanner capture, and CSV export", async () => {
  const [page, scanPage, projectionPage, liveRoute, core, layout, styles, workerSource, packageJson, sample, sampleZip, successAudio, failureAudio, boardingAudio, celebrationAudio] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/scan/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/projection/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/api/live-event/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/checkin-core.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/layout.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
    readFile(new URL("../worker/index.ts", import.meta.url), "utf8"),
    readFile(new URL("../package.json", import.meta.url), "utf8"),
    readFile(new URL("./fixtures/luma-sample.csv", import.meta.url), "utf8"),
    readFile(new URL("../public/arrival-checkin-sample-150.zip", import.meta.url)),
    readFile(new URL("../public/audio/checkin-success.mp3", import.meta.url)),
    readFile(new URL("../public/audio/checkin-failure.mp3", import.meta.url)),
    readFile(new URL("../public/audio/boarding-announcement.mp3", import.meta.url)),
    readFile(new URL("../public/audio/energy-celebration.mp3", import.meta.url)),
  ]);

  assert.match(page, /const MAX_ATTENDEES = 200/);
  assert.match(page, /indexedDB\.open/);
  assert.match(page, /"qr_code_url"/);
  assert.match(page, /"checked_in_at"/);
  assert.match(page, /keyboardEvent\.key === "Enter"/);
  assert.match(page, /local_check_in_status/);
  assert.match(page, /approvedValues/);
  assert.match(page, /new Blob\(\["\\uFEFF"/);
  assert.match(page, /來賓畫面顯示內容/);
  assert.match(page, /selectedDisplayFields/);
  assert.match(page, /\/arrival-checkin-sample-150\.zip/);
  assert.match(page, /150 人 ZIP/);
  assert.doesNotMatch(scanPage, /請出示並掃描/);
  assert.match(scanPage, /將票券上的 QR Code 對準掃描器/);
  assert.match(scanPage, /getDisplayFields/);
  assert.match(scanPage, /writeSavedEvent/);
  assert.match(scanPage, /guestResultFromSavedEvent/);
  assert.match(scanPage, /lastPresentedAtRef/);
  assert.match(scanPage, /has-custom-background/);
  assert.match(scanPage, /guest-status-column/);
  assert.match(scanPage, /guest-details-column/);
  assert.match(scanPage, /報到成功/);
  assert.match(scanPage, /已報到過/);
  assert.match(scanPage, /playResultSound/);
  assert.match(scanPage, /報到提示音/);
  assert.match(scanPage, /預設關閉/);
  assert.match(scanPage, /aria-checked=\{resultSoundEnabled\}/);
  assert.match(scanPage, /resultSoundEnabledRef/);
  assert.match(scanPage, /BarcodeDetector/);
  assert.match(scanPage, /getUserMedia/);
  assert.match(scanPage, /enumerateDevices/);
  assert.match(scanPage, /deviceId: \{ exact: cameraId \}/);
  assert.match(scanPage, /選擇鏡頭/);
  assert.match(scanPage, /使用電腦鏡頭掃描/);
  assert.match(scanPage, /scan-settings-menu/);
  assert.match(scanPage, /target\.closest\("\.scan-settings-menu"\)/);
  assert.match(scanPage, /\/audio\/checkin-success\.mp3/);
  assert.match(scanPage, /\/audio\/checkin-failure\.mp3/);
  assert.doesNotMatch(scanPage, /掃描器已就緒|QR CHECK-IN|資料僅用於本次活動報到/);
  assert.match(scanPage, /!backgroundImageDataUrl/);
  assert.match(page, /lastScan = checkedInAt/);
  assert.match(page, /prepareBackgroundImage/);
  assert.match(page, /上傳背景圖/);
  assert.match(page, /DEFAULT_GUEST_BACKGROUND = "#0E0F12"/);
  assert.match(page, /活動中控台/);
  assert.match(page, /目前報到率/);
  assert.match(page, /抵達節奏/);
  assert.match(page, /播放登車廣播/);
  assert.match(page, /全場彩蛋/);
  assert.match(page, /buildArrivalChart/);
  assert.match(page, /publishProjectionCue/);
  assert.match(scanPage, /DEFAULT_GUEST_BACKGROUND = "#0E0F12"/);
  assert.match(scanPage, /publishLiveEvent/);
  assert.match(projectionPage, /POLL_INTERVAL_MS = 700/);
  assert.match(projectionPage, /ARRIVAL_DISPLAY_MS = 3600/);
  assert.match(projectionPage, /seenAttendeesRef/);
  assert.match(projectionPage, /arrivalQueue/);
  assert.match(projectionPage, /activeEntrance/);
  assert.match(projectionPage, /還有 \{arrivalQueue\.length\} 位等待登場/);
  assert.doesNotMatch(projectionPage, /slice\(-6\)/);
  assert.match(projectionPage, /projection-arrival/);
  assert.match(projectionPage, /energy-planet/);
  assert.match(projectionPage, /planetStyle/);
  assert.match(projectionPage, /checkedIn\.map/);
  assert.match(projectionPage, /顆星球/);
  assert.match(projectionPage, /floating-attendee-name/);
  assert.match(projectionPage, /requestFullscreen/);
  assert.match(projectionPage, /boarding-announcement\.mp3/);
  assert.match(projectionPage, /energy-celebration\.mp3/);
  assert.match(liveRoute, /input\.total > 200/);
  assert.match(liveRoute, /cache-control/);
  assert.match(liveRoute, /getD1/);
  assert.match(liveRoute, /CREATE TABLE IF NOT EXISTS live_event_state/);
  assert.match(core, /BroadcastChannel/);
  assert.match(core, /\.filter\(\(attendee\) => attendee\.checkedInAt\)/);
  assert.match(core, /\/api\/live-event/);
  assert.match(core, /displaySettings/);
  assert.match(core, /backgroundImageDataUrl/);
  assert.match(core, /backgroundColor/);
  assert.match(styles, /\.guest-screen\.has-custom-background\s*\{[^}]*background-size:\s*contain/s);
  assert.match(styles, /\.guest-screen \.guest-idle-content/);
  assert.match(styles, /width:\s*min\(360px/);
  assert.match(styles, /\.guest-person-result\s*\{[^}]*grid-template-columns:/s);
  assert.match(styles, /\.energy-planet\.is-arriving/);
  assert.match(styles, /\.energy-planet\.is-awaiting-arrival/);
  assert.match(styles, /\.projection-arrival-queue/);
  assert.match(styles, /@keyframes planetFlyIn/);
  assert.doesNotMatch(projectionPage, /className="energy-particle"/);
  assert.doesNotMatch(styles, /\.guest-screen\.show-result\s*\{[^}]*background-color:/s);
  assert.doesNotMatch(styles, /-webkit-line-clamp/);
  assert.match(workerSource, /ADMIN_PASSWORD/);
  assert.match(workerSource, /HttpOnly/);
  assert.match(workerSource, /SameSite=Strict/);
  assert.doesNotMatch(workerSource, /llap55688/);
  assert.doesNotMatch(core, /url\.pathname|lastPath/);
  assert.doesNotMatch(page, /url\.pathname|lastPath/);
  assert.ok(successAudio.length > 1_000);
  assert.ok(failureAudio.length > 1_000);
  assert.ok(boardingAudio.length > 10_000);
  assert.ok(celebrationAudio.length > 10_000);
  assert.match(layout, /lang="zh-Hant"/);
  assert.doesNotMatch(packageJson, /react-loading-skeleton/);
  assert.match(packageJson, /vinext dev -H 0\.0\.0\.0/);
  assert.match(sample.replace(/^\uFEFF/, ""), /^guest_id,name,first_name,last_name,email,/);
  assert.match(sample, /qr_code_url/);
  assert.ok(sampleZip.length > 10_000);
});
