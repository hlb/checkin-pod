export const MAX_SHARED_ATTENDEES = 10_000;
export const MAX_SHARED_LANES = 100;
export const SHARED_IMPORT_CHUNK_SIZE = 200;
export const SHARED_CHANGE_PAGE_SIZE = 500;

export function defaultEventName(fileName: string) {
  return fileName.replace(/\.csv$/i, "").trim() || "未命名活動";
}

export function eventDeletionConfirmation(eventId: string) {
  return eventId;
}

export function isEventDeletionConfirmed(eventId: string, confirmation: string) {
  return confirmation === eventDeletionConfirmation(eventId);
}

export function publicProjectionName(name: string | null, privacy: ProjectionPrivacy) {
  if (privacy === "count") return "來賓";
  const characters = [...(name?.trim() ?? "")];
  if (privacy === "names") return characters.join("") || "來賓";
  if (characters.length <= 1) return "來賓";
  if (characters.length === 2) return `${characters[0]}○`;
  return `${characters[0]}${"○".repeat(Math.min(2, characters.length - 2))}${characters.at(-1)}`;
}

export function chunkItems<T>(items: T[], size = SHARED_IMPORT_CHUNK_SIZE) {
  if (!Number.isInteger(size) || size < 1) throw new Error("chunk size must be a positive integer");
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) chunks.push(items.slice(index, index + size));
  return chunks;
}

export function assertSharedCapacity(count: number) {
  if (!Number.isInteger(count) || count < 1 || count > MAX_SHARED_ATTENDEES) {
    throw new Error(`活動需要 1 到 ${MAX_SHARED_ATTENDEES.toLocaleString()} 位可報到來賓。`);
  }
}
import type { ProjectionPrivacy } from "./checkin-core.ts";
