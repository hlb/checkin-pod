import { constantTimeEqual } from "./admin-auth.ts";
import type { LiveEventSnapshot } from "./checkin-core.ts";

export type StoredLiveEventSnapshot = LiveEventSnapshot & { writerTokenHash?: string };

export function cleanLiveEventSnapshot(
  value: unknown,
  currentSnapshot: StoredLiveEventSnapshot | null,
  now = new Date().toISOString(),
): StoredLiveEventSnapshot | null {
  if (!value || typeof value !== "object") return null;
  const input = value as Partial<LiveEventSnapshot>;
  if (
    typeof input.eventId !== "string" ||
    typeof input.fileName !== "string" ||
    typeof input.total !== "number" ||
    typeof input.revision !== "number" ||
    !Number.isInteger(input.revision) ||
    input.revision < 0 ||
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
    revision: input.revision,
    updatedAt: now,
    attendees,
    cue: currentSnapshot?.eventId === input.eventId ? currentSnapshot.cue : undefined,
  };
}

export function isLiveEventWriterAuthorized(options: {
  current: StoredLiveEventSnapshot | null;
  incomingEventId: string;
  isAdmin: boolean;
  suppliedTokenHash: string;
}) {
  const { current, incomingEventId, isAdmin, suppliedTokenHash } = options;
  if (!current || current.eventId !== incomingEventId) return isAdmin;
  if (isAdmin) return true;
  if (!current.writerTokenHash || !suppliedTokenHash) return false;
  return constantTimeEqual(suppliedTokenHash, current.writerTokenHash);
}

export function isStaleLiveEventSnapshot(
  current: StoredLiveEventSnapshot | null,
  incoming: StoredLiveEventSnapshot,
) {
  return current?.eventId === incoming.eventId && incoming.revision < (current.revision ?? 0);
}

export function toPublicLiveEventSnapshot(
  snapshot: StoredLiveEventSnapshot | null,
): LiveEventSnapshot | null {
  if (!snapshot) return null;
  const visible: StoredLiveEventSnapshot = { ...snapshot };
  delete visible.writerTokenHash;
  return visible;
}
