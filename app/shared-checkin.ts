import type {
  Attendee,
  DisplaySettings,
  LastScan,
  ProjectionCue,
  ProjectionCueType,
  SavedEvent,
} from "./checkin-core.ts";
import {
  MAX_SHARED_ATTENDEES,
  assertSharedCapacity,
  chunkItems,
} from "./shared-checkin-policy.ts";
export {
  MAX_SHARED_ATTENDEES,
  SHARED_CHANGE_PAGE_SIZE,
  SHARED_IMPORT_CHUNK_SIZE,
  assertSharedCapacity,
  chunkItems,
} from "./shared-checkin-policy.ts";

export type SharedEventConnection = {
  eventId: string;
  laneId: string;
  laneName: string;
  laneToken: string;
  cursor: number;
};

export type SharedLaneSession = Pick<SharedEventConnection, "eventId" | "laneId" | "laneName" | "laneToken">;

export type SharedEventMetadata = {
  eventId: string;
  fileName: string;
  headers: string[];
  selectedFields: string[];
  backgroundColor: string;
  total: number;
  laneName: string;
};

export type SharedChange = {
  id: number;
  attendeeId: string | null;
  outcome: "success" | "duplicate" | "unknown" | "undo";
  checkedInAt: string | null;
  occurredAt: string;
  laneName?: string;
};

export type SharedScanResult = {
  kind: LastScan["kind"];
  attendee?: Attendee;
  code?: string;
  at: string;
  laneName?: string;
  cursor: number;
};

export type SharedLane = {
  laneId: string;
  laneName: string;
  laneToken: string;
  url: string;
};

type JsonResponse = Record<string, unknown>;

async function apiJson<T extends JsonResponse>(input: RequestInfo | URL, init?: RequestInit) {
  const response = await fetch(input, init);
  const body = await response.json().catch(() => ({})) as T & { error?: string };
  if (!response.ok) {
    const messages: Record<string, string> = {
      unauthorized: "工作站授權失效，請由中控台重新建立工作站連結。",
      event_not_ready: "活動名單尚未完成同步，請稍後再試。",
      event_not_found: "找不到這場活動，請重新匯入名單。",
      attendee_limit_exceeded: `活動最多支援 ${MAX_SHARED_ATTENDEES.toLocaleString()} 位來賓。`,
      duplicate_scan_key: "名單中有重複的 QR Code 或報到碼，請修正 CSV 後再匯入。",
      invalid_payload: "傳送的活動資料格式不正確。",
    };
    throw new Error(messages[body.error ?? ""] ?? "無法連線到共用報到服務，請檢查網路後再試一次。");
  }
  return body;
}

export async function importSharedEvent(
  event: SavedEvent,
  onProgress?: (uploaded: number, total: number) => void,
): Promise<SharedEventConnection> {
  assertSharedCapacity(event.attendees.length);
  const beginning = await apiJson<{
    eventId: string;
    laneId: string;
    laneName: string;
    laneToken: string;
  }>("/api/shared-checkin", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      action: "begin_import",
      fileName: event.fileName,
      headers: event.headers,
      selectedFields: event.displaySettings?.selectedFields ?? [],
      backgroundColor: event.displaySettings?.backgroundColor ?? "#0E0F12",
      expectedTotal: event.attendees.length,
    }),
  });

  let uploaded = 0;
  for (const chunk of chunkItems(event.attendees)) {
    await apiJson<{ ok: true }>("/api/shared-checkin", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        action: "upload_chunk",
        eventId: beginning.eventId,
        attendees: chunk.map((attendee, chunkIndex) => ({
          ...attendee,
          position: uploaded + chunkIndex,
        })),
      }),
    });
    uploaded += chunk.length;
    onProgress?.(uploaded, event.attendees.length);
  }

  const finalized = await apiJson<{ cursor: number }>("/api/shared-checkin", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action: "finalize_import", eventId: beginning.eventId }),
  });
  return { ...beginning, cursor: finalized.cursor };
}

export async function readSharedLane(session: SharedLaneSession) {
  const query = new URLSearchParams({
    mode: "lane",
    eventId: session.eventId,
    laneId: session.laneId,
    token: session.laneToken,
  });
  return apiJson<{ event: SharedEventMetadata }>(`/api/shared-checkin?${query}`).then((body) => body.event);
}

export async function scanSharedEvent(
  session: SharedLaneSession,
  code: string,
  scannedAt = new Date().toISOString(),
  requestId = crypto.randomUUID(),
) {
  return apiJson<SharedScanResult & JsonResponse>("/api/shared-checkin", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action: "scan", ...session, code, scannedAt, requestId }),
  });
}

export async function setSharedAttendeeCheckIn(
  eventId: string,
  attendeeId: string,
  checkedInAt: string | null,
) {
  return apiJson<{ attendee: Attendee; cursor: number }>("/api/shared-checkin", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      action: "set_attendee",
      eventId,
      attendeeId,
      checkedInAt,
      requestId: crypto.randomUUID(),
    }),
  });
}

export async function fetchSharedChanges(eventId: string, after: number) {
  const query = new URLSearchParams({ mode: "changes", eventId, after: String(after) });
  return apiJson<{
    changes: SharedChange[];
    cursor: number;
    hasMore: boolean;
    arrived: number;
    total: number;
  }>(`/api/shared-checkin?${query}`);
}

export function applySharedChanges(event: SavedEvent, changes: SharedChange[], cursor: number): SavedEvent {
  if (!event.sharedEvent || !changes.length && cursor === event.sharedEvent.cursor) return event;
  const states = new Map<string, string | null>();
  for (const change of changes) {
    if (!change.attendeeId) continue;
    if (change.outcome === "success" || change.outcome === "undo") {
      states.set(change.attendeeId, change.checkedInAt);
    }
  }
  const latest = changes.at(-1);
  const lastScan: LastScan | undefined = latest
    ? latest.outcome === "unknown"
      ? { kind: "unknown", at: latest.occurredAt }
      : latest.attendeeId && latest.outcome !== "undo"
        ? {
            kind: latest.outcome === "success" ? "success" : "duplicate",
            attendeeId: latest.attendeeId,
            at: latest.occurredAt,
          }
        : event.lastScan
    : event.lastScan;
  return {
    ...event,
    revision: (event.revision ?? 0) + Math.max(1, changes.length),
    lastScan,
    sharedEvent: { ...event.sharedEvent, cursor },
    attendees: states.size
      ? event.attendees.map((attendee) => states.has(attendee.id)
        ? { ...attendee, checkedInAt: states.get(attendee.id) ?? null }
        : attendee)
      : event.attendees,
  };
}

export function applySharedScanResult(event: SavedEvent, result: SharedScanResult): SavedEvent {
  if (!event.sharedEvent) return event;
  const attendeeId = result.attendee?.id;
  const nextAttendees = attendeeId && result.kind === "success"
    ? event.attendees.map((attendee) => attendee.id === attendeeId
      ? { ...attendee, checkedInAt: result.attendee?.checkedInAt ?? result.at }
      : attendee)
    : event.attendees;
  return {
    ...event,
    revision: (event.revision ?? 0) + 1,
    // The response cursor may skip activities created by other lanes just before this scan.
    // Only the ordered changes feed is allowed to advance the reconciliation cursor.
    sharedEvent: event.sharedEvent,
    lastScan: result.kind === "unknown"
      ? { kind: "unknown", code: result.code, at: result.at }
      : attendeeId
        ? { kind: result.kind, attendeeId, at: result.at }
        : event.lastScan,
    attendees: nextAttendees,
  };
}

export async function createSharedLane(eventId: string, laneName: string) {
  const lane = await apiJson<Omit<SharedLane, "url">>("/api/shared-checkin", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action: "create_lane", eventId, laneName }),
  });
  const query = new URLSearchParams({ event: eventId, lane: lane.laneId, token: lane.laneToken });
  return { ...lane, url: `${window.location.origin}/scan?${query}` };
}

export async function updateSharedSettings(eventId: string, settings: DisplaySettings) {
  await apiJson<{ ok: true }>("/api/shared-checkin", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action: "update_settings", eventId, settings }),
  });
}

export async function sendSharedProjectionCue(eventId: string, type: ProjectionCueType) {
  return apiJson<{ cue: ProjectionCue }>("/api/shared-checkin", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action: "cue", eventId, type }),
  });
}

export async function deleteSharedEvent(eventId: string) {
  await apiJson<{ ok: true }>("/api/shared-checkin", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action: "delete_event", eventId }),
  });
}
