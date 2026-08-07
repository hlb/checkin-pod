export type OriginalRow = Record<string, string>;

export type Attendee = {
  id: string;
  name: string;
  email: string;
  phone: string;
  ticket: string;
  approvalStatus: string;
  qrValue: string;
  scanKeys: string[];
  checkedInAt: string | null;
  original: OriginalRow;
};

export type LastScan = {
  kind: "success" | "duplicate" | "unknown";
  attendeeId?: string;
  code?: string;
  at: string;
};

export type DisplaySettings = {
  selectedFields: string[];
  backgroundImageDataUrl?: string;
  backgroundColor?: string;
};

export type SavedEvent = {
  version: 1;
  fileName: string;
  importedAt: string;
  headers: string[];
  attendees: Attendee[];
  sourceRowCount?: number;
  excludedRowCount?: number;
  displaySettings?: DisplaySettings;
  lastScan?: LastScan;
};

export type ProjectionCueType = "boarding" | "celebration";

export type ProjectionCue = {
  id: string;
  type: ProjectionCueType;
  at: string;
};

export type LiveEventSnapshot = {
  eventId: string;
  fileName: string;
  total: number;
  updatedAt: string;
  attendees: Array<Pick<Attendee, "id" | "name" | "checkedInAt">>;
  cue?: ProjectionCue;
};

export const CHANNEL_NAME = "arrival-checkin-sync";
const DB_NAME = "arrival-checkin";
const DB_VERSION = 1;
const STORE_NAME = "events";
const CURRENT_EVENT_KEY = "current-event";

const FIELD_ALIASES = {
  name: ["name", "full_name", "guest_name", "attendee_name", "姓名", "名字"],
  firstName: ["first_name", "firstname", "given_name", "名"],
  lastName: ["last_name", "lastname", "family_name", "姓"],
  email: ["email", "email_address", "guest_email", "電子郵件", "信箱"],
  phone: ["phone", "phone_number", "mobile", "mobile_phone", "電話", "手機"],
  ticket: ["ticket_name", "ticket_type", "ticket", "票種", "票券"],
  approval: ["approval_status", "status", "guest_status", "報名狀態"],
  qr: [
    "qr_code_url",
    "qrcode_url",
    "qr_url",
    "qr_code",
    "qrcode",
    "check_in_url",
    "checkin_url",
    "ticket_key",
    "qr",
    "報到碼",
  ],
  checkedAt: ["checked_in_at", "check_in_at", "checkin_at", "check_in_time", "報到時間"],
  checked: ["checked_in", "check_in_status", "checkin_status", "已報到"],
  ticketId: ["ticket_api_id", "ticket_id", "guest_api_id", "guest_id", "id"],
} as const;

export function normalizeHeader(value: string) {
  return value
    .replace(/^\uFEFF/, "")
    .trim()
    .toLowerCase()
    .replace(/[\s\-/]+/g, "_")
    .replace(/[()]/g, "");
}

export function parseCsv(source: string): { headers: string[]; rows: OriginalRow[] } {
  const matrix: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;

  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    const next = source[index + 1];
    if (quoted) {
      if (char === '"' && next === '"') {
        cell += '"';
        index += 1;
      } else if (char === '"') {
        quoted = false;
      } else {
        cell += char;
      }
      continue;
    }
    if (char === '"' && cell.length === 0) quoted = true;
    else if (char === ",") {
      row.push(cell);
      cell = "";
    } else if (char === "\n" || char === "\r") {
      if (char === "\r" && next === "\n") index += 1;
      row.push(cell);
      if (row.some((value) => value.trim() !== "")) matrix.push(row);
      row = [];
      cell = "";
    } else cell += char;
  }

  if (quoted) throw new Error("CSV 中有未關閉的引號，請確認檔案是否完整。");
  row.push(cell);
  if (row.some((value) => value.trim() !== "")) matrix.push(row);
  if (matrix.length < 2) throw new Error("CSV 需要有標題列與至少一筆報名資料。");

  const headers = matrix[0].map((header, index) => {
    const clean = header.replace(/^\uFEFF/, "").trim();
    return clean || `column_${index + 1}`;
  });
  const rows = matrix.slice(1).map((values) =>
    Object.fromEntries(headers.map((header, index) => [header, values[index] ?? ""])),
  );
  return { headers, rows };
}

function getField(row: OriginalRow, aliases: readonly string[]) {
  const entries = Object.entries(row);
  for (const alias of aliases) {
    const match = entries.find(([header]) => normalizeHeader(header) === alias);
    if (match && match[1].trim()) return match[1].trim();
  }
  return "";
}

export function scanKeysFor(rawValue: string) {
  const raw = rawValue.trim().replace(/[\r\n]+$/g, "");
  if (!raw) return [];
  const keys = new Set<string>([raw.toLowerCase(), raw.replace(/\/$/, "").toLowerCase()]);
  try {
    const url = new URL(raw);
    const pk = url.searchParams.get("pk");
    if (pk) keys.add(pk.toLowerCase());
  } catch {
    const pkMatch = raw.match(/[?&]pk=([^&#]+)/i);
    if (pkMatch) {
      try {
        keys.add(decodeURIComponent(pkMatch[1]).toLowerCase());
      } catch {
        keys.add(pkMatch[1].toLowerCase());
      }
    }
  }
  return [...keys];
}

function looksChecked(value: string) {
  return ["true", "yes", "y", "1", "checked", "checked_in", "已報到"].includes(
    value.trim().toLowerCase(),
  );
}

export function toAttendees(rows: OriginalRow[], importedAt: string): Attendee[] {
  return rows.map((original, index) => {
    const firstName = getField(original, FIELD_ALIASES.firstName);
    const lastName = getField(original, FIELD_ALIASES.lastName);
    const name =
      getField(original, FIELD_ALIASES.name) ||
      [firstName, lastName].filter(Boolean).join(" ") ||
      `未命名來賓 ${index + 1}`;
    const email = getField(original, FIELD_ALIASES.email);
    const qrValue = getField(original, FIELD_ALIASES.qr);
    const checkedAt = getField(original, FIELD_ALIASES.checkedAt);
    const checkedValue = getField(original, FIELD_ALIASES.checked);
    const externalId = getField(original, FIELD_ALIASES.ticketId);
    const scanKeys = new Set(scanKeysFor(qrValue));
    if (email) scanKeys.add(email.toLowerCase());
    if (externalId) scanKeys.add(externalId.toLowerCase());
    return {
      id: `${externalId || qrValue || email || "guest"}-${index}`,
      name,
      email,
      phone: getField(original, FIELD_ALIASES.phone),
      ticket: getField(original, FIELD_ALIASES.ticket) || "一般票",
      approvalStatus: getField(original, FIELD_ALIASES.approval),
      qrValue,
      scanKeys: [...scanKeys],
      checkedInAt: checkedAt || (looksChecked(checkedValue) ? importedAt : null),
      original,
    };
  });
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE_NAME)) {
        request.result.createObjectStore(STORE_NAME);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export async function readSavedEvent(): Promise<SavedEvent | null> {
  const database = await openDatabase();
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(STORE_NAME, "readonly");
    const request = transaction.objectStore(STORE_NAME).get(CURRENT_EVENT_KEY);
    request.onsuccess = () => resolve((request.result as SavedEvent | undefined) ?? null);
    request.onerror = () => reject(request.error);
    transaction.oncomplete = () => database.close();
  });
}

export async function writeSavedEvent(event: SavedEvent) {
  const database = await openDatabase();
  return new Promise<void>((resolve, reject) => {
    const transaction = database.transaction(STORE_NAME, "readwrite");
    transaction.objectStore(STORE_NAME).put(event, CURRENT_EVENT_KEY);
    transaction.oncomplete = () => {
      database.close();
      resolve();
    };
    transaction.onerror = () => reject(transaction.error);
  });
}

export async function clearSavedEvent() {
  const database = await openDatabase();
  return new Promise<void>((resolve, reject) => {
    const transaction = database.transaction(STORE_NAME, "readwrite");
    transaction.objectStore(STORE_NAME).delete(CURRENT_EVENT_KEY);
    transaction.oncomplete = () => {
      database.close();
      resolve();
    };
    transaction.onerror = () => reject(transaction.error);
  });
}

export function broadcastEventChange() {
  if (typeof BroadcastChannel === "undefined") return;
  const channel = new BroadcastChannel(CHANNEL_NAME);
  channel.postMessage({ type: "event-changed", at: Date.now() });
  channel.close();
}

export function liveSnapshotFromEvent(event: SavedEvent): LiveEventSnapshot {
  return {
    eventId: event.importedAt,
    fileName: event.fileName,
    total: event.attendees.length,
    updatedAt: new Date().toISOString(),
    attendees: event.attendees
      .filter((attendee) => attendee.checkedInAt)
      .map(({ id, name, checkedInAt }) => ({ id, name, checkedInAt })),
  };
}

export async function publishLiveEvent(event: SavedEvent) {
  const response = await fetch("/api/live-event", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(liveSnapshotFromEvent(event)),
  });
  if (!response.ok) throw new Error("無法同步投影牆資料。");
}

export async function clearLiveEvent() {
  const response = await fetch("/api/live-event", { method: "DELETE" });
  if (!response.ok) throw new Error("無法清除投影牆資料。");
}

export async function publishProjectionCue(type: ProjectionCueType) {
  const response = await fetch("/api/live-event", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ type }),
  });
  if (!response.ok) throw new Error("活動資料尚未同步，請重新整理管理頁後再試一次。");
  return (await response.json()) as { cue: ProjectionCue };
}

export function defaultDisplayFields(headers: string[]) {
  const preferred = ["name", "ticket_name", "email"];
  const selected = preferred
    .map((wanted) => headers.find((header) => normalizeHeader(header) === wanted))
    .filter((header): header is string => Boolean(header));
  if (selected.length) return selected;
  return headers
    .filter((header) => !/qr|guest_id|ticket_id|checked_in_at/i.test(normalizeHeader(header)))
    .slice(0, 2);
}

export function getDisplayFields(event: SavedEvent) {
  const selected = event.displaySettings?.selectedFields.filter((field) => event.headers.includes(field));
  return selected?.length ? selected : defaultDisplayFields(event.headers);
}

export function displayValue(attendee: Attendee, field: string) {
  return attendee.original[field]?.trim() || "—";
}

export function labelForField(field: string) {
  const normalized = normalizeHeader(field);
  if (normalized === "name") return "姓名";
  if (normalized === "email") return "Email";
  if (normalized === "phone_number" || normalized === "phone") return "電話";
  if (normalized === "ticket_name" || normalized === "ticket_type") return "票種";
  return field;
}

export function csvEscape(value: string) {
  return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

export function formatTime(value: string | null, includeDate = false) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("zh-TW", {
    ...(includeDate ? { year: "numeric", month: "2-digit", day: "2-digit" } : {}),
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(date);
}

export function compactDate(value: Date) {
  return new Intl.DateTimeFormat("sv-SE", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  })
    .format(value)
    .replace(" ", "-")
    .replace(":", "");
}
