import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  MAX_SHARED_ATTENDEES,
  MAX_SHARED_LANES,
  SHARED_IMPORT_CHUNK_SIZE,
  SharedApiError,
  applySharedChanges,
  applySharedScanResult,
  assertSharedCapacity,
  chunkItems,
  scanSharedEventWithRetry,
} from "../app/shared-checkin.ts";
import {
  MAX_PENDING_SCANS,
  appendPendingScan,
  parsePendingScans,
  scanQueueKey,
} from "../app/scan-queue.ts";
import { ATOMIC_CHECK_IN_SQL, SHARED_SCHEMA_SQL } from "../app/shared-checkin-sql.ts";

function openSharedDatabase() {
  const database = new DatabaseSync(":memory:");
  database.exec("PRAGMA foreign_keys = ON");
  for (const statement of SHARED_SCHEMA_SQL) database.exec(statement);
  return database;
}

function insertEvent(database, total = 1) {
  database.prepare(`INSERT INTO checkin_events
    (event_id, file_name, headers_json, selected_fields_json, background_color,
      total, status, active, created_at, updated_at)
    VALUES (?, ?, '[]', '[]', '#0E0F12', ?, 'active', 1, ?, ?)`)
    .run("event-1", "guests.csv", total, "2026-08-08T00:00:00.000Z", "2026-08-08T00:00:00.000Z");
}

test("bounds shared events at 10,000 attendees and chunks imports without loss", () => {
  assert.equal(MAX_SHARED_ATTENDEES, 10_000);
  assert.doesNotThrow(() => assertSharedCapacity(1));
  assert.doesNotThrow(() => assertSharedCapacity(10_000));
  assert.throws(() => assertSharedCapacity(0), /1 到 10,000/);
  assert.throws(() => assertSharedCapacity(10_001), /1 到 10,000/);

  const attendees = Array.from({ length: 10_000 }, (_, index) => index);
  const chunks = chunkItems(attendees);
  assert.equal(SHARED_IMPORT_CHUNK_SIZE, 200);
  assert.equal(chunks.length, 50);
  assert.ok(chunks.every((chunk) => chunk.length === 200));
  assert.deepEqual(chunks.flat(), attendees);
});

test("bounds each event at 100 active workstations", () => {
  assert.equal(MAX_SHARED_LANES, 100);
});

test("persists only valid queued scans and enforces the offline queue bound", () => {
  const valid = {
    code: " QR-001 ",
    scannedAt: "2026-08-08T01:02:03+08:00",
    requestId: " request-001 ",
  };
  const parsed = parsePendingScans(JSON.stringify([
    valid,
    null,
    { code: "QR-002", scannedAt: "invalid", requestId: "request-002" },
    { code: "", scannedAt: valid.scannedAt, requestId: "request-003" },
  ]));
  assert.deepEqual(parsed, [{
    code: "QR-001",
    scannedAt: "2026-08-07T17:02:03.000Z",
    requestId: "request-001",
  }]);
  assert.deepEqual(parsePendingScans("not-json"), []);
  assert.equal(scanQueueKey("event-1", "lane-1"), "checkin-pod-pending-scans:event-1:lane-1");

  const queue = Array.from({ length: MAX_PENDING_SCANS }, (_, index) => ({
    code: `QR-${index}`,
    scannedAt: "2026-08-08T00:00:00.000Z",
    requestId: `request-${index}`,
  }));
  assert.equal(appendPendingScan(queue, valid), false);
  queue.pop();
  assert.equal(appendPendingScan(queue, valid), true);
  assert.equal(queue.length, MAX_PENDING_SCANS);
});

test("retries transient scan failures with the same idempotency key", async () => {
  const originalFetch = globalThis.fetch;
  const requestIds = [];
  let calls = 0;
  globalThis.fetch = async (_input, init) => {
    calls += 1;
    requestIds.push(JSON.parse(init.body).requestId);
    if (calls < 3) return new Response(JSON.stringify({ error: "shared_state_unavailable" }), { status: 503 });
    return new Response(JSON.stringify({ kind: "success", at: "2026-08-08T00:00:00.000Z", cursor: 1 }), { status: 200 });
  };
  try {
    const result = await scanSharedEventWithRetry(
      { eventId: "event-1", laneId: "lane-1", laneName: "入口 A", laneToken: "secret" },
      "QR-001",
      "2026-08-08T00:00:00.000Z",
      "stable-request-id",
      3,
      0,
    );
    assert.equal(result.kind, "success");
    assert.equal(calls, 3);
    assert.deepEqual(requestIds, ["stable-request-id", "stable-request-id", "stable-request-id"]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("does not retry a revoked or unauthorized workstation", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 });
  };
  try {
    await assert.rejects(
      scanSharedEventWithRetry(
        { eventId: "event-1", laneId: "lane-1", laneName: "入口 A", laneToken: "expired" },
        "QR-001",
        undefined,
        "request-id",
        3,
        0,
      ),
      (error) => error instanceof SharedApiError && error.code === "unauthorized" && !error.retryable,
    );
    assert.equal(calls, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("enforces the 10,000 attendee capacity in SQLite itself", () => {
  const database = openSharedDatabase();
  assert.throws(() => insertEvent(database, 10_001), /CHECK constraint failed/);
  insertEvent(database, 10_000);
  assert.equal(database.prepare("SELECT total FROM checkin_events WHERE event_id = ?").get("event-1").total, 10_000);
  database.close();
});

test("allows exactly one winner when two clients atomically check in the same attendee", () => {
  const database = openSharedDatabase();
  insertEvent(database);
  database.prepare(`INSERT INTO checkin_attendees
    (event_id, attendee_id, position, name, original_json)
    VALUES ('event-1', 'guest-1', 0, '王小明', '{}')`).run();

  const update = database.prepare(ATOMIC_CHECK_IN_SQL);
  const first = update.all("2026-08-08T01:00:00.000Z", "lane-a", "event-1", "guest-1");
  const second = update.all("2026-08-08T01:00:00.001Z", "lane-b", "event-1", "guest-1");
  const stored = database.prepare(`SELECT checked_in_at, checked_in_lane_id
    FROM checkin_attendees WHERE event_id = 'event-1' AND attendee_id = 'guest-1'`).get();

  assert.equal(first.length, 1);
  assert.equal(second.length, 0);
  assert.equal(stored.checked_in_at, "2026-08-08T01:00:00.000Z");
  assert.equal(stored.checked_in_lane_id, "lane-a");
  database.close();
});

test("stores 10,000 attendees and uses indexed QR and activity cursor lookups", () => {
  const database = openSharedDatabase();
  insertEvent(database, 10_000);
  const attendeeInsert = database.prepare(`INSERT INTO checkin_attendees
    (event_id, attendee_id, position, name, original_json) VALUES (?, ?, ?, ?, '{}')`);
  const keyInsert = database.prepare(`INSERT INTO checkin_scan_keys
    (event_id, key_hash, attendee_id) VALUES (?, ?, ?)`);
  database.exec("BEGIN");
  for (let index = 0; index < 10_000; index += 1) {
    attendeeInsert.run("event-1", `guest-${index}`, index, `Guest ${index}`);
    keyInsert.run("event-1", `hash-${index}`, `guest-${index}`);
  }
  database.exec("COMMIT");

  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM checkin_attendees WHERE event_id = ?").get("event-1").count, 10_000);
  const keyPlan = database.prepare(`EXPLAIN QUERY PLAN SELECT attendee_id FROM checkin_scan_keys
    WHERE event_id = ? AND key_hash = ?`).all("event-1", "hash-9999");
  assert.match(keyPlan.map((row) => row.detail).join(" "), /PRIMARY KEY|INDEX/i);

  database.prepare(`INSERT INTO checkin_activity
    (event_id, attendee_id, outcome, occurred_at, request_id)
    VALUES ('event-1', 'guest-9999', 'success', '2026-08-08T01:00:00.000Z', 'request-1')`).run();
  const activityPlan = database.prepare(`EXPLAIN QUERY PLAN SELECT id FROM checkin_activity
    WHERE event_id = ? AND id > ? ORDER BY id LIMIT 500`).all("event-1", 0);
  assert.match(activityPlan.map((row) => row.detail).join(" "), /checkin_activity_event_cursor_idx/i);
  database.close();
});

test("applies paged changes without losing prior attendee state or moving the cursor backward", () => {
  const attendees = Array.from({ length: 1_000 }, (_, index) => ({
    id: `guest-${index}`,
    name: `Guest ${index}`,
    email: "",
    phone: "",
    ticket: "General",
    approvalStatus: "approved",
    qrValue: `QR-${index}`,
    scanKeys: [`qr-${index}`],
    checkedInAt: null,
    original: { name: `Guest ${index}` },
  }));
  const event = {
    version: 1,
    fileName: "guests.csv",
    importedAt: "2026-08-08T00:00:00.000Z",
    headers: ["name"],
    attendees,
    sharedEvent: { eventId: "event-1", laneId: "lane-1", laneName: "入口 A", laneToken: "secret", cursor: 0 },
  };
  const firstPage = Array.from({ length: 500 }, (_, index) => ({
    id: index + 1,
    attendeeId: `guest-${index}`,
    outcome: "success",
    checkedInAt: `2026-08-08T01:00:${String(index % 60).padStart(2, "0")}.000Z`,
    occurredAt: `2026-08-08T01:00:${String(index % 60).padStart(2, "0")}.000Z`,
  }));
  const secondPage = Array.from({ length: 500 }, (_, index) => ({
    id: index + 501,
    attendeeId: `guest-${index + 500}`,
    outcome: "success",
    checkedInAt: `2026-08-08T01:01:${String(index % 60).padStart(2, "0")}.000Z`,
    occurredAt: `2026-08-08T01:01:${String(index % 60).padStart(2, "0")}.000Z`,
  }));
  const first = applySharedChanges(event, firstPage, 500);
  const second = applySharedChanges(first, secondPage, 1_000);

  assert.equal(first.attendees.filter((attendee) => attendee.checkedInAt).length, 500);
  assert.equal(second.attendees.filter((attendee) => attendee.checkedInAt).length, 1_000);
  assert.equal(second.sharedEvent.cursor, 1_000);
  assert.equal(second.lastScan.attendeeId, "guest-999");
});

test("a direct scan response cannot skip unseen activity from another client", () => {
  const attendee = {
    id: "guest-1", name: "Guest 1", email: "", phone: "", ticket: "General",
    approvalStatus: "approved", qrValue: "QR-1", scanKeys: ["qr-1"], checkedInAt: null,
    original: { name: "Guest 1" },
  };
  const event = {
    version: 1,
    fileName: "guests.csv",
    importedAt: "2026-08-08T00:00:00.000Z",
    headers: ["name"],
    attendees: [attendee],
    sharedEvent: { eventId: "event-1", laneId: "lane-1", laneName: "入口 A", laneToken: "secret", cursor: 40 },
  };
  const next = applySharedScanResult(event, {
    kind: "success",
    attendee: { ...attendee, checkedInAt: "2026-08-08T01:00:00.000Z" },
    at: "2026-08-08T01:00:00.000Z",
    cursor: 42,
  });

  assert.equal(next.attendees[0].checkedInAt, "2026-08-08T01:00:00.000Z");
  assert.equal(next.sharedEvent.cursor, 40, "activity 41 must still be fetched from the ordered changes feed");
});

test("generated migration is executable and retains query optimization", async () => {
  const migration = await readFile(new URL("../drizzle/0001_volatile_tigra.sql", import.meta.url), "utf8");
  const database = new DatabaseSync(":memory:");
  for (const statement of migration.split("--> statement-breakpoint").map((item) => item.trim()).filter(Boolean)) {
    database.exec(statement);
  }
  const tables = database.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((row) => row.name);
  assert.ok(tables.includes("checkin_events"));
  assert.ok(tables.includes("checkin_attendees"));
  assert.ok(tables.includes("checkin_scan_keys"));
  assert.ok(tables.includes("checkin_lanes"));
  assert.ok(tables.includes("checkin_activity"));
  assert.match(migration, /PRAGMA optimize/);
  database.close();
});
