import type { LiveEventSnapshot, ProjectionCueType } from "../../checkin-core";
import { getD1 } from "../../../db";

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

async function readSnapshot(database: D1Database): Promise<LiveEventSnapshot | null> {
  await ensureLiveEventTable(database);
  const row = await database
    .prepare("SELECT snapshot_json FROM live_event_state WHERE id = ?")
    .bind(LIVE_EVENT_ID)
    .first<{ snapshot_json: string }>();
  if (!row?.snapshot_json) return null;
  try {
    return JSON.parse(row.snapshot_json) as LiveEventSnapshot;
  } catch {
    return null;
  }
}

async function writeSnapshot(database: D1Database, snapshot: LiveEventSnapshot) {
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

function cleanSnapshot(
  value: unknown,
  currentSnapshot: LiveEventSnapshot | null,
): LiveEventSnapshot | null {
  if (!value || typeof value !== "object") return null;
  const input = value as Partial<LiveEventSnapshot>;
  if (
    typeof input.eventId !== "string" ||
    typeof input.fileName !== "string" ||
    typeof input.total !== "number" ||
    !Number.isInteger(input.total) ||
    input.total < 0 ||
    input.total > 200 ||
    !Array.isArray(input.attendees) ||
    input.attendees.length > 200
  ) {
    return null;
  }

  const attendees = input.attendees.flatMap((attendee) => {
    if (!attendee || typeof attendee !== "object") return [];
    const item = attendee as { id?: unknown; name?: unknown; checkedInAt?: unknown };
    if (typeof item.id !== "string" || typeof item.name !== "string") return [];
    if (item.checkedInAt !== null && typeof item.checkedInAt !== "string") return [];
    return [{
      id: item.id.slice(0, 500),
      name: item.name.slice(0, 120),
      checkedInAt: item.checkedInAt,
    }];
  });

  if (attendees.length !== input.attendees.length || attendees.length > input.total) return null;
  return {
    eventId: input.eventId.slice(0, 200),
    fileName: input.fileName.slice(0, 240),
    total: input.total,
    updatedAt: new Date().toISOString(),
    attendees,
    cue: currentSnapshot?.eventId === input.eventId ? currentSnapshot.cue : undefined,
  };
}

export async function GET() {
  try {
    return noStoreJson({ snapshot: await readSnapshot(getD1()) });
  } catch {
    return noStoreJson({ error: "live_state_unavailable" }, { status: 500 });
  }
}

export async function PUT(request: Request) {
  const contentLength = Number(request.headers.get("content-length") ?? 0);
  if (contentLength > 200_000) return noStoreJson({ error: "payload_too_large" }, { status: 413 });
  try {
    const database = getD1();
    const snapshot = cleanSnapshot(
      await request.json().catch(() => null),
      await readSnapshot(database),
    );
    if (!snapshot) return noStoreJson({ error: "invalid_snapshot" }, { status: 400 });
    await writeSnapshot(database, snapshot);
    return noStoreJson({ ok: true, updatedAt: snapshot.updatedAt });
  } catch {
    return noStoreJson({ error: "live_state_unavailable" }, { status: 500 });
  }
}

export async function PATCH(request: Request) {
  try {
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

export async function DELETE() {
  try {
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
