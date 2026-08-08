import { env } from "cloudflare:workers";
import { hasValidAdminSession, sha256Hex } from "../../admin-auth";
import type { Attendee, OriginalRow, ProjectionCueType } from "../../checkin-core";
import { scanKeysFor } from "../../checkin-core";
import { MAX_SHARED_ATTENDEES, MAX_SHARED_LANES, SHARED_CHANGE_PAGE_SIZE } from "../../shared-checkin-policy";
import { ATOMIC_CHECK_IN_SQL, SHARED_SCHEMA_SQL } from "../../shared-checkin-sql";
import { getD1 } from "../../../db";

type EventRow = {
  event_id: string;
  file_name: string;
  headers_json: string;
  selected_fields_json: string;
  background_color: string;
  sync_mode: "single" | "multi";
  total: number;
  status: string;
  cue_id: string | null;
  cue_type: string | null;
  cue_at: string | null;
  created_at: string;
  updated_at: string;
};

type AttendeeRow = {
  event_id: string;
  attendee_id: string;
  position: number;
  name: string;
  email: string;
  phone: string;
  ticket: string;
  approval_status: string;
  checked_in_at: string | null;
  checked_in_lane_id: string | null;
  original_json: string;
};

type ActivityRow = {
  id: number;
  attendee_id: string | null;
  outcome: "success" | "duplicate" | "unknown" | "undo";
  checked_in_at: string | null;
  occurred_at: string;
  lane_name?: string | null;
};

let schemaReady: Promise<void> | null = null;

function noStoreJson(body: unknown, init?: ResponseInit) {
  const headers = new Headers(init?.headers);
  headers.set("cache-control", "no-store, max-age=0");
  headers.set("content-type", "application/json; charset=utf-8");
  return new Response(JSON.stringify(body), { ...init, headers });
}

function adminPassword() {
  return (env as unknown as { ADMIN_PASSWORD?: string }).ADMIN_PASSWORD;
}

async function requireAdmin(request: Request) {
  return hasValidAdminSession(request, adminPassword());
}

async function ensureSchema(database: D1Database) {
  if (!schemaReady) {
    schemaReady = (async () => {
      for (const sql of SHARED_SCHEMA_SQL) await database.prepare(sql).run();
    })().catch((error) => {
      schemaReady = null;
      throw error;
    });
  }
  await schemaReady;
}

function parseJsonArray(value: string) {
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

function parseOriginal(value: string): OriginalRow {
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" ? parsed as OriginalRow : {};
  } catch {
    return {};
  }
}

function attendeeFromRow(row: AttendeeRow): Attendee {
  return {
    id: row.attendee_id,
    name: row.name,
    email: row.email,
    phone: row.phone,
    ticket: row.ticket,
    approvalStatus: row.approval_status,
    qrValue: "",
    scanKeys: [],
    checkedInAt: row.checked_in_at,
    original: parseOriginal(row.original_json),
  };
}

function eventMetadata(event: EventRow, laneName: string) {
  return {
    eventId: event.event_id,
    fileName: event.file_name,
    headers: parseJsonArray(event.headers_json),
    selectedFields: parseJsonArray(event.selected_fields_json),
    backgroundColor: event.background_color,
    total: event.total,
    laneName,
  };
}

async function adminEventMetadata(database: D1Database, event: EventRow) {
  const cursor = await database.prepare("SELECT COALESCE(MAX(id), 0) AS cursor FROM checkin_activity WHERE event_id = ?")
    .bind(event.event_id).first<{ cursor: number }>();
  return {
    eventId: event.event_id,
    fileName: event.file_name,
    importedAt: event.created_at,
    headers: parseJsonArray(event.headers_json),
    selectedFields: parseJsonArray(event.selected_fields_json),
    backgroundColor: event.background_color,
    total: event.total,
    cursor: cursor?.cursor ?? 0,
    syncMode: event.sync_mode,
  };
}

async function findAdminEvent(database: D1Database, requestedEventId = "") {
  const selection = `SELECT event_id, file_name, headers_json, selected_fields_json,
      background_color, sync_mode, total, status, cue_id, cue_type, cue_at, created_at, updated_at
    FROM checkin_events`;
  return requestedEventId
    ? database.prepare(`${selection} WHERE event_id = ? AND status = 'active' LIMIT 1`)
      .bind(requestedEventId).first<EventRow>()
    : database.prepare(`${selection} WHERE status = 'active'
        ORDER BY active DESC, updated_at DESC LIMIT 1`).first<EventRow>();
}

function safeText(value: unknown, maxLength: number) {
  return typeof value === "string" ? value.trim().slice(0, maxLength) : "";
}

function safeIso(value: unknown) {
  if (typeof value !== "string") return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function validStringArray(value: unknown, maxItems: number, maxLength: number) {
  if (!Array.isArray(value) || value.length > maxItems) return null;
  const values = value.map((item) => safeText(item, maxLength));
  return values.every(Boolean) ? values : null;
}

async function laneForRequest(
  database: D1Database,
  eventId: string,
  laneId: string,
  laneToken: string,
) {
  if (!eventId || !laneId || !laneToken) return null;
  const tokenHash = await sha256Hex(laneToken);
  return database.prepare(`SELECT l.lane_id, l.name, e.event_id, e.file_name, e.headers_json,
      e.selected_fields_json, e.background_color, e.sync_mode, e.total, e.status,
      e.cue_id, e.cue_type, e.cue_at
    FROM checkin_lanes l
    JOIN checkin_events e ON e.event_id = l.event_id
    WHERE l.event_id = ? AND l.lane_id = ? AND l.token_hash = ? AND l.revoked_at IS NULL
    LIMIT 1`)
    .bind(eventId, laneId, tokenHash)
    .first<EventRow & { lane_id: string; name: string }>();
}

async function rowForAttendee(database: D1Database, eventId: string, attendeeId: string) {
  return database.prepare(`SELECT event_id, attendee_id, position, name, email, phone, ticket,
      approval_status, checked_in_at, checked_in_lane_id, original_json
    FROM checkin_attendees WHERE event_id = ? AND attendee_id = ? LIMIT 1`)
    .bind(eventId, attendeeId)
    .first<AttendeeRow>();
}

async function activityByRequest(database: D1Database, eventId: string, requestId: string) {
  return database.prepare(`SELECT id, attendee_id, outcome, checked_in_at, occurred_at
    FROM checkin_activity WHERE event_id = ? AND request_id = ? LIMIT 1`)
    .bind(eventId, requestId)
    .first<ActivityRow>();
}

async function recordActivity(
  database: D1Database,
  values: {
    eventId: string;
    attendeeId: string | null;
    laneId: string | null;
    outcome: ActivityRow["outcome"];
    checkedInAt: string | null;
    occurredAt: string;
    requestId: string;
  },
) {
  await database.prepare(`INSERT OR IGNORE INTO checkin_activity
      (event_id, attendee_id, lane_id, outcome, checked_in_at, occurred_at, request_id)
    VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .bind(values.eventId, values.attendeeId, values.laneId, values.outcome,
      values.checkedInAt, values.occurredAt, values.requestId)
    .run();
  return activityByRequest(database, values.eventId, values.requestId);
}

async function scanResponse(database: D1Database, eventId: string, activity: ActivityRow) {
  const row = activity.attendee_id
    ? await rowForAttendee(database, eventId, activity.attendee_id)
    : null;
  return {
    kind: activity.outcome === "undo" ? "unknown" : activity.outcome,
    attendee: row ? attendeeFromRow(row) : undefined,
    at: activity.occurred_at,
    cursor: activity.id,
  };
}

async function handleBeginImport(request: Request, body: Record<string, unknown>, database: D1Database) {
  if (!(await requireAdmin(request))) return noStoreJson({ error: "unauthorized" }, { status: 401 });
  const fileName = safeText(body.fileName, 240);
  const headers = validStringArray(body.headers, 250, 240);
  const selectedFields = validStringArray(body.selectedFields, 30, 240) ?? [];
  const expectedTotal = Number(body.expectedTotal);
  const syncMode = body.syncMode === undefined || body.syncMode === "multi"
    ? "multi"
    : body.syncMode === "single" ? "single" : null;
  const backgroundColor = /^#[0-9a-f]{6}$/i.test(safeText(body.backgroundColor, 7))
    ? safeText(body.backgroundColor, 7).toUpperCase()
    : "#0E0F12";
  if (!fileName || !headers || !syncMode || !Number.isInteger(expectedTotal) || expectedTotal < 1) {
    return noStoreJson({ error: "invalid_payload" }, { status: 400 });
  }
  if (expectedTotal > MAX_SHARED_ATTENDEES) {
    return noStoreJson({ error: "attendee_limit_exceeded" }, { status: 413 });
  }
  const eventId = crypto.randomUUID();
  const laneId = crypto.randomUUID();
  const laneName = "中控台主工作站";
  const laneToken = `${crypto.randomUUID()}${crypto.randomUUID()}`.replaceAll("-", "");
  const tokenHash = await sha256Hex(laneToken);
  const now = new Date().toISOString();
  await database.batch([
    database.prepare(`INSERT INTO checkin_events
        (event_id, file_name, headers_json, selected_fields_json, background_color,
          sync_mode, total, status, active, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'importing', 0, ?, ?)`)
      .bind(eventId, fileName, JSON.stringify(headers), JSON.stringify(selectedFields),
        backgroundColor, syncMode, expectedTotal, now, now),
    database.prepare(`INSERT INTO checkin_lanes
        (lane_id, event_id, name, token_hash, created_at)
      VALUES (?, ?, ?, ?, ?)`)
      .bind(laneId, eventId, laneName, tokenHash, now),
  ]);
  return noStoreJson({ eventId, laneId, laneName, laneToken });
}

async function handleUploadChunk(request: Request, body: Record<string, unknown>, database: D1Database) {
  if (!(await requireAdmin(request))) return noStoreJson({ error: "unauthorized" }, { status: 401 });
  const eventId = safeText(body.eventId, 80);
  const attendees = Array.isArray(body.attendees) ? body.attendees : [];
  if (!eventId || !attendees.length || attendees.length > 200) {
    return noStoreJson({ error: "invalid_payload" }, { status: 400 });
  }
  const event = await database.prepare("SELECT event_id, status FROM checkin_events WHERE event_id = ?")
    .bind(eventId).first<{ event_id: string; status: string }>();
  if (!event) return noStoreJson({ error: "event_not_found" }, { status: 404 });
  if (event.status !== "importing") return noStoreJson({ error: "event_not_ready" }, { status: 409 });

  const statements: D1PreparedStatement[] = [];
  for (const raw of attendees) {
    const attendee = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
    const attendeeId = safeText(attendee.id, 240);
    const name = safeText(attendee.name, 300);
    const position = Number(attendee.position);
    const scanKeys = validStringArray(attendee.scanKeys, 24, 2048);
    const original = attendee.original && typeof attendee.original === "object" ? attendee.original : {};
    const originalJson = JSON.stringify(original);
    if (!attendeeId || !name || !Number.isInteger(position) || position < 0 || !scanKeys || !scanKeys.length || originalJson.length > 100_000) {
      return noStoreJson({ error: "invalid_payload" }, { status: 400 });
    }
    statements.push(database.prepare(`INSERT INTO checkin_attendees
        (event_id, attendee_id, position, name, email, phone, ticket, approval_status,
          checked_in_at, checked_in_lane_id, original_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)
      ON CONFLICT(event_id, attendee_id) DO UPDATE SET
        position = excluded.position, name = excluded.name, email = excluded.email,
        phone = excluded.phone, ticket = excluded.ticket,
        approval_status = excluded.approval_status, checked_in_at = excluded.checked_in_at,
        original_json = excluded.original_json`)
      .bind(eventId, attendeeId, position, name, safeText(attendee.email, 500),
        safeText(attendee.phone, 120), safeText(attendee.ticket, 300),
        safeText(attendee.approvalStatus, 120), safeIso(attendee.checkedInAt), originalJson));
    const hashes = [...new Set(await Promise.all(scanKeys.map((key) => sha256Hex(key.toLowerCase()))))];
    for (const keyHash of hashes) {
      statements.push(database.prepare(`INSERT INTO checkin_scan_keys (event_id, key_hash, attendee_id)
        VALUES (?, ?, ?)
        ON CONFLICT(event_id, key_hash) DO UPDATE SET attendee_id =
          CASE WHEN attendee_id = excluded.attendee_id THEN attendee_id ELSE '__CONFLICT__' END`)
        .bind(eventId, keyHash, attendeeId));
    }
  }
  for (let index = 0; index < statements.length; index += 100) {
    await database.batch(statements.slice(index, index + 100));
  }
  const conflict = await database.prepare(`SELECT 1 AS found FROM checkin_scan_keys
    WHERE event_id = ? AND attendee_id = '__CONFLICT__' LIMIT 1`).bind(eventId).first();
  if (conflict) return noStoreJson({ error: "duplicate_scan_key" }, { status: 409 });
  return noStoreJson({ ok: true });
}

async function handleFinalizeImport(request: Request, body: Record<string, unknown>, database: D1Database) {
  if (!(await requireAdmin(request))) return noStoreJson({ error: "unauthorized" }, { status: 401 });
  const eventId = safeText(body.eventId, 80);
  const event = await database.prepare("SELECT total, status FROM checkin_events WHERE event_id = ?")
    .bind(eventId).first<{ total: number; status: string }>();
  if (!event) return noStoreJson({ error: "event_not_found" }, { status: 404 });
  const count = await database.prepare("SELECT COUNT(*) AS count FROM checkin_attendees WHERE event_id = ?")
    .bind(eventId).first<{ count: number }>();
  if (count?.count !== event.total) return noStoreJson({ error: "invalid_payload" }, { status: 409 });
  const now = new Date().toISOString();
  await database.batch([
    database.prepare("UPDATE checkin_events SET active = 0, updated_at = ? WHERE active = 1").bind(now),
    database.prepare("UPDATE checkin_events SET active = 1, status = 'active', updated_at = ? WHERE event_id = ?")
      .bind(now, eventId),
  ]);
  return noStoreJson({ cursor: 0 });
}

async function handleScan(body: Record<string, unknown>, database: D1Database) {
  const eventId = safeText(body.eventId, 80);
  const laneId = safeText(body.laneId, 80);
  const laneToken = safeText(body.laneToken, 256);
  const code = safeText(body.code, 2048);
  const requestId = safeText(body.requestId, 128);
  if (!eventId || !laneId || !laneToken || !code || !requestId) {
    return noStoreJson({ error: "invalid_payload" }, { status: 400 });
  }
  const lane = await laneForRequest(database, eventId, laneId, laneToken);
  if (!lane) return noStoreJson({ error: "unauthorized" }, { status: 401 });
  if (lane.status !== "active") return noStoreJson({ error: "event_not_ready" }, { status: 409 });
  const previous = await activityByRequest(database, eventId, requestId);
  if (previous) return noStoreJson(await scanResponse(database, eventId, previous));

  const keyHashes = [...new Set(await Promise.all(scanKeysFor(code).map((key) => sha256Hex(key.toLowerCase()))))];
  const placeholders = keyHashes.map(() => "?").join(",");
  const candidate = keyHashes.length
    ? await database.prepare(`SELECT a.event_id, a.attendee_id, a.position, a.name, a.email,
        a.phone, a.ticket, a.approval_status, a.checked_in_at, a.checked_in_lane_id, a.original_json
      FROM checkin_scan_keys k
      JOIN checkin_attendees a ON a.event_id = k.event_id AND a.attendee_id = k.attendee_id
      WHERE k.event_id = ? AND k.key_hash IN (${placeholders})
      ORDER BY a.position LIMIT 1`)
      .bind(eventId, ...keyHashes).first<AttendeeRow>()
    : null;
  const occurredAt = new Date().toISOString();
  if (!candidate) {
    const activity = await recordActivity(database, {
      eventId, attendeeId: null, laneId, outcome: "unknown", checkedInAt: null, occurredAt, requestId,
    });
    return noStoreJson(activity ? await scanResponse(database, eventId, activity) : { error: "write_failed" },
      activity ? undefined : { status: 500 });
  }

  const updated = await database.prepare(ATOMIC_CHECK_IN_SQL)
    .bind(occurredAt, laneId, eventId, candidate.attendee_id)
    .all<AttendeeRow>();
  const checked = updated.results[0];
  const authoritative = checked ?? await rowForAttendee(database, eventId, candidate.attendee_id);
  const requestedOutcome = checked ? "success" : "duplicate";
  const activity = await recordActivity(database, {
    eventId,
    attendeeId: candidate.attendee_id,
    laneId,
    outcome: requestedOutcome,
    checkedInAt: authoritative?.checked_in_at ?? occurredAt,
    occurredAt,
    requestId,
  });
  await database.prepare("UPDATE checkin_lanes SET last_seen_at = ? WHERE lane_id = ?")
    .bind(occurredAt, laneId).run();
  return noStoreJson(activity ? await scanResponse(database, eventId, activity) : { error: "write_failed" },
    activity ? undefined : { status: 500 });
}

async function handleSetAttendee(request: Request, body: Record<string, unknown>, database: D1Database) {
  if (!(await requireAdmin(request))) return noStoreJson({ error: "unauthorized" }, { status: 401 });
  const eventId = safeText(body.eventId, 80);
  const attendeeId = safeText(body.attendeeId, 240);
  const checkedInAt = body.checkedInAt === null ? null : safeIso(body.checkedInAt);
  const requestId = safeText(body.requestId, 128) || crypto.randomUUID();
  if (!eventId || !attendeeId || body.checkedInAt !== null && !checkedInAt) {
    return noStoreJson({ error: "invalid_payload" }, { status: 400 });
  }
  const existing = await rowForAttendee(database, eventId, attendeeId);
  if (!existing) return noStoreJson({ error: "event_not_found" }, { status: 404 });
  await database.prepare(`UPDATE checkin_attendees SET checked_in_at = ?, checked_in_lane_id = NULL
    WHERE event_id = ? AND attendee_id = ?`).bind(checkedInAt, eventId, attendeeId).run();
  const occurredAt = new Date().toISOString();
  const activity = await recordActivity(database, {
    eventId, attendeeId, laneId: null, outcome: checkedInAt ? "success" : "undo",
    checkedInAt, occurredAt, requestId,
  });
  const row = await rowForAttendee(database, eventId, attendeeId);
  return noStoreJson({ attendee: row ? attendeeFromRow(row) : attendeeFromRow(existing), cursor: activity?.id ?? 0 });
}

async function handleSingleSync(request: Request, body: Record<string, unknown>, database: D1Database) {
  if (!(await requireAdmin(request))) return noStoreJson({ error: "unauthorized" }, { status: 401 });
  const eventId = safeText(body.eventId, 80);
  const syncId = safeText(body.syncId, 80);
  const rawChanges = Array.isArray(body.changes) ? body.changes : [];
  if (!eventId || !syncId || !rawChanges.length || rawChanges.length > 200) {
    return noStoreJson({ error: "invalid_payload" }, { status: 400 });
  }
  const event = await database.prepare(`SELECT status, sync_mode FROM checkin_events
    WHERE event_id = ? LIMIT 1`).bind(eventId).first<{ status: string; sync_mode: string }>();
  if (!event) return noStoreJson({ error: "event_not_found" }, { status: 404 });
  if (event.status !== "active" || event.sync_mode !== "single") {
    return noStoreJson({ error: "event_not_ready" }, { status: 409 });
  }

  const statements: D1PreparedStatement[] = [];
  const occurredAt = new Date().toISOString();
  for (let index = 0; index < rawChanges.length; index += 1) {
    const raw = rawChanges[index];
    const change = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
    const attendeeId = safeText(change.id, 240);
    const checkedInAt = change.checkedInAt === null ? null : safeIso(change.checkedInAt);
    if (!attendeeId || change.checkedInAt !== null && !checkedInAt) {
      return noStoreJson({ error: "invalid_payload" }, { status: 400 });
    }
    const requestId = `${syncId}:${index}`;
    const outcome = checkedInAt ? "success" : "undo";
    statements.push(
      database.prepare(`INSERT OR IGNORE INTO checkin_activity
          (event_id, attendee_id, lane_id, outcome, checked_in_at, occurred_at, request_id)
        SELECT ?, attendee_id, NULL, ?, ?, ?, ? FROM checkin_attendees
        WHERE event_id = ? AND attendee_id = ? AND checked_in_at IS NOT ?`)
        .bind(eventId, outcome, checkedInAt, occurredAt, requestId, eventId, attendeeId, checkedInAt),
      database.prepare(`UPDATE checkin_attendees
        SET checked_in_at = ?, checked_in_lane_id = NULL
        WHERE event_id = ? AND attendee_id = ? AND checked_in_at IS NOT ?`)
        .bind(checkedInAt, eventId, attendeeId, checkedInAt),
    );
  }
  for (let index = 0; index < statements.length; index += 100) {
    await database.batch(statements.slice(index, index + 100));
  }
  await database.prepare("UPDATE checkin_events SET updated_at = ? WHERE event_id = ?")
    .bind(occurredAt, eventId).run();
  const cursor = await database.prepare("SELECT COALESCE(MAX(id), 0) AS cursor FROM checkin_activity WHERE event_id = ?")
    .bind(eventId).first<{ cursor: number }>();
  return noStoreJson({ ok: true, cursor: cursor?.cursor ?? 0 });
}

async function handleCreateLane(request: Request, body: Record<string, unknown>, database: D1Database) {
  if (!(await requireAdmin(request))) return noStoreJson({ error: "unauthorized" }, { status: 401 });
  const eventId = safeText(body.eventId, 80);
  const laneName = safeText(body.laneName, 80);
  if (!eventId || !laneName) return noStoreJson({ error: "invalid_payload" }, { status: 400 });
  const event = await database.prepare("SELECT 1 AS found FROM checkin_events WHERE event_id = ? AND status = 'active'")
    .bind(eventId).first();
  if (!event) return noStoreJson({ error: "event_not_found" }, { status: 404 });
  const activeLaneCount = await database.prepare(`SELECT COUNT(*) AS count FROM checkin_lanes
    WHERE event_id = ? AND revoked_at IS NULL`).bind(eventId).first<{ count: number }>();
  if ((activeLaneCount?.count ?? 0) >= MAX_SHARED_LANES) {
    return noStoreJson({ error: "lane_limit_exceeded" }, { status: 409 });
  }
  const laneId = crypto.randomUUID();
  const laneToken = `${crypto.randomUUID()}${crypto.randomUUID()}`.replaceAll("-", "");
  const tokenHash = await sha256Hex(laneToken);
  await database.prepare(`INSERT INTO checkin_lanes (lane_id, event_id, name, token_hash, created_at)
    VALUES (?, ?, ?, ?, ?)`).bind(laneId, eventId, laneName, tokenHash, new Date().toISOString()).run();
  return noStoreJson({ laneId, laneName, laneToken });
}

async function handleLaneMutation(request: Request, body: Record<string, unknown>, database: D1Database) {
  if (!(await requireAdmin(request))) return noStoreJson({ error: "unauthorized" }, { status: 401 });
  const eventId = safeText(body.eventId, 80);
  const laneId = safeText(body.laneId, 80);
  if (!eventId || !laneId) return noStoreJson({ error: "invalid_payload" }, { status: 400 });
  const lane = await database.prepare(`SELECT lane_id, name, revoked_at FROM checkin_lanes
    WHERE event_id = ? AND lane_id = ? LIMIT 1`)
    .bind(eventId, laneId).first<{ lane_id: string; name: string; revoked_at: string | null }>();
  if (!lane) return noStoreJson({ error: "lane_not_found" }, { status: 404 });
  const now = new Date().toISOString();
  if (body.action === "revoke_lane") {
    await database.prepare("UPDATE checkin_lanes SET revoked_at = ? WHERE event_id = ? AND lane_id = ?")
      .bind(now, eventId, laneId).run();
    return noStoreJson({ ok: true, revokedAt: now });
  }
  if (body.action === "rename_lane") {
    const laneName = safeText(body.laneName, 80);
    if (!laneName) return noStoreJson({ error: "invalid_payload" }, { status: 400 });
    await database.prepare("UPDATE checkin_lanes SET name = ? WHERE event_id = ? AND lane_id = ?")
      .bind(laneName, eventId, laneId).run();
    return noStoreJson({ ok: true, laneName });
  }
  if (body.action === "rotate_lane") {
    if (lane.revoked_at) {
      const activeLaneCount = await database.prepare(`SELECT COUNT(*) AS count FROM checkin_lanes
        WHERE event_id = ? AND revoked_at IS NULL`).bind(eventId).first<{ count: number }>();
      if ((activeLaneCount?.count ?? 0) >= MAX_SHARED_LANES) {
        return noStoreJson({ error: "lane_limit_exceeded" }, { status: 409 });
      }
    }
    const laneToken = `${crypto.randomUUID()}${crypto.randomUUID()}`.replaceAll("-", "");
    const tokenHash = await sha256Hex(laneToken);
    await database.prepare(`UPDATE checkin_lanes SET token_hash = ?, revoked_at = NULL,
      last_seen_at = NULL WHERE event_id = ? AND lane_id = ?`)
      .bind(tokenHash, eventId, laneId).run();
    return noStoreJson({ laneId, laneName: lane.name, laneToken });
  }
  return noStoreJson({ error: "invalid_payload" }, { status: 400 });
}

async function handleAdminMutation(request: Request, body: Record<string, unknown>, database: D1Database) {
  if (!(await requireAdmin(request))) return noStoreJson({ error: "unauthorized" }, { status: 401 });
  const eventId = safeText(body.eventId, 80);
  if (!eventId) return noStoreJson({ error: "invalid_payload" }, { status: 400 });
  if (body.action === "update_settings") {
    const settings = body.settings && typeof body.settings === "object"
      ? body.settings as Record<string, unknown> : {};
    const selectedFields = validStringArray(settings.selectedFields, 30, 240);
    const backgroundColor = safeText(settings.backgroundColor, 7);
    if (!selectedFields || backgroundColor && !/^#[0-9a-f]{6}$/i.test(backgroundColor)) {
      return noStoreJson({ error: "invalid_payload" }, { status: 400 });
    }
    await database.prepare(`UPDATE checkin_events SET selected_fields_json = ?,
      background_color = COALESCE(NULLIF(?, ''), background_color), updated_at = ? WHERE event_id = ?`)
      .bind(JSON.stringify(selectedFields), backgroundColor, new Date().toISOString(), eventId).run();
    return noStoreJson({ ok: true });
  }
  if (body.action === "cue") {
    if (body.type !== "boarding" && body.type !== "celebration") {
      return noStoreJson({ error: "invalid_payload" }, { status: 400 });
    }
    const type = body.type as ProjectionCueType;
    const at = new Date().toISOString();
    const cue = { id: `${Date.now()}-${crypto.randomUUID()}`, type, at };
    await database.prepare(`UPDATE checkin_events SET cue_id = ?, cue_type = ?, cue_at = ?, updated_at = ?
      WHERE event_id = ?`).bind(cue.id, cue.type, cue.at, cue.at, eventId).run();
    return noStoreJson({ cue });
  }
  if (body.action === "delete_event") {
    await database.prepare("DELETE FROM checkin_events WHERE event_id = ?").bind(eventId).run();
    return noStoreJson({ ok: true });
  }
  return noStoreJson({ error: "invalid_payload" }, { status: 400 });
}

export async function POST(request: Request) {
  const contentLength = Number(request.headers.get("content-length") ?? 0);
  if (contentLength > 4_000_000) return noStoreJson({ error: "payload_too_large" }, { status: 413 });
  try {
    const database = getD1();
    await ensureSchema(database);
    const parsed = await request.json().catch(() => null);
    const body = parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : {};
    switch (body.action) {
      case "begin_import": return handleBeginImport(request, body, database);
      case "upload_chunk": return handleUploadChunk(request, body, database);
      case "finalize_import": return handleFinalizeImport(request, body, database);
      case "scan": return handleScan(body, database);
      case "set_attendee": return handleSetAttendee(request, body, database);
      case "sync_single": return handleSingleSync(request, body, database);
      case "create_lane": return handleCreateLane(request, body, database);
      case "revoke_lane":
      case "rename_lane":
      case "rotate_lane": return handleLaneMutation(request, body, database);
      case "update_settings":
      case "cue":
      case "delete_event": return handleAdminMutation(request, body, database);
      default: return noStoreJson({ error: "invalid_payload" }, { status: 400 });
    }
  } catch (error) {
    console.error("shared_checkin_post_failed", error);
    return noStoreJson({ error: "shared_state_unavailable" }, { status: 500 });
  }
}

async function handleLaneListGet(request: Request, url: URL, database: D1Database) {
  if (!(await requireAdmin(request))) return noStoreJson({ error: "unauthorized" }, { status: 401 });
  const eventId = safeText(url.searchParams.get("eventId"), 80);
  if (!eventId) return noStoreJson({ error: "invalid_payload" }, { status: 400 });
  const lanes = await database.prepare(`SELECT l.lane_id, l.name, l.created_at, l.last_seen_at,
      l.revoked_at, COUNT(CASE WHEN a.outcome = 'success' THEN 1 END) AS success_count
    FROM checkin_lanes l
    LEFT JOIN checkin_activity a ON a.event_id = l.event_id AND a.lane_id = l.lane_id
    WHERE l.event_id = ?
    GROUP BY l.lane_id, l.name, l.created_at, l.last_seen_at, l.revoked_at
    ORDER BY (l.revoked_at IS NULL) DESC, l.created_at ASC`)
    .bind(eventId).all<{
      lane_id: string; name: string; created_at: string; last_seen_at: string | null;
      revoked_at: string | null; success_count: number;
    }>();
  return noStoreJson({
    lanes: lanes.results.map((lane) => ({
      laneId: lane.lane_id,
      laneName: lane.name,
      createdAt: lane.created_at,
      lastSeenAt: lane.last_seen_at,
      revokedAt: lane.revoked_at,
      successCount: lane.success_count,
    })),
  });
}

async function handleAdminSummaryGet(request: Request, url: URL, database: D1Database) {
  if (!(await requireAdmin(request))) return noStoreJson({ error: "unauthorized" }, { status: 401 });
  const event = await findAdminEvent(database, safeText(url.searchParams.get("eventId"), 80));
  return noStoreJson({ event: event ? await adminEventMetadata(database, event) : null });
}

async function handleRosterGet(request: Request, url: URL, database: D1Database) {
  if (!(await requireAdmin(request))) return noStoreJson({ error: "unauthorized" }, { status: 401 });
  const requestedEventId = safeText(url.searchParams.get("eventId"), 80);
  const event = await findAdminEvent(database, requestedEventId);
  if (!event) return noStoreJson({ event: null, attendees: [], hasMore: false, nextPosition: -1 });
  const parsedAfterPosition = Number.parseInt(url.searchParams.get("afterPosition") ?? "-1", 10);
  const parsedLimit = Number.parseInt(url.searchParams.get("limit") ?? "500", 10);
  const afterPosition = Number.isFinite(parsedAfterPosition) ? Math.max(-1, parsedAfterPosition) : -1;
  const limit = Number.isFinite(parsedLimit) ? Math.max(1, Math.min(500, parsedLimit)) : 500;
  const result = await database.prepare(`SELECT event_id, attendee_id, position, name, email, phone,
      ticket, approval_status, checked_in_at, checked_in_lane_id, original_json
    FROM checkin_attendees WHERE event_id = ? AND position > ? ORDER BY position LIMIT ?`)
    .bind(event.event_id, afterPosition, limit + 1).all<AttendeeRow>();
  const hasMore = result.results.length > limit;
  const page = result.results.slice(0, limit);
  return noStoreJson({
    event: await adminEventMetadata(database, event),
    attendees: page.map(attendeeFromRow),
    hasMore,
    nextPosition: page.at(-1)?.position ?? afterPosition,
  });
}

async function handleLaneGet(url: URL, database: D1Database) {
  const eventId = safeText(url.searchParams.get("eventId"), 80);
  const laneId = safeText(url.searchParams.get("laneId"), 80);
  const token = safeText(url.searchParams.get("token"), 256);
  const lane = await laneForRequest(database, eventId, laneId, token);
  if (!lane) return noStoreJson({ error: "unauthorized" }, { status: 401 });
  if (lane.status !== "active") return noStoreJson({ error: "event_not_ready" }, { status: 409 });
  await database.prepare("UPDATE checkin_lanes SET last_seen_at = ? WHERE lane_id = ?")
    .bind(new Date().toISOString(), laneId).run();
  return noStoreJson({ event: eventMetadata(lane, lane.name) });
}

async function handleChangesGet(request: Request, url: URL, database: D1Database) {
  if (!(await requireAdmin(request))) return noStoreJson({ error: "unauthorized" }, { status: 401 });
  const eventId = safeText(url.searchParams.get("eventId"), 80);
  const after = Math.max(0, Number.parseInt(url.searchParams.get("after") ?? "0", 10) || 0);
  const now = new Date().toISOString();
  await database.batch([
    database.prepare("UPDATE checkin_events SET active = 0, updated_at = ? WHERE active = 1 AND event_id <> ?")
      .bind(now, eventId),
    database.prepare("UPDATE checkin_events SET active = 1, updated_at = ? WHERE event_id = ? AND status = 'active'")
      .bind(now, eventId),
  ]);
  const result = await database.prepare(`SELECT a.id, a.attendee_id, a.outcome, a.checked_in_at,
      a.occurred_at, l.name AS lane_name
    FROM checkin_activity a LEFT JOIN checkin_lanes l ON l.lane_id = a.lane_id
    WHERE a.event_id = ? AND a.id > ? ORDER BY a.id LIMIT ?`)
    .bind(eventId, after, SHARED_CHANGE_PAGE_SIZE + 1).all<ActivityRow>();
  const rows = result.results;
  const hasMore = rows.length > SHARED_CHANGE_PAGE_SIZE;
  const page = rows.slice(0, SHARED_CHANGE_PAGE_SIZE);
  const counts = await database.prepare(`SELECT COUNT(*) AS total,
      SUM(CASE WHEN checked_in_at IS NOT NULL THEN 1 ELSE 0 END) AS arrived
    FROM checkin_attendees WHERE event_id = ?`).bind(eventId).first<{ total: number; arrived: number | null }>();
  return noStoreJson({
    changes: page.map((row) => ({
      id: row.id, attendeeId: row.attendee_id, outcome: row.outcome,
      checkedInAt: row.checked_in_at, occurredAt: row.occurred_at,
      laneName: row.lane_name ?? undefined,
    })),
    cursor: page.at(-1)?.id ?? after,
    hasMore,
    arrived: counts?.arrived ?? 0,
    total: counts?.total ?? 0,
  });
}

async function handleProjectionGet(url: URL, database: D1Database) {
  const afterValue = url.searchParams.get("after");
  const after = Math.max(0, Number.parseInt(afterValue ?? "0", 10) || 0);
  const event = await database.prepare(`SELECT event_id, file_name, headers_json,
      selected_fields_json, background_color, sync_mode, total, status, cue_id, cue_type, cue_at
    FROM checkin_events WHERE active = 1 AND status = 'active' ORDER BY updated_at DESC LIMIT 1`)
    .first<EventRow>();
  if (!event) return noStoreJson({ event: null });
  const cursorRow = await database.prepare("SELECT COALESCE(MAX(id), 0) AS cursor FROM checkin_activity WHERE event_id = ?")
    .bind(event.event_id).first<{ cursor: number }>();
  const cue = event.cue_id && (event.cue_type === "boarding" || event.cue_type === "celebration")
    ? { id: event.cue_id, type: event.cue_type, at: event.cue_at ?? "" }
    : undefined;
  if (afterValue === null) {
    const attendees = await database.prepare(`SELECT attendee_id, name, checked_in_at
      FROM checkin_attendees WHERE event_id = ? AND checked_in_at IS NOT NULL ORDER BY position`)
      .bind(event.event_id).all<{ attendee_id: string; name: string; checked_in_at: string }>();
    return noStoreJson({
      event: {
        eventId: event.event_id, fileName: event.file_name, total: event.total,
        cursor: cursorRow?.cursor ?? 0, cue,
        attendees: attendees.results.map((row) => ({ id: row.attendee_id, name: row.name, checkedInAt: row.checked_in_at })),
      },
    });
  }
  const result = await database.prepare(`SELECT a.id, a.attendee_id, a.outcome, a.checked_in_at,
      a.occurred_at, g.name
    FROM checkin_activity a LEFT JOIN checkin_attendees g
      ON g.event_id = a.event_id AND g.attendee_id = a.attendee_id
    WHERE a.event_id = ? AND a.id > ? AND a.outcome IN ('success', 'undo')
    ORDER BY a.id LIMIT ?`)
    .bind(event.event_id, after, SHARED_CHANGE_PAGE_SIZE + 1)
    .all<ActivityRow & { name: string | null }>();
  const hasMore = result.results.length > SHARED_CHANGE_PAGE_SIZE;
  const page = result.results.slice(0, SHARED_CHANGE_PAGE_SIZE);
  return noStoreJson({
    event: {
      eventId: event.event_id, fileName: event.file_name, total: event.total,
      cursor: page.at(-1)?.id ?? Math.max(after, cursorRow?.cursor ?? 0),
      hasMore, cue,
      changes: page.map((row) => ({
        id: row.attendee_id, name: row.name ?? "來賓", checkedInAt: row.outcome === "undo" ? null : row.checked_in_at,
        activityId: row.id,
      })),
    },
  });
}

export async function GET(request: Request) {
  try {
    const database = getD1();
    await ensureSchema(database);
    const url = new URL(request.url);
    switch (url.searchParams.get("mode")) {
      case "lane": return handleLaneGet(url, database);
      case "lanes": return handleLaneListGet(request, url, database);
      case "admin_summary": return handleAdminSummaryGet(request, url, database);
      case "roster": return handleRosterGet(request, url, database);
      case "changes": return handleChangesGet(request, url, database);
      case "projection": return handleProjectionGet(url, database);
      default: return noStoreJson({ error: "invalid_payload" }, { status: 400 });
    }
  } catch (error) {
    console.error("shared_checkin_get_failed", error);
    return noStoreJson({ error: "shared_state_unavailable" }, { status: 500 });
  }
}
