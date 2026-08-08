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
  restoreAttendeeScanKeys,
  scanSharedEvent,
} from "../app/shared-checkin.ts";
import { ATOMIC_CHECK_IN_SQL, SHARED_SCHEMA_SQL } from "../app/shared-checkin-sql.ts";
import {
  defaultEventName,
  eventDeletionConfirmation,
  isEventDeletionConfirmed,
  publicProjectionName,
} from "../app/shared-checkin-policy.ts";

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

test("enforces attendee and lane relationships in the runtime schema", () => {
  const database = openSharedDatabase();
  insertEvent(database);
  assert.throws(() => database.prepare(`INSERT INTO checkin_scan_keys
    (event_id, key_hash, attendee_id) VALUES ('event-1', 'hash-1', 'missing')`).run(), /FOREIGN KEY/);
  database.prepare(`INSERT INTO checkin_attendees
    (event_id, attendee_id, position, name, original_json)
    VALUES ('event-1', 'guest-1', 0, 'Guest', '{}')`).run();
  database.prepare(`INSERT INTO checkin_scan_keys
    (event_id, key_hash, attendee_id) VALUES ('event-1', 'hash-1', 'guest-1')`).run();
  assert.throws(() => database.prepare(`INSERT INTO checkin_activity
    (event_id, attendee_id, lane_id, outcome, occurred_at, request_id)
    VALUES ('event-1', 'guest-1', 'missing', 'success', '2026-08-08T00:00:00.000Z', 'request-1')`).run(), /FOREIGN KEY/);
  database.close();
});

test("requires the exact event-specific confirmation string for permanent deletion", () => {
  const confirmation = eventDeletionConfirmation("event-1");
  assert.equal(confirmation, "永久刪除活動 event-1");
  assert.equal(isEventDeletionConfirmed("event-1", confirmation), true);
  assert.equal(isEventDeletionConfirmed("event-1", ""), false);
  assert.equal(isEventDeletionConfirmed("event-1", eventDeletionConfirmation("event-2")), false);
});

test("derives the default event name from the CSV file name", () => {
  assert.equal(defaultEventName("luma-sample-10000.csv"), "luma-sample-10000");
  assert.equal(defaultEventName("活動名單.CSV"), "活動名單");
  assert.equal(defaultEventName(".csv"), "未命名活動");
});

test("defaults the public projection to anonymous names and supports explicit masking", () => {
  assert.equal(publicProjectionName("王小明", "count"), "來賓");
  assert.equal(publicProjectionName("王小明", "masked"), "王○明");
  assert.equal(publicProjectionName("Amy Chen", "masked"), "A○○n");
  assert.equal(publicProjectionName("王小明", "names"), "王小明");
});

test("posts every scan directly to the server with its request ID", async () => {
  const originalFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (_input, init) => {
    requests.push(JSON.parse(init.body));
    return new Response(JSON.stringify({
      kind: "success",
      attendee: { id: "guest-1", name: "王小明", checkedInAt: "2026-08-08T01:00:00.000Z", displayValues: {} },
      at: "2026-08-08T01:00:00.000Z",
      cursor: 1,
    }), { status: 200 });
  };
  try {
    const result = await scanSharedEvent(
      { eventId: "event-1", laneId: "lane-1", laneName: "單機中控台" },
      "QR-001",
      "2026-08-08T01:00:00.000Z",
      "request-001",
    );
    assert.equal(result.kind, "success");
    assert.equal(requests.length, 1);
    assert.deepEqual(requests[0], {
      action: "scan",
      eventId: "event-1",
      laneId: "lane-1",
      code: "QR-001",
      scannedAt: "2026-08-08T01:00:00.000Z",
      requestId: "request-001",
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("restores QR scan keys for a server-restored single-device activity", () => {
  const restored = restoreAttendeeScanKeys([{
    id: "guest-1-0",
    name: "王小明",
    email: "guest@example.com",
    phone: "",
    ticket: "一般票",
    approvalStatus: "approved",
    qrValue: "",
    scanKeys: [],
    checkedInAt: "2026-08-08T01:00:00.000Z",
    original: {
      guest_id: "guest-1",
      name: "王小明",
      email: "guest@example.com",
      qr_code_url: "https://example.com/check-in?pk=QR-001",
    },
  }], "2026-08-08T00:00:00.000Z");

  assert.equal(restored[0].qrValue, "https://example.com/check-in?pk=QR-001");
  assert.ok(restored[0].scanKeys.includes("qr-001"));
  assert.equal(restored[0].checkedInAt, "2026-08-08T01:00:00.000Z");
});

test("returns duplicate results from the authoritative server response", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({
    kind: "duplicate",
    attendee: { id: "guest-1", name: "王小明", checkedInAt: "2026-08-08T00:59:00.000Z", displayValues: {} },
    at: "2026-08-08T01:00:00.000Z",
    cursor: 2,
  }), { status: 200 });
  try {
    const result = await scanSharedEvent(
      { eventId: "event-1", laneId: "lane-1", laneName: "入口 A" },
      "QR-001",
    );
    assert.equal(result.kind, "duplicate");
    assert.equal(result.attendee.checkedInAt, "2026-08-08T00:59:00.000Z");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("surfaces a network failure after one request without an offline queue", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    throw new TypeError("network unavailable");
  };
  try {
    await assert.rejects(
      scanSharedEvent(
        { eventId: "event-1", laneId: "lane-1", laneName: "入口 A" },
        "QR-001",
        undefined,
        "request-id",
      ),
      (error) => error instanceof SharedApiError && error.code === "network_error" && error.status === 0,
    );
    assert.equal(calls, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("rejects an unauthorized workstation after one direct request", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 });
  };
  try {
    await assert.rejects(
      scanSharedEvent(
        { eventId: "event-1", laneId: "lane-1", laneName: "入口 A" },
        "QR-001",
        undefined,
        "request-id",
      ),
      (error) => error instanceof SharedApiError && error.code === "unauthorized" && error.status === 401,
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
  assert.equal(database.prepare("SELECT sync_mode FROM checkin_events WHERE event_id = ?").get("event-1").sync_mode, "multi");
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

test("keeps attendee totals and check-in progress separate in event history", () => {
  const database = openSharedDatabase();
  insertEvent(database, 2);
  database.prepare(`INSERT INTO checkin_events
    (event_id, file_name, headers_json, selected_fields_json, background_color,
      sync_mode, total, status, active, created_at, updated_at)
    VALUES (?, ?, '[]', '[]', '#0E0F12', 'single', ?, 'active', 0, ?, ?)`).run(
      "event-2",
      "second-event.csv",
      1,
      "2026-08-07T00:00:00.000Z",
      "2026-08-07T00:00:00.000Z",
    );
  const attendeeInsert = database.prepare(`INSERT INTO checkin_attendees
    (event_id, attendee_id, position, name, checked_in_at, original_json)
    VALUES (?, ?, ?, ?, ?, '{}')`);
  attendeeInsert.run("event-1", "guest-1", 0, "王小明", "2026-08-08T01:00:00.000Z");
  attendeeInsert.run("event-1", "guest-2", 1, "陳小華", null);
  attendeeInsert.run("event-2", "guest-1", 0, "林小美", "2026-08-07T01:00:00.000Z");

  const events = database.prepare(`SELECT e.event_id, e.total,
      COALESCE(SUM(CASE WHEN a.checked_in_at IS NOT NULL THEN 1 ELSE 0 END), 0) AS arrived
    FROM checkin_events e
    LEFT JOIN checkin_attendees a ON a.event_id = e.event_id
    WHERE e.status = 'active'
    GROUP BY e.event_id, e.total
    ORDER BY e.active DESC, e.created_at DESC`).all();

  assert.deepEqual(events.map((event) => ({
    eventId: event.event_id,
    total: event.total,
    arrived: event.arrived,
  })), [
    { eventId: "event-1", total: 2, arrived: 1 },
    { eventId: "event-2", total: 1, arrived: 1 },
  ]);
  database.close();
});

test("permanently deleting an event cascades through its server records", () => {
  const database = openSharedDatabase();
  insertEvent(database);
  database.prepare(`INSERT INTO checkin_attendees
    (event_id, attendee_id, position, name, original_json)
    VALUES ('event-1', 'guest-1', 0, '王小明', '{}')`).run();
  database.prepare(`INSERT INTO checkin_scan_keys
    (event_id, key_hash, attendee_id)
    VALUES ('event-1', 'hash-1', 'guest-1')`).run();
  database.prepare(`INSERT INTO checkin_lanes
    (lane_id, event_id, name, token_hash, created_at)
    VALUES ('lane-1', 'event-1', '入口 A', 'token-hash-1', '2026-08-08T00:00:00.000Z')`).run();
  database.prepare(`INSERT INTO checkin_activity
    (event_id, attendee_id, lane_id, outcome, occurred_at, request_id)
    VALUES ('event-1', 'guest-1', 'lane-1', 'success', '2026-08-08T01:00:00.000Z', 'request-1')`).run();

  database.prepare("DELETE FROM checkin_events WHERE event_id = ?").run("event-1");

  for (const table of [
    "checkin_events",
    "checkin_attendees",
    "checkin_scan_keys",
    "checkin_lanes",
    "checkin_activity",
  ]) {
    assert.equal(database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count, 0);
  }
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

test("SQL migrations add retention and relational integrity while removing the legacy API table", async () => {
  const migrations = await Promise.all([
    readFile(new URL("../drizzle/0000_round_sabra.sql", import.meta.url), "utf8"),
    readFile(new URL("../drizzle/0001_volatile_tigra.sql", import.meta.url), "utf8"),
    readFile(new URL("../drizzle/0002_chilly_the_spike.sql", import.meta.url), "utf8"),
    readFile(new URL("../drizzle/0003_lying_orphan.sql", import.meta.url), "utf8"),
    readFile(new URL("../drizzle/0004_illegal_triathlon.sql", import.meta.url), "utf8"),
    readFile(new URL("../drizzle/0005_true_zaran.sql", import.meta.url), "utf8"),
    readFile(new URL("../drizzle/0006_blue_toxin.sql", import.meta.url), "utf8"),
    readFile(new URL("../drizzle/0007_reset_production.sql", import.meta.url), "utf8"),
  ]);
  const database = new DatabaseSync(":memory:");
  const apply = (source) => {
    for (const statement of source.split("--> statement-breakpoint").map((item) => item.trim()).filter(Boolean)) {
      database.exec(statement);
    }
  };
  for (const migration of migrations.slice(0, 4)) apply(migration);
  database.prepare(`INSERT INTO checkin_events
    (event_id, file_name, event_name, headers_json, selected_fields_json, background_color,
      sync_mode, total, status, active, created_at, updated_at)
    VALUES ('legacy-event', 'legacy.csv', 'Legacy', '[]', '[]', '#0E0F12',
      'multi', 0, 'active', 0, '2026-08-01T00:00:00.000Z', '2026-08-01T00:00:00.000Z')`).run();
  for (const migration of migrations.slice(4, 7)) apply(migration);
  const tables = database.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((row) => row.name);
  assert.ok(tables.includes("checkin_events"));
  assert.ok(tables.includes("checkin_attendees"));
  assert.ok(tables.includes("checkin_scan_keys"));
  assert.ok(tables.includes("checkin_lanes"));
  assert.ok(tables.includes("checkin_activity"));
  assert.ok(tables.includes("checkin_admin_audit"));
  assert.equal(tables.includes("live_event_state"), false);
  assert.match(migrations[1], /PRAGMA optimize/);
  assert.match(migrations[2], /ADD `sync_mode`/);
  assert.match(migrations[3], /ADD `event_name`/);
  const eventColumns = database.prepare("PRAGMA table_info(checkin_events)").all().map((row) => row.name);
  assert.ok(eventColumns.includes("sync_mode"));
  assert.ok(eventColumns.includes("event_name"));
  assert.ok(eventColumns.includes("projection_privacy"));
  assert.ok(eventColumns.includes("expires_at"));
  assert.equal(
    database.prepare("SELECT expires_at FROM checkin_events WHERE event_id = 'legacy-event'").get().expires_at,
    "2026-08-31T00:00:00.000Z",
  );
  const scanKeyForeignKeys = database.prepare("PRAGMA foreign_key_list(checkin_scan_keys)").all();
  assert.ok(scanKeyForeignKeys.some((row) => row.table === "checkin_attendees"));
  const activityForeignKeys = database.prepare("PRAGMA foreign_key_list(checkin_activity)").all();
  assert.ok(activityForeignKeys.some((row) => row.table === "checkin_attendees"));
  assert.ok(activityForeignKeys.some((row) => row.table === "checkin_lanes"));

  apply(migrations[7]);
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM checkin_events").get().count, 0);
  const rebuiltTables = database.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'checkin_%'",
  ).all().map((row) => row.name);
  assert.ok(rebuiltTables.includes("checkin_events"));
  assert.ok(rebuiltTables.includes("checkin_attendees"));
  assert.ok(rebuiltTables.includes("checkin_scan_keys"));
  assert.ok(rebuiltTables.includes("checkin_lanes"));
  assert.ok(rebuiltTables.includes("checkin_activity"));
  assert.ok(rebuiltTables.includes("checkin_admin_audit"));

  const resetSql = await readFile(new URL("../scripts/reset-d1.sql", import.meta.url), "utf8");
  database.exec("PRAGMA foreign_keys = ON");
  database.exec(resetSql);
  const resetTables = database.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'checkin_%'",
  ).all();
  assert.deepEqual(resetTables, []);
  database.close();
});
