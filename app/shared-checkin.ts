import type {
  Attendee,
  CheckInMode,
  DisplaySettings,
  LastScan,
  ProjectionPrivacy,
  ProjectionCue,
  ProjectionCueType,
  SavedEvent,
} from "./checkin-core.ts";
import { attendeeForServerImport } from "./checkin-core.ts";
import {
  MAX_SHARED_ATTENDEES,
  MAX_SHARED_LANES,
  assertSharedCapacity,
  chunkItems,
  defaultEventName,
} from "./shared-checkin-policy.ts";
export {
  MAX_SHARED_ATTENDEES,
  MAX_SHARED_LANES,
  SHARED_CHANGE_PAGE_SIZE,
  SHARED_IMPORT_CHUNK_SIZE,
  assertSharedCapacity,
  chunkItems,
  defaultEventName,
  eventDeletionConfirmation,
} from "./shared-checkin-policy.ts";

export type SharedEventConnection = {
  eventId: string;
  laneId: string;
  laneName: string;
  cursor: number;
  /** @deprecated Legacy browser records use this once to exchange an HttpOnly lane session. */
  laneToken?: string;
};

export type SharedLaneSession = Pick<SharedEventConnection, "eventId" | "laneId" | "laneName">;

export type SharedLaneBootstrap = SharedLaneSession & { laneToken: string };

export type SharedEventMetadata = {
  eventId: string;
  fileName: string;
  eventName: string;
  headers: string[];
  selectedFields: string[];
  backgroundColor: string;
  projectionPrivacy: ProjectionPrivacy;
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
  attendee?: SharedAttendeeResult;
  code?: string;
  at: string;
  laneName?: string;
  cursor: number;
};

export type SharedAttendeeResult = Pick<Attendee, "id" | "name" | "checkedInAt"> & {
  displayValues: Record<string, string>;
};

export type SharedLane = {
  eventId: string;
  laneId: string;
  laneName: string;
  laneToken: string;
  url: string;
};

export type SharedLaneRecord = {
  laneId: string;
  laneName: string;
  createdAt: string;
  lastSeenAt: string | null;
  revokedAt: string | null;
  successCount: number;
};

export type SharedAdminEventMetadata = {
  eventId: string;
  fileName: string;
  eventName: string;
  importedAt: string;
  headers: string[];
  selectedFields: string[];
  backgroundColor: string;
  projectionPrivacy: ProjectionPrivacy;
  total: number;
  cursor: number;
  syncMode: CheckInMode;
  expiresAt: string;
};

export type SharedEventHistoryItem = {
  eventId: string;
  fileName: string;
  eventName: string;
  importedAt: string;
  updatedAt: string;
  total: number;
  arrived: number;
  active: boolean;
  syncMode: CheckInMode;
  expiresAt: string;
};

export class SharedApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(
    message: string,
    status: number,
    code: string,
  ) {
    super(message);
    this.name = "SharedApiError";
    this.status = status;
    this.code = code;
  }

}

type JsonResponse = Record<string, unknown>;
let adminInitialization: Promise<void> | null = null;

async function apiJson<T extends JsonResponse>(input: RequestInfo | URL, init?: RequestInit) {
  let response: Response;
  try {
    response = await fetch(input, init);
  } catch {
    throw new SharedApiError("網路連線中斷，這次掃描尚未送出。請恢復連線後重新掃描。", 0, "network_error");
  }
  const body = await response.json().catch(() => ({})) as T & { error?: string };
  if (!response.ok) {
    const messages: Record<string, string> = {
      unauthorized: "工作站授權失效，請由中控台重新建立工作站連結。",
      event_not_ready: "活動名單尚未準備完成，請稍後再試。",
      event_not_found: "找不到這場活動，請重新匯入名單。",
      attendee_limit_exceeded: `活動最多支援 ${MAX_SHARED_ATTENDEES.toLocaleString()} 位來賓。`,
      duplicate_scan_key: "名單中有重複的 QR Code、票號或報到碼，請修正名單後再匯入。",
      invalid_payload: "傳送的活動資料格式不正確。",
      deletion_confirmation_mismatch: "Event ID 不正確，活動尚未刪除。",
      lane_not_found: "找不到這個工作站。",
      lane_limit_exceeded: `每場活動最多支援 ${MAX_SHARED_LANES} 個工作站。`,
    };
    const code = body.error ?? "unknown_error";
    throw new SharedApiError(
      messages[code] ?? "無法連線到共用報到服務，請檢查網路後再試一次。",
      response.status,
      code,
    );
  }
  return body;
}

export function initializeSharedCheckin() {
  if (!adminInitialization) {
    adminInitialization = apiJson<{ ok: true }>("/api/shared-checkin", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "initialize" }),
    }).then(() => undefined).catch((error) => {
      adminInitialization = null;
      throw error;
    });
  }
  return adminInitialization;
}

export async function importSharedEvent(
  event: SavedEvent,
  onProgress?: (uploaded: number, total: number) => void,
  syncMode: CheckInMode = "multi",
): Promise<SharedEventConnection> {
  assertSharedCapacity(event.attendees.length);
  const beginning = await apiJson<{
    eventId: string;
    laneId: string;
    laneName: string;
  }>("/api/shared-checkin", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      action: "begin_import",
      fileName: event.fileName,
      eventName: event.eventName ?? defaultEventName(event.fileName),
      headers: event.headers,
      selectedFields: event.displaySettings?.selectedFields ?? [],
      backgroundColor: event.displaySettings?.backgroundColor ?? "#0E0F12",
      projectionPrivacy: event.displaySettings?.projectionPrivacy ?? "count",
      retentionDays: 30,
      expectedTotal: event.attendees.length,
      syncMode,
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
        attendees: chunk.map((attendee, chunkIndex) => attendeeForServerImport(
          attendee,
          event.displaySettings?.selectedFields ?? [],
          uploaded + chunkIndex,
        )),
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
  return apiJson<{ event: SharedEventMetadata }>("/api/shared-checkin", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action: "lane_heartbeat", eventId: session.eventId, laneId: session.laneId }),
  }).then((body) => body.event);
}

export async function activateSharedLane(session: SharedLaneBootstrap) {
  return apiJson<{ event: SharedEventMetadata }>("/api/shared-checkin", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      action: "activate_lane",
      eventId: session.eventId,
      laneId: session.laneId,
      laneToken: session.laneToken,
    }),
  }).then((body) => body.event);
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
    body: JSON.stringify({
      action: "scan",
      eventId: session.eventId,
      laneId: session.laneId,
      code,
      scannedAt,
      requestId,
    }),
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
  await initializeSharedCheckin();
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

function laneUrl(eventId: string, laneId: string, laneToken: string) {
  const query = new URLSearchParams({ event: eventId, lane: laneId, token: laneToken });
  return `${window.location.origin}/scan#${query}`;
}

export async function createSharedLane(eventId: string, laneName: string) {
  const lane = await apiJson<Omit<SharedLane, "url">>("/api/shared-checkin", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action: "create_lane", eventId, laneName }),
  });
  return { ...lane, eventId, url: laneUrl(eventId, lane.laneId, lane.laneToken) };
}

export async function fetchSharedLanes(eventId: string) {
  await initializeSharedCheckin();
  const query = new URLSearchParams({ mode: "lanes", eventId });
  return apiJson<{ lanes: SharedLaneRecord[] }>(`/api/shared-checkin?${query}`).then((body) => body.lanes);
}

export async function revokeSharedLane(eventId: string, laneId: string) {
  return apiJson<{ ok: true; revokedAt: string }>("/api/shared-checkin", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action: "revoke_lane", eventId, laneId }),
  });
}

export async function renameSharedLane(eventId: string, laneId: string, laneName: string) {
  return apiJson<{ ok: true; laneName: string }>("/api/shared-checkin", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action: "rename_lane", eventId, laneId, laneName }),
  });
}

export async function rotateSharedLane(eventId: string, laneId: string) {
  const lane = await apiJson<Omit<SharedLane, "url">>("/api/shared-checkin", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action: "rotate_lane", eventId, laneId }),
  });
  return { ...lane, eventId, url: laneUrl(eventId, lane.laneId, lane.laneToken) };
}

export async function fetchActiveSharedEventSummary(eventId = "") {
  await initializeSharedCheckin();
  const query = new URLSearchParams({ mode: "admin_summary" });
  if (eventId) query.set("eventId", eventId);
  return apiJson<{ event: SharedAdminEventMetadata | null }>(`/api/shared-checkin?${query}`)
    .then((body) => body.event);
}

export async function fetchSharedEventHistory() {
  await initializeSharedCheckin();
  return apiJson<{ events: SharedEventHistoryItem[] }>("/api/shared-checkin?mode=events")
    .then((body) => body.events);
}

export async function setSharedEventActive(eventId: string, active: boolean) {
  await apiJson<{ ok: true }>("/api/shared-checkin", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action: active ? "activate_event" : "deactivate_event", eventId }),
  });
}

export async function renameSharedEvent(eventId: string, eventName: string) {
  return apiJson<{ ok: true; eventName: string }>("/api/shared-checkin", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action: "rename_event", eventId, eventName }),
  });
}

export async function fetchSharedRosterPage(eventId = "", afterPosition = -1) {
  await initializeSharedCheckin();
  const query = new URLSearchParams({ mode: "roster", afterPosition: String(afterPosition), limit: "500" });
  if (eventId) query.set("eventId", eventId);
  return apiJson<{
    event: SharedAdminEventMetadata | null;
    attendees: Attendee[];
    hasMore: boolean;
    nextPosition: number;
  }>(`/api/shared-checkin?${query}`);
}

export async function fetchCompleteSharedRoster(eventId = "") {
  let afterPosition = -1;
  let metadata: SharedAdminEventMetadata | null = null;
  const attendees: Attendee[] = [];
  let hasMore = true;
  while (hasMore) {
    const page = await fetchSharedRosterPage(eventId || metadata?.eventId || "", afterPosition);
    if (!page.event) return { event: null, attendees: [] };
    metadata = page.event;
    attendees.push(...page.attendees);
    if (page.hasMore && page.nextPosition <= afterPosition) {
      throw new SharedApiError("伺服器名單分頁無法繼續，請重新整理後再試一次。", 500, "invalid_roster_cursor");
    }
    afterPosition = page.nextPosition;
    hasMore = page.hasMore;
  }
  return { event: metadata, attendees };
}

export async function restoreSharedEvent(eventId = ""): Promise<SavedEvent | null> {
  const restored = await fetchCompleteSharedRoster(eventId);
  if (!restored.event) return null;
  const lane = await createSharedLane(
    restored.event.eventId,
    restored.event.syncMode === "single" ? "單機中控台" : "復原中控台",
  );
  await activateSharedLane(lane);
  return {
    version: 1,
    fileName: restored.event.fileName,
    eventName: restored.event.eventName,
    importedAt: restored.event.importedAt,
    headers: restored.event.headers,
    attendees: restored.attendees,
    sourceRowCount: restored.event.total,
    excludedRowCount: 0,
    displaySettings: {
      selectedFields: restored.event.selectedFields,
      backgroundColor: restored.event.backgroundColor,
      projectionPrivacy: restored.event.projectionPrivacy,
    },
    revision: restored.event.cursor,
    checkInMode: restored.event.syncMode,
    sharedEvent: {
      eventId: restored.event.eventId,
      laneId: lane.laneId,
      laneName: lane.laneName,
      cursor: restored.event.cursor,
    },
  };
}

export async function restoreActiveSharedEvent() {
  return restoreSharedEvent();
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

export async function deleteSharedEvent(eventId: string, confirmation: string) {
  await apiJson<{ ok: true }>("/api/shared-checkin", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action: "delete_event", eventId, confirmation }),
  });
}
