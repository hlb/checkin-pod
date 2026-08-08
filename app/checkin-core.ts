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

export type ProjectionPrivacy = "count" | "masked" | "names";

export type DisplaySettings = {
  selectedFields: string[];
  /** @deprecated Background images are stored separately in IndexedDB. */
  backgroundImageDataUrl?: string;
  backgroundColor?: string;
  projectionPrivacy?: ProjectionPrivacy;
};

export type CheckInMode = "single" | "multi";

/** @deprecated Read only to migrate pre-online single-device events. */
export type LegacySingleSyncState = {
  eventId: string;
  cursor: number;
  lastSyncedAt: string;
  lastSyncedSignature: string;
};

export type SavedEvent = {
  version: 1;
  fileName: string;
  eventName?: string;
  importedAt: string;
  headers: string[];
  attendees: Attendee[];
  sourceRowCount?: number;
  excludedRowCount?: number;
  displaySettings?: DisplaySettings;
  lastScan?: LastScan;
  revision?: number;
  checkInMode?: CheckInMode;
  /** @deprecated Migrated to sharedEvent when the activity is opened. */
  singleSync?: LegacySingleSyncState;
  sharedEvent?: import("./shared-checkin").SharedEventConnection;
};

export type ScanOutcome = {
  kind: LastScan["kind"];
  attendee?: Attendee;
  code?: string;
  at: string;
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
  revision: number;
  updatedAt: string;
  attendees: Array<Pick<Attendee, "id" | "name" | "checkedInAt">>;
  cue?: ProjectionCue;
};

export const CHANNEL_NAME = "checkin-pod-event-changes";
const DB_NAME = "checkin-pod";
const LEGACY_DB_NAME = "arrival-checkin";
const DB_VERSION = 2;
const STORE_NAME = "events";
const ASSET_STORE_NAME = "assets";
const CURRENT_EVENT_KEY = "current-event";
const BACKGROUND_IMAGE_KEY = "guest-background";
const WRITE_LOCK_NAME = "checkin-pod-write";
let fallbackWriteQueue: Promise<void> = Promise.resolve();

const FIELD_ALIASES = {
  name: ["name", "full_name", "guest_name", "attendee_name", "姓名", "名字", "聯絡人_姓名"],
  firstName: ["first_name", "firstname", "given_name", "名"],
  lastName: ["last_name", "lastname", "family_name", "姓"],
  email: ["email", "email_address", "guest_email", "電子郵件", "信箱", "聯絡人_email"],
  phone: ["phone", "phone_number", "mobile", "mobile_phone", "電話", "手機", "聯絡人_手機"],
  ticket: ["ticket_name", "ticket_type", "ticket", "票種", "票券"],
  approval: ["approval_status", "status", "guest_status", "報名狀態", "票券付款狀態"],
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
    "qr_code_序號",
  ],
  checkedAt: ["checked_in_at", "check_in_at", "checkin_at", "check_in_time", "報到時間", "attendance_book"],
  checked: ["checked_in", "check_in_status", "checkin_status", "已報到"],
  ticketId: ["ticket_api_id", "ticket_id", "guest_api_id", "guest_id", "id"],
  alternateScanKeys: ["訂單編號", "報名序號", "檢查碼"],
} as const;

const ELIGIBLE_APPROVAL_STATUSES = new Set([
  "approved",
  "accepted",
  "going",
  "confirmed",
  "paid",
]);

export function normalizeHeader(value: string) {
  return value
    .replace(/^\uFEFF/, "")
    .trim()
    .toLowerCase()
    .replace(/[\s\-/]+/g, "_")
    .replace(/[()]/g, "");
}

const SERVER_OPERATIONAL_FIELDS = new Set(
  Object.values(FIELD_ALIASES).flat().map((field) => normalizeHeader(field)),
);

/** Keep only fields required for check-in or explicitly selected for staff display. */
export function minimizeOriginalRow(original: OriginalRow, selectedFields: string[]) {
  const selected = new Set(selectedFields.map((field) => normalizeHeader(field)));
  return Object.fromEntries(
    Object.entries(original).filter(([field]) => {
      const normalized = normalizeHeader(field);
      return SERVER_OPERATIONAL_FIELDS.has(normalized) || selected.has(normalized);
    }),
  );
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

function normalizeCheckedInAt(value: string) {
  const kktixTimestamp = value.match(
    /^(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2}:\d{2})\s+([+-]\d{2})(\d{2})$/,
  );
  return kktixTimestamp
    ? `${kktixTimestamp[1]}T${kktixTimestamp[2]}${kktixTimestamp[3]}:${kktixTimestamp[4]}`
    : value;
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
    for (const alias of FIELD_ALIASES.alternateScanKeys) {
      const value = getField(original, [alias]);
      if (value) scanKeys.add(value.toLowerCase());
    }
    return {
      id: `${externalId || qrValue || email || "guest"}-${index}`,
      name,
      email,
      phone: getField(original, FIELD_ALIASES.phone),
      ticket: getField(original, FIELD_ALIASES.ticket) || "一般票",
      approvalStatus: getField(original, FIELD_ALIASES.approval),
      qrValue,
      scanKeys: [...scanKeys],
      checkedInAt: checkedAt
        ? normalizeCheckedInAt(checkedAt)
        : looksChecked(checkedValue)
          ? importedAt
          : null,
      original,
    };
  });
}

export function filterEligibleAttendees(attendees: Attendee[]) {
  const hasRecognizedStatus = attendees.some((attendee) =>
    ELIGIBLE_APPROVAL_STATUSES.has(attendee.approvalStatus.toLowerCase()),
  );
  return hasRecognizedStatus
    ? attendees.filter((attendee) =>
        ELIGIBLE_APPROVAL_STATUSES.has(attendee.approvalStatus.toLowerCase()),
      )
    : attendees;
}

function openDatabase(databaseName = DB_NAME): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(databaseName, DB_VERSION);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE_NAME)) {
        request.result.createObjectStore(STORE_NAME);
      }
      if (!request.result.objectStoreNames.contains(ASSET_STORE_NAME)) {
        request.result.createObjectStore(ASSET_STORE_NAME);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function readSavedEventFromDatabase(databaseName: string) {
  const database = await openDatabase(databaseName);
  return new Promise<SavedEvent | null>((resolve, reject) => {
    const transaction = database.transaction(STORE_NAME, "readonly");
    const request = transaction.objectStore(STORE_NAME).get(CURRENT_EVENT_KEY);
    request.onsuccess = () => resolve((request.result as SavedEvent | undefined) ?? null);
    request.onerror = () => reject(request.error);
    transaction.oncomplete = () => database.close();
    transaction.onerror = () => {
      database.close();
      reject(transaction.error);
    };
  });
}

export async function readSavedEvent(): Promise<SavedEvent | null> {
  let saved = await readSavedEventFromDatabase(DB_NAME);
  if (!saved) {
    saved = await readSavedEventFromDatabase(LEGACY_DB_NAME);
    if (saved) await writeSavedEvent(saved);
  }
  if (!saved) return null;

  let migrated = saved;
  let changed = false;
  const savedDisplaySettings = saved.displaySettings;
  const legacyBackground = savedDisplaySettings?.backgroundImageDataUrl;
  if (savedDisplaySettings && legacyBackground) {
    await writeBackgroundImageDataUrl(legacyBackground);
    const displaySettings: DisplaySettings = {
      ...savedDisplaySettings,
      selectedFields: savedDisplaySettings.selectedFields ?? defaultDisplayFields(saved.headers),
    };
    delete displaySettings.backgroundImageDataUrl;
    migrated = { ...migrated, displaySettings };
    changed = true;
  }
  if (!migrated.checkInMode) {
    migrated = { ...migrated, checkInMode: migrated.sharedEvent ? "multi" : "single" };
    changed = true;
  }
  if (changed) await writeSavedEvent(migrated);
  return migrated;
}

export async function writeSavedEvent(event: SavedEvent) {
  const displaySettings = event.displaySettings ? { ...event.displaySettings } : undefined;
  if (displaySettings) delete displaySettings.backgroundImageDataUrl;
  const compactEvent = { ...event, displaySettings };
  const database = await openDatabase();
  return new Promise<void>((resolve, reject) => {
    const transaction = database.transaction(STORE_NAME, "readwrite");
    transaction.objectStore(STORE_NAME).put(compactEvent, CURRENT_EVENT_KEY);
    transaction.oncomplete = () => {
      database.close();
      resolve();
    };
    transaction.onerror = () => {
      database.close();
      reject(transaction.error);
    };
  });
}

export async function clearSavedEvent() {
  const clearDatabase = async (databaseName: string) => {
    const database = await openDatabase(databaseName);
    return new Promise<void>((resolve, reject) => {
      const transaction = database.transaction([STORE_NAME, ASSET_STORE_NAME], "readwrite");
      transaction.objectStore(STORE_NAME).delete(CURRENT_EVENT_KEY);
      transaction.objectStore(ASSET_STORE_NAME).delete(BACKGROUND_IMAGE_KEY);
      transaction.oncomplete = () => {
        database.close();
        resolve();
      };
      transaction.onerror = () => {
        database.close();
        reject(transaction.error);
      };
    });
  };
  await Promise.all([clearDatabase(DB_NAME), clearDatabase(LEGACY_DB_NAME)]);
}

async function readBackgroundImageFromDatabase(databaseName: string) {
  const database = await openDatabase(databaseName);
  return new Promise<string | null>((resolve, reject) => {
    const transaction = database.transaction(ASSET_STORE_NAME, "readonly");
    const request = transaction.objectStore(ASSET_STORE_NAME).get(BACKGROUND_IMAGE_KEY);
    request.onsuccess = () => resolve(typeof request.result === "string" ? request.result : null);
    request.onerror = () => reject(request.error);
    transaction.oncomplete = () => database.close();
    transaction.onerror = () => {
      database.close();
      reject(transaction.error);
    };
  });
}

export async function readBackgroundImageDataUrl(): Promise<string | null> {
  const current = await readBackgroundImageFromDatabase(DB_NAME);
  if (current) return current;
  const legacy = await readBackgroundImageFromDatabase(LEGACY_DB_NAME);
  if (legacy) await writeBackgroundImageDataUrl(legacy);
  return legacy;
}

export async function writeBackgroundImageDataUrl(value: string | null) {
  const database = await openDatabase();
  return new Promise<void>((resolve, reject) => {
    const transaction = database.transaction(ASSET_STORE_NAME, "readwrite");
    const store = transaction.objectStore(ASSET_STORE_NAME);
    if (value) store.put(value, BACKGROUND_IMAGE_KEY);
    else store.delete(BACKGROUND_IMAGE_KEY);
    transaction.oncomplete = () => {
      database.close();
      resolve();
    };
    transaction.onerror = () => {
      database.close();
      reject(transaction.error);
    };
  });
}

async function withEventWriteLock<T>(work: () => Promise<T>): Promise<T> {
  if (typeof navigator !== "undefined" && navigator.locks?.request) {
    return navigator.locks.request(WRITE_LOCK_NAME, work);
  }
  const result = fallbackWriteQueue.then(work, work);
  fallbackWriteQueue = result.then(() => undefined, () => undefined);
  return result;
}

export function applyScanToEvent(
  event: SavedEvent,
  rawCode: string,
  scannedAt = new Date().toISOString(),
): { event: SavedEvent; outcome: ScanOutcome } {
  const code = rawCode.trim().replace(/[\r\n]+$/g, "");
  const keys = scanKeysFor(code);
  const candidates = event.attendees.filter((attendee) =>
    attendee.scanKeys.some((key) => keys.includes(key)),
  );
  const revision = (event.revision ?? 0) + 1;
  if (!candidates.length) {
    return {
      event: { ...event, revision, lastScan: { kind: "unknown", code, at: scannedAt } },
      outcome: { kind: "unknown", code, at: scannedAt },
    };
  }
  const attendee = candidates.find((candidate) => !candidate.checkedInAt) ?? candidates[0];
  if (attendee.checkedInAt) {
    return {
      event: {
        ...event,
        revision,
        lastScan: { kind: "duplicate", attendeeId: attendee.id, at: scannedAt },
      },
      outcome: { kind: "duplicate", attendee, at: scannedAt },
    };
  }
  const checkedAttendee = { ...attendee, checkedInAt: scannedAt };
  return {
    event: {
      ...event,
      revision,
      lastScan: { kind: "success", attendeeId: attendee.id, at: scannedAt },
      attendees: event.attendees.map((item) =>
        item.id === attendee.id ? checkedAttendee : item,
      ),
    },
    outcome: { kind: "success", attendee: checkedAttendee, at: scannedAt },
  };
}

export async function replaceSavedEvent(event: SavedEvent) {
  const prepared = {
    ...event,
    revision: Math.max(1, event.revision ?? 0),
  };
  await withEventWriteLock(() => writeSavedEvent(prepared));
  broadcastEventChange();
  return { event: prepared };
}

export async function mutateSavedEvent(
  mutate: (event: SavedEvent) => SavedEvent,
) {
  const updated = await withEventWriteLock(async () => {
    const current = await readSavedEvent();
    if (!current) throw new Error("找不到目前的活動名單，請重新匯入 CSV。");
    const next = mutate(current);
    const normalized = { ...next, revision: (current.revision ?? 0) + 1 };
    await writeSavedEvent(normalized);
    return normalized;
  });
  broadcastEventChange();
  return updated;
}

export function broadcastEventChange() {
  if (typeof BroadcastChannel === "undefined") return;
  const channel = new BroadcastChannel(CHANNEL_NAME);
  channel.postMessage({ type: "event-changed", at: Date.now() });
  channel.close();
}

export function defaultDisplayFields(headers: string[]) {
  const preferred = [FIELD_ALIASES.name, FIELD_ALIASES.ticket, FIELD_ALIASES.email];
  const selected = preferred
    .map((aliases) => headers.find((header) =>
      aliases.some((alias) => normalizeHeader(header) === alias),
    ))
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
  if (FIELD_ALIASES.name.some((alias) => alias === normalized)) return "姓名";
  if (FIELD_ALIASES.email.some((alias) => alias === normalized)) return "Email";
  if (FIELD_ALIASES.phone.some((alias) => alias === normalized)) return "電話";
  if (FIELD_ALIASES.ticket.some((alias) => alias === normalized)) return "票種";
  return field;
}

export function csvEscape(value: string) {
  const spreadsheetSafe = /^(?:[\t\r\n]|\s*[=+\-@])/.test(value) ? `'${value}` : value;
  return /[",\r\n]/.test(spreadsheetSafe)
    ? `"${spreadsheetSafe.replace(/"/g, '""')}"`
    : spreadsheetSafe;
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
