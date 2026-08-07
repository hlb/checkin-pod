import type { ProjectionCueType } from "../../checkin-core";
import { hasValidAdminSession, sha256Hex } from "../../admin-auth";
import {
  cleanLiveEventSnapshot,
  isLiveEventWriterAuthorized,
  isStaleLiveEventSnapshot,
  toPublicLiveEventSnapshot,
} from "../../live-event-policy";
import type { StoredLiveEventSnapshot } from "../../live-event-policy";
import { getD1 } from "../../../db";
import { env } from "cloudflare:workers";

const LIVE_EVENT_ID = 1;
const LIVE_EVENT_SCHEMA = `CREATE TABLE IF NOT EXISTS live_event_state (
  id INTEGER PRIMARY KEY,
  snapshot_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
)`;

function noStoreJson(body: unknown, init?: ResponseInit) {
  const headers = new Headers(init?.headers);
  headers.set("cache-control", "no-store, max-age=0");
  headers.set("content-type", "application/json; charset=utf-8");
  return new Response(JSON.stringify(body), { ...init, headers });
}

async function ensureLiveEventTable(database: D1Database) {
  await database.prepare(LIVE_EVENT_SCHEMA).run();
}

async function readSnapshot(database: D1Database): Promise<StoredLiveEventSnapshot | null> {
  await ensureLiveEventTable(database);
  const row = await database
    .prepare("SELECT snapshot_json FROM live_event_state WHERE id = ?")
    .bind(LIVE_EVENT_ID)
    .first<{ snapshot_json: string }>();
  if (!row?.snapshot_json) return null;
  try {
    return JSON.parse(row.snapshot_json) as StoredLiveEventSnapshot;
  } catch {
    return null;
  }
}

async function writeSnapshot(database: D1Database, snapshot: StoredLiveEventSnapshot) {
  await ensureLiveEventTable(database);
  await database
    .prepare(`INSERT INTO live_event_state (id, snapshot_json, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        snapshot_json = excluded.snapshot_json,
        updated_at = excluded.updated_at`)
    .bind(LIVE_EVENT_ID, JSON.stringify(snapshot), snapshot.updatedAt)
    .run();
}

async function writeSnapshotIfFresh(database: D1Database, snapshot: StoredLiveEventSnapshot) {
  await ensureLiveEventTable(database);
  const result = await database
    .prepare(`INSERT INTO live_event_state (id, snapshot_json, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        snapshot_json = excluded.snapshot_json,
        updated_at = excluded.updated_at
      WHERE json_extract(live_event_state.snapshot_json, '$.eventId') IS NULL
        OR json_extract(live_event_state.snapshot_json, '$.eventId') <> ?
        OR COALESCE(CAST(json_extract(live_event_state.snapshot_json, '$.revision') AS INTEGER), 0) <= ?`)
    .bind(
      LIVE_EVENT_ID,
      JSON.stringify(snapshot),
      snapshot.updatedAt,
      snapshot.eventId,
      snapshot.revision,
    )
    .run();
  return (result.meta?.changes ?? 1) > 0;
}

function adminPassword() {
  return (env as unknown as { ADMIN_PASSWORD?: string }).ADMIN_PASSWORD;
}

async function isAuthorizedWriter(
  request: Request,
  current: StoredLiveEventSnapshot | null,
  incomingEventId: string,
) {
  const isAdmin = await hasValidAdminSession(request, adminPassword());
  const suppliedToken = request.headers.get("x-event-writer-token")?.slice(0, 256) ?? "";
  if (!current || current.eventId !== incomingEventId) {
    return { authorized: isAdmin, isAdmin, suppliedToken };
  }
  if (isAdmin) return { authorized: true, isAdmin, suppliedToken };
  if (!current.writerTokenHash || !suppliedToken) {
    return { authorized: false, isAdmin, suppliedToken };
  }
  const suppliedHash = suppliedToken ? await sha256Hex(suppliedToken) : "";
  return {
    authorized: isLiveEventWriterAuthorized({
      current,
      incomingEventId,
      isAdmin,
      suppliedTokenHash: suppliedHash,
    }),
    isAdmin,
    suppliedToken,
  };
}

export async function GET() {
  try {
    return noStoreJson({ snapshot: toPublicLiveEventSnapshot(await readSnapshot(getD1())) });
  } catch {
    return noStoreJson({ error: "live_state_unavailable" }, { status: 500 });
  }
}

export async function PUT(request: Request) {
  const contentLength = Number(request.headers.get("content-length") ?? 0);
  if (contentLength > 200_000) return noStoreJson({ error: "payload_too_large" }, { status: 413 });
  try {
    const database = getD1();
    const current = await readSnapshot(database);
    const snapshot = cleanLiveEventSnapshot(await request.json().catch(() => null), current);
    if (!snapshot) return noStoreJson({ error: "invalid_snapshot" }, { status: 400 });
    const writer = await isAuthorizedWriter(request, current, snapshot.eventId);
    if (!writer.authorized) return noStoreJson({ error: "unauthorized" }, { status: 401 });
    if (isStaleLiveEventSnapshot(current, snapshot)) {
      return noStoreJson({ ok: true, stale: true, updatedAt: current?.updatedAt });
    }
    const writerTokenHash = writer.isAdmin && writer.suppliedToken
      ? await sha256Hex(writer.suppliedToken)
      : current?.eventId === snapshot.eventId
        ? current.writerTokenHash
        : undefined;
    const written = await writeSnapshotIfFresh(database, { ...snapshot, writerTokenHash });
    if (!written) {
      const latest = await readSnapshot(database);
      return noStoreJson({ ok: true, stale: true, updatedAt: latest?.updatedAt });
    }
    return noStoreJson({ ok: true, updatedAt: snapshot.updatedAt });
  } catch {
    return noStoreJson({ error: "live_state_unavailable" }, { status: 500 });
  }
}

export async function PATCH(request: Request) {
  try {
    if (!(await hasValidAdminSession(request, adminPassword()))) {
      return noStoreJson({ error: "unauthorized" }, { status: 401 });
    }
    const database = getD1();
    const snapshot = await readSnapshot(database);
    if (!snapshot) return noStoreJson({ error: "no_live_event" }, { status: 409 });
    const body = (await request.json().catch(() => null)) as { type?: unknown } | null;
    if (body?.type !== "boarding" && body?.type !== "celebration") {
      return noStoreJson({ error: "invalid_cue" }, { status: 400 });
    }
    const type = body.type as ProjectionCueType;
    const at = new Date().toISOString();
    const cue = { id: `${Date.now()}-${crypto.randomUUID()}`, type, at };
    await writeSnapshot(database, { ...snapshot, updatedAt: at, cue });
    return noStoreJson({ ok: true, cue });
  } catch {
    return noStoreJson({ error: "live_state_unavailable" }, { status: 500 });
  }
}

export async function DELETE(request: Request) {
  try {
    if (!(await hasValidAdminSession(request, adminPassword()))) {
      return noStoreJson({ error: "unauthorized" }, { status: 401 });
    }
    const database = getD1();
    await ensureLiveEventTable(database);
    await database
      .prepare("DELETE FROM live_event_state WHERE id = ?")
      .bind(LIVE_EVENT_ID)
      .run();
    return noStoreJson({ ok: true });
  } catch {
    return noStoreJson({ error: "live_state_unavailable" }, { status: 500 });
  }
}
