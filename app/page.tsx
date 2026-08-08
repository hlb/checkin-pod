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
  Attendee,
  CHANNEL_NAME,
  SavedEvent,
  broadcastEventChange,
  clearSavedEvent,
  commitAttendeeCheckIn,
  commitScan,
  compactDate,
  csvEscape,
  defaultDisplayFields,
  filterEligibleAttendees,
  formatTime,
  mutateSavedEvent,
  normalizeHeader,
  parseCsv,
  readBackgroundImageDataUrl,
  readSavedEvent,
  replaceSavedEvent,
  scanKeysFor,
  toAttendees,
  writeBackgroundImageDataUrl,
  writeSavedEvent,
} from "./checkin-core";
import type { CheckInMode, ProjectionCueType, ProjectionPrivacy } from "./checkin-core";
import { appendPendingScan, parsePendingScans, scanQueueKey } from "./scan-queue";
import type { PendingScan } from "./scan-queue";
import {
  MAX_SHARED_ATTENDEES,
  applySharedChanges,
  applySharedScanResult,
  checkInStateSignature,
  createSharedLane,
  defaultEventName,
  deleteSharedEvent,
  diffSingleCheckInState,
  eventDeletionConfirmation,
  fetchSharedChanges,
  fetchSharedEventHistory,
  fetchActiveSharedEventSummary,
  fetchCompleteSharedRoster,
  fetchSharedLanes,
  importSharedEvent,
  renameSharedLane,
  renameSharedEvent,
  restoreSharedEvent,
  revokeSharedLane,
  rotateSharedLane,
  scanSharedEventWithRetry,
  sendSharedProjectionCue,
  setSharedAttendeeCheckIn,
  setSharedEventActive,
  syncSingleCheckInState,
  updateSharedSettings,
} from "./shared-checkin";
import type {
  SharedAdminEventMetadata,
  SharedEventHistoryItem,
  SharedLane,
  SharedLaneRecord,
} from "./shared-checkin";

type ScanResult =
  | { kind: "success"; attendee: Attendee; message: string }
  | { kind: "duplicate"; attendee: Attendee; message: string }
  | { kind: "unknown"; code: string; message: string }
  | { kind: "undone"; attendee: Attendee; message: string };

type Filter = "all" | "pending" | "arrived";

const MAX_ATTENDEES = MAX_SHARED_ATTENDEES;
const GUESTS_PER_PAGE = 100;
const MAX_CSV_FILE_SIZE = 50 * 1024 * 1024;
const MAX_BACKGROUND_FILE_SIZE = 15 * 1024 * 1024;
const MAX_BACKGROUND_WIDTH = 2560;
const MAX_BACKGROUND_HEIGHT = 1440;
const BACKGROUND_IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);
const DEFAULT_GUEST_BACKGROUND = "#0E0F12";
const SINGLE_SYNC_INTERVAL_MS = 5 * 60 * 1_000;
const SINGLE_SYNC_STATUS_INTERVAL_MS = 30_000;

type SingleSyncView = {
  kind: "idle" | "checking" | "pending" | "synced" | "error";
  message: string;
};

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

function formatEventDate(value: string) {
  return new Intl.DateTimeFormat("zh-TW", {
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(value));
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
    : { kind: "duplicate", attendee, message: `${attendee.name} 已報到過` };
}

export default function Home() {
  const [event, setEvent] = useState<SavedEvent | null>(null);
  const [backgroundImageDataUrl, setBackgroundImageDataUrl] = useState<string | null>(null);
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
  const [importProgress, setImportProgress] = useState(0);
  const [guestPage, setGuestPage] = useState(1);
  const [laneName, setLaneName] = useState("");
  const [createdLane, setCreatedLane] = useState<SharedLane | null>(null);
  const [laneBusy, setLaneBusy] = useState(false);
  const [lanes, setLanes] = useState<SharedLaneRecord[]>([]);
  const [laneActionId, setLaneActionId] = useState("");
  const [recoverableEvent, setRecoverableEvent] = useState<SharedAdminEventMetadata | null>(null);
  const [recovering, setRecovering] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [adminScanQueueSize, setAdminScanQueueSize] = useState(0);
  const [importMode, setImportMode] = useState<CheckInMode>("single");
  const [singleSyncView, setSingleSyncView] = useState<SingleSyncView>({ kind: "idle", message: "" });
  const [singleSyncBusy, setSingleSyncBusy] = useState(false);
  const [singleSyncProgress, setSingleSyncProgress] = useState(0);
  const [eventHistory, setEventHistory] = useState<SharedEventHistoryItem[]>([]);
  const [historyLoading, setHistoryLoading] = useState(true);
  const [historyActionId, setHistoryActionId] = useState("");
  const [deleteCandidate, setDeleteCandidate] = useState<SharedEventHistoryItem | null>(null);
  const [deletionInput, setDeletionInput] = useState("");
  const [deletionPasted, setDeletionPasted] = useState(false);
  const [deletionCopyLabel, setDeletionCopyLabel] = useState("複製確認字串");
  const scanInputRef = useRef<HTMLInputElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const backgroundInputRef = useRef<HTMLInputElement>(null);
  const deletionInputRef = useRef<HTMLInputElement>(null);
  const scanBufferRef = useRef("");
  const lastKeyAtRef = useRef(0);
  const scannerIdleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const adminPendingScansRef = useRef<PendingScan[]>([]);
  const adminQueueBusyRef = useRef(false);
  const drainAdminQueueRef = useRef<() => Promise<void>>(async () => undefined);
  const singleSyncBusyRef = useRef(false);
  const sharedEventId = event?.sharedEvent?.eventId;
  const sharedLaneId = event?.sharedEvent?.laneId;
  const sharedInitialCursor = event?.sharedEvent?.cursor ?? 0;
  const currentServerEventId = event?.sharedEvent?.eventId ?? event?.singleSync?.eventId ?? "";
  const singleSyncEventId = event?.checkInMode === "single" ? event.singleSync?.eventId : undefined;
  const singleSyncCursor = event?.checkInMode === "single" ? event.singleSync?.cursor : undefined;
  const singleSyncLastSyncedAt = event?.checkInMode === "single" ? event.singleSync?.lastSyncedAt : undefined;

  const refreshLanes = useCallback(async () => {
    if (!sharedEventId) {
      setLanes([]);
      return;
    }
    try {
      setLanes(await fetchSharedLanes(sharedEventId));
    } catch {
      // Changes polling still verifies connectivity; keep the last good list during a brief outage.
    }
  }, [sharedEventId]);

  const refreshEventHistory = useCallback(async () => {
    try {
      setEventHistory(await fetchSharedEventHistory());
    } catch {
      // Keep the last successful history list during a brief outage.
    } finally {
      setHistoryLoading(false);
    }
  }, []);

  const syncSingleDevice = useCallback(async (source: "initial" | "automatic" | "manual" = "manual") => {
    if (singleSyncBusyRef.current) return;
    singleSyncBusyRef.current = true;
    setSingleSyncBusy(true);
    setSingleSyncProgress(0);
    setSingleSyncView({ kind: "checking", message: "正在同步報到狀態…" });
    try {
      const current = await readSavedEvent();
      if (!current || current.checkInMode !== "single") return;

      let eventId = current.singleSync?.eventId ?? "";
      let cursor = current.singleSync?.cursor ?? 0;
      let changes = [] as ReturnType<typeof diffSingleCheckInState>;
      if (eventId) {
        const localSignature = checkInStateSignature(current.attendees);
        const summary = await fetchActiveSharedEventSummary(eventId);
        const needsRosterComparison = summary?.syncMode === "single"
          && summary.total === current.attendees.length
          && (summary.cursor !== current.singleSync?.cursor
            || localSignature !== current.singleSync?.lastSyncedSignature);
        if (summary?.syncMode === "single" && summary.total === current.attendees.length) {
          cursor = Math.max(cursor, summary.cursor);
          if (needsRosterComparison) {
            const server = await fetchCompleteSharedRoster(eventId);
            const serverIds = new Set(server.attendees.map((attendee) => attendee.id));
            const hasSameRoster = server.attendees.length === current.attendees.length
              && current.attendees.every((attendee) => serverIds.has(attendee.id));
            if (server.event?.syncMode === "single" && hasSameRoster) {
              changes = diffSingleCheckInState(current.attendees, server.attendees);
              cursor = Math.max(cursor, server.event.cursor);
            } else {
              eventId = "";
            }
          }
        } else {
          eventId = "";
        }
      }

      if (!eventId) {
        const connection = await importSharedEvent(
          current,
          (uploaded, total) => setSingleSyncProgress(Math.round((uploaded / total) * 100)),
          "single",
        );
        eventId = connection.eventId;
        cursor = connection.cursor;
      } else if (changes.length) {
        const synced = await syncSingleCheckInState(
          eventId,
          changes,
          (completed, total) => setSingleSyncProgress(Math.round((completed / total) * 100)),
        );
        cursor = Math.max(cursor, synced.cursor);
      }
      await updateSharedSettings(eventId, current.displaySettings ?? { selectedFields: [] });

      const syncedAt = new Date().toISOString();
      const syncedSignature = checkInStateSignature(current.attendees);
      const next = await mutateSavedEvent((latest) => latest.checkInMode === "single"
        ? {
            ...latest,
            singleSync: {
              eventId,
              cursor,
              lastSyncedAt: syncedAt,
              lastSyncedSignature: syncedSignature,
            },
          }
        : latest);
      setEvent(next);
      const hasNewLocalState = checkInStateSignature(next.attendees) !== syncedSignature;
      setSingleSyncView(hasNewLocalState
        ? { kind: "pending", message: "同步期間新增了報到，可立即再同步。" }
        : {
            kind: "synced",
            message: `${changes.length.toLocaleString()} 筆差異已同步 · ${formatTime(syncedAt)}`,
          });
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : "伺服器同步暫時失敗。";
      setSingleSyncView({ kind: "error", message: "本機資料完整，伺服器同步等待重試。" });
      if (source !== "automatic") setError(message);
    } finally {
      singleSyncBusyRef.current = false;
      setSingleSyncBusy(false);
      setSingleSyncProgress(0);
    }
  }, []);

  useEffect(() => {
    const load = async () => {
      try {
        const saved = await readSavedEvent();
        setEvent(saved);
        setScanResult(resultFromSavedEvent(saved));
        setBackgroundImageDataUrl(await readBackgroundImageDataUrl());
        if (!saved) setRecoverableEvent(await fetchActiveSharedEventSummary());
      } catch {
        setError("無法讀取瀏覽器中的報到紀錄，請確認不是使用私密瀏覽模式。");
      } finally {
        setReady(true);
      }
    };
    void load();
  }, []);

  useEffect(() => {
    const initial = window.setTimeout(() => void refreshEventHistory(), 0);
    const timer = window.setInterval(() => void refreshEventHistory(), 30_000);
    return () => {
      window.clearTimeout(initial);
      window.clearInterval(timer);
    };
  }, [refreshEventHistory]);

  useEffect(() => {
    if (!event || event.checkInMode !== "single" || singleSyncBusyRef.current) return;
    const timer = window.setTimeout(() => {
      const signature = checkInStateSignature(event.attendees);
      if (!event.singleSync) {
        setSingleSyncView({ kind: "pending", message: "伺服器等待第一次同步。" });
      } else if (signature !== event.singleSync.lastSyncedSignature) {
        setSingleSyncView({ kind: "pending", message: "本機有新的報到狀態。" });
      } else {
        setSingleSyncView({
          kind: "synced",
          message: `上次同步 ${formatTime(event.singleSync.lastSyncedAt, true)}`,
        });
      }
    }, 0);
    return () => window.clearTimeout(timer);
  }, [event]);

  useEffect(() => {
    if (event?.checkInMode !== "single") return;
    let interval: number | undefined;
    const elapsed = singleSyncLastSyncedAt
      ? Date.now() - new Date(singleSyncLastSyncedAt).getTime()
      : SINGLE_SYNC_INTERVAL_MS;
    const initialDelay = Math.max(0, SINGLE_SYNC_INTERVAL_MS - Math.max(0, elapsed));
    const timeout = window.setTimeout(() => {
      void syncSingleDevice("automatic");
      interval = window.setInterval(() => void syncSingleDevice("automatic"), SINGLE_SYNC_INTERVAL_MS);
    }, initialDelay);
    return () => {
      window.clearTimeout(timeout);
      if (interval) window.clearInterval(interval);
    };
  }, [event?.checkInMode, singleSyncEventId, singleSyncLastSyncedAt, syncSingleDevice]);

  useEffect(() => {
    if (!singleSyncEventId || singleSyncCursor === undefined) return;
    let disposed = false;
    const check = async () => {
      if (singleSyncBusyRef.current) return;
      try {
        const summary = await fetchActiveSharedEventSummary(singleSyncEventId);
        if (!disposed && (!summary || summary.syncMode !== "single" || summary.cursor !== singleSyncCursor)) {
          setSingleSyncView({ kind: "pending", message: "本機與伺服器狀態不同。" });
        }
      } catch {
        if (!disposed) setSingleSyncView({ kind: "error", message: "伺服器狀態等待確認。" });
      }
    };
    const initial = window.setTimeout(() => void check(), 0);
    const timer = window.setInterval(() => void check(), SINGLE_SYNC_STATUS_INTERVAL_MS);
    return () => {
      disposed = true;
      window.clearTimeout(initial);
      window.clearInterval(timer);
    };
  }, [singleSyncCursor, singleSyncEventId]);

  useEffect(() => {
    if (!sharedEventId) return;
    const initial = window.setTimeout(() => void refreshLanes(), 0);
    const timer = window.setInterval(() => void refreshLanes(), 5_000);
    return () => {
      window.clearTimeout(initial);
      window.clearInterval(timer);
    };
  }, [refreshLanes, sharedEventId]);

  useEffect(() => {
    if (!sharedEventId) return;
    let disposed = false;
    let busy = false;
    let nextCursor = sharedInitialCursor;
    const poll = async () => {
      if (busy || disposed) return;
      busy = true;
      try {
        let cursor = nextCursor;
        let hasMore = true;
        while (hasMore && !disposed) {
          const batch = await fetchSharedChanges(sharedEventId, cursor);
          if (!batch.changes.length && batch.cursor === cursor) break;
          cursor = batch.cursor;
          nextCursor = batch.cursor;
          hasMore = batch.hasMore;
          const next = await mutateSavedEvent((current) =>
            current.sharedEvent?.eventId === sharedEventId
              ? applySharedChanges(current, batch.changes, batch.cursor)
              : current,
          );
          if (disposed || next.sharedEvent?.eventId !== sharedEventId) break;
          setEvent(next);
          const latest = batch.changes.at(-1);
          if (latest) {
            setScanResult(resultFromSavedEvent(next));
            setLastInputAt(latest.occurredAt);
            if (latest.laneName) setControlNote(`最近報到來自 ${latest.laneName}`);
          }
        }
      } catch {
        if (!disposed) setError("多工作站同步暫時中斷；正在保留本機畫面並會自動重試。");
      } finally {
        busy = false;
      }
    };
    void poll();
    const timer = window.setInterval(() => void poll(), 700);
    return () => {
      disposed = true;
      window.clearInterval(timer);
    };
  }, [sharedEventId, sharedInitialCursor]);

  useEffect(() => {
    if (typeof BroadcastChannel === "undefined") return;
    const channel = new BroadcastChannel(CHANNEL_NAME);
    channel.onmessage = () => {
      readSavedEvent()
        .then(async (saved) => {
          setEvent(saved);
          setScanResult(resultFromSavedEvent(saved));
          setLastInputAt(saved?.lastScan?.at ?? null);
          setBackgroundImageDataUrl(await readBackgroundImageDataUrl());
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

  const persistAdminQueue = useCallback((connection: SavedEvent["sharedEvent"]) => {
    if (!connection) return;
    const key = scanQueueKey(connection.eventId, connection.laneId);
    if (adminPendingScansRef.current.length) {
      window.localStorage.setItem(key, JSON.stringify(adminPendingScansRef.current));
    } else {
      window.localStorage.removeItem(key);
    }
  }, []);

  const performScan = useCallback(
    async (pending: PendingScan) => {
      if (!event) return;
      const code = pending.code.trim().replace(/[\r\n]+$/g, "");
      if (!code) return;
      const scannedAt = pending.scannedAt;
      setLastInputAt(scannedAt);
      setScanText("");
      try {
        const current = await readSavedEvent() ?? event;
        let committed;
        if (current.sharedEvent) {
          const sharedOutcome = await scanSharedEventWithRetry(
            current.sharedEvent,
            code,
            scannedAt,
            pending.requestId,
          );
          const next = applySharedScanResult(current, { ...sharedOutcome, code });
          await writeSavedEvent(next);
          broadcastEventChange();
          const attendee = sharedOutcome.attendee
            ? next.attendees.find((candidate) => candidate.id === sharedOutcome.attendee?.id)
            : undefined;
          const outcome = { ...sharedOutcome, attendee };
          committed = { event: next, outcome, projectionSync: Promise.resolve(true) };
        } else {
          committed = await commitScan(code, scannedAt);
        }
        setEvent(committed.event);
        const attendee = committed.outcome.attendee;
        setScanResult(committed.outcome.kind === "unknown"
          ? { kind: "unknown", code, message: "名單中找不到這組 QR Code" }
          : committed.outcome.kind === "duplicate"
            ? { kind: "duplicate", attendee: attendee!, message: `${attendee!.name} 已報到過` }
            : { kind: "success", attendee: attendee!, message: `${attendee!.name} 報到成功` });
        if (!(await committed.projectionSync)) {
          setError("報到紀錄已保存在瀏覽器，但投影牆暫時無法同步。");
        }
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : "無法保存報到紀錄，請立即匯出備份。");
        throw caught;
      } finally {
        window.setTimeout(() => scanInputRef.current?.focus(), 0);
      }
    },
    [event],
  );

  const drainAdminQueue = useCallback(async () => {
    if (adminQueueBusyRef.current || !adminPendingScansRef.current.length) return;
    adminQueueBusyRef.current = true;
    try {
      while (adminPendingScansRef.current.length) {
        try {
          await performScan(adminPendingScansRef.current[0]);
          adminPendingScansRef.current.shift();
          persistAdminQueue(event?.sharedEvent);
          setAdminScanQueueSize(adminPendingScansRef.current.length);
        } catch {
          break;
        }
      }
    } finally {
      adminQueueBusyRef.current = false;
    }
  }, [event?.sharedEvent, performScan, persistAdminQueue]);

  useEffect(() => {
    drainAdminQueueRef.current = drainAdminQueue;
  }, [drainAdminQueue]);

  useEffect(() => {
    if (!sharedEventId || !sharedLaneId) return;
    const timer = window.setTimeout(() => {
      adminPendingScansRef.current = parsePendingScans(
        window.localStorage.getItem(scanQueueKey(sharedEventId, sharedLaneId)),
      );
      setAdminScanQueueSize(adminPendingScansRef.current.length);
      if (adminPendingScansRef.current.length) void drainAdminQueueRef.current();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [sharedEventId, sharedLaneId]);

  useEffect(() => {
    const resume = () => void drainAdminQueueRef.current();
    window.addEventListener("online", resume);
    return () => window.removeEventListener("online", resume);
  }, []);

  const handleScan = useCallback((rawCode: string) => {
    if (!event) return;
    const code = rawCode.trim().replace(/[\r\n]+$/g, "");
    if (!code) return;
    const appended = appendPendingScan(adminPendingScansRef.current, {
      code,
      scannedAt: new Date().toISOString(),
      requestId: crypto.randomUUID(),
    });
    if (!appended) {
      setError("等待送出的掃描已達 100 筆，請先檢查網路連線。");
      return;
    }
    persistAdminQueue(event.sharedEvent);
    setAdminScanQueueSize(adminPendingScansRef.current.length);
    void drainAdminQueue();
  }, [drainAdminQueue, event, persistAdminQueue]);

  useEffect(() => {
    if (!event) return;

    const isKnownCode = (code: string) => {
      if (event.sharedEvent) return true;
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
    const isKnown = Boolean(event.sharedEvent) || event.attendees.some((attendee) =>
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
        setError("請選擇 Luma 或 KKTIX 匯出的 CSV 檔案。");
        return;
      }
      if (file.size > MAX_CSV_FILE_SIZE) {
        setError("CSV 檔案上限為 50 MB。請移除報到流程不需要的欄位後再匯入。");
        return;
      }
      if (event && !window.confirm("匯入新名單會取代目前保存在這台瀏覽器的名單，要繼續嗎？")) {
        return;
      }

      setImporting(true);
      setImportProgress(0);
      try {
        const source = await file.text();
        const { headers, rows } = parseCsv(source);
        const importedAt = new Date().toISOString();
        const parsedAttendees = toAttendees(rows, importedAt);
        const attendees = filterEligibleAttendees(parsedAttendees);
        if (attendees.length > MAX_ATTENDEES) {
          throw new Error(
            `這個版本最多支援 ${MAX_ATTENDEES} 位可報到來賓，目前檔案有 ${attendees.length} 位。`,
          );
        }
        if (!attendees.some((attendee) => attendee.qrValue)) {
          throw new Error(
            "找不到 QR Code 欄位。請確認 Luma CSV 包含 qr_code_url，或 KKTIX CSV 包含 QR Code 序號。",
          );
        }
        const nextEvent: SavedEvent = {
          version: 1,
          fileName: file.name,
          eventName: defaultEventName(file.name),
          importedAt,
          headers,
          attendees,
          sourceRowCount: rows.length,
          excludedRowCount: rows.length - attendees.length,
          displaySettings: {
            selectedFields: defaultDisplayFields(headers),
            projectionPrivacy: "count",
          },
          checkInMode: importMode,
        };
        await writeBackgroundImageDataUrl(null);
        const sharedEvent = importMode === "multi"
          ? await importSharedEvent(nextEvent, (uploaded, total) => {
              setImportProgress(Math.round((uploaded / total) * 100));
            }, "multi")
          : undefined;
        const committed = await replaceSavedEvent({ ...nextEvent, sharedEvent });
        setEvent(committed.event);
        setBackgroundImageDataUrl(null);
        if (!(await committed.projectionSync)) {
          setError("名單已保存，但投影牆暫時無法同步。");
        }
        setScanResult(null);
        setFilter("all");
        setSearch("");
        setGuestPage(1);
        if (importMode === "single") await syncSingleDevice("initial");
        await refreshEventHistory();
        window.setTimeout(() => scanInputRef.current?.focus(), 80);
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : "無法讀取這份 CSV，請確認檔案格式。 ");
      } finally {
        setImporting(false);
        setImportProgress(0);
        if (fileInputRef.current) fileInputRef.current.value = "";
      }
    },
    [event, importMode, refreshEventHistory, syncSingleDevice],
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

  const toggleCheckIn = async (attendee: Attendee) => {
    if (!event) return;
    const checkedInAt = attendee.checkedInAt ? null : new Date().toISOString();
    try {
      const committed = event.sharedEvent
        ? await setSharedAttendeeCheckIn(event.sharedEvent.eventId, attendee.id, checkedInAt).then(async (result) => {
            const updated = { ...attendee, checkedInAt: result.attendee.checkedInAt };
            const next: SavedEvent = {
              ...event,
              revision: (event.revision ?? 0) + 1,
              sharedEvent: event.sharedEvent,
              lastScan: checkedInAt ? { kind: "success", attendeeId: attendee.id, at: checkedInAt } : event.lastScan,
              attendees: event.attendees.map((item) => item.id === attendee.id ? updated : item),
            };
            await writeSavedEvent(next);
            broadcastEventChange();
            return { event: next, attendee: updated, projectionSync: Promise.resolve(true) };
          })
        : await commitAttendeeCheckIn(attendee.id, checkedInAt);
      setEvent(committed.event);
      if (checkedInAt) setLastInputAt(checkedInAt);
      setScanResult(
        checkedInAt
          ? { kind: "success", attendee: committed.attendee, message: `${attendee.name} 手動報到成功` }
          : { kind: "undone", attendee: committed.attendee, message: `已取消 ${attendee.name} 的報到` },
      );
      if (!(await committed.projectionSync)) {
        setError("報到紀錄已保存在瀏覽器，但投影牆暫時無法同步。");
      }
    } catch {
      setError("無法保存手動報到狀態，請再試一次。");
    }
    window.setTimeout(() => scanInputRef.current?.focus(), 0);
  };

  const exportCsv = async () => {
    if (!event) return;
    setExporting(true);
    let exportEvent = event;
    try {
      if (event.sharedEvent) {
        const restored = await fetchCompleteSharedRoster(event.sharedEvent.eventId);
        if (!restored.event) throw new Error("伺服器找不到目前活動名單。");
        exportEvent = { ...event, attendees: restored.attendees };
      }
      const statusHeader = exportEvent.headers.includes("local_check_in_status")
        ? "checkin_local_status"
        : "local_check_in_status";
      const timeHeader = exportEvent.headers.includes("local_checked_in_at")
        ? "checkin_local_checked_in_at"
        : "local_checked_in_at";
      const exportHeaders = [...exportEvent.headers, statusHeader, timeHeader];
      const lines = [
        exportHeaders.map(csvEscape).join(","),
        ...exportEvent.attendees.map((attendee) =>
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
      const baseName = exportEvent.fileName.replace(/\.csv$/i, "") || "luma-guests";
      link.href = url;
      link.download = `${baseName}_checkin_${compactDate(new Date())}.csv`;
      link.click();
      URL.revokeObjectURL(url);
      setShowMenu(false);
      window.setTimeout(() => scanInputRef.current?.focus(), 0);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "無法從伺服器匯出最新紀錄。");
    } finally {
      setExporting(false);
    }
  };

  const downloadSample = (attendeeCount: 150 | 10_000) => {
    const fileName = attendeeCount === 150
      ? "checkin-pod-sample-150.zip"
      : "checkin-pod-sample-10000.zip";
    const link = document.createElement("a");
    link.href = `/${fileName}`;
    link.download = fileName;
    link.click();
  };

  const replaceList = () => {
    setShowMenu(false);
    fileInputRef.current?.click();
  };

  const removeList = async () => {
    if (!event || !window.confirm("確定要清除這台瀏覽器中的名單與所有報到紀錄嗎？此動作無法復原。")) {
      return;
    }
    const serverEventId = event.sharedEvent?.eventId ?? event.singleSync?.eventId;
    if (serverEventId) await setSharedEventActive(serverEventId, false).catch(() => undefined);
    await clearSavedEvent();
    broadcastEventChange();
    setEvent(null);
    setBackgroundImageDataUrl(null);
    setScanResult(null);
    setSearch("");
    setFilter("all");
    setShowMenu(false);
    await refreshEventHistory();
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
    void mutateSavedEvent((current) => ({
      ...current,
      displaySettings: { ...current.displaySettings, selectedFields },
    })).then(async (next) => {
      setEvent(next);
      const serverEventId = next.sharedEvent?.eventId ?? next.singleSync?.eventId;
      if (serverEventId) await updateSharedSettings(serverEventId, next.displaySettings!);
    }).catch(() => setError("無法保存來賓畫面欄位設定。"));
  };

  const handleBackgroundChange = async (changeEvent: ChangeEvent<HTMLInputElement>) => {
    const input = changeEvent.currentTarget;
    const file = input.files?.[0];
    if (!file) return;
    setError("");
    setBackgroundUploading(true);
    try {
      const backgroundImageDataUrl = await prepareBackgroundImage(file);
      await writeBackgroundImageDataUrl(backgroundImageDataUrl);
      setBackgroundImageDataUrl(backgroundImageDataUrl);
      broadcastEventChange();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "無法設定這張背景圖。");
    } finally {
      setBackgroundUploading(false);
      input.value = "";
      window.setTimeout(() => scanInputRef.current?.focus(), 0);
    }
  };

  const removeBackground = () => {
    if (!backgroundImageDataUrl) return;
    void writeBackgroundImageDataUrl(null)
      .then(() => {
        setBackgroundImageDataUrl(null);
        broadcastEventChange();
      })
      .catch(() => setError("無法移除背景圖。"));
    window.setTimeout(() => scanInputRef.current?.focus(), 0);
  };

  const updateBackgroundColor = (backgroundColor: string) => {
    if (!event || !/^#[0-9a-f]{6}$/i.test(backgroundColor)) return;
    void mutateSavedEvent((current) => ({
      ...current,
      displaySettings: {
        ...current.displaySettings,
        selectedFields: selectedDisplayFields,
        backgroundColor,
      },
    })).then(async (next) => {
      setEvent(next);
      const serverEventId = next.sharedEvent?.eventId ?? next.singleSync?.eventId;
      if (serverEventId) await updateSharedSettings(serverEventId, next.displaySettings!);
    }).catch(() => setError("無法保存背景底色。"));
  };

  const updateProjectionPrivacy = (projectionPrivacy: ProjectionPrivacy) => {
    if (!event) return;
    void mutateSavedEvent((current) => ({
      ...current,
      displaySettings: {
        ...current.displaySettings,
        selectedFields: selectedDisplayFields,
        projectionPrivacy,
      },
    })).then(async (next) => {
      setEvent(next);
      const serverEventId = next.sharedEvent?.eventId ?? next.singleSync?.eventId;
      if (serverEventId) await updateSharedSettings(serverEventId, next.displaySettings!);
    }).catch(() => setError("無法保存投影牆隱私設定。"));
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
      const serverEventId = event?.sharedEvent?.eventId ?? event?.singleSync?.eventId;
      if (!serverEventId) throw new Error("活動正在建立投影資料，請稍後再試。");
      await sendSharedProjectionCue(serverEventId, type);
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
        return [attendee.name, attendee.email, attendee.phone, attendee.ticket, ...attendee.scanKeys]
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
  const guestPageCount = Math.max(1, Math.ceil(visibleAttendees.length / GUESTS_PER_PAGE));
  const pagedAttendees = visibleAttendees.slice(
    (Math.min(guestPage, guestPageCount) - 1) * GUESTS_PER_PAGE,
    Math.min(guestPage, guestPageCount) * GUESTS_PER_PAGE,
  );

  const addLane = async () => {
    if (!event?.sharedEvent || !laneName.trim()) return;
    setLaneBusy(true);
    try {
      const lane = await createSharedLane(event.sharedEvent.eventId, laneName.trim());
      setCreatedLane(lane);
      setLaneName("");
      await refreshLanes();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "無法建立工作站。");
    } finally {
      setLaneBusy(false);
    }
  };

  const restoreEvent = async () => {
    setRecovering(true);
    setError("");
    try {
      const restored = await restoreSharedEvent(recoverableEvent?.eventId);
      if (!restored) throw new Error("目前沒有可以復原的進行中活動。");
      const serverEventId = restored.sharedEvent?.eventId ?? restored.singleSync?.eventId;
      if (serverEventId) await setSharedEventActive(serverEventId, true);
      const committed = await replaceSavedEvent(restored);
      setEvent(committed.event);
      setRecoverableEvent(null);
      setBackgroundImageDataUrl(null);
      setScanResult(null);
      await refreshEventHistory();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "無法復原活動名單。");
    } finally {
      setRecovering(false);
    }
  };

  const loadHistoryEvent = async (historyEvent: SharedEventHistoryItem) => {
    if (historyEvent.eventId === currentServerEventId) return;
    if (event && !window.confirm("載入歷史活動會取代這台裝置目前顯示的活動。伺服器上的活動資料會保留。要繼續嗎？")) {
      return;
    }
    setHistoryActionId(historyEvent.eventId);
    setError("");
    try {
      const restored = await restoreSharedEvent(historyEvent.eventId);
      if (!restored) throw new Error("找不到這場歷史活動。");
      await setSharedEventActive(historyEvent.eventId, true);
      const committed = await replaceSavedEvent(restored);
      setEvent(committed.event);
      setRecoverableEvent(null);
      setBackgroundImageDataUrl(null);
      setScanResult(null);
      setFilter("all");
      setSearch("");
      setGuestPage(1);
      await refreshEventHistory();
      window.scrollTo({ top: 0, behavior: "smooth" });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "無法載入這場歷史活動。");
    } finally {
      setHistoryActionId("");
    }
  };

  const editEventName = async (eventId: string, currentName: string) => {
    const entered = window.prompt("輸入活動名稱", currentName);
    const eventName = entered?.trim();
    if (!eventName || eventName === currentName) return;
    setHistoryActionId(eventId);
    setError("");
    try {
      const renamed = await renameSharedEvent(eventId, eventName);
      setEventHistory((history) => history.map((item) =>
        item.eventId === eventId ? { ...item, eventName: renamed.eventName } : item));
      setRecoverableEvent((current) => current?.eventId === eventId
        ? { ...current, eventName: renamed.eventName }
        : current);
      if (eventId === currentServerEventId) {
        const next = await mutateSavedEvent((current) => ({ ...current, eventName: renamed.eventName }));
        setEvent(next);
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "無法更新活動名稱。");
    } finally {
      setHistoryActionId("");
    }
  };

  const openDeleteDialog = (historyEvent: SharedEventHistoryItem) => {
    setDeleteCandidate(historyEvent);
    setDeletionInput("");
    setDeletionPasted(false);
    setDeletionCopyLabel("複製確認字串");
    window.setTimeout(() => deletionInputRef.current?.focus(), 0);
  };

  const closeDeleteDialog = () => {
    if (deleteCandidate && historyActionId === deleteCandidate.eventId) return;
    setDeleteCandidate(null);
    setDeletionInput("");
    setDeletionPasted(false);
  };

  const copyDeletionConfirmation = async () => {
    if (!deleteCandidate) return;
    try {
      await navigator.clipboard.writeText(eventDeletionConfirmation(deleteCandidate.eventId));
      setDeletionCopyLabel("已複製，請貼到下方");
    } catch {
      setDeletionCopyLabel("請選取字串並複製");
    }
  };

  const confirmDeleteHistoryEvent = async () => {
    if (!deleteCandidate) return;
    const confirmation = eventDeletionConfirmation(deleteCandidate.eventId);
    if (!deletionPasted || deletionInput !== confirmation) return;
    const deletedEventId = deleteCandidate.eventId;
    const deletesCurrentEvent = deletedEventId === currentServerEventId;
    setHistoryActionId(deletedEventId);
    setError("");
    try {
      await deleteSharedEvent(deletedEventId, deletionInput);
      if (deletesCurrentEvent) {
        await clearSavedEvent();
        broadcastEventChange();
        setEvent(null);
        setBackgroundImageDataUrl(null);
        setScanResult(null);
        setSearch("");
        setFilter("all");
      }
      if (recoverableEvent?.eventId === deletedEventId) setRecoverableEvent(null);
      setEventHistory((history) => history.filter((item) => item.eventId !== deletedEventId));
      setDeleteCandidate(null);
      setDeletionInput("");
      setDeletionPasted(false);
      await refreshEventHistory();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "無法刪除這場活動。");
    } finally {
      setHistoryActionId("");
    }
  };

  const stopLane = async (lane: SharedLaneRecord) => {
    if (!event?.sharedEvent || !window.confirm(`確定停用「${lane.laneName}」？這台設備的舊連結會立即失效。`)) return;
    setLaneActionId(lane.laneId);
    try {
      await revokeSharedLane(event.sharedEvent.eventId, lane.laneId);
      await refreshLanes();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "無法停用工作站。");
    } finally {
      setLaneActionId("");
    }
  };

  const editLaneName = async (lane: SharedLaneRecord) => {
    if (!event?.sharedEvent) return;
    const nextName = window.prompt("工作站名稱", lane.laneName)?.trim();
    if (!nextName || nextName === lane.laneName) return;
    setLaneActionId(lane.laneId);
    try {
      await renameSharedLane(event.sharedEvent.eventId, lane.laneId, nextName);
      if (lane.laneId === event.sharedEvent.laneId) {
        const next = await mutateSavedEvent((current) => current.sharedEvent
          ? { ...current, sharedEvent: { ...current.sharedEvent, laneName: nextName } }
          : current);
        setEvent(next);
      }
      await refreshLanes();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "無法重新命名工作站。");
    } finally {
      setLaneActionId("");
    }
  };

  const renewLaneLink = async (lane: SharedLaneRecord) => {
    if (!event?.sharedEvent || !window.confirm(`重新產生「${lane.laneName}」連結後，舊連結會立即失效。要繼續嗎？`)) return;
    setLaneActionId(lane.laneId);
    try {
      const renewed = await rotateSharedLane(event.sharedEvent.eventId, lane.laneId);
      setCreatedLane(renewed);
      await refreshLanes();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "無法重新產生工作站連結。");
    } finally {
      setLaneActionId("");
    }
  };

  const copyLaneUrl = async () => {
    if (!createdLane) return;
    await navigator.clipboard.writeText(createdLane.url);
    setControlNote(`${createdLane.laneName} 的工作站連結已複製`);
  };

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
        aria-label="選擇 Luma 或 KKTIX CSV 檔案"
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
        <a className="brand" href="#top" aria-label="Checkin Pod 首頁">
          <span className="brand-mark">P</span>
          <span>Checkin Pod</span>
          <span className="brand-subtitle">活動報到輔助機</span>
        </a>
        <div className="top-actions">
          {event ? (
            <>
              <span className="saved-pill"><i /> {event.checkInMode === "multi" ? "多機即時同步" : "單機 · 已儲存在此裝置"}</span>
              <a className="display-button" href="/scan" target="_blank" rel="noreferrer">
                開啟來賓畫面 <span aria-hidden="true">↗</span>
              </a>
              <a className="display-button projection-link" href="/projection" target="_blank" rel="noreferrer">
                開啟投影牆 <span aria-hidden="true">↗</span>
              </a>
              <button className="export-button" type="button" disabled={exporting} onClick={() => void exportCsv()}>
                <span aria-hidden="true">↓</span> {exporting ? "正在取得最新紀錄…" : "匯出結果"}
              </button>
            </>
          ) : null}
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
                {event ? (
                  <>
                    <button type="button" onClick={replaceList}>匯入新名單</button>
                    <button type="button" className="danger-item" onClick={() => void removeList()}>
                      清除本機紀錄
                    </button>
                  </>
                ) : null}
                <form method="post" action="/admin-auth/logout">
                  <button className="logout-item" type="submit">登出中控台</button>
                </form>
              </div>
            ) : null}
          </div>
        </div>
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
              匯入 Luma 或 KKTIX 活動名單，選擇單機或多機報到。系統預設單機，最多支援 10,000 人。
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
            <h2>{importing ? "正在讀取名單…" : "把 Luma / KKTIX CSV 放到這裡"}</h2>
            <p>或從電腦選擇一份檔案</p>
            <fieldset className="checkin-mode-picker" disabled={importing}>
              <legend>報到模式</legend>
              <label aria-label="單機報到" htmlFor="checkin-mode-single" className={importMode === "single" ? "is-selected" : ""}>
                <input
                  id="checkin-mode-single"
                  type="radio"
                  name="checkin-mode"
                  value="single"
                  checked={importMode === "single"}
                  onChange={() => setImportMode("single")}
                />
                <span><strong>單機</strong><small>本機報到 · 每 5 分鐘備份</small></span>
              </label>
              <label aria-label="多機報到" htmlFor="checkin-mode-multi" className={importMode === "multi" ? "is-selected" : ""}>
                <input
                  id="checkin-mode-multi"
                  type="radio"
                  name="checkin-mode"
                  value="multi"
                  checked={importMode === "multi"}
                  onChange={() => setImportMode("multi")}
                />
                <span><strong>多機</strong><small>多入口即時防重複</small></span>
              </label>
            </fieldset>
            <button
              className="primary-button"
              type="button"
              disabled={importing}
              onClick={() => fileInputRef.current?.click()}
            >
              {importing ? `準備名單中${importProgress ? ` · ${importProgress}%` : "…"}` : "選擇 CSV 檔案"}
            </button>
            <div className="sample-downloads">
              <button className="sample-link" type="button" onClick={() => downloadSample(150)}>
                下載 150 人範例（ZIP）
              </button>
              <button className="sample-link" type="button" onClick={() => downloadSample(10_000)}>
                下載 10,000 人範例（ZIP）
              </button>
            </div>
            <small className="sample-note">兩份範例共用同一組測試 QR Code</small>
            {recoverableEvent ? (
              <div className="restore-event-card">
                <div>
                  <span>找到進行中的活動</span>
                  <strong>{recoverableEvent.eventName || defaultEventName(recoverableEvent.fileName)}</strong>
                  <small>{recoverableEvent.total.toLocaleString()} 位來賓 · {recoverableEvent.syncMode === "single" ? "單機備份" : "多機活動"}可完整復原</small>
                </div>
                <button type="button" disabled={recovering} onClick={() => void restoreEvent()}>
                  {recovering ? "復原中…" : "復原活動"}
                </button>
              </div>
            ) : null}
            <div className="privacy-note">
              <span aria-hidden="true">⌂</span>
              {importMode === "single" ? (
                <p><strong>完整名單保存在這台裝置</strong><br />報到狀態每 5 分鐘備份至伺服器</p>
              ) : (
                <p><strong>名單同步至每個活動入口</strong><br />共用資料庫即時防止重複入場</p>
              )}
            </div>
          </div>
        </section>
      ) : (
        <>
          <section className="event-dashboard" id="top">
            <div className="dashboard-heading">
              <div>
                <p className="eyebrow"><span /> Live operations</p>
                <div className="event-title-line">
                  <h1>{event.eventName ?? defaultEventName(event.fileName)}</h1>
                  {currentServerEventId ? (
                    <button
                      type="button"
                      disabled={Boolean(historyActionId)}
                      onClick={() => void editEventName(currentServerEventId, event.eventName ?? defaultEventName(event.fileName))}
                    >
                      改活動名稱
                    </button>
                  ) : null}
                </div>
                <p className="file-meta">
                  {event.fileName} · {total} 位可報到
                  {event.excludedRowCount ? ` · 已略過 ${event.excludedRowCount} 筆不可報到資料` : ""}
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
                <div><strong>開啟投影牆</strong><small>投影電腦以相同網站網址開啟</small></div>
              </a>
            </div>

            {event.checkInMode === "single" ? (
              <section className={`single-sync-control is-${singleSyncView.kind}`} aria-label="單機同步狀態">
                <div className="single-sync-copy">
                  <span>Single-device backup</span>
                  <strong>單機報到</strong>
                  <p>完整名單與報到操作保存在這台裝置。報到狀態每 5 分鐘同步至伺服器。</p>
                </div>
                <div className="single-sync-status" aria-live="polite">
                  <i aria-hidden="true" />
                  <div>
                    <strong>{singleSyncBusy ? "正在同步" : singleSyncView.kind === "synced" ? "同步完成" : "等待同步"}</strong>
                    <span>{singleSyncProgress ? `${singleSyncProgress}% · ` : ""}{singleSyncView.message}</span>
                  </div>
                </div>
                <button type="button" disabled={singleSyncBusy} onClick={() => void syncSingleDevice("manual")}>
                  {singleSyncBusy ? "同步中…" : "立即同步"}
                </button>
              </section>
            ) : null}

            {event.sharedEvent ? (
              <section className="lane-control" aria-label="多工作站報到">
                <div className="lane-control-copy">
                  <span>Multi-device lanes</span>
                  <strong>新增報到工作站</strong>
                  <p>每台設備使用自己的連結；所有掃描都由共用資料庫原子判定，避免重複入場。</p>
                </div>
                <div className="lane-create-form">
                  <label>
                    <span>工作站名稱</span>
                    <input
                      value={laneName}
                      maxLength={80}
                      placeholder="例如：入口 A、二樓報到處"
                      onChange={(changeEvent) => setLaneName(changeEvent.target.value)}
                    />
                  </label>
                  <button type="button" disabled={laneBusy || !laneName.trim()} onClick={() => void addLane()}>
                    {laneBusy ? "建立中…" : "建立工作站連結"}
                  </button>
                </div>
                {createdLane ? (
                  <div className="lane-link-result" aria-live="polite">
                    <div><span>已建立</span><strong>{createdLane.laneName}</strong></div>
                    <code>{createdLane.url}</code>
                    <button type="button" onClick={() => void copyLaneUrl()}>複製連結</button>
                    <a href={createdLane.url} target="_blank" rel="noreferrer">在這台電腦開啟 ↗</a>
                  </div>
                ) : null}
                <div className="lane-list">
                  <div className="lane-list-heading">
                    <strong>工作站列表</strong>
                    <span>{lanes.filter((lane) => !lane.revokedAt).length} 個啟用中</span>
                  </div>
                  {lanes.map((lane) => {
                    const isCurrent = lane.laneId === event.sharedEvent?.laneId;
                    const busy = laneActionId === lane.laneId;
                    return (
                      <div className={`lane-list-item ${lane.revokedAt ? "is-revoked" : ""}`} key={lane.laneId}>
                        <span className="lane-state-dot" aria-hidden="true" />
                        <div className="lane-list-name">
                          <strong>{lane.laneName}</strong>
                          <span>
                            {isCurrent ? "此裝置 · " : ""}{lane.revokedAt ? "已停用" : lane.lastSeenAt ? `最近使用 ${formatTime(lane.lastSeenAt, true)}` : "尚未連線"}
                          </span>
                        </div>
                        <div className="lane-count"><strong>{lane.successCount.toLocaleString()}</strong><span>成功報到</span></div>
                        <div className="lane-list-actions">
                          <button type="button" disabled={busy} onClick={() => void editLaneName(lane)}>改名</button>
                          <button type="button" disabled={busy || isCurrent} onClick={() => void renewLaneLink(lane)}>
                            {lane.revokedAt ? "重新啟用" : "換發連結"}
                          </button>
                          {!lane.revokedAt ? (
                            <button type="button" className="danger" disabled={busy || isCurrent} onClick={() => void stopLane(lane)}>停用</button>
                          ) : null}
                        </div>
                      </div>
                    );
                  })}
                  {!lanes.length ? <p className="lane-list-empty">正在讀取工作站…</p> : null}
                </div>
              </section>
            ) : null}

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
                  <span className="scanner-hint">{adminScanQueueSize ? `等待處理 ${adminScanQueueSize} 筆 · ` : ""}最近操作 {lastInputAt ? formatTime(lastInputAt) : "—"}</span>
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
            <div className="projection-privacy-setting">
              <div>
                <strong>投影牆姓名</strong>
                <span>公開畫面預設只顯示匿名來賓。</span>
              </div>
              <select
                value={event.displaySettings?.projectionPrivacy ?? "count"}
                onChange={(changeEvent) => updateProjectionPrivacy(changeEvent.target.value as ProjectionPrivacy)}
                aria-label="投影牆姓名顯示方式"
              >
                <option value="count">匿名來賓</option>
                <option value="masked">姓名遮罩</option>
                <option value="names">完整姓名</option>
              </select>
            </div>
            <div className="background-settings">
              <div
                className={`background-preview ${backgroundImageDataUrl ? "has-image" : ""}`}
                style={{
                  backgroundColor: event.displaySettings?.backgroundColor ?? DEFAULT_GUEST_BACKGROUND,
                  ...(backgroundImageDataUrl
                    ? { backgroundImage: `url("${backgroundImageDataUrl}")` }
                    : {}),
                }}
                aria-hidden="true"
              >
                {!backgroundImageDataUrl ? <span>預設底色</span> : null}
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
                    : backgroundImageDataUrl
                      ? "更換背景"
                      : "上傳背景圖"}
                </button>
                {backgroundImageDataUrl ? (
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
                  <button className={filter === "all" ? "active" : ""} type="button" onClick={() => { setFilter("all"); setGuestPage(1); }}>全部 <span>{total}</span></button>
                  <button className={filter === "pending" ? "active" : ""} type="button" onClick={() => { setFilter("pending"); setGuestPage(1); }}>未報到 <span>{remaining}</span></button>
                  <button className={filter === "arrived" ? "active" : ""} type="button" onClick={() => { setFilter("arrived"); setGuestPage(1); }}>已報到 <span>{arrived}</span></button>
                </div>
                <label className="search-box">
                  <span aria-hidden="true">⌕</span>
                  <span className="visually-hidden">搜尋來賓</span>
                  <input
                    value={search}
                    onChange={(changeEvent) => { setSearch(changeEvent.target.value); setGuestPage(1); }}
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
                  {pagedAttendees.map((attendee) => (
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
            {visibleAttendees.length > GUESTS_PER_PAGE ? (
              <nav className="guest-pagination" aria-label="來賓名單分頁">
                <span>共 {visibleAttendees.length.toLocaleString()} 位 · 第 {Math.min(guestPage, guestPageCount)} / {guestPageCount} 頁</span>
                <div>
                  <button type="button" disabled={guestPage <= 1} onClick={() => setGuestPage((page) => Math.max(1, page - 1))}>上一頁</button>
                  <button type="button" disabled={guestPage >= guestPageCount} onClick={() => setGuestPage((page) => Math.min(guestPageCount, page + 1))}>下一頁</button>
                </div>
              </nav>
            ) : null}
          </section>
        </>
      )}

      <section className="event-history-section" aria-labelledby="event-history-title">
        <div className="event-history-heading">
          <div>
            <p className="section-kicker">Event history</p>
            <h2 id="event-history-title">活動歷史</h2>
            <p>伺服器分開保存每場活動的名單與報到紀錄。可在這台裝置載入任一活動。</p>
          </div>
          <button
            type="button"
            disabled={historyLoading}
            onClick={() => {
              setHistoryLoading(true);
              void refreshEventHistory();
            }}
          >
            {historyLoading ? "更新中…" : "更新列表"}
          </button>
        </div>
        <div className="event-history-list">
          {eventHistory.map((historyEvent) => {
            const isCurrent = historyEvent.eventId === currentServerEventId;
            const progress = historyEvent.total
              ? Math.round((historyEvent.arrived / historyEvent.total) * 100)
              : 0;
            return (
              <article className={`event-history-item ${isCurrent ? "is-current" : ""}`} key={historyEvent.eventId}>
                <div className="event-history-name">
                  <div>
                    {isCurrent ? <span className="current-event-badge">目前裝置</span> : null}
                    {historyEvent.active ? <span className="active-event-badge">投影中</span> : null}
                  </div>
                  <strong>{historyEvent.eventName}</strong>
                  <small>{historyEvent.fileName} · {formatEventDate(historyEvent.importedAt)} · {historyEvent.syncMode === "single" ? "單機" : "多機"} · 保留至 {formatEventDate(historyEvent.expiresAt)}</small>
                </div>
                <div className="event-history-progress">
                  <div><span>報到進度</span><strong>{historyEvent.arrived.toLocaleString()} / {historyEvent.total.toLocaleString()}</strong></div>
                  <div className="history-progress-track" role="progressbar" aria-label={`${historyEvent.eventName} 報到進度`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress}>
                    <i style={{ width: `${progress}%` }} />
                  </div>
                </div>
                <div className="event-history-actions">
                  <button
                    className="history-rename-button"
                    type="button"
                    disabled={Boolean(historyActionId)}
                    onClick={() => void editEventName(historyEvent.eventId, historyEvent.eventName)}
                  >
                    改名
                  </button>
                  <button
                    type="button"
                    disabled={isCurrent || Boolean(historyActionId)}
                    onClick={() => void loadHistoryEvent(historyEvent)}
                  >
                    {isCurrent ? "目前活動" : historyActionId === historyEvent.eventId ? "處理中…" : "載入活動"}
                  </button>
                  <button
                    className="history-delete-button"
                    type="button"
                    disabled={Boolean(historyActionId)}
                    onClick={() => openDeleteDialog(historyEvent)}
                  >
                    刪除
                  </button>
                </div>
              </article>
            );
          })}
          {!eventHistory.length ? (
            <div className="event-history-empty">
              <strong>{historyLoading ? "正在讀取活動…" : "目前沒有活動紀錄"}</strong>
              <span>{historyLoading ? "" : "匯入第一份 CSV 後，活動會顯示在這裡。"}</span>
            </div>
          ) : null}
        </div>
        {eventHistory.length >= 100 ? <p className="event-history-limit">顯示最近 100 場活動</p> : null}
      </section>

      {deleteCandidate ? (
        <div
          className="event-delete-overlay"
          role="presentation"
          onKeyDown={(keyboardEvent) => {
            if (keyboardEvent.key === "Escape") closeDeleteDialog();
          }}
          onMouseDown={(mouseEvent) => {
            if (mouseEvent.target === mouseEvent.currentTarget) closeDeleteDialog();
          }}
        >
          <section className="event-delete-dialog" role="dialog" aria-modal="true" aria-labelledby="event-delete-title" aria-describedby="event-delete-description">
            <span className="event-delete-mark" aria-hidden="true">!</span>
            <p className="section-kicker">Permanent deletion</p>
            <h2 id="event-delete-title">永久刪除活動</h2>
            <p id="event-delete-description">
              「{deleteCandidate.eventName}」的名單、報到紀錄與工作站連結會從伺服器永久刪除。
            </p>
            {deleteCandidate.eventId === currentServerEventId ? <p className="event-delete-current-note">這是目前裝置使用的活動。本機名單也會一併清除。</p> : null}
            <div className="event-delete-confirmation">
              <span>步驟 1：複製確認字串</span>
              <div>
                <code>{eventDeletionConfirmation(deleteCandidate.eventId)}</code>
                <button type="button" onClick={() => void copyDeletionConfirmation()}>{deletionCopyLabel}</button>
              </div>
            </div>
            <label className="event-delete-input" htmlFor="event-delete-confirmation-input">
              <span>步驟 2：貼上確認字串</span>
              <input
                id="event-delete-confirmation-input"
                ref={deletionInputRef}
                value={deletionInput}
                onChange={(changeEvent) => setDeletionInput(changeEvent.target.value)}
                onPaste={() => setDeletionPasted(true)}
                placeholder="請貼上確認字串"
                autoComplete="off"
                spellCheck={false}
              />
            </label>
            <div className="event-delete-actions">
              <button type="button" onClick={closeDeleteDialog} disabled={historyActionId === deleteCandidate.eventId}>取消</button>
              <button
                className="confirm-delete-button"
                type="button"
                disabled={!deletionPasted || deletionInput !== eventDeletionConfirmation(deleteCandidate.eventId) || historyActionId === deleteCandidate.eventId}
                onClick={() => void confirmDeleteHistoryEvent()}
              >
                {historyActionId === deleteCandidate.eventId ? "刪除中…" : "永久刪除"}
              </button>
            </div>
          </section>
        </div>
      ) : null}

      <footer>
        <p><span className="brand-mark small">P</span> Checkin Pod · 活動報到輔助機</p>
        <p>{event?.checkInMode === "multi" ? "多機模式使用共用資料庫即時同步" : "單機模式使用本機名單與五分鐘伺服器備份"}</p>
      </footer>
    </main>
  );
}
