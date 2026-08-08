"use client";

import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties } from "react";
import {
  Attendee,
  CHANNEL_NAME,
  LastScan,
  SavedEvent,
  displayValue,
  formatTime,
  getDisplayFields,
  labelForField,
  readBackgroundImageDataUrl,
  readSavedEvent,
  scanKeysFor,
  writeSavedEvent,
} from "../checkin-core";
import { activateSharedLane, readSharedLane, scanSharedEvent } from "../shared-checkin";
import type { SharedAttendeeResult, SharedLaneBootstrap, SharedLaneSession } from "../shared-checkin";

type GuestResult = {
  kind: LastScan["kind"];
  attendee?: Attendee | SharedAttendeeResult;
  at: string;
};

type DetectedBarcode = { rawValue: string };
type BarcodeDetectorInstance = {
  detect(source: HTMLVideoElement): Promise<DetectedBarcode[]>;
};
type BarcodeDetectorConstructor = {
  new (options: { formats: string[] }): BarcodeDetectorInstance;
  getSupportedFormats?: () => Promise<string[]>;
};
type CameraDevice = { deviceId: string; label: string };

const RESULT_DURATION_MS = 6500;
const DEFAULT_GUEST_BACKGROUND = "#0E0F12";
const LANE_SESSION_KEY = "checkin-pod-lane-session";

function cameraDevicesFrom(devices: MediaDeviceInfo[]): CameraDevice[] {
  return devices
    .filter((device) => device.kind === "videoinput")
    .map((device, index) => ({
      deviceId: device.deviceId,
      label: device.label || `鏡頭 ${index + 1}`,
    }));
}

function guestResultFromSavedEvent(saved: SavedEvent | null): GuestResult | null {
  if (!saved?.lastScan) return null;
  const attendee = saved.lastScan.attendeeId
    ? saved.attendees.find((item) => item.id === saved.lastScan?.attendeeId)
    : undefined;
  if (saved.lastScan.kind === "unknown") {
    return { kind: "unknown", at: saved.lastScan.at };
  }
  if (!attendee) return null;
  return { kind: saved.lastScan.kind, attendee, at: saved.lastScan.at };
}

function guestDisplayValue(attendee: Attendee | SharedAttendeeResult, field: string) {
  if ("displayValues" in attendee) return attendee.displayValues[field]?.trim() || "—";
  return displayValue(attendee, field);
}

export default function ScanPage() {
  const [event, setEvent] = useState<SavedEvent | null>(null);
  const [backgroundImageDataUrl, setBackgroundImageDataUrl] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [result, setResult] = useState<GuestResult | null>(null);
  const [error, setError] = useState("");
  const [cameraActive, setCameraActive] = useState(false);
  const [cameraBusy, setCameraBusy] = useState(false);
  const [cameraError, setCameraError] = useState("");
  const [cameraDevices, setCameraDevices] = useState<CameraDevice[]>([]);
  const [selectedCameraId, setSelectedCameraId] = useState("");
  const [resultSoundEnabled, setResultSoundEnabled] = useState(false);
  const [laneSession, setLaneSession] = useState<SharedLaneSession | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const cameraStreamRef = useRef<MediaStream | null>(null);
  const barcodeDetectorRef = useRef<BarcodeDetectorInstance | null>(null);
  const lastCameraCodeRef = useRef("");
  const resetTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scanInputTimerRef = useRef<number | null>(null);
  const lastPresentedAtRef = useRef<string | null>(null);
  const successAudioRef = useRef<HTMLAudioElement>(null);
  const failureAudioRef = useRef<HTMLAudioElement>(null);
  const resultSoundEnabledRef = useRef(false);
  const laneEventId = laneSession?.eventId ?? "";

  const updateCameraList = useCallback((devices: MediaDeviceInfo[]) => {
    const availableCameras = cameraDevicesFrom(devices);
    setCameraDevices(availableCameras);
    setSelectedCameraId((current) =>
      availableCameras.some((camera) => camera.deviceId === current)
        ? current
        : availableCameras[0]?.deviceId ?? "",
    );
  }, []);

  const releaseCamera = useCallback(() => {
    cameraStreamRef.current?.getTracks().forEach((track) => track.stop());
    cameraStreamRef.current = null;
    barcodeDetectorRef.current = null;
    lastCameraCodeRef.current = "";
    if (videoRef.current) videoRef.current.srcObject = null;
  }, []);

  const stopCamera = useCallback(() => {
    releaseCamera();
    setCameraActive(false);
    setCameraBusy(false);
    setCameraError("");
  }, [releaseCamera]);

  useEffect(() => {
    const mediaDevices = navigator.mediaDevices;
    if (!mediaDevices?.enumerateDevices) return;
    let disposed = false;
    const applyDevices = (devices: MediaDeviceInfo[]) => {
      if (!disposed) updateCameraList(devices);
    };
    const refreshDevices = () => {
      void mediaDevices.enumerateDevices().then(applyDevices).catch(() => undefined);
    };
    void mediaDevices.enumerateDevices().then(applyDevices).catch(() => undefined);
    mediaDevices.addEventListener("devicechange", refreshDevices);
    return () => {
      disposed = true;
      mediaDevices.removeEventListener("devicechange", refreshDevices);
    };
  }, [updateCameraList]);

  const playResultSound = useCallback((kind: GuestResult["kind"]) => {
    if (!resultSoundEnabledRef.current) return;
    const sounds = [successAudioRef.current, failureAudioRef.current];
    sounds.forEach((sound) => {
      if (!sound) return;
      sound.pause();
      sound.currentTime = 0;
    });
    const sound = kind === "success" ? successAudioRef.current : failureAudioRef.current;
    if (sound) void sound.play().catch(() => undefined);
  }, []);

  const toggleResultSound = async () => {
    const nextEnabled = !resultSoundEnabled;
    const sounds = [successAudioRef.current, failureAudioRef.current];
    if (nextEnabled) {
      for (const sound of sounds) {
        if (!sound) continue;
        sound.muted = true;
        await sound.play().catch(() => undefined);
        sound.pause();
        sound.currentTime = 0;
        sound.muted = false;
      }
    } else {
      sounds.forEach((sound) => sound?.pause());
    }
    resultSoundEnabledRef.current = nextEnabled;
    setResultSoundEnabled(nextEnabled);
  };

  const showResult = useCallback((nextResult: GuestResult) => {
    lastPresentedAtRef.current = nextResult.at;
    setResult(nextResult);
    playResultSound(nextResult.kind);
    if (resetTimerRef.current) clearTimeout(resetTimerRef.current);
    resetTimerRef.current = setTimeout(() => setResult(null), RESULT_DURATION_MS);
  }, [playResultSound]);

  useEffect(() => {
    const successAudio = new Audio("/audio/checkin-success.mp3");
    const failureAudio = new Audio("/audio/checkin-failure.mp3");
    successAudio.preload = "auto";
    failureAudio.preload = "auto";
    successAudioRef.current = successAudio;
    failureAudioRef.current = failureAudio;
    return () => {
      successAudio.pause();
      failureAudio.pause();
      successAudioRef.current = null;
      failureAudioRef.current = null;
    };
  }, []);

  const startCamera = useCallback(async (requestedCameraId?: string) => {
    setCameraBusy(true);
    setCameraError("");
    try {
      const Detector = (
        window as typeof window & { BarcodeDetector?: BarcodeDetectorConstructor }
      ).BarcodeDetector;
      if (!Detector) {
        throw new Error("這個瀏覽器不支援鏡頭 QR 辨識，請改用最新版 Chrome。");
      }
      if (!navigator.mediaDevices?.getUserMedia) {
        throw new Error("這個瀏覽器無法使用鏡頭，請確認是從 localhost 開啟。");
      }
      const supportedFormats = Detector.getSupportedFormats
        ? await Detector.getSupportedFormats()
        : ["qr_code"];
      if (!supportedFormats.includes("qr_code")) {
        throw new Error("這個瀏覽器的鏡頭不支援 QR Code 辨識。");
      }

      const cameraId = requestedCameraId ?? selectedCameraId;
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: cameraId
          ? { deviceId: { exact: cameraId } }
          : { facingMode: { ideal: "environment" } },
      });
      cameraStreamRef.current = stream;
      barcodeDetectorRef.current = new Detector({ formats: ["qr_code"] });
      const activeCameraId = stream.getVideoTracks()[0]?.getSettings().deviceId;
      if (activeCameraId) setSelectedCameraId(activeCameraId);
      const devices = await navigator.mediaDevices.enumerateDevices();
      updateCameraList(devices);
      if (!videoRef.current) throw new Error("無法建立鏡頭預覽，請重新整理頁面。");
      videoRef.current.srcObject = stream;
      await videoRef.current.play();
      setCameraActive(true);
    } catch (caught) {
      releaseCamera();
      if (caught instanceof DOMException && caught.name === "NotAllowedError") {
        setCameraError("鏡頭權限被拒絕，請在瀏覽器網址列允許鏡頭後再試一次。");
      } else {
        setCameraError(caught instanceof Error ? caught.message : "無法開啟電腦鏡頭。");
      }
    } finally {
      setCameraBusy(false);
    }
  }, [releaseCamera, selectedCameraId, updateCameraList]);

  const changeCamera = (cameraId: string) => {
    setSelectedCameraId(cameraId);
    if (!cameraActive) return;
    releaseCamera();
    setCameraActive(false);
    void startCamera(cameraId);
  };

  useEffect(() => () => releaseCamera(), [releaseCamera]);

  useEffect(() => {
    const video = videoRef.current;
    const stream = cameraStreamRef.current;
    if (!cameraActive || !video || !stream) return;
    video.srcObject = stream;
    void video.play().catch(() => setCameraError("鏡頭預覽暫時無法繼續，請重新開啟鏡頭。"));
  }, [cameraActive]);

  const refreshEvent = useCallback(async () => {
    let hasRemoteSession = false;
    try {
      const fragment = new URLSearchParams(window.location.hash.replace(/^#/, ""));
      const legacyQuery = new URLSearchParams(window.location.search);
      const bootstrapParams = fragment.get("token") ? fragment : legacyQuery;
      const bootstrapSession: SharedLaneBootstrap | null = bootstrapParams.get("event")
        && bootstrapParams.get("lane")
        && bootstrapParams.get("token")
        ? {
            eventId: bootstrapParams.get("event")!,
            laneId: bootstrapParams.get("lane")!,
            laneToken: bootstrapParams.get("token")!,
            laneName: "報到工作站",
          }
        : null;
      let storedSession: SharedLaneSession | null = null;
      try {
        const parsed = JSON.parse(window.localStorage.getItem(LANE_SESSION_KEY) ?? "null") as Partial<SharedLaneSession> | null;
        if (parsed?.eventId && parsed.laneId) {
          storedSession = {
            eventId: parsed.eventId,
            laneId: parsed.laneId,
            laneName: parsed.laneName ?? "報到工作站",
          };
        }
      } catch {
        window.localStorage.removeItem(LANE_SESSION_KEY);
      }
      const saved = await readSavedEvent();
      if (!bootstrapSession && saved) {
        let preparedSaved = saved;
        if (saved.sharedEvent?.laneToken) {
          const metadata = await activateSharedLane({
            eventId: saved.sharedEvent.eventId,
            laneId: saved.sharedEvent.laneId,
            laneName: saved.sharedEvent.laneName,
            laneToken: saved.sharedEvent.laneToken,
          });
          const sanitizedConnection = { ...saved.sharedEvent };
          delete sanitizedConnection.laneToken;
          preparedSaved = { ...saved, sharedEvent: { ...sanitizedConnection, laneName: metadata.laneName } };
          await writeSavedEvent(preparedSaved);
        }
        const background = await readBackgroundImageDataUrl();
        setEvent(preparedSaved);
        setLaneSession(preparedSaved.sharedEvent ? {
          eventId: preparedSaved.sharedEvent.eventId,
          laneId: preparedSaved.sharedEvent.laneId,
          laneName: preparedSaved.sharedEvent.laneName,
        } : null);
        setBackgroundImageDataUrl(background);
        const incomingResult = guestResultFromSavedEvent(preparedSaved);
        if (incomingResult && incomingResult.at !== lastPresentedAtRef.current) {
          showResult(incomingResult);
        }
        setError("");
        return;
      }
      let remoteSession = storedSession;
      if (bootstrapSession) {
        hasRemoteSession = true;
        const metadata = await activateSharedLane(bootstrapSession);
        remoteSession = { ...bootstrapSession, laneName: metadata.laneName };
        window.history.replaceState(null, "", window.location.pathname);
      }
      if (remoteSession) {
        hasRemoteSession = true;
        const metadata = await readSharedLane(remoteSession);
        const preparedSession: SharedLaneSession = {
          eventId: remoteSession.eventId,
          laneId: remoteSession.laneId,
          laneName: metadata.laneName,
        };
        window.localStorage.setItem(LANE_SESSION_KEY, JSON.stringify(preparedSession));
        setLaneSession(preparedSession);
        setEvent({
          version: 1,
          fileName: metadata.fileName,
          eventName: metadata.eventName,
          importedAt: metadata.eventId,
          headers: metadata.headers,
          attendees: [],
          displaySettings: {
            selectedFields: metadata.selectedFields,
            backgroundColor: metadata.backgroundColor,
          },
        });
        setBackgroundImageDataUrl(null);
        setError("");
        return;
      }
      setEvent(saved);
      setLaneSession(null);
      setBackgroundImageDataUrl(null);
      setError("");
    } catch (caught) {
      if (!hasRemoteSession) setEvent(null);
      setError(caught instanceof Error ? caught.message : "無法讀取報到名單，請洽報到人員。");
    } finally {
      setReady(true);
    }
  }, [showResult]);

  useEffect(() => {
    const timer = window.setTimeout(() => void refreshEvent(), 0);
    return () => window.clearTimeout(timer);
  }, [refreshEvent]);

  useEffect(() => {
    if (!laneEventId) return;
    const timer = window.setInterval(() => void refreshEvent(), 5_000);
    return () => window.clearInterval(timer);
  }, [laneEventId, refreshEvent]);

  useEffect(() => {
    if (typeof BroadcastChannel === "undefined") return;
    const channel = new BroadcastChannel(CHANNEL_NAME);
    channel.onmessage = () => void refreshEvent();
    return () => channel.close();
  }, [refreshEvent]);

  useEffect(() => {
    if (!ready) return;
    const timer = window.setTimeout(() => inputRef.current?.focus(), 60);
    return () => window.clearTimeout(timer);
  }, [ready, event, result]);

  useEffect(() => {
    const refocusScanner = (pointerEvent: PointerEvent) => {
      const target = pointerEvent.target;
      if (target instanceof Element && target.closest(".scan-settings-menu")) return;
      window.setTimeout(() => inputRef.current?.focus(), 0);
    };
    window.addEventListener("pointerdown", refocusScanner);
    return () => window.removeEventListener("pointerdown", refocusScanner);
  }, []);

  useEffect(() => {
    return () => {
      if (resetTimerRef.current) clearTimeout(resetTimerRef.current);
      if (scanInputTimerRef.current) clearTimeout(scanInputTimerRef.current);
    };
  }, []);

  const processScan = useCallback((rawCode: string) => {
    if (!event) return;
    const code = rawCode.trim().replace(/[\r\n]+$/g, "");
    if (!code) return;
    if (scanInputTimerRef.current) clearTimeout(scanInputTimerRef.current);
    scanInputTimerRef.current = null;
    if (inputRef.current) inputRef.current.value = "";
    if (!laneSession) {
      setError("活動尚未連接伺服器。請由報到人員重新載入活動。");
      return;
    }
    void scanSharedEvent(
      laneSession,
      code,
      new Date().toISOString(),
      crypto.randomUUID(),
    ).then((outcome) => {
      showResult({ kind: outcome.kind, attendee: outcome.attendee, at: outcome.at });
      setError("");
    }).catch((caught) => {
      setError(caught instanceof Error ? caught.message : "無法送出報到紀錄。請檢查網路後重新掃描。");
    });
  }, [event, laneSession, showResult]);

  useEffect(() => {
    if (!cameraActive || !barcodeDetectorRef.current) return;
    let detecting = false;
    const timer = window.setInterval(() => {
      const video = videoRef.current;
      const detector = barcodeDetectorRef.current;
      if (detecting || !video || !detector || video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) {
        return;
      }
      detecting = true;
      detector
        .detect(video)
        .then((barcodes) => {
          const code = barcodes[0]?.rawValue.trim() ?? "";
          if (!code) {
            lastCameraCodeRef.current = "";
            return;
          }
          if (code === lastCameraCodeRef.current) return;
          lastCameraCodeRef.current = code;
          processScan(code);
        })
        .catch(() => undefined)
        .finally(() => {
          detecting = false;
        });
    }, 220);
    return () => window.clearInterval(timer);
  }, [cameraActive, processScan]);

  const handleScanInput = (inputEvent: FormEvent<HTMLInputElement>) => {
    if (scanInputTimerRef.current) clearTimeout(scanInputTimerRef.current);
    const bufferedCode = inputEvent.currentTarget.value;
    if (!event || bufferedCode.trim().length < 3) return;
    scanInputTimerRef.current = window.setTimeout(() => {
      const currentCode = inputRef.current?.value ?? "";
      const keys = scanKeysFor(currentCode);
      const isKnown = laneSession || event.attendees.some((attendee) =>
        attendee.scanKeys.some((key) => keys.includes(key)),
      );
      if (isKnown) processScan(currentCode);
    }, 100);
  };

  const submitScan = (formEvent: FormEvent) => {
    formEvent.preventDefault();
    processScan(inputRef.current?.value ?? "");
  };

  const selectedFields = useMemo(() => (event ? getDisplayFields(event) : []), [event]);
  if (!ready) {
    return (
      <main className="guest-screen guest-loading">
        <span className="brand-mark guest-brand-mark">P</span>
        <p>正在準備掃描器…</p>
      </main>
    );
  }

  if (!event) {
    return (
      <main className="guest-screen guest-empty">
        <div className="guest-brand"><span className="brand-mark">P</span><strong>Checkin Pod</strong></div>
        <div className="guest-empty-card">
          <span className="empty-mark">!</span>
          <h1>尚未載入活動名單</h1>
          <p>{error || "請先由報到人員開啟管理頁並匯入 Luma 或 KKTIX CSV。"}</p>
          <a href="/admin">前往管理頁</a>
        </div>
      </main>
    );
  }

  const backgroundColor = event.displaySettings?.backgroundColor ?? DEFAULT_GUEST_BACKGROUND;
  const guestScreenStyle = {
    backgroundColor,
    ...(backgroundImageDataUrl
      ? { "--guest-background-image": `url("${backgroundImageDataUrl}")` }
      : {}),
  } as CSSProperties;

  return (
    <main
      className={`guest-screen ${backgroundImageDataUrl ? "has-custom-background" : ""} ${cameraActive ? "camera-active" : ""} ${result ? `show-result ${result.kind}` : "is-idle"}`}
      style={guestScreenStyle}
    >
      <form className="guest-scan-form" onSubmit={submitScan}>
        <label htmlFor="guest-scan-input" className="visually-hidden">掃描 QR Code</label>
        <input
          ref={inputRef}
          id="guest-scan-input"
          className="guest-scan-input"
          onInput={handleScanInput}
          autoComplete="off"
          autoCapitalize="off"
          spellCheck={false}
        />
      </form>

      <details className="scan-settings-menu">
        <summary><span aria-hidden="true">⚙</span> 掃描設定</summary>
        <div className="scan-settings-popover">
          <div className="scan-settings-heading">
            <strong>鏡頭掃描</strong>
            <span>{laneSession ? `${laneSession.laneName} · 即時連線` : "USB 掃描器仍可同時使用"}</span>
          </div>
          <div className="camera-controls">
            {cameraDevices.length > 1 ? (
              <label className="camera-selector">
                <span>選擇鏡頭</span>
                <select
                  value={selectedCameraId}
                  disabled={cameraBusy}
                  onChange={(changeEvent) => changeCamera(changeEvent.target.value)}
                >
                  {cameraDevices.map((camera) => (
                    <option key={camera.deviceId} value={camera.deviceId}>{camera.label}</option>
                  ))}
                </select>
              </label>
            ) : null}
            <button
              type="button"
              className={`camera-toggle ${cameraActive ? "is-active" : ""}`}
              disabled={cameraBusy}
              onClick={() => cameraActive ? stopCamera() : void startCamera()}
            >
              <span aria-hidden="true">◉</span>
              {cameraBusy ? "正在開啟鏡頭…" : cameraActive ? "關閉電腦鏡頭" : "使用電腦鏡頭掃描"}
            </button>
          </div>
          {cameraError ? <p className="camera-error" role="alert">{cameraError}</p> : null}
          <div className="scan-sound-setting">
            <div>
              <strong>報到提示音</strong>
              <span>控制報到成功與失敗音效，預設關閉</span>
            </div>
            <button
              type="button"
              className={`scan-sound-toggle ${resultSoundEnabled ? "is-enabled" : ""}`}
              role="switch"
              aria-checked={resultSoundEnabled}
              onClick={() => void toggleResultSound()}
            >
              <i />
              <span>{resultSoundEnabled ? "開啟" : "關閉"}</span>
            </button>
          </div>
        </div>
      </details>

      {!backgroundImageDataUrl ? (
        <header className="guest-screen-header">
          <div className="guest-brand"><span className="brand-mark">P</span><strong>Checkin Pod</strong></div>
        </header>
      ) : null}

      {error ? <div className="guest-screen-error" role="alert">{error}</div> : null}

      <div className={`guest-scan-content ${cameraActive ? "has-camera" : ""}`}>
        <section className="guest-camera-panel" aria-label="電腦鏡頭掃描區" aria-hidden={!cameraActive}>
          <div className={`camera-view ${cameraActive ? "is-active" : ""}`}>
            <video ref={videoRef} muted playsInline aria-label="電腦鏡頭 QR Code 預覽" />
            <span className="camera-reticle" aria-hidden="true" />
          </div>
          <div className={`camera-scan-status ${result?.kind ?? "ready"}`} aria-live="polite">
            <i aria-hidden="true" />
            <span>
              {!result
                ? "鏡頭持續掃描中"
                : result.kind === "success"
                  ? `${result.attendee?.name ?? "來賓"}報到成功`
                  : result.kind === "duplicate"
                    ? `${result.attendee?.name ?? "來賓"}已報到過`
                    : "找不到報名資料"}
            </span>
          </div>
          <p>將下一張 QR Code 放入鏡頭框內</p>
        </section>

        {!result ? (
          <section className="guest-idle-content" aria-live="polite">
            {!cameraActive ? (
              <div className="scan-symbol" aria-hidden="true">
                <i className="corner c1" /><i className="corner c2" />
                <i className="corner c3" /><i className="corner c4" />
                <span className="scan-line" />
                <b>QR</b>
              </div>
            ) : null}
            <p className="guest-eyebrow">WELCOME · 歡迎抵達</p>
            <p className="guest-instruction">
              {cameraActive ? "鏡頭會持續顯示並掃描下一位來賓" : "將票券上的 QR Code 對準掃描器"}
            </p>
          </section>
        ) : result.kind === "unknown" ? (
          <section className="guest-result-content" aria-live="assertive">
            <div className="result-mark unknown-mark">?</div>
            <p className="guest-eyebrow">NEEDS ASSISTANCE</p>
            <h1>找不到報名資料</h1>
            <p className="result-subtitle">請洽報到人員協助確認</p>
            <div className="reset-countdown"><span /> 鏡頭持續顯示，可直接掃描下一位</div>
          </section>
        ) : (
          <section className="guest-result-content guest-person-result" aria-live="assertive">
            <div className="guest-status-column">
              <div className={`result-mark ${result.kind === "success" ? "success-mark" : "duplicate-mark"}`}>
                {result.kind === "success" ? "✓" : "!"}
              </div>
              <p className="guest-eyebrow">
                {result.kind === "success" ? "CHECK-IN COMPLETE" : "ALREADY CHECKED IN"}
              </p>
              <h1>{result.kind === "success" ? "報到成功" : "已報到過"}</h1>
              <p className="result-subtitle">
                {result.kind === "success" ? "謝謝您的到來，祝活動愉快" : `報到時間 ${formatTime(result.attendee?.checkedInAt ?? null)}`}
              </p>
              <div className="reset-countdown"><span /> 鏡頭持續顯示，可直接掃描下一位</div>
            </div>
            <div className="guest-details-column">
              {result.attendee ? (
                <div className="guest-data-grid">
                  {selectedFields.map((field) => (
                    <div className="guest-data-item" key={field}>
                      <span>{labelForField(field)}</span>
                      <strong>{guestDisplayValue(result.attendee!, field)}</strong>
                    </div>
                  ))}
                </div>
              ) : null}
            </div>
          </section>
        )}
      </div>

    </main>
  );
}
