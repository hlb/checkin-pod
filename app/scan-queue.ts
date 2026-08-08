export const MAX_PENDING_SCANS = 100;

export type PendingScan = {
  code: string;
  scannedAt: string;
  requestId: string;
};

const STORAGE_PREFIX = "checkin-pod-pending-scans";

export function scanQueueKey(eventId: string, laneId: string) {
  return `${STORAGE_PREFIX}:${eventId}:${laneId}`;
}

export function parsePendingScans(raw: string | null): PendingScan[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.slice(0, MAX_PENDING_SCANS).flatMap((item) => {
      if (!item || typeof item !== "object") return [];
      const value = item as Partial<PendingScan>;
      if (typeof value.code !== "string" || typeof value.scannedAt !== "string" || typeof value.requestId !== "string") {
        return [];
      }
      const code = value.code.trim().slice(0, 2048);
      const requestId = value.requestId.trim().slice(0, 128);
      if (!code || !requestId || Number.isNaN(new Date(value.scannedAt).getTime())) return [];
      return [{ code, scannedAt: new Date(value.scannedAt).toISOString(), requestId }];
    });
  } catch {
    return [];
  }
}

export function appendPendingScan(queue: PendingScan[], pending: PendingScan) {
  if (queue.length >= MAX_PENDING_SCANS) return false;
  queue.push(pending);
  return true;
}
