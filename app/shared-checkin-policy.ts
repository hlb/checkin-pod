export const MAX_SHARED_ATTENDEES = 10_000;
export const MAX_SHARED_LANES = 100;
export const SHARED_IMPORT_CHUNK_SIZE = 200;
export const SHARED_CHANGE_PAGE_SIZE = 500;

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
