import { mkdir, readFile, writeFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import process from "node:process";

const DEFAULTS = {
  baseUrl: "http://localhost:3000",
  attendees: 10_000,
  clients: 50,
  contentionTickets: 10,
  report: "reports/stress-test-10000x50.md",
};

function argumentsFrom(argv) {
  const values = { ...DEFAULTS };
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    const value = argv[index + 1];
    if (key === "--base-url") values.baseUrl = value.replace(/\/$/, "");
    if (key === "--attendees") values.attendees = Number(value);
    if (key === "--clients") values.clients = Number(value);
    if (key === "--contention-tickets") values.contentionTickets = Number(value);
    if (key === "--report") values.report = value;
    if (key.startsWith("--")) index += 1;
  }
  return values;
}

async function loadLocalAdminValue(name) {
  if (process.env[name]) return process.env[name];
  const source = await readFile(new URL("../.env.local", import.meta.url), "utf8").catch(() => "");
  for (const line of source.split(/\r?\n/)) {
    const match = line.match(new RegExp(`^${name}\\s*=\\s*(.*)$`));
    if (!match) continue;
    return match[1].trim().replace(/^(['"])(.*)\1$/, "$2");
  }
  return "";
}

function percentile(values, fraction) {
  if (!values.length) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)];
}

function formatNumber(value, digits = 1) {
  return Number(value).toFixed(digits);
}

const options = argumentsFrom(process.argv.slice(2));
if (!Number.isInteger(options.attendees) || options.attendees < 1 || options.attendees > 10_000) {
  throw new Error("--attendees must be an integer between 1 and 10000");
}
if (!Number.isInteger(options.clients) || options.clients < 1 || options.clients > 200) {
  throw new Error("--clients must be an integer between 1 and 200");
}
if (!Number.isInteger(options.contentionTickets) || options.contentionTickets < 1 || options.contentionTickets >= options.attendees) {
  throw new Error("--contention-tickets must be smaller than --attendees");
}

const username = await loadLocalAdminValue("ADMIN_USERNAME") || "admin";
const password = await loadLocalAdminValue("ADMIN_PASSWORD");
if (!password) throw new Error("ADMIN_PASSWORD is required (environment or .env.local)");

let adminCookie = "";
let eventId = "";
let cleanupSucceeded = false;
const errors = [];
const checks = [];
const scanLatencies = [];
const startedAt = new Date();
let importMs = 0;
let laneSetupMs = 0;
let scanWallMs = 0;
let resultCounts = { success: 0, duplicate: 0, unknown: 0, failed: 0 };
let activityCounts = { success: 0, duplicate: 0, unknown: 0, undo: 0 };
let projectionCount = 0;
let finalArrived = 0;
let recoveredRosterCount = 0;
let recoveredCheckedInCount = 0;
let laneReportedSuccess = 0;

function check(name, passed, detail) {
  checks.push({ name, passed, detail });
  if (!passed) errors.push(`${name}: ${detail}`);
}

async function request(path, init = {}, measure = false) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 60_000);
  const started = performance.now();
  try {
    const response = await fetch(`${options.baseUrl}${path}`, { ...init, signal: controller.signal });
    const contentType = response.headers.get("content-type") ?? "";
    const body = contentType.includes("application/json")
      ? await response.json().catch(() => ({}))
      : { text: await response.text() };
    return { response, body, duration: performance.now() - started };
  } finally {
    clearTimeout(timeout);
    if (measure) scanLatencies.push(performance.now() - started);
  }
}
async function post(body, cookie = adminCookie, measure = false) {
  return request("/api/shared-checkin", {
    method: "POST",
    headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
    body: JSON.stringify(body),
  }, measure);
}

function responseCookie(response) {
  return response.headers.get("set-cookie")?.split(";", 1)[0] ?? "";
}

async function activateLane(laneId, laneName, laneToken) {
  const activated = await post({ action: "activate_lane", eventId, laneId, laneToken }, "");
  const cookie = responseCookie(activated.response);
  if (!activated.response.ok || !cookie) {
    throw new Error(`lane activation failed (${activated.response.status})`);
  }
  return { laneId, laneName, cookie };
}

async function readCompleteRoster(requestedEventId) {
  const attendees = [];
  let afterPosition = -1;
  let hasMore = true;
  let metadata = null;
  while (hasMore) {
    const page = await request(`/api/shared-checkin?${new URLSearchParams({
      mode: "roster",
      eventId: requestedEventId,
      afterPosition: String(afterPosition),
      limit: "500",
    })}`, { headers: { cookie: adminCookie } });
    if (!page.response.ok) throw new Error(`roster read failed (${page.response.status})`);
    metadata = page.body.event;
    attendees.push(...page.body.attendees);
    afterPosition = page.body.nextPosition;
    hasMore = page.body.hasMore;
  }
  return { metadata, attendees };
}

function attendee(index) {
  const serial = String(index).padStart(5, "0");
  const qr = `STRESS-QR-${serial}`;
  return {
    id: `stress-guest-${serial}`,
    position: index,
    name: `Stress Guest ${serial}`,
    email: `stress-${serial}@example.com`,
    phone: `09${String(index).padStart(8, "0")}`,
    ticket: index % 10 === 0 ? "VIP" : "General",
    approvalStatus: "approved",
    checkedInAt: null,
    original: {
      guest_id: `stress-guest-${serial}`,
      name: `Stress Guest ${serial}`,
      email: `stress-${serial}@example.com`,
      qr_code_url: qr,
      ticket_name: index % 10 === 0 ? "VIP" : "General",
      approval_status: "approved",
    },
    scanKeys: [qr.toLowerCase(), `stress-${serial}@example.com`, `stress-guest-${serial}`],
  };
}

function scanBody(lane, code, requestId) {
  return {
    action: "scan",
    eventId,
    laneId: lane.laneId,
    code,
    requestId,
  };
}

async function writeReport(status) {
  const endedAt = new Date();
  const passedChecks = checks.filter((item) => item.passed).length;
  const totalRequests = scanLatencies.length;
  const throughput = scanWallMs ? totalRequests / (scanWallMs / 1000) : 0;
  const markdown = `# Checkin Pod 多工作站壓力測試報告

- 結果：**${status}**
- 測試時間：${startedAt.toISOString()} ～ ${endedAt.toISOString()}
- 測試目標：${options.baseUrl}
- 測試資料：${options.attendees.toLocaleString()} 位來賓
- 並行 clients：${options.clients}
- 高競爭票券：${options.contentionTickets} 張，每張由 ${options.clients} 台 clients 同時掃描
- 執行環境：Node ${process.version} · ${process.platform} ${process.arch}

## 結果摘要

| 指標 | 結果 |
|---|---:|
| 名單匯入時間 | ${formatNumber(importMs / 1000, 2)} 秒 |
| ${options.clients} 工作站建立與驗證 | ${formatNumber(laneSetupMs / 1000, 2)} 秒 |
| 掃描階段時間 | ${formatNumber(scanWallMs / 1000, 2)} 秒 |
| 掃描 API 請求 | ${totalRequests.toLocaleString()} |
| 平均吞吐量 | ${formatNumber(throughput, 2)} req/s |
| 延遲 p50 | ${formatNumber(percentile(scanLatencies, .50), 1)} ms |
| 延遲 p95 | ${formatNumber(percentile(scanLatencies, .95), 1)} ms |
| 延遲 p99 | ${formatNumber(percentile(scanLatencies, .99), 1)} ms |
| 延遲 max | ${formatNumber(Math.max(0, ...scanLatencies), 1)} ms |
| 成功回應 | ${resultCounts.success.toLocaleString()} |
| 已報到過回應 | ${resultCounts.duplicate.toLocaleString()} |
| 找不到資料回應 | ${resultCounts.unknown.toLocaleString()} |
| 失敗/非預期回應 | ${resultCounts.failed.toLocaleString()} |
| 資料庫最終已報到 | ${finalArrived.toLocaleString()} / ${options.attendees.toLocaleString()} |
| 伺服器復原名單 | ${recoveredRosterCount.toLocaleString()}（已報到 ${recoveredCheckedInCount.toLocaleString()}） |
| 工作站統計成功數 | ${laneReportedSuccess.toLocaleString()} |
| 投影初始星球資料 | ${projectionCount.toLocaleString()} |

## 防重複與一致性檢查

${checks.map((item) => `- ${item.passed ? "✅" : "❌"} ${item.name}：${item.detail}`).join("\n")}

通過 ${passedChecks} / ${checks.length} 項檢查。活動測試資料在報告產生後${cleanupSucceeded ? "已清除" : "未能自動清除"}。

## 活動紀錄分布

| outcome | 數量 |
|---|---:|
| success | ${activityCounts.success.toLocaleString()} |
| duplicate | ${activityCounts.duplicate.toLocaleString()} |
| unknown | ${activityCounts.unknown.toLocaleString()} |
| undo | ${activityCounts.undo.toLocaleString()} |

## 重跑方式

先啟動本機網站，再執行：

\`\`\`bash
npm run stress
\`\`\`

腳本會建立獨立測試活動、使用 HttpOnly lane session 完成驗證、輸出本報告，最後刪除該測試活動。管理帳號與密碼只從環境或本機 \`.env.local\` 讀取，不會寫入報告。
`;
  const reportUrl = new URL(`../${options.report}`, import.meta.url);
  await mkdir(new URL("./", reportUrl), { recursive: true });
  await writeFile(reportUrl, markdown, "utf8");
}

try {
  console.log(`[stress] login ${options.baseUrl}`);
  const login = await request("/admin-auth", {
    method: "POST",
    redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded", origin: options.baseUrl },
    body: new URLSearchParams({ username, password }),
  });
  adminCookie = responseCookie(login.response);
  if (login.response.status !== 303 || !adminCookie) {
    const message = login.body.text?.match(/<p class="error"[^>]*>([^<]+)<\/p>/)?.[1] ?? "";
    throw new Error(`admin login failed (${login.response.status}${message ? `: ${message}` : ""})`);
  }

  const capacity = await post({
    action: "begin_import",
    fileName: "over-capacity.csv",
    headers: ["name", "qr_code_url"],
    selectedFields: ["name"],
    expectedTotal: 10_001,
    backgroundColor: "#0E0F12",
  });
  check("10,001 人容量拒絕", capacity.response.status === 413, `HTTP ${capacity.response.status}`);

  console.log(`[stress] importing ${options.attendees.toLocaleString()} attendees`);
  const importStarted = performance.now();
  const beginning = await post({
    action: "begin_import",
    fileName: `stress-${options.attendees}.csv`,
    headers: ["guest_id", "name", "email", "qr_code_url", "ticket_name", "approval_status"],
    selectedFields: ["name", "ticket_name", "email"],
    expectedTotal: options.attendees,
    backgroundColor: "#0E0F12",
  });
  if (!beginning.response.ok) throw new Error(`begin import failed (${beginning.response.status} ${beginning.body.error ?? ""})`);
  eventId = beginning.body.eventId;
  const lanes = [{
    laneId: beginning.body.laneId,
    laneName: beginning.body.laneName,
    cookie: responseCookie(beginning.response),
  }];
  if (!lanes[0].cookie) throw new Error("begin import did not issue the primary lane cookie");
  for (let offset = 0; offset < options.attendees; offset += 200) {
    const items = Array.from({ length: Math.min(200, options.attendees - offset) }, (_, index) => attendee(offset + index));
    const uploaded = await post({ action: "upload_chunk", eventId, attendees: items });
    if (!uploaded.response.ok) throw new Error(`upload failed at ${offset} (${uploaded.response.status} ${uploaded.body.error ?? ""})`);
    if ((offset + items.length) % 1_000 === 0) console.log(`[stress] imported ${(offset + items.length).toLocaleString()}/${options.attendees.toLocaleString()}`);
  }
  const finalized = await post({ action: "finalize_import", eventId });
  if (!finalized.response.ok) throw new Error(`finalize failed (${finalized.response.status} ${finalized.body.error ?? ""})`);
  importMs = performance.now() - importStarted;

  console.log(`[stress] creating ${options.clients} independent clients`);
  const laneStarted = performance.now();
  const extraLanes = await Promise.all(Array.from({ length: options.clients - 1 }, async (_, index) => {
    const created = await post({ action: "create_lane", eventId, laneName: `Stress lane ${index + 2}` });
    if (!created.response.ok) throw new Error(`lane creation failed (${created.response.status})`);
    return created.body;
  }));
  lanes.push(...await Promise.all(extraLanes.map((lane) =>
    activateLane(lane.laneId, lane.laneName, lane.laneToken))));
  const laneReads = await Promise.all(lanes.map((lane) => request(`/api/shared-checkin?${new URLSearchParams({
    mode: "lane", eventId, laneId: lane.laneId,
  })}`, { headers: { cookie: lane.cookie } })));
  check(`${options.clients} 台工作站各自取得活動資訊`, laneReads.every((result) => result.response.ok && result.body.event?.total === options.attendees),
    `${laneReads.filter((result) => result.response.ok).length}/${options.clients} 成功`);
  const wrongToken = await post({
    action: "activate_lane", eventId, laneId: lanes[0].laneId, laneToken: "wrong-token",
  }, "");
  check("錯誤工作站 token 被拒絕", wrongToken.response.status === 401, `HTTP ${wrongToken.response.status}`);

  const initialLaneList = await request(`/api/shared-checkin?${new URLSearchParams({ mode: "lanes", eventId })}`, {
    headers: { cookie: adminCookie },
  });
  check("中控台取得完整工作站列表", initialLaneList.response.ok && initialLaneList.body.lanes?.length === options.clients,
    `${initialLaneList.body.lanes?.length ?? 0}/${options.clients} 工作站`);

  const renamedLane = lanes[Math.min(1, lanes.length - 1)];
  const renamed = await post({ action: "rename_lane", eventId, laneId: renamedLane.laneId, laneName: "重新命名入口" });
  check("工作站可重新命名", renamed.response.ok && renamed.body.laneName === "重新命名入口", `HTTP ${renamed.response.status}`);

  const rotatedLane = lanes[Math.min(2, lanes.length - 1)];
  const oldRotatedCookie = rotatedLane.cookie;
  const rotated = await post({ action: "rotate_lane", eventId, laneId: rotatedLane.laneId });
  const oldRotatedAccess = await request(`/api/shared-checkin?${new URLSearchParams({
    mode: "lane", eventId, laneId: rotatedLane.laneId,
  })}`, { headers: { cookie: oldRotatedCookie } });
  if (rotated.response.ok) {
    const reactivated = await activateLane(rotatedLane.laneId, rotatedLane.laneName, rotated.body.laneToken);
    rotatedLane.cookie = reactivated.cookie;
  }
  check("換發工作站連結會立即撤銷舊 token", rotated.response.ok && oldRotatedAccess.response.status === 401,
    `rotate HTTP ${rotated.response.status} · old token HTTP ${oldRotatedAccess.response.status}`);

  const restartedLane = lanes.at(-1);
  const revoked = await post({ action: "revoke_lane", eventId, laneId: restartedLane.laneId });
  const revokedAccess = await request(`/api/shared-checkin?${new URLSearchParams({
    mode: "lane", eventId, laneId: restartedLane.laneId,
  })}`, { headers: { cookie: restartedLane.cookie } });
  check("停用工作站會立即拒絕掃描連線", revoked.response.ok && revokedAccess.response.status === 401,
    `revoke HTTP ${revoked.response.status} · lane HTTP ${revokedAccess.response.status}`);
  const restarted = await post({ action: "rotate_lane", eventId, laneId: restartedLane.laneId });
  if (restarted.response.ok) {
    const reactivated = await activateLane(restartedLane.laneId, restartedLane.laneName, restarted.body.laneToken);
    restartedLane.cookie = reactivated.cookie;
  }
  const restartedAccess = await request(`/api/shared-checkin?${new URLSearchParams({
    mode: "lane", eventId, laneId: restartedLane.laneId,
  })}`, { headers: { cookie: restartedLane.cookie } });
  check("停用工作站可換發連結後重新啟用", restarted.response.ok && restartedAccess.response.ok,
    `rotate HTTP ${restarted.response.status} · lane HTTP ${restartedAccess.response.status}`);

  const summary = await request(`/api/shared-checkin?${new URLSearchParams({ mode: "admin_summary", eventId })}`, {
    headers: { cookie: adminCookie },
  });
  check("本機資料遺失時可發現伺服器活動", summary.response.ok && summary.body.event?.total === options.attendees,
    `${summary.body.event?.total ?? 0}/${options.attendees} attendees`);
  laneSetupMs = performance.now() - laneStarted;

  const normalCount = options.attendees - options.contentionTickets;
  let completed = 0;
  console.log(`[stress] scanning ${normalCount.toLocaleString()} unique tickets with ${options.clients} concurrent clients`);
  const scanStarted = performance.now();
  const idempotentResults = await Promise.all(Array.from({ length: 3 }, () =>
    post(scanBody(lanes[0], "STRESS-QR-00000", "idempotent-retry-0"), lanes[0].cookie, true)));
  for (const result of idempotentResults) {
    const kind = result.response.ok ? result.body.kind : "failed";
    if (kind in resultCounts) resultCounts[kind] += 1;
    else resultCounts.failed += 1;
  }
  check("同一請求重送只保留同一個成功結果", idempotentResults.every((result) =>
    result.response.ok && result.body.kind === "success" && result.body.cursor === idempotentResults[0].body.cursor),
  `${idempotentResults.filter((result) => result.body.kind === "success").length}/3 success · cursor ${idempotentResults[0].body.cursor ?? "n/a"}`);
  const laneAttendee = idempotentResults[0].body.attendee ?? {};
  check("工作站掃描回應只包含最小欄位與顯示 allowlist",
    !Object.hasOwn(laneAttendee, "email") && !Object.hasOwn(laneAttendee, "phone")
      && !Object.hasOwn(laneAttendee, "approvalStatus") && !Object.hasOwn(laneAttendee, "original")
      && typeof laneAttendee.displayValues === "object",
    `fields: ${Object.keys(laneAttendee).sort().join(", ")}`);
  await Promise.all(lanes.map(async (lane, clientIndex) => {
    for (let index = clientIndex; index < normalCount; index += options.clients) {
      if (index === 0) continue;
      const serial = String(index).padStart(5, "0");
      const result = await post(scanBody(lane, `STRESS-QR-${serial}`, `unique-${clientIndex}-${index}`), lane.cookie, true);
      const kind = result.response.ok ? result.body.kind : "failed";
      if (kind in resultCounts) resultCounts[kind] += 1;
      else resultCounts.failed += 1;
      if (kind !== "success" && errors.length < 20) errors.push(`unique ${index}: HTTP ${result.response.status} ${kind}`);
      completed += 1;
      if (completed % 1_000 === 0) console.log(`[stress] scanned ${completed.toLocaleString()}/${normalCount.toLocaleString()}`);
    }
  }));

  console.log(`[stress] running ${options.contentionTickets} x ${options.clients}-client duplicate races`);
  const contentionOutcomes = [];
  for (let offset = 0; offset < options.contentionTickets; offset += 1) {
    const index = normalCount + offset;
    const serial = String(index).padStart(5, "0");
    const results = await Promise.all(lanes.map((lane, clientIndex) =>
      post(scanBody(lane, `STRESS-QR-${serial}`, `race-${offset}-${clientIndex}`), lane.cookie, true)));
    const outcomes = results.map((result) => result.response.ok ? result.body.kind : "failed");
    contentionOutcomes.push(outcomes);
    for (const kind of outcomes) {
      if (kind in resultCounts) resultCounts[kind] += 1;
      else resultCounts.failed += 1;
    }
  }

  const unknowns = await Promise.all(lanes.map((lane, clientIndex) =>
    post(scanBody(lane, `UNKNOWN-${clientIndex}`, `unknown-${clientIndex}`), lane.cookie, true)));
  for (const result of unknowns) {
    const kind = result.response.ok ? result.body.kind : "failed";
    if (kind in resultCounts) resultCounts[kind] += 1;
    else resultCounts.failed += 1;
  }
  scanWallMs = performance.now() - scanStarted;

  check("一般票券全部一次成功", resultCounts.success === options.attendees + 2,
    `${resultCounts.success.toLocaleString()} success responses（含同一成功結果重送 2 次）`);
  check("同票競態每輪只有一台成功", contentionOutcomes.every((outcomes) =>
    outcomes.filter((kind) => kind === "success").length === 1 &&
    outcomes.filter((kind) => kind === "duplicate").length === options.clients - 1),
  `${options.contentionTickets} 輪競態；預期每輪 1 success + ${options.clients - 1} duplicate`);
  check("未知票券皆被辨識為 unknown", unknowns.every((result) => result.response.ok && result.body.kind === "unknown"),
    `${unknowns.filter((result) => result.body.kind === "unknown").length}/${options.clients} unknown`);
  check("掃描 API 無非預期失敗", resultCounts.failed === 0, `${resultCounts.failed} failed`);

  console.log("[stress] reconciling activity log and projection snapshot");
  let cursor = 0;
  let hasMore = true;
  while (hasMore) {
    const changes = await request(`/api/shared-checkin?${new URLSearchParams({ mode: "changes", eventId, after: String(cursor) })}`, {
      headers: { cookie: adminCookie },
    });
    if (!changes.response.ok) throw new Error(`changes read failed (${changes.response.status})`);
    for (const change of changes.body.changes) activityCounts[change.outcome] += 1;
    cursor = changes.body.cursor;
    hasMore = changes.body.hasMore;
    finalArrived = changes.body.arrived;
  }
  const projection = await request("/api/shared-checkin?mode=projection");
  projectionCount = projection.body.event?.attendees?.length ?? 0;
  const recoveredRoster = await readCompleteRoster(eventId);
  recoveredRosterCount = recoveredRoster.attendees.length;
  recoveredCheckedInCount = recoveredRoster.attendees.filter((item) => item.checkedInAt).length;
  const finalLaneList = await request(`/api/shared-checkin?${new URLSearchParams({ mode: "lanes", eventId })}`, {
    headers: { cookie: adminCookie },
  });
  laneReportedSuccess = finalLaneList.body.lanes?.reduce((sum, lane) => sum + Number(lane.successCount ?? 0), 0) ?? 0;
  check("資料庫最終人數一致", finalArrived === options.attendees,
    `${finalArrived.toLocaleString()} / ${options.attendees.toLocaleString()} checked in`);
  check("活動紀錄成功數無重複", activityCounts.success === options.attendees,
    `${activityCounts.success.toLocaleString()} success activities`);
  check("競態重複數符合預期", activityCounts.duplicate === options.contentionTickets * (options.clients - 1),
    `${activityCounts.duplicate.toLocaleString()} duplicate activities`);
  check("伺服器可分頁復原完整名單與報到狀態",
    recoveredRoster.metadata?.total === options.attendees && recoveredRosterCount === options.attendees && recoveredCheckedInCount === options.attendees,
    `${recoveredRosterCount.toLocaleString()} roster · ${recoveredCheckedInCount.toLocaleString()} checked in`);
  check("工作站列表統計加總與成功活動一致", finalLaneList.response.ok && laneReportedSuccess === options.attendees,
    `${laneReportedSuccess.toLocaleString()} lane successes`);
  check("投影初始資料有完整星球數", projectionCount === options.attendees,
    `${projectionCount.toLocaleString()} planets`);
} catch (error) {
  errors.push(error instanceof Error ? error.stack ?? error.message : String(error));
} finally {
  if (eventId && adminCookie) {
    const removed = await post({
      action: "delete_event", eventId, confirmation: `永久刪除活動 ${eventId}`,
    }).catch(() => null);
    cleanupSucceeded = Boolean(removed?.response.ok);
  }
  check("測試活動已清除", cleanupSucceeded, cleanupSucceeded ? "cleanup complete" : "cleanup failed");
  const status = errors.length === 0 && checks.every((item) => item.passed) ? "PASS" : "FAIL";
  await writeReport(status);
  console.log(`[stress] ${status} · report: ${options.report}`);
  if (status !== "PASS") {
    console.error(errors.slice(0, 20).join("\n"));
    process.exitCode = 1;
  }
}
