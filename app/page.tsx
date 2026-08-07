"use client";

import {
  ChangeEvent,
  DragEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { CSSProperties } from "react";
import {
  clearLiveEvent,
  publishLiveEvent,
  publishProjectionCue,
} from "./checkin-core";
import type { ProjectionCueType } from "./checkin-core";

type OriginalRow = Record<string, string>;

type Attendee = {
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

type SavedEvent = {
  version: 1;
  fileName: string;
  importedAt: string;
  headers: string[];
  attendees: Attendee[];
  sourceRowCount?: number;
  excludedRowCount?: number;
  displaySettings?: {
    selectedFields: string[];
    backgroundImageDataUrl?: string;
    backgroundColor?: string;
  };
  lastScan?: {
    kind: "success" | "duplicate" | "unknown";
    attendeeId?: string;
    code?: string;
    at: string;
  };
};

type ScanResult =
  | { kind: "success"; attendee: Attendee; message: string }
  | { kind: "duplicate"; attendee: Attendee; message: string }
  | { kind: "unknown"; code: string; message: string }
  | { kind: "undone"; attendee: Attendee; message: string };

type Filter = "all" | "pending" | "arrived";

const DB_NAME = "arrival-checkin";
const DB_VERSION = 1;
const STORE_NAME = "events";
const CURRENT_EVENT_KEY = "current-event";
const CHANNEL_NAME = "arrival-checkin-sync";
const MAX_ATTENDEES = 200;
const MAX_BACKGROUND_FILE_SIZE = 15 * 1024 * 1024;
const MAX_BACKGROUND_WIDTH = 2560;
const MAX_BACKGROUND_HEIGHT = 1440;
const BACKGROUND_IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);
const DEFAULT_GUEST_BACKGROUND = "#0E0F12";

type ArrivalBucket = {
  start: number;
  count: number;
  label: string;
  tooltip: string;
};

type ArrivalChart = {
  buckets: ArrivalBucket[];
  grainLabel: string;
  rangeLabel: string;
  peakCount: number;
};

const ARRIVAL_BUCKET_SIZES = [
  60_000,
  2 * 60_000,
  5 * 60_000,
  10 * 60_000,
  15 * 60_000,
  30 * 60_000,
  60 * 60_000,
  2 * 60 * 60_000,
  4 * 60 * 60_000,
  8 * 60 * 60_000,
  24 * 60 * 60_000,
  2 * 24 * 60 * 60_000,
  7 * 24 * 60 * 60_000,
  30 * 24 * 60 * 60_000,
];

function arrivalGrainLabel(milliseconds: number) {
  const minutes = milliseconds / 60_000;
  if (minutes < 60) return `${minutes} 分鐘`;
  const hours = minutes / 60;
  if (hours < 24) return `${hours} 小時`;
  return `${hours / 24} 天`;
}

function buildArrivalChart(attendees: Attendee[]): ArrivalChart {
  const timestamps = attendees
    .flatMap((attendee) => {
      if (!attendee.checkedInAt) return [];
      const value = new Date(attendee.checkedInAt).getTime();
      return Number.isFinite(value) ? [value] : [];
    })
    .sort((a, b) => a - b);
  if (!timestamps.length) return { buckets: [], grainLabel: "", rangeLabel: "", peakCount: 0 };

  const first = timestamps[0];
  const last = timestamps[timestamps.length - 1];
  const interval = ARRIVAL_BUCKET_SIZES.find((size) => {
    const start = Math.floor(first / size) * size;
    return Math.floor((last - start) / size) + 1 <= 12;
  }) ?? ARRIVAL_BUCKET_SIZES.at(-1)!;
  const start = Math.floor(first / interval) * interval;
  const bucketCount = Math.floor((last - start) / interval) + 1;
  const sameDay = new Date(first).toDateString() === new Date(last).toDateString();
  const buckets = Array.from({ length: bucketCount }, (_, index) => {
    const bucketStart = start + index * interval;
    const bucketEnd = bucketStart + interval;
    const count = timestamps.filter((timestamp) => timestamp >= bucketStart && timestamp < bucketEnd).length;
    const date = new Date(bucketStart);
    const label = interval < 24 * 60 * 60_000
      ? new Intl.DateTimeFormat("zh-TW", {
          ...(sameDay ? {} : { month: "numeric", day: "numeric" }),
          hour: "2-digit",
          minute: "2-digit",
          hour12: false,
        }).format(date)
      : new Intl.DateTimeFormat("zh-TW", { month: "numeric", day: "numeric" }).format(date);
    const tooltip = `${new Intl.DateTimeFormat("zh-TW", {
      month: "numeric",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).format(date)} · ${count} 位`;
    return { start: bucketStart, count, label, tooltip };
  });
  const rangeFormatter = new Intl.DateTimeFormat("zh-TW", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  return {
    buckets,
    grainLabel: arrivalGrainLabel(interval),
    rangeLabel: `${rangeFormatter.format(new Date(first))}–${rangeFormatter.format(new Date(last))}`,
    peakCount: Math.max(...buckets.map((bucket) => bucket.count)),
  };
}

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
  checkedAt: [
    "checked_in_at",
    "check_in_at",
    "checkin_at",
    "check_in_time",
    "報到時間",
  ],
  checked: ["checked_in", "check_in_status", "checkin_status", "已報到"],
  ticketId: ["ticket_api_id", "ticket_id", "guest_api_id", "guest_id", "id"],
} as const;

function normalizeHeader(value: string) {
  return value
    .replace(/^\uFEFF/, "")
    .trim()
    .toLowerCase()
    .replace(/[\s\-/]+/g, "_")
    .replace(/[()]/g, "");
}

function parseCsv(source: string): { headers: string[]; rows: OriginalRow[] } {
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

    if (char === '"' && cell.length === 0) {
      quoted = true;
    } else if (char === ",") {
      row.push(cell);
      cell = "";
    } else if (char === "\n" || char === "\r") {
      if (char === "\r" && next === "\n") index += 1;
      row.push(cell);
      if (row.some((value) => value.trim() !== "")) matrix.push(row);
      row = [];
      cell = "";
    } else {
      cell += char;
    }
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

function scanKeysFor(rawValue: string) {
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

function toAttendees(rows: OriginalRow[], importedAt: string): Attendee[] {
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

async function readSavedEvent(): Promise<SavedEvent | null> {
  const database = await openDatabase();
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(STORE_NAME, "readonly");
    const request = transaction.objectStore(STORE_NAME).get(CURRENT_EVENT_KEY);
    request.onsuccess = () => resolve((request.result as SavedEvent | undefined) ?? null);
    request.onerror = () => reject(request.error);
    transaction.oncomplete = () => database.close();
  });
}

async function writeSavedEvent(event: SavedEvent) {
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

async function clearSavedEvent() {
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

function csvEscape(value: string) {
  return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

function formatTime(value: string | null, includeDate = false) {
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

function compactDate(value: Date) {
  const parts = new Intl.DateTimeFormat("sv-SE", {
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
  return parts;
}

async function prepareBackgroundImage(file: File) {
  if (!BACKGROUND_IMAGE_TYPES.has(file.type)) {
    throw new Error("背景圖只支援 JPG、PNG 或 WebP 格式。");
  }
  if (file.size > MAX_BACKGROUND_FILE_SIZE) {
    throw new Error("背景圖檔案請勿超過 15 MB。");
  }

  const objectUrl = URL.createObjectURL(file);
  try {
    const image = await new Promise<HTMLImageElement>((resolve, reject) => {
      const loadedImage = new Image();
      loadedImage.onload = () => resolve(loadedImage);
      loadedImage.onerror = () => reject(new Error("無法讀取這張背景圖，請換一張圖片。"));
      loadedImage.src = objectUrl;
    });
    const scale = Math.min(
      1,
      MAX_BACKGROUND_WIDTH / image.naturalWidth,
      MAX_BACKGROUND_HEIGHT / image.naturalHeight,
    );
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
    const context = canvas.getContext("2d");
    if (!context) throw new Error("這台瀏覽器無法處理背景圖。");
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = "high";
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    const dataUrl = canvas.toDataURL("image/webp", 0.82);
    if (dataUrl.length > 5_000_000) {
      throw new Error("處理後的背景圖仍然太大，請改用尺寸較小的圖片。");
    }
    return dataUrl;
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

function broadcastEventChange() {
  if (typeof BroadcastChannel === "undefined") return;
  const channel = new BroadcastChannel(CHANNEL_NAME);
  channel.postMessage({ type: "event-changed", at: Date.now() });
  channel.close();
}

function defaultDisplayFields(headers: string[]) {
  const preferred = ["name", "ticket_name", "email"];
  const selected = preferred
    .map((wanted) => headers.find((header) => normalizeHeader(header) === wanted))
    .filter((header): header is string => Boolean(header));
  return selected.length ? selected : headers.slice(0, 2);
}

function resultFromSavedEvent(saved: SavedEvent | null): ScanResult | null {
  if (!saved?.lastScan) return null;
  const attendee = saved.lastScan.attendeeId
    ? saved.attendees.find((item) => item.id === saved.lastScan?.attendeeId)
    : undefined;
  if (saved.lastScan.kind === "unknown") {
    return {
      kind: "unknown",
      code: saved.lastScan.code ?? "",
      message: "名單中找不到這組 QR Code",
    };
  }
  if (!attendee) return null;
  return saved.lastScan.kind === "success"
    ? { kind: "success", attendee, message: `${attendee.name} 報到成功` }
    : { kind: "duplicate", attendee, message: `${attendee.name} 已經報到過了` };
}

export default function Home() {
  const [event, setEvent] = useState<SavedEvent | null>(null);
  const [ready, setReady] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [importing, setImporting] = useState(false);
  const [error, setError] = useState("");
  const [scanText, setScanText] = useState("");
  const [scanResult, setScanResult] = useState<ScanResult | null>(null);
  const [filter, setFilter] = useState<Filter>("all");
  const [search, setSearch] = useState("");
  const [lastInputAt, setLastInputAt] = useState<string | null>(null);
  const [showMenu, setShowMenu] = useState(false);
  const [backgroundUploading, setBackgroundUploading] = useState(false);
  const [controlBusy, setControlBusy] = useState<ProjectionCueType | null>(null);
  const [controlNote, setControlNote] = useState("控制指令將送往投影牆");
  const scanInputRef = useRef<HTMLInputElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const backgroundInputRef = useRef<HTMLInputElement>(null);
  const scanBufferRef = useRef("");
  const lastKeyAtRef = useRef(0);
  const scannerIdleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    readSavedEvent()
      .then((saved) => {
        setEvent(saved);
        setScanResult(resultFromSavedEvent(saved));
        if (saved) void publishLiveEvent(saved).catch(() => undefined);
      })
      .catch(() => setError("無法讀取瀏覽器中的報到紀錄，請確認不是使用私密瀏覽模式。"))
      .finally(() => setReady(true));
  }, []);

  useEffect(() => {
    if (typeof BroadcastChannel === "undefined") return;
    const channel = new BroadcastChannel(CHANNEL_NAME);
    channel.onmessage = () => {
      readSavedEvent()
        .then((saved) => {
          setEvent(saved);
          setScanResult(resultFromSavedEvent(saved));
          setLastInputAt(saved?.lastScan?.at ?? null);
        })
        .catch(() => setError("來賓畫面有新資料，但管理畫面暫時無法同步。"));
    };
    return () => channel.close();
  }, []);

  useEffect(() => {
    if (!ready || !event) return;
    const timer = window.setTimeout(() => scanInputRef.current?.focus(), 80);
    return () => window.clearTimeout(timer);
  }, [ready, event]);

  const persist = useCallback(async (nextEvent: SavedEvent) => {
    setEvent(nextEvent);
    try {
      await writeSavedEvent(nextEvent);
      broadcastEventChange();
      void publishLiveEvent(nextEvent).catch(() => {
        setError("報到紀錄已保存在瀏覽器，但投影牆暫時無法同步。");
      });
    } catch {
      setError("畫面已更新，但無法寫入瀏覽器儲存空間；請立即匯出備份。 ");
    }
  }, []);

  const handleScan = useCallback(
    (rawCode: string) => {
      if (!event) return;
      const code = rawCode.trim().replace(/[\r\n]+$/g, "");
      if (!code) return;
      const keys = scanKeysFor(code);
      const candidates = event.attendees.filter((attendee) =>
        attendee.scanKeys.some((key) => keys.includes(key)),
      );

      setLastInputAt(new Date().toISOString());
      setScanText("");

      if (candidates.length === 0) {
        const nextEvent = {
          ...event,
          lastScan: { kind: "unknown" as const, code, at: new Date().toISOString() },
        };
        void persist(nextEvent);
        setScanResult({
          kind: "unknown",
          code,
          message: "名單中找不到這組 QR Code",
        });
        window.setTimeout(() => scanInputRef.current?.focus(), 0);
        return;
      }

      const attendee = candidates.find((candidate) => !candidate.checkedInAt) ?? candidates[0];
      if (attendee.checkedInAt) {
        const nextEvent = {
          ...event,
          lastScan: {
            kind: "duplicate" as const,
            attendeeId: attendee.id,
            at: new Date().toISOString(),
          },
        };
        void persist(nextEvent);
        setScanResult({
          kind: "duplicate",
          attendee,
          message: `${attendee.name} 已經報到過了`,
        });
        window.setTimeout(() => scanInputRef.current?.focus(), 0);
        return;
      }

      const checkedInAt = new Date().toISOString();
      const checkedAttendee = { ...attendee, checkedInAt };
      const nextEvent = {
        ...event,
        lastScan: { kind: "success" as const, attendeeId: attendee.id, at: checkedInAt },
        attendees: event.attendees.map((item) =>
          item.id === attendee.id ? checkedAttendee : item,
        ),
      };
      void persist(nextEvent);
      setScanResult({
        kind: "success",
        attendee: checkedAttendee,
        message: `${attendee.name} 報到成功`,
      });
      window.setTimeout(() => scanInputRef.current?.focus(), 0);
    },
    [event, persist],
  );

  useEffect(() => {
    if (!event) return;

    const isKnownCode = (code: string) => {
      const keys = scanKeysFor(code);
      return event.attendees.some((attendee) =>
        attendee.scanKeys.some((key) => keys.includes(key)),
      );
    };

    const captureScanner = (keyboardEvent: KeyboardEvent) => {
      if (keyboardEvent.metaKey || keyboardEvent.ctrlKey || keyboardEvent.altKey) return;
      const target = keyboardEvent.target as HTMLElement | null;
      if (
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        target instanceof HTMLSelectElement
      ) {
        return;
      }

      const now = performance.now();
      if (keyboardEvent.key === "Enter") {
        if (scannerIdleTimerRef.current) clearTimeout(scannerIdleTimerRef.current);
        const buffered = scanBufferRef.current;
        scanBufferRef.current = "";
        if (buffered.length >= 3) {
          keyboardEvent.preventDefault();
          handleScan(buffered);
        }
        return;
      }

      if (keyboardEvent.key.length !== 1) return;
      if (now - lastKeyAtRef.current > 120) scanBufferRef.current = "";
      scanBufferRef.current += keyboardEvent.key;
      lastKeyAtRef.current = now;
      if (scannerIdleTimerRef.current) clearTimeout(scannerIdleTimerRef.current);
      scannerIdleTimerRef.current = setTimeout(() => {
        const buffered = scanBufferRef.current;
        if (buffered.length >= 3 && isKnownCode(buffered)) {
          scanBufferRef.current = "";
          handleScan(buffered);
        }
      }, 100);
    };

    window.addEventListener("keydown", captureScanner);
    return () => {
      window.removeEventListener("keydown", captureScanner);
      if (scannerIdleTimerRef.current) clearTimeout(scannerIdleTimerRef.current);
    };
  }, [event, handleScan]);

  useEffect(() => {
    if (!event || scanText.trim().length < 3) return;
    const keys = scanKeysFor(scanText);
    const isKnown = event.attendees.some((attendee) =>
      attendee.scanKeys.some((key) => keys.includes(key)),
    );
    if (!isKnown) return;
    const timer = window.setTimeout(() => handleScan(scanText), 100);
    return () => window.clearTimeout(timer);
  }, [event, handleScan, scanText]);

  const importFile = useCallback(
    async (file: File) => {
      setError("");
      if (!file.name.toLowerCase().endsWith(".csv") && file.type !== "text/csv") {
        setError("請選擇 Luma 匯出的 CSV 檔案。");
        return;
      }
      if (event && !window.confirm("匯入新名單會取代目前保存在這台瀏覽器的名單，要繼續嗎？")) {
        return;
      }

      setImporting(true);
      try {
        const source = await file.text();
        const { headers, rows } = parseCsv(source);
        const importedAt = new Date().toISOString();
        const parsedAttendees = toAttendees(rows, importedAt);
        const approvedValues = new Set(["approved", "accepted", "going", "confirmed"]);
        const hasApprovalStatuses = parsedAttendees.some((attendee) =>
          approvedValues.has(attendee.approvalStatus.toLowerCase()),
        );
        const attendees = hasApprovalStatuses
          ? parsedAttendees.filter((attendee) =>
              approvedValues.has(attendee.approvalStatus.toLowerCase()),
            )
          : parsedAttendees;
        if (attendees.length > MAX_ATTENDEES) {
          throw new Error(
            `這個版本最多支援 ${MAX_ATTENDEES} 位可報到來賓，目前檔案有 ${attendees.length} 位。`,
          );
        }
        if (!attendees.some((attendee) => attendee.qrValue)) {
          throw new Error(
            "找不到 QR Code 欄位。請確認 CSV 包含 qr_code_url、qrcode 或 qr_code 欄位。",
          );
        }
        const nextEvent: SavedEvent = {
          version: 1,
          fileName: file.name,
          importedAt,
          headers,
          attendees,
          sourceRowCount: rows.length,
          excludedRowCount: rows.length - attendees.length,
          displaySettings: { selectedFields: defaultDisplayFields(headers) },
        };
        await persist(nextEvent);
        setScanResult(null);
        setFilter("all");
        setSearch("");
        window.setTimeout(() => scanInputRef.current?.focus(), 80);
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : "無法讀取這份 CSV，請確認檔案格式。 ");
      } finally {
        setImporting(false);
        if (fileInputRef.current) fileInputRef.current.value = "";
      }
    },
    [event, persist],
  );

  const handleFileChange = (changeEvent: ChangeEvent<HTMLInputElement>) => {
    const file = changeEvent.target.files?.[0];
    if (file) void importFile(file);
  };

  const handleDrop = (dropEvent: DragEvent<HTMLDivElement>) => {
    dropEvent.preventDefault();
    setDragging(false);
    const file = dropEvent.dataTransfer.files?.[0];
    if (file) void importFile(file);
  };

  const toggleCheckIn = (attendee: Attendee) => {
    if (!event) return;
    const checkedInAt = attendee.checkedInAt ? null : new Date().toISOString();
    const updated = { ...attendee, checkedInAt };
    const lastScan = checkedInAt
      ? { kind: "success" as const, attendeeId: attendee.id, at: checkedInAt }
      : event.lastScan?.attendeeId === attendee.id
        ? undefined
        : event.lastScan;
    const nextEvent = {
      ...event,
      lastScan,
      attendees: event.attendees.map((item) => (item.id === attendee.id ? updated : item)),
    };
    void persist(nextEvent);
    if (checkedInAt) setLastInputAt(checkedInAt);
    setScanResult(
      checkedInAt
        ? { kind: "success", attendee: updated, message: `${attendee.name} 手動報到成功` }
        : { kind: "undone", attendee: updated, message: `已取消 ${attendee.name} 的報到` },
    );
    window.setTimeout(() => scanInputRef.current?.focus(), 0);
  };

  const exportCsv = () => {
    if (!event) return;
    const statusHeader = event.headers.includes("local_check_in_status")
      ? "checkin_local_status"
      : "local_check_in_status";
    const timeHeader = event.headers.includes("local_checked_in_at")
      ? "checkin_local_checked_in_at"
      : "local_checked_in_at";
    const exportHeaders = [...event.headers, statusHeader, timeHeader];
    const lines = [
      exportHeaders.map(csvEscape).join(","),
      ...event.attendees.map((attendee) =>
        exportHeaders
          .map((header) => {
            if (header === statusHeader) return attendee.checkedInAt ? "checked_in" : "not_checked_in";
            if (header === timeHeader) return attendee.checkedInAt ?? "";
            return attendee.original[header] ?? "";
          })
          .map(csvEscape)
          .join(","),
      ),
    ];
    const blob = new Blob(["\uFEFF", lines.join("\r\n")], {
      type: "text/csv;charset=utf-8",
    });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    const baseName = event.fileName.replace(/\.csv$/i, "") || "luma-guests";
    link.href = url;
    link.download = `${baseName}_checkin_${compactDate(new Date())}.csv`;
    link.click();
    URL.revokeObjectURL(url);
    setShowMenu(false);
    window.setTimeout(() => scanInputRef.current?.focus(), 0);
  };

  const downloadSample = () => {
    const sample = [
      "name,email,ticket_name,qr_code_url",
      '王小明,ming@example.com,一般票,"https://luma.com/check-in/event?pk=demo-001"',
      '陳美玲,mei@example.com,VIP,"https://luma.com/check-in/event?pk=demo-002"',
    ].join("\r\n");
    const blob = new Blob(["\uFEFF", sample], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "luma-checkin-sample.csv";
    link.click();
    URL.revokeObjectURL(url);
  };

  const replaceList = () => {
    setShowMenu(false);
    fileInputRef.current?.click();
  };

  const removeList = async () => {
    if (!event || !window.confirm("確定要清除這台瀏覽器中的名單與所有報到紀錄嗎？此動作無法復原。")) {
      return;
    }
    await clearSavedEvent();
    await clearLiveEvent().catch(() => undefined);
    broadcastEventChange();
    setEvent(null);
    setScanResult(null);
    setSearch("");
    setFilter("all");
    setShowMenu(false);
  };

  const selectedDisplayFields = event
    ? event.displaySettings?.selectedFields.filter((field) => event.headers.includes(field)) ??
      defaultDisplayFields(event.headers)
    : [];
  const selectableDisplayFields = event
    ? event.headers.filter((header) => {
        const normalized = normalizeHeader(header);
        return ![
          "guest_id",
          "ticket_type_id",
          "qr_code_url",
          "checked_in_at",
        ].includes(normalized);
      })
    : [];

  const toggleDisplayField = (field: string) => {
    if (!event) return;
    const isSelected = selectedDisplayFields.includes(field);
    if (isSelected && selectedDisplayFields.length === 1) {
      setError("來賓畫面至少要保留一個顯示欄位。");
      return;
    }
    const selectedFields = isSelected
      ? selectedDisplayFields.filter((item) => item !== field)
      : [...selectedDisplayFields, field];
    void persist({
      ...event,
      displaySettings: { ...event.displaySettings, selectedFields },
    });
  };

  const handleBackgroundChange = async (changeEvent: ChangeEvent<HTMLInputElement>) => {
    const input = changeEvent.currentTarget;
    const file = input.files?.[0];
    if (!file) return;
    setError("");
    setBackgroundUploading(true);
    try {
      const backgroundImageDataUrl = await prepareBackgroundImage(file);
      const latestEvent = await readSavedEvent();
      if (!latestEvent) throw new Error("找不到目前的活動名單，請重新匯入 CSV。");
      const selectedFields =
        latestEvent.displaySettings?.selectedFields ?? defaultDisplayFields(latestEvent.headers);
      await persist({
        ...latestEvent,
        displaySettings: {
          ...latestEvent.displaySettings,
          selectedFields,
          backgroundImageDataUrl,
        },
      });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "無法設定這張背景圖。");
    } finally {
      setBackgroundUploading(false);
      input.value = "";
      window.setTimeout(() => scanInputRef.current?.focus(), 0);
    }
  };

  const removeBackground = () => {
    if (!event?.displaySettings?.backgroundImageDataUrl) return;
    void persist({
      ...event,
      displaySettings: {
        ...event.displaySettings,
        selectedFields: selectedDisplayFields,
        backgroundImageDataUrl: undefined,
      },
    });
    window.setTimeout(() => scanInputRef.current?.focus(), 0);
  };

  const updateBackgroundColor = (backgroundColor: string) => {
    if (!event || !/^#[0-9a-f]{6}$/i.test(backgroundColor)) return;
    void persist({
      ...event,
      displaySettings: {
        ...event.displaySettings,
        selectedFields: selectedDisplayFields,
        backgroundColor,
      },
    });
  };

  const arrived = event?.attendees.filter((attendee) => attendee.checkedInAt).length ?? 0;
  const total = event?.attendees.length ?? 0;
  const remaining = total - arrived;
  const rate = total ? Math.round((arrived / total) * 100) : 0;
  const withoutQr = event?.attendees.filter((attendee) => !attendee.qrValue).length ?? 0;
  const arrivalChart = useMemo(
    () => buildArrivalChart(event?.attendees ?? []),
    [event],
  );
  const recentArrivals = useMemo(
    () => (event?.attendees ?? [])
      .filter((attendee) => attendee.checkedInAt)
      .sort((a, b) => (b.checkedInAt ?? "").localeCompare(a.checkedInAt ?? ""))
      .slice(0, 5),
    [event],
  );

  const triggerProjectionCue = async (type: ProjectionCueType) => {
    setControlBusy(type);
    try {
      await publishProjectionCue(type);
      setControlNote(type === "boarding" ? "登車廣播指令已送出" : "全場彩蛋指令已送出");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "無法控制投影牆。");
    } finally {
      setControlBusy(null);
    }
  };

  const visibleAttendees = useMemo(() => {
    if (!event) return [];
    const query = search.trim().toLowerCase();
    return event.attendees
      .filter((attendee) => {
        if (filter === "arrived" && !attendee.checkedInAt) return false;
        if (filter === "pending" && attendee.checkedInAt) return false;
        if (!query) return true;
        return [attendee.name, attendee.email, attendee.phone, attendee.ticket]
          .join(" ")
          .toLowerCase()
          .includes(query);
      })
      .sort((a, b) => {
        if (a.checkedInAt && b.checkedInAt) return b.checkedInAt.localeCompare(a.checkedInAt);
        if (a.checkedInAt) return -1;
        if (b.checkedInAt) return 1;
        return a.name.localeCompare(b.name, "zh-Hant");
      });
  }, [event, filter, search]);

  if (!ready) {
    return (
      <main className="loading-shell" aria-label="正在讀取報到資料">
        <div className="loading-mark">到</div>
        <p>正在還原這台裝置的報到紀錄…</p>
      </main>
    );
  }

  return (
    <main className={`app-shell ${event ? "has-event" : "empty"}`}>
      <input
        ref={fileInputRef}
        type="file"
        accept=".csv,text/csv"
        onChange={handleFileChange}
        className="visually-hidden"
        aria-label="選擇 Luma CSV 檔案"
      />
      <input
        ref={backgroundInputRef}
        type="file"
        accept="image/jpeg,image/png,image/webp"
        onChange={(changeEvent) => void handleBackgroundChange(changeEvent)}
        className="visually-hidden"
        aria-label="選擇來賓畫面背景圖"
      />

      <header className="topbar">
        <a className="brand" href="#top" aria-label="抵達報到台首頁">
          <span className="brand-mark">到</span>
          <span>抵達</span>
          <span className="brand-subtitle">QR 報到台</span>
        </a>
        {event ? (
          <div className="top-actions">
            <span className="saved-pill"><i /> 已儲存在此裝置</span>
            <a className="display-button" href="/scan" target="_blank" rel="noreferrer">
              開啟來賓畫面 <span aria-hidden="true">↗</span>
            </a>
            <a className="display-button projection-link" href="/projection" target="_blank" rel="noreferrer">
              開啟投影牆 <span aria-hidden="true">↗</span>
            </a>
            <button className="export-button" type="button" onClick={exportCsv}>
              <span aria-hidden="true">↓</span> 匯出結果
            </button>
            <div className="menu-wrap">
              <button
                type="button"
                className="icon-button"
                aria-label="更多選項"
                aria-expanded={showMenu}
                onClick={() => setShowMenu((current) => !current)}
              >
                •••
              </button>
              {showMenu ? (
                <div className="menu-popover">
                  <button type="button" onClick={replaceList}>匯入新名單</button>
                  <button type="button" className="danger-item" onClick={() => void removeList()}>
                    清除本機紀錄
                  </button>
                </div>
              ) : null}
            </div>
          </div>
        ) : null}
      </header>

      {error ? (
        <div className="error-banner" role="alert">
          <span aria-hidden="true">!</span>
          <p>{error}</p>
          <button type="button" onClick={() => setError("")} aria-label="關閉錯誤訊息">×</button>
        </div>
      ) : null}

      {!event ? (
        <section className="welcome" id="top">
          <div className="welcome-copy">
            <p className="eyebrow"><span /> 現場報到，從容開始</p>
            <h1>一掃，就知道<br /><em>誰抵達了。</em></h1>
            <p className="welcome-lead">
              匯入 Luma 活動名單，接上掃描器就能開始。最多 200 人，報到紀錄保存在這台裝置。
            </p>
            <div className="trust-row">
              <span><b>01</b> 匯入 CSV</span>
              <i />
              <span><b>02</b> 掃描 QR Code</span>
              <i />
              <span><b>03</b> 匯出紀錄</span>
            </div>
          </div>

          <div
            className={`drop-card ${dragging ? "is-dragging" : ""}`}
            onDragOver={(dragEvent) => {
              dragEvent.preventDefault();
              setDragging(true);
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={handleDrop}
          >
            <div className="file-glyph" aria-hidden="true"><span>CSV</span></div>
            <p className="drop-kicker">準備活動名單</p>
            <h2>{importing ? "正在讀取名單…" : "把 Luma CSV 放到這裡"}</h2>
            <p>或從電腦選擇一份檔案</p>
            <button
              className="primary-button"
              type="button"
              disabled={importing}
              onClick={() => fileInputRef.current?.click()}
            >
              {importing ? "匯入中…" : "選擇 CSV 檔案"}
            </button>
            <button className="sample-link" type="button" onClick={downloadSample}>
              先下載欄位範例
            </button>
            <div className="privacy-note">
              <span aria-hidden="true">⌂</span>
              <p><strong>不使用雲端服務</strong><br />只在本機保存，並可同步到同一區網的投影牆</p>
            </div>
          </div>
        </section>
      ) : (
        <>
          <section className="event-dashboard" id="top">
            <div className="dashboard-heading">
              <div>
                <p className="eyebrow"><span /> Live operations</p>
                <h1>活動中控台</h1>
                <p className="file-meta">
                  {event.fileName} · {total} 位可報到
                  {event.excludedRowCount ? ` · 已略過 ${event.excludedRowCount} 筆非 approved` : ""}
                  {` · ${formatTime(event.importedAt, true)} 匯入`}
                </p>
              </div>
              <div className="control-status" aria-live="polite">
                <i />
                <span>{controlNote}</span>
              </div>
            </div>

            <div className="event-control-strip" aria-label="活動控制">
              <button
                type="button"
                disabled={controlBusy !== null}
                onClick={() => void triggerProjectionCue("boarding")}
              >
                <span aria-hidden="true">◖</span>
                <div>
                  <strong>{controlBusy === "boarding" ? "正在送出…" : "播放登車廣播"}</strong>
                  <small>在投影牆播放現場廣播</small>
                </div>
              </button>
              <button
                type="button"
                className="celebration-control"
                disabled={controlBusy !== null}
                onClick={() => void triggerProjectionCue("celebration")}
              >
                <span aria-hidden="true">✦</span>
                <div>
                  <strong>{controlBusy === "celebration" ? "正在觸發…" : "全場彩蛋"}</strong>
                  <small>播放彩蛋並引爆能量牆</small>
                </div>
              </button>
              <a href="/projection" target="_blank" rel="noreferrer">
                <span aria-hidden="true">↗</span>
                <div><strong>開啟投影牆</strong><small>投影電腦以區網網址開啟</small></div>
              </a>
            </div>

            <div className="cockpit-grid">
              <article className="cockpit-card rate-overview">
                <div className="cockpit-card-heading">
                  <div><span>目前報到率</span><small>CHECK-IN RATE</small></div>
                  <span className="live-badge"><i /> LIVE</span>
                </div>
                <div className="rate-hero">
                  <strong>{rate}<small>%</small></strong>
                  <span>{arrived} / {total} 位已抵達</span>
                </div>
                <div
                  className="rate-progress"
                  role="progressbar"
                  aria-label="目前報到率"
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={rate}
                >
                  <i style={{ width: `${rate}%` }} />
                </div>
                <div className="rate-breakdown">
                  <div><span>已抵達</span><strong>{arrived}</strong></div>
                  <div><span>尚未抵達</span><strong>{remaining}</strong></div>
                  <div><span>缺少 QR</span><strong className={withoutQr ? "warn" : ""}>{withoutQr}</strong></div>
                </div>
                <p className="metric-definition">報到率 = 已報到人數 ÷ 可報到名單總數</p>
              </article>

              <article className="cockpit-card arrival-chart-card">
                <div className="cockpit-card-heading chart-heading">
                  <div>
                    <span>抵達節奏</span>
                    <small>
                      {arrivalChart.buckets.length
                        ? `每 ${arrivalChart.grainLabel}實際報到人數 · ${arrivalChart.rangeLabel}`
                        : "等待第一位來賓報到"}
                    </small>
                  </div>
                  {arrivalChart.peakCount ? <strong>單一時段最高 {arrivalChart.peakCount} 位</strong> : null}
                </div>
                {arrivalChart.buckets.length >= 4 ? (
                  <div
                    className="arrival-bars"
                    role="img"
                    aria-label={`抵達節奏圖表，共 ${arrived} 位已報到，單一時段最高 ${arrivalChart.peakCount} 位`}
                  >
                    {arrivalChart.buckets.map((bucket) => (
                      <div className="arrival-bar-column" key={bucket.start} title={bucket.tooltip}>
                        <span>{bucket.count || ""}</span>
                        <i
                          style={{
                            "--bar-height": `${bucket.count ? Math.max(8, (bucket.count / arrivalChart.peakCount) * 100) : 0}%`,
                          } as CSSProperties}
                        />
                        <small>{bucket.label}</small>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="chart-empty">
                    <span aria-hidden="true">⌁</span>
                    <strong>{arrived ? "資料累積中" : "還沒有報到資料"}</strong>
                    <p>{arrived ? "至少累積四個時間區間後，這裡會顯示抵達節奏。" : "開始掃描後，圖表會用真實報到時間自動建立。"}</p>
                  </div>
                )}
                <p className="chart-source">資料來源：本機名單中的實際報到時間，不含預測資料</p>
              </article>

              <div className="scan-panel live-panel cockpit-live-panel">
                <div className="scan-panel-head">
                  <div><span className="live-dot" /><strong>來賓畫面即時同步</strong></div>
                  <span className="scanner-hint">最近操作 {lastInputAt ? formatTime(lastInputAt) : "—"}</span>
                </div>
                <div className={`live-scan-result ${scanResult ? scanResult.kind : "idle"}`} aria-live="polite">
                  {!scanResult ? (
                    <>
                      <span className="live-person-mark" aria-hidden="true">⌁</span>
                      <div className="live-person-copy">
                        <span>現在掃描</span>
                        <strong>等待掃描或手動報到</strong>
                        <p>結果會同步顯示在另一個來賓畫面</p>
                      </div>
                    </>
                  ) : scanResult.kind === "unknown" ? (
                    <>
                      <span className="live-person-mark" aria-hidden="true">?</span>
                      <div className="live-person-copy">
                        <span>找不到資料</span>
                        <strong>這組 QR Code 不在名單中</strong>
                        <p className="code-preview">{scanResult.code}</p>
                      </div>
                    </>
                  ) : (
                    <>
                      <span className="avatar live-avatar">{scanResult.attendee.name.slice(0, 1).toUpperCase()}</span>
                      <div className="live-person-copy">
                        <span>{scanResult.kind === "success" ? "剛剛完成報到" : "重複掃描"}</span>
                        <strong>{scanResult.attendee.name}</strong>
                        <p>{scanResult.attendee.email || scanResult.attendee.phone || "沒有聯絡資料"} · {scanResult.attendee.ticket}</p>
                      </div>
                      <span className={`live-status ${scanResult.kind}`}>{scanResult.kind === "success" ? "已報到" : "已報到過"}</span>
                    </>
                  )}
                </div>
                <div className="live-panel-actions">
                  <a href="/scan" target="_blank" rel="noreferrer">開啟來賓掃描頁 ↗</a>
                  <span>掃描或手動報到都會更新此處</span>
                </div>
              </div>

              <article className="cockpit-card recent-arrivals-card">
                <div className="cockpit-card-heading">
                  <div><span>最近抵達</span><small>LIVE ARRIVALS</small></div>
                  <strong>{recentArrivals.length ? `最近 ${recentArrivals.length} 位` : "等待中"}</strong>
                </div>
                {recentArrivals.length ? (
                  <div className="recent-arrivals-list">
                    {recentArrivals.map((attendee) => (
                      <div className="recent-arrival" key={attendee.id}>
                        <span className="recent-avatar">{attendee.name.slice(0, 1).toUpperCase()}</span>
                        <div><strong>{attendee.name}</strong><small>{attendee.ticket}</small></div>
                        <time dateTime={attendee.checkedInAt ?? undefined}>{formatTime(attendee.checkedInAt)}</time>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="recent-empty"><span>第一位來賓報到後會出現在這裡</span></div>
                )}
              </article>
            </div>
          </section>

          <section className="display-settings-section">
            <div className="display-settings-copy">
              <p className="section-kicker">Guest display</p>
              <h2>來賓畫面顯示內容</h2>
              <p>勾選的資料會在掃描成功或重複掃描時顯示，變更會立即同步。</p>
            </div>
            <div className="selected-field-summary">
              {selectedDisplayFields.map((field) => (
                <span key={field}>{field}</span>
              ))}
            </div>
            <details className="field-picker">
              <summary>設定顯示欄位 <span>{selectedDisplayFields.length} 個</span></summary>
              <div className="field-picker-grid">
                {selectableDisplayFields.map((field) => (
                  <label key={field} title={field}>
                    <input
                      type="checkbox"
                      checked={selectedDisplayFields.includes(field)}
                      onChange={() => toggleDisplayField(field)}
                    />
                    <span>{field}</span>
                  </label>
                ))}
              </div>
            </details>
            <div className="background-settings">
              <div
                className={`background-preview ${event.displaySettings?.backgroundImageDataUrl ? "has-image" : ""}`}
                style={{
                  backgroundColor: event.displaySettings?.backgroundColor ?? DEFAULT_GUEST_BACKGROUND,
                  ...(event.displaySettings?.backgroundImageDataUrl
                    ? { backgroundImage: `url("${event.displaySettings.backgroundImageDataUrl}")` }
                    : {}),
                }}
                aria-hidden="true"
              >
                {!event.displaySettings?.backgroundImageDataUrl ? <span>預設底色</span> : null}
              </div>
              <div className="background-settings-copy">
                <strong>來賓畫面背景</strong>
                <span>支援 JPG、PNG、WebP，最多 15 MB；會完整顯示、不裁切。</span>
              </div>
              <div className="background-settings-actions">
                <label className="background-color-control">
                  <span>底色</span>
                  <input
                    type="color"
                    value={event.displaySettings?.backgroundColor ?? DEFAULT_GUEST_BACKGROUND}
                    onChange={(changeEvent) => updateBackgroundColor(changeEvent.target.value)}
                    aria-label="選擇來賓畫面背景底色"
                  />
                  <output>{(event.displaySettings?.backgroundColor ?? DEFAULT_GUEST_BACKGROUND).toUpperCase()}</output>
                </label>
                <button
                  type="button"
                  className="background-upload-button"
                  disabled={backgroundUploading}
                  onClick={() => backgroundInputRef.current?.click()}
                >
                  {backgroundUploading
                    ? "處理圖片中…"
                    : event.displaySettings?.backgroundImageDataUrl
                      ? "更換背景"
                      : "上傳背景圖"}
                </button>
                {event.displaySettings?.backgroundImageDataUrl ? (
                  <button type="button" className="background-remove-button" onClick={removeBackground}>
                    移除
                  </button>
                ) : null}
              </div>
            </div>
          </section>

          <section className="guest-section">
            <div className="guest-toolbar">
              <div>
                <p className="section-kicker">Guest list</p>
                <h2>來賓名單</h2>
              </div>
              <div className="toolbar-controls">
                <div className="filter-tabs" role="group" aria-label="篩選名單">
                  <button className={filter === "all" ? "active" : ""} type="button" onClick={() => setFilter("all")}>全部 <span>{total}</span></button>
                  <button className={filter === "pending" ? "active" : ""} type="button" onClick={() => setFilter("pending")}>未報到 <span>{remaining}</span></button>
                  <button className={filter === "arrived" ? "active" : ""} type="button" onClick={() => setFilter("arrived")}>已報到 <span>{arrived}</span></button>
                </div>
                <label className="search-box">
                  <span aria-hidden="true">⌕</span>
                  <span className="visually-hidden">搜尋來賓</span>
                  <input
                    value={search}
                    onChange={(changeEvent) => setSearch(changeEvent.target.value)}
                    placeholder="搜尋姓名、Email、票種"
                  />
                </label>
              </div>
            </div>

            <div className="guest-table-wrap">
              <table className="guest-table">
                <thead>
                  <tr><th>來賓</th><th>票種</th><th>報名狀態</th><th>報到時間</th><th><span className="visually-hidden">操作</span></th></tr>
                </thead>
                <tbody>
                  {visibleAttendees.map((attendee) => (
                    <tr key={attendee.id} className={attendee.checkedInAt ? "is-checked" : ""}>
                      <td>
                        <div className="guest-identity">
                          <span className="avatar">{attendee.name.slice(0, 1).toUpperCase()}</span>
                          <div><strong>{attendee.name}</strong><span>{attendee.email || attendee.phone || "沒有聯絡資料"}</span></div>
                        </div>
                      </td>
                      <td><span className="ticket-chip">{attendee.ticket}</span></td>
                      <td><span className="approval-text">{attendee.approvalStatus || "—"}</span></td>
                      <td>
                        {attendee.checkedInAt ? (
                          <span className="time-stamp"><i />{formatTime(attendee.checkedInAt)}</span>
                        ) : <span className="muted">尚未報到</span>}
                      </td>
                      <td>
                        <button
                          type="button"
                          className={`row-action ${attendee.checkedInAt ? "undo" : "check"}`}
                          onClick={() => toggleCheckIn(attendee)}
                        >
                          {attendee.checkedInAt ? "取消" : "手動報到"}
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {visibleAttendees.length === 0 ? (
                <div className="empty-results"><span>⌕</span><strong>找不到符合的來賓</strong><p>試試其他姓名、Email 或篩選條件。</p></div>
              ) : null}
            </div>
          </section>
        </>
      )}

      <footer>
        <p><span className="brand-mark small">到</span> 抵達 QR 報到台</p>
        <p>完整名單保存在這台瀏覽器；投影牆只接收姓名與報到狀態</p>
      </footer>
    </main>
  );
}
