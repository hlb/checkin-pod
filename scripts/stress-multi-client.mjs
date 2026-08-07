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

async function loadLocalPassword() {
  if (process.env.ADMIN_PASSWORD) return process.env.ADMIN_PASSWORD;
  const source = await readFile(new URL("../.env.local", import.meta.url), "utf8").catch(() => "");
  for (const line of source.split(/\r?\n/)) {
    const match = line.match(/^ADMIN_PASSWORD\s*=\s*(.*)$/);
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

const password = await loadLocalPassword();
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
    const body = await response.json().catch(() => ({}));
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
    laneToken: lane.laneToken,
    code,
    requestId,
  };
}

async function writeReport(status) {
  const endedAt = new Date();
  const passedChecks = checks.filter((item) => item.passed).length;
  const totalRequests = Object.values(resultCounts).reduce((sum, count) => sum + count, 0);
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
| 50 工作站建立與驗證 | ${formatNumber(laneSetupMs / 1000, 2)} 秒 |
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

腳本會建立獨立測試活動、完成驗證、輸出本報告，最後刪除該測試活動。密碼只從 \`ADMIN_PASSWORD\` 或本機 \`.env.local\` 讀取，不會寫入報告。
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
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ password }),
  });
  adminCookie = login.response.headers.get("set-cookie")?.split(";", 1)[0] ?? "";
  if (login.response.status !== 303 || !adminCookie) throw new Error(`admin login failed (${login.response.status})`);

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
    laneToken: beginning.body.laneToken,
    laneName: beginning.body.laneName,
  }];
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
  lanes.push(...extraLanes);
  const laneReads = await Promise.all(lanes.map((lane) => request(`/api/shared-checkin?${new URLSearchParams({
    mode: "lane", eventId, laneId: lane.laneId, token: lane.laneToken,
  })}`)));
  check("50 台工作站各自取得活動資訊", laneReads.every((result) => result.response.ok && result.body.event?.total === options.attendees),
    `${laneReads.filter((result) => result.response.ok).length}/${options.clients} 成功`);
  const wrongToken = await request(`/api/shared-checkin?${new URLSearchParams({
    mode: "lane", eventId, laneId: lanes[0].laneId, token: "wrong-token",
  })}`);
  check("錯誤工作站 token 被拒絕", wrongToken.response.status === 401, `HTTP ${wrongToken.response.status}`);
  laneSetupMs = performance.now() - laneStarted;

  const normalCount = options.attendees - options.contentionTickets;
  let completed = 0;
  console.log(`[stress] scanning ${normalCount.toLocaleString()} unique tickets with ${options.clients} concurrent clients`);
  const scanStarted = performance.now();
  await Promise.all(lanes.map(async (lane, clientIndex) => {
    for (let index = clientIndex; index < normalCount; index += options.clients) {
      const serial = String(index).padStart(5, "0");
      const result = await post(scanBody(lane, `STRESS-QR-${serial}`, `unique-${clientIndex}-${index}`), "", true);
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
      post(scanBody(lane, `STRESS-QR-${serial}`, `race-${offset}-${clientIndex}`), "", true)));
    const outcomes = results.map((result) => result.response.ok ? result.body.kind : "failed");
    contentionOutcomes.push(outcomes);
    for (const kind of outcomes) {
      if (kind in resultCounts) resultCounts[kind] += 1;
      else resultCounts.failed += 1;
    }
  }

  const unknowns = await Promise.all(lanes.map((lane, clientIndex) =>
    post(scanBody(lane, `UNKNOWN-${clientIndex}`, `unknown-${clientIndex}`), "", true)));
  for (const result of unknowns) {
    const kind = result.response.ok ? result.body.kind : "failed";
    if (kind in resultCounts) resultCounts[kind] += 1;
    else resultCounts.failed += 1;
  }
  scanWallMs = performance.now() - scanStarted;

  check("一般票券全部一次成功", resultCounts.success === options.attendees,
    `${resultCounts.success.toLocaleString()} / ${options.attendees.toLocaleString()} success`);
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
  check("資料庫最終人數一致", finalArrived === options.attendees,
    `${finalArrived.toLocaleString()} / ${options.attendees.toLocaleString()} checked in`);
  check("活動紀錄成功數無重複", activityCounts.success === options.attendees,
    `${activityCounts.success.toLocaleString()} success activities`);
  check("競態重複數符合預期", activityCounts.duplicate === options.contentionTickets * (options.clients - 1),
    `${activityCounts.duplicate.toLocaleString()} duplicate activities`);
  check("投影初始資料有完整星球數", projectionCount === options.attendees,
    `${projectionCount.toLocaleString()} planets`);
} catch (error) {
  errors.push(error instanceof Error ? error.stack ?? error.message : String(error));
} finally {
  if (eventId && adminCookie) {
    const removed = await post({ action: "delete_event", eventId }).catch(() => null);
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
