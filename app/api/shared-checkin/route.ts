import { env } from "cloudflare:workers";
import { adminSessionFromRequest, hasValidAdminSession, sha256Hex } from "../../admin-auth";
import { laneSessionCookie, laneTokenFromRequest } from "../../lane-auth";
import { readLimitedText, utf8ByteLength } from "../../request-body";
import type { Attendee, OriginalRow, ProjectionCueType, ProjectionPrivacy } from "../../checkin-core";
import { scanKeysFor } from "../../checkin-core";
import {
  MAX_SHARED_ATTENDEES,
  MAX_SHARED_LANES,
  SHARED_CHANGE_PAGE_SIZE,
  defaultEventName,
  isEventDeletionConfirmed,
  publicProjectionName,
} from "../../shared-checkin-policy";
import { ATOMIC_CHECK_IN_SQL, SHARED_SCHEMA_SQL } from "../../shared-checkin-sql";
import { getD1 } from "../../../db";

type EventRow = {
  event_id: string;
  file_name: string;
  event_name: string;
  headers_json: string;
  selected_fields_json: string;
  background_color: string;
  projection_privacy: ProjectionPrivacy;
  sync_mode: "single" | "multi";
  total: number;
  status: string;
  cue_id: string | null;
  cue_type: string | null;
  cue_at: string | null;
  created_at: string;
  updated_at: string;
  expires_at: string;
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

type RateLimiter = { limit(options: { key: string }): Promise<{ success: boolean }> };
type SharedEnv = {
  SESSION_SECRET?: string;
  SCAN_RATE_LIMITER?: RateLimiter;
  SCAN_IP_RATE_LIMITER?: RateLimiter;
  UNKNOWN_SCAN_RATE_LIMITER?: RateLimiter;
  UNKNOWN_SCAN_IP_RATE_LIMITER?: RateLimiter;
};
type LocalRateWindow = { startedAt: number; count: number };

let schemaReady: Promise<void> | null = null;
let lastRetentionCleanupAt = 0;
const localRateWindows = new Map<string, LocalRateWindow>();

function noStoreJson(body: unknown, init?: ResponseInit) {
  const headers = new Headers(init?.headers);
  headers.set("cache-control", "no-store, max-age=0");
  headers.set("content-type", "application/json; charset=utf-8");
  return new Response(JSON.stringify(body), { ...init, headers });
}

function adminSessionSecret() {
  return (env as unknown as SharedEnv).SESSION_SECRET;
}

function localRateLimit(key: string, limit: number, periodMs: number) {
  const now = Date.now();
  const current = localRateWindows.get(key);
  if (!current || now - current.startedAt >= periodMs) {
    localRateWindows.set(key, { startedAt: now, count: 1 });
    return true;
  }
  current.count += 1;
  if (localRateWindows.size > 10_000) {
    for (const [candidate, window] of localRateWindows) {
      if (now - window.startedAt >= periodMs) localRateWindows.delete(candidate);
    }
  }
  return current.count <= limit;
}

async function withinRateLimit(
  binding: RateLimiter | undefined,
  key: string,
  fallbackLimit: number,
  fallbackPeriodMs: number,
) {
  if (binding) return (await binding.limit({ key })).success;
  return localRateLimit(key, fallbackLimit, fallbackPeriodMs);
}

function rateLimitedJson() {
  return noStoreJson(
    { error: "rate_limited" },
    { status: 429, headers: { "retry-after": "60" } },
  );
}

function clientAddress(request: Request) {
  return request.headers.get("cf-connecting-ip")?.trim().slice(0, 64) || "unknown";
}

async function requireAdmin(request: Request) {
  return hasValidAdminSession(request, adminSessionSecret());
}

async function recordAdminAudit(
  request: Request,
  database: D1Database,
  action: string,
  eventId: string | null,
  details: Record<string, unknown> = {},
) {
  const session = await adminSessionFromRequest(request, adminSessionSecret());
  if (!session) return;
  const suppliedRequestId = safeText(request.headers.get("x-request-id"), 128);
  const auditDetails = {
    sourceHash: await sha256Hex(clientAddress(request)),
    ...details,
  };
  await database.prepare(`INSERT OR IGNORE INTO checkin_admin_audit
      (actor, action, event_id, occurred_at, request_id, details_json)
    VALUES (?, ?, ?, ?, ?, ?)`).bind(
      session.sub,
      action.slice(0, 120),
      eventId,
      new Date().toISOString(),
      suppliedRequestId || crypto.randomUUID(),
      JSON.stringify(auditDetails).slice(0, 4_000),
    ).run();
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

async function purgeExpiredEvents(database: D1Database) {
  const now = Date.now();
  if (now - lastRetentionCleanupAt < 60_000) return;
  lastRetentionCleanupAt = now;
  await database.prepare(`DELETE FROM checkin_events
    WHERE expires_at <> '' AND expires_at <= ?`).bind(new Date(now).toISOString()).run();
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
    eventName: event.event_name || defaultEventName(event.file_name),
    headers: parseJsonArray(event.headers_json),
    selectedFields: parseJsonArray(event.selected_fields_json),
    backgroundColor: event.background_color,
    projectionPrivacy: event.projection_privacy,
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
    eventName: event.event_name || defaultEventName(event.file_name),
    importedAt: event.created_at,
    headers: parseJsonArray(event.headers_json),
    selectedFields: parseJsonArray(event.selected_fields_json),
    backgroundColor: event.background_color,
    projectionPrivacy: event.projection_privacy,
    total: event.total,
    cursor: cursor?.cursor ?? 0,
    syncMode: event.sync_mode,
    expiresAt: event.expires_at,
  };
}

async function findAdminEvent(database: D1Database, requestedEventId = "") {
  const selection = `SELECT event_id, file_name, event_name, headers_json, selected_fields_json,
      background_color, projection_privacy, sync_mode, total, status, cue_id, cue_type, cue_at,
      created_at, updated_at, expires_at
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

function projectionPrivacy(value: unknown): ProjectionPrivacy | null {
  return value === "count" || value === "masked" || value === "names" ? value : null;
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

async function laneForToken(
  database: D1Database,
  eventId: string,
  laneId: string,
  laneToken: string,
) {
  if (!eventId || !laneId || !laneToken) return null;
  const tokenHash = await sha256Hex(laneToken);
  return database.prepare(`SELECT l.lane_id, l.name, e.event_id, e.file_name, e.event_name, e.headers_json,
      e.selected_fields_json, e.background_color, e.projection_privacy, e.sync_mode, e.total, e.status,
      e.cue_id, e.cue_type, e.cue_at, e.created_at, e.updated_at, e.expires_at
    FROM checkin_lanes l
    JOIN checkin_events e ON e.event_id = l.event_id
    WHERE l.event_id = ? AND l.lane_id = ? AND l.token_hash = ? AND l.revoked_at IS NULL
    LIMIT 1`)
    .bind(eventId, laneId, tokenHash)
    .first<EventRow & { lane_id: string; name: string }>();
}

async function laneForRequest(
  database: D1Database,
  eventId: string,
  laneId: string,
  request: Request,
) {
  return laneForToken(database, eventId, laneId, laneTokenFromRequest(request));
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

function laneAttendeeFromRow(row: AttendeeRow, selectedFields: string[]) {
  const original = parseOriginal(row.original_json);
  return {
    id: row.attendee_id,
    name: row.name,
    checkedInAt: row.checked_in_at,
    displayValues: Object.fromEntries(selectedFields.map((field) => [field, original[field] ?? ""])),
  };
}

async function scanResponse(
  database: D1Database,
  eventId: string,
  activity: ActivityRow,
  selectedFields: string[],
  includeFullAttendee: boolean,
) {
  const row = activity.attendee_id
    ? await rowForAttendee(database, eventId, activity.attendee_id)
    : null;
  return {
    kind: activity.outcome === "undo" ? "unknown" : activity.outcome,
    attendee: row
      ? includeFullAttendee ? attendeeFromRow(row) : laneAttendeeFromRow(row, selectedFields)
      : undefined,
    at: activity.occurred_at,
    cursor: activity.id,
  };
}

async function handleBeginImport(request: Request, body: Record<string, unknown>, database: D1Database) {
  if (!(await requireAdmin(request))) return noStoreJson({ error: "unauthorized" }, { status: 401 });
  const fileName = safeText(body.fileName, 240);
  const eventName = safeText(body.eventName, 240) || defaultEventName(fileName);
  const headers = validStringArray(body.headers, 250, 240);
  const selectedFields = validStringArray(body.selectedFields, 30, 240) ?? [];
  const privacy = projectionPrivacy(body.projectionPrivacy) ?? "count";
  const retentionDays = body.retentionDays === undefined ? 30 : Number(body.retentionDays);
  const expectedTotal = Number(body.expectedTotal);
  const syncMode = body.syncMode === undefined || body.syncMode === "multi"
    ? "multi"
    : body.syncMode === "single" ? "single" : null;
  const backgroundColor = /^#[0-9a-f]{6}$/i.test(safeText(body.backgroundColor, 7))
    ? safeText(body.backgroundColor, 7).toUpperCase()
    : "#0E0F12";
  if (!fileName || !headers || !syncMode || !Number.isInteger(expectedTotal) || expectedTotal < 1
    || !Number.isInteger(retentionDays) || retentionDays < 1 || retentionDays > 365) {
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
  const expiresAt = new Date(Date.now() + retentionDays * 86_400_000).toISOString();
  await database.batch([
    database.prepare(`INSERT INTO checkin_events
        (event_id, file_name, event_name, headers_json, selected_fields_json, background_color,
          projection_privacy, sync_mode, total, status, active, created_at, updated_at, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'importing', 0, ?, ?, ?)`)
      .bind(eventId, fileName, eventName, JSON.stringify(headers), JSON.stringify(selectedFields),
        backgroundColor, privacy, syncMode, expectedTotal, now, now, expiresAt),
    database.prepare(`INSERT INTO checkin_lanes
        (lane_id, event_id, name, token_hash, created_at)
      VALUES (?, ?, ?, ?, ?)`)
      .bind(laneId, eventId, laneName, tokenHash, now),
  ]);
  await recordAdminAudit(request, database, "event.import.begin", eventId, {
    expectedTotal,
    syncMode,
    projectionPrivacy: privacy,
    retentionDays,
  });
  return noStoreJson(
    { eventId, laneId, laneName },
    { headers: { "set-cookie": laneSessionCookie(laneToken, new URL(request.url).protocol === "https:") } },
  );
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
  const keyAssignments = new Map<string, string>();
  for (const raw of attendees) {
    const attendee = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
    const attendeeId = safeText(attendee.id, 240);
    const name = safeText(attendee.name, 300);
    const position = Number(attendee.position);
    const scanKeys = validStringArray(attendee.scanKeys, 24, 2048);
    const original = attendee.original && typeof attendee.original === "object" ? attendee.original : {};
    const originalJson = JSON.stringify(original);
    if (!attendeeId || !name || !Number.isInteger(position) || position < 0 || !scanKeys || !scanKeys.length || utf8ByteLength(originalJson) > 20_000) {
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
      const assignedAttendee = keyAssignments.get(keyHash);
      if (assignedAttendee && assignedAttendee !== attendeeId) {
        return noStoreJson({ error: "duplicate_scan_key" }, { status: 409 });
      }
      keyAssignments.set(keyHash, attendeeId);
      statements.push(database.prepare(`INSERT INTO checkin_scan_keys (event_id, key_hash, attendee_id)
        VALUES (?, ?, ?)
        ON CONFLICT(event_id, key_hash) DO NOTHING`)
        .bind(eventId, keyHash, attendeeId));
    }
  }
  const keyEntries = [...keyAssignments.entries()];
  for (let index = 0; index < keyEntries.length; index += 75) {
    const entries = keyEntries.slice(index, index + 75);
    const hashes = entries.map(([hash]) => hash);
    const existing = await database.prepare(`SELECT key_hash, attendee_id FROM checkin_scan_keys
      WHERE event_id = ? AND key_hash IN (${hashes.map(() => "?").join(",")})`)
      .bind(eventId, ...hashes).all<{ key_hash: string; attendee_id: string }>();
    if (existing.results.some((row) => keyAssignments.get(row.key_hash) !== row.attendee_id)) {
      return noStoreJson({ error: "duplicate_scan_key" }, { status: 409 });
    }
  }
  for (let index = 0; index < statements.length; index += 100) {
    await database.batch(statements.slice(index, index + 100));
  }
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
  await recordAdminAudit(request, database, "event.import.finalize", eventId, { total: event.total });
  return noStoreJson({ cursor: 0 });
}

async function handleActivateLane(request: Request, body: Record<string, unknown>, database: D1Database) {
  const eventId = safeText(body.eventId, 80);
  const laneId = safeText(body.laneId, 80);
  const laneToken = safeText(body.laneToken, 256);
  const lane = await laneForToken(database, eventId, laneId, laneToken);
  if (!lane) return noStoreJson({ error: "unauthorized" }, { status: 401 });
  if (lane.status !== "active") return noStoreJson({ error: "event_not_ready" }, { status: 409 });
  const now = new Date().toISOString();
  await database.prepare("UPDATE checkin_lanes SET last_seen_at = ? WHERE lane_id = ?")
    .bind(now, laneId).run();
  return noStoreJson(
    { event: eventMetadata(lane, lane.name) },
    { headers: { "set-cookie": laneSessionCookie(laneToken, new URL(request.url).protocol === "https:") } },
  );
}

async function handleLaneHeartbeat(request: Request, body: Record<string, unknown>, database: D1Database) {
  const eventId = safeText(body.eventId, 80);
  const laneId = safeText(body.laneId, 80);
  const lane = await laneForRequest(database, eventId, laneId, request);
  if (!lane) return noStoreJson({ error: "unauthorized" }, { status: 401 });
  if (lane.status !== "active") return noStoreJson({ error: "event_not_ready" }, { status: 409 });
  await database.prepare("UPDATE checkin_lanes SET last_seen_at = ? WHERE lane_id = ?")
    .bind(new Date().toISOString(), laneId).run();
  return noStoreJson({ event: eventMetadata(lane, lane.name) });
}

async function handleScan(request: Request, body: Record<string, unknown>, database: D1Database) {
  const eventId = safeText(body.eventId, 80);
  const laneId = safeText(body.laneId, 80);
  const code = safeText(body.code, 2048);
  const requestId = safeText(body.requestId, 128);
  if (!eventId || !laneId || !code || !requestId) {
    return noStoreJson({ error: "invalid_payload" }, { status: 400 });
  }
  const lane = await laneForRequest(database, eventId, laneId, request);
  if (!lane) return noStoreJson({ error: "unauthorized" }, { status: 401 });
  if (lane.status !== "active") return noStoreJson({ error: "event_not_ready" }, { status: 409 });
  const sharedEnv = env as unknown as SharedEnv;
  const mainRateChecks = await Promise.all([
    withinRateLimit(sharedEnv.SCAN_RATE_LIMITER, `lane:${eventId}:${laneId}`, 900, 60_000),
    withinRateLimit(sharedEnv.SCAN_IP_RATE_LIMITER, `ip:${clientAddress(request)}`, 60_000, 60_000),
  ]);
  if (mainRateChecks.some((allowed) => !allowed)) {
    return rateLimitedJson();
  }
  const selectedFields = parseJsonArray(lane.selected_fields_json);
  const includeFullAttendee = await requireAdmin(request);
  const previous = await activityByRequest(database, eventId, requestId);
  if (previous) {
    return noStoreJson(await scanResponse(database, eventId, previous, selectedFields, includeFullAttendee));
  }

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
    const unknownRateChecks = await Promise.all([
      withinRateLimit(
        sharedEnv.UNKNOWN_SCAN_RATE_LIMITER,
        `lane:${eventId}:${laneId}`,
        60,
        60_000,
      ),
      withinRateLimit(
        sharedEnv.UNKNOWN_SCAN_IP_RATE_LIMITER,
        `ip:${clientAddress(request)}`,
        3_000,
        60_000,
      ),
    ]);
    if (unknownRateChecks.some((allowed) => !allowed)) return rateLimitedJson();
    const activity = await recordActivity(database, {
      eventId, attendeeId: null, laneId, outcome: "unknown", checkedInAt: null, occurredAt, requestId,
    });
    return noStoreJson(activity
      ? await scanResponse(database, eventId, activity, selectedFields, includeFullAttendee)
      : { error: "write_failed" },
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
  return noStoreJson(activity
    ? await scanResponse(database, eventId, activity, selectedFields, includeFullAttendee)
    : { error: "write_failed" },
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
  await recordAdminAudit(request, database, checkedInAt ? "attendee.check_in" : "attendee.undo", eventId, {
    attendeeId,
  });
  return noStoreJson({ attendee: row ? attendeeFromRow(row) : attendeeFromRow(existing), cursor: activity?.id ?? 0 });
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
  await recordAdminAudit(request, database, "lane.create", eventId, { laneId, laneName });
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
    await recordAdminAudit(request, database, "lane.revoke", eventId, { laneId });
    return noStoreJson({ ok: true, revokedAt: now });
  }
  if (body.action === "rename_lane") {
    const laneName = safeText(body.laneName, 80);
    if (!laneName) return noStoreJson({ error: "invalid_payload" }, { status: 400 });
    await database.prepare("UPDATE checkin_lanes SET name = ? WHERE event_id = ? AND lane_id = ?")
      .bind(laneName, eventId, laneId).run();
    await recordAdminAudit(request, database, "lane.rename", eventId, { laneId, laneName });
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
    await recordAdminAudit(request, database, "lane.rotate", eventId, { laneId });
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
    const privacy = projectionPrivacy(settings.projectionPrivacy) ?? "count";
    if (!selectedFields || backgroundColor && !/^#[0-9a-f]{6}$/i.test(backgroundColor)) {
      return noStoreJson({ error: "invalid_payload" }, { status: 400 });
    }
    await database.prepare(`UPDATE checkin_events SET selected_fields_json = ?,
      background_color = COALESCE(NULLIF(?, ''), background_color), projection_privacy = ?,
      updated_at = ? WHERE event_id = ?`)
      .bind(JSON.stringify(selectedFields), backgroundColor, privacy, new Date().toISOString(), eventId).run();
    await recordAdminAudit(request, database, "event.settings.update", eventId, {
      selectedFields,
      projectionPrivacy: privacy,
    });
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
    await recordAdminAudit(request, database, "event.cue", eventId, { type });
    return noStoreJson({ cue });
  }
  if (body.action === "activate_event") {
    const event = await database.prepare("SELECT 1 AS found FROM checkin_events WHERE event_id = ? AND status = 'active'")
      .bind(eventId).first();
    if (!event) return noStoreJson({ error: "event_not_found" }, { status: 404 });
    const now = new Date().toISOString();
    await database.batch([
      database.prepare("UPDATE checkin_events SET active = 0 WHERE active = 1 AND event_id <> ?").bind(eventId),
      database.prepare("UPDATE checkin_events SET active = 1, updated_at = ? WHERE event_id = ?")
        .bind(now, eventId),
    ]);
    await recordAdminAudit(request, database, "event.activate", eventId);
    return noStoreJson({ ok: true });
  }
  if (body.action === "deactivate_event") {
    await database.prepare("UPDATE checkin_events SET active = 0, updated_at = ? WHERE event_id = ?")
      .bind(new Date().toISOString(), eventId).run();
    await recordAdminAudit(request, database, "event.deactivate", eventId);
    return noStoreJson({ ok: true });
  }
  if (body.action === "rename_event") {
    const eventName = safeText(body.eventName, 240);
    if (!eventName) return noStoreJson({ error: "invalid_payload" }, { status: 400 });
    const result = await database.prepare("UPDATE checkin_events SET event_name = ?, updated_at = ? WHERE event_id = ? AND status = 'active'")
      .bind(eventName, new Date().toISOString(), eventId).run();
    if (!result.meta.changes) return noStoreJson({ error: "event_not_found" }, { status: 404 });
    await recordAdminAudit(request, database, "event.rename", eventId, { eventName });
    return noStoreJson({ ok: true, eventName });
  }
  if (body.action === "delete_event") {
    const confirmation = safeText(body.confirmation, 160);
    if (!isEventDeletionConfirmed(eventId, confirmation)) {
      return noStoreJson({ error: "deletion_confirmation_mismatch" }, { status: 400 });
    }
    const result = await database.prepare("DELETE FROM checkin_events WHERE event_id = ?").bind(eventId).run();
    if (!result.meta.changes) return noStoreJson({ error: "event_not_found" }, { status: 404 });
    await recordAdminAudit(request, database, "event.delete", eventId);
    return noStoreJson({ ok: true });
  }
  return noStoreJson({ error: "invalid_payload" }, { status: 400 });
}

export async function POST(request: Request) {
  if (!(request.headers.get("content-type") ?? "").toLowerCase().startsWith("application/json")) {
    return noStoreJson({ error: "unsupported_media_type" }, { status: 415 });
  }
  const rawBody = await readLimitedText(request, 4_000_000);
  if (!rawBody.ok) {
    return noStoreJson(
      { error: rawBody.reason === "too_large" ? "payload_too_large" : "invalid_payload" },
      { status: rawBody.reason === "too_large" ? 413 : 400 },
    );
  }
  try {
    const database = getD1();
    await ensureSchema(database);
    await purgeExpiredEvents(database);
    const parsed = (() => {
      try {
        return JSON.parse(rawBody.value) as unknown;
      } catch {
        return null;
      }
    })();
    const body = parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : {};
    switch (body.action) {
      case "begin_import": return handleBeginImport(request, body, database);
      case "upload_chunk": return handleUploadChunk(request, body, database);
      case "finalize_import": return handleFinalizeImport(request, body, database);
      case "activate_lane": return handleActivateLane(request, body, database);
      case "lane_heartbeat": return handleLaneHeartbeat(request, body, database);
      case "scan": return handleScan(request, body, database);
      case "set_attendee": return handleSetAttendee(request, body, database);
      case "create_lane": return handleCreateLane(request, body, database);
      case "revoke_lane":
      case "rename_lane":
      case "rotate_lane": return handleLaneMutation(request, body, database);
      case "update_settings":
      case "cue":
      case "activate_event":
      case "deactivate_event":
      case "rename_event":
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

async function handleEventHistoryGet(request: Request, database: D1Database) {
  if (!(await requireAdmin(request))) return noStoreJson({ error: "unauthorized" }, { status: 401 });
  const result = await database.prepare(`SELECT e.event_id, e.file_name, e.event_name, e.sync_mode, e.total,
      e.active, e.created_at, e.updated_at, e.expires_at,
      COALESCE(SUM(CASE WHEN a.checked_in_at IS NOT NULL THEN 1 ELSE 0 END), 0) AS arrived
    FROM checkin_events e
    LEFT JOIN checkin_attendees a ON a.event_id = e.event_id
    WHERE e.status = 'active'
    GROUP BY e.event_id, e.file_name, e.event_name, e.sync_mode, e.total, e.active,
      e.created_at, e.updated_at, e.expires_at
    ORDER BY e.active DESC, e.created_at DESC
    LIMIT 100`).all<{
      event_id: string; file_name: string; event_name: string; sync_mode: "single" | "multi"; total: number;
      active: number; created_at: string; updated_at: string; expires_at: string; arrived: number;
    }>();
  return noStoreJson({
    events: result.results.map((event) => ({
      eventId: event.event_id,
      fileName: event.file_name,
      eventName: event.event_name || defaultEventName(event.file_name),
      syncMode: event.sync_mode,
      total: event.total,
      arrived: event.arrived,
      active: Boolean(event.active),
      importedAt: event.created_at,
      updatedAt: event.updated_at,
      expiresAt: event.expires_at,
    })),
  });
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

async function handleLaneGet(request: Request, url: URL, database: D1Database) {
  const eventId = safeText(url.searchParams.get("eventId"), 80);
  const laneId = safeText(url.searchParams.get("laneId"), 80);
  const lane = await laneForRequest(database, eventId, laneId, request);
  if (!lane) return noStoreJson({ error: "unauthorized" }, { status: 401 });
  if (lane.status !== "active") return noStoreJson({ error: "event_not_ready" }, { status: 409 });
  return noStoreJson({ event: eventMetadata(lane, lane.name) });
}

async function handleChangesGet(request: Request, url: URL, database: D1Database) {
  if (!(await requireAdmin(request))) return noStoreJson({ error: "unauthorized" }, { status: 401 });
  const eventId = safeText(url.searchParams.get("eventId"), 80);
  const after = Math.max(0, Number.parseInt(url.searchParams.get("after") ?? "0", 10) || 0);
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
  const event = await database.prepare(`SELECT event_id, file_name, event_name, headers_json,
      selected_fields_json, background_color, projection_privacy, sync_mode, total, status,
      cue_id, cue_type, cue_at, created_at, updated_at, expires_at
    FROM checkin_events WHERE active = 1 AND status = 'active' ORDER BY updated_at DESC LIMIT 1`)
    .first<EventRow>();
  if (!event) return noStoreJson({ event: null });
  const cursorRow = await database.prepare("SELECT COALESCE(MAX(id), 0) AS cursor FROM checkin_activity WHERE event_id = ?")
    .bind(event.event_id).first<{ cursor: number }>();
  const cue = event.cue_id && (event.cue_type === "boarding" || event.cue_type === "celebration")
    ? { id: event.cue_id, type: event.cue_type, at: event.cue_at ?? "" }
    : undefined;
  if (afterValue === null) {
    const attendees = await database.prepare(`SELECT position, name, checked_in_at
      FROM checkin_attendees WHERE event_id = ? AND checked_in_at IS NOT NULL ORDER BY position`)
      .bind(event.event_id).all<{ position: number; name: string; checked_in_at: string }>();
    return noStoreJson({
      event: {
        eventId: event.event_id, fileName: event.file_name, total: event.total,
        eventName: event.event_name || defaultEventName(event.file_name),
        cursor: cursorRow?.cursor ?? 0, cue,
        attendees: attendees.results.map((row) => ({
          id: `guest-${row.position}`,
          name: publicProjectionName(row.name, event.projection_privacy),
          checkedInAt: row.checked_in_at,
        })),
      },
    });
  }
  const result = await database.prepare(`SELECT a.id, a.attendee_id, a.outcome, a.checked_in_at,
      a.occurred_at, g.name, g.position
    FROM checkin_activity a LEFT JOIN checkin_attendees g
      ON g.event_id = a.event_id AND g.attendee_id = a.attendee_id
    WHERE a.event_id = ? AND a.id > ? AND a.outcome IN ('success', 'undo')
    ORDER BY a.id LIMIT ?`)
    .bind(event.event_id, after, SHARED_CHANGE_PAGE_SIZE + 1)
    .all<ActivityRow & { name: string | null; position: number | null }>();
  const hasMore = result.results.length > SHARED_CHANGE_PAGE_SIZE;
  const page = result.results.slice(0, SHARED_CHANGE_PAGE_SIZE);
  return noStoreJson({
    event: {
      eventId: event.event_id, fileName: event.file_name, total: event.total,
      eventName: event.event_name || defaultEventName(event.file_name),
      cursor: page.at(-1)?.id ?? Math.max(after, cursorRow?.cursor ?? 0),
      hasMore, cue,
      changes: page.map((row) => ({
        id: `guest-${row.position ?? row.id}`,
        name: publicProjectionName(row.name, event.projection_privacy),
        checkedInAt: row.outcome === "undo" ? null : row.checked_in_at,
        activityId: row.id,
      })),
    },
  });
}

export async function GET(request: Request) {
  try {
    const database = getD1();
    await ensureSchema(database);
    await purgeExpiredEvents(database);
    const url = new URL(request.url);
    switch (url.searchParams.get("mode")) {
      case "lane": return handleLaneGet(request, url, database);
      case "lanes": return handleLaneListGet(request, url, database);
      case "admin_summary": return handleAdminSummaryGet(request, url, database);
      case "events": return handleEventHistoryGet(request, database);
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
