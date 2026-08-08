"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties } from "react";
import type { LiveEventSnapshot, ProjectionCue } from "../checkin-core";
import { hashText, planetAppearanceForId } from "../planet-variants";

type LiveAttendee = LiveEventSnapshot["attendees"][number];
type FloatingName = {
  key: string;
  name: string;
  x: number;
  y: number;
  scale: number;
  duration: number;
};
type Entrance = { key: string; attendee: LiveAttendee };
type SharedProjectionEvent = {
  eventId: string;
  fileName: string;
  eventName: string;
  total: number;
  cursor: number;
  hasMore?: boolean;
  cue?: ProjectionCue;
  attendees?: LiveAttendee[];
  changes?: Array<LiveAttendee & { activityId: number }>;
};

const POLL_INTERVAL_MS = 700;
const ARRIVAL_DISPLAY_MS = 3600;
const PARTICLE_COLORS = ["#FFD84A", "#57E5E5", "#FF7B68", "#A89BFF", "#6EE7A1"];

function halton(index: number, base: number) {
  let fraction = 1;
  let value = 0;
  let current = index;
  while (current > 0) {
    fraction /= base;
    value += fraction * (current % base);
    current = Math.floor(current / base);
  }
  return value;
}

function planetLayout(attendee: LiveAttendee, index: number) {
  const hash = hashText(attendee.id);
  let x = 5 + halton(index + 1, 2) * 90;
  const y = 7 + halton(index + 1, 3) * 82;
  if (x > 39 && x < 61 && y > 33 && y < 68) {
    x += x < 50 ? -13 : 13;
  }
  const entrySide = hash % 4;
  const entryX = entrySide === 0 ? -115 : entrySide === 1 ? 115 : -35 + ((hash >>> 7) % 70);
  const entryY = entrySide === 2 ? -105 : entrySide === 3 ? 105 : 25 + ((hash >>> 13) % 65);
  return { hash, x, y, entryX, entryY, size: 18 + ((hash >>> 16) % 25) };
}

function planetStyle(attendee: LiveAttendee, index: number) {
  const palette = planetAppearanceForId(attendee.id).palette;
  const layout = planetLayout(attendee, index);
  return {
    "--planet-x": `${layout.x}%`,
    "--planet-y": `${layout.y}%`,
    "--planet-size": `${layout.size}px`,
    "--planet-light": palette[0],
    "--planet-mid": palette[1],
    "--planet-dark": palette[2],
    "--planet-delay": `${-((layout.hash >>> 20) % 80) / 10}s`,
    "--planet-duration": `${5 + ((layout.hash >>> 24) % 7)}s`,
    "--planet-entry-x": `${layout.entryX}vw`,
    "--planet-entry-y": `${layout.entryY}vh`,
  } as CSSProperties;
}

function drawSettledPlanet(
  context: CanvasRenderingContext2D,
  attendee: LiveAttendee,
  index: number,
  width: number,
  height: number,
) {
  const layout = planetLayout(attendee, index);
  const appearance = planetAppearanceForId(attendee.id);
  const [light, mid, dark] = appearance.palette;
  const x = width * layout.x / 100;
  const y = height * layout.y / 100;
  const radius = Math.max(4, layout.size / 2);
  context.save();
  context.translate(x, y);
  context.shadowColor = light;
  context.shadowBlur = 8;
  const gradient = context.createRadialGradient(-radius * .35, -radius * .4, radius * .08, 0, 0, radius);
  gradient.addColorStop(0, "#ffffff");
  gradient.addColorStop(.2, light);
  gradient.addColorStop(.62, mid);
  gradient.addColorStop(1, dark);
  context.fillStyle = gradient;
  context.strokeStyle = light;
  context.lineWidth = Math.max(.7, radius * .06);

  if (appearance.type === "cube") {
    context.rotate(Math.PI / 4);
    context.fillRect(-radius * .72, -radius * .72, radius * 1.44, radius * 1.44);
    context.strokeRect(-radius * .72, -radius * .72, radius * 1.44, radius * 1.44);
    context.strokeStyle = "rgba(5,8,10,.72)";
    for (const offset of [-.35, 0, .35]) {
      context.beginPath(); context.moveTo(-radius * .72, radius * offset); context.lineTo(radius * .72, radius * offset); context.stroke();
      context.beginPath(); context.moveTo(radius * offset, -radius * .72); context.lineTo(radius * offset, radius * .72); context.stroke();
    }
  } else if (appearance.type === "crystal" || appearance.type === "molten") {
    const points = appearance.type === "crystal" ? 6 : 10;
    context.beginPath();
    for (let point = 0; point < points; point += 1) {
      const angle = -Math.PI / 2 + point * Math.PI * 2 / points;
      const jitter = appearance.type === "molten" && point % 2 ? .7 : 1;
      const px = Math.cos(angle) * radius * jitter;
      const py = Math.sin(angle) * radius * jitter;
      if (!point) context.moveTo(px, py); else context.lineTo(px, py);
    }
    context.closePath(); context.fill(); context.stroke();
  } else {
    context.beginPath();
    context.ellipse(0, 0, radius, appearance.type === "banded" ? radius * .68 : radius, 0, 0, Math.PI * 2);
    context.fill(); context.stroke();
    if (appearance.type === "rocky") {
      context.fillStyle = dark;
      context.beginPath(); context.arc(-radius * .25, radius * .2, radius * .2, 0, Math.PI * 2); context.fill();
    }
    if (appearance.type === "banded") {
      context.strokeStyle = light;
      for (const offset of [-.28, 0, .28]) {
        context.beginPath(); context.moveTo(-radius * .85, radius * offset); context.lineTo(radius * .85, radius * offset); context.stroke();
      }
    }
  }
  if (appearance.type === "ringed") {
    context.shadowBlur = 0;
    context.strokeStyle = light;
    context.lineWidth = Math.max(1, radius * .1);
    context.rotate(-.32);
    context.beginPath(); context.ellipse(0, 0, radius * 1.65, radius * .42, 0, 0, Math.PI * 2); context.stroke();
  }
  context.restore();
}

function burstStyle(index: number, seed: number) {
  const hash = hashText(`${seed}-${index}`);
  return {
    "--burst-x": `${hash % 100}%`,
    "--burst-width": `${5 + ((hash >>> 8) % 8)}px`,
    "--burst-height": `${8 + ((hash >>> 12) % 12)}px`,
    "--burst-color": PARTICLE_COLORS[(hash >>> 16) % PARTICLE_COLORS.length],
    "--burst-turn": `${280 + ((hash >>> 20) % 800)}deg`,
    "--burst-drift": `${-160 + ((hash >>> 10) % 320)}px`,
    "--burst-delay": `${(hash % 40) / 100}s`,
    "--burst-duration": `${2.2 + ((hash >>> 24) % 24) / 10}s`,
  } as CSSProperties;
}

export default function ProjectionPage() {
  const [snapshot, setSnapshot] = useState<LiveEventSnapshot | null>(null);
  const [connected, setConnected] = useState(false);
  const [activated, setActivated] = useState(false);
  const [arrivalQueue, setArrivalQueue] = useState<Entrance[]>([]);
  const [activeEntrance, setActiveEntrance] = useState<Entrance | null>(null);
  const [floatingNames, setFloatingNames] = useState<FloatingName[]>([]);
  const [cueBanner, setCueBanner] = useState("");
  const [celebrationSeed, setCelebrationSeed] = useState(0);
  const seenAttendeesRef = useRef(new Set<string>());
  const currentEventIdRef = useRef("");
  const initializedRef = useRef(false);
  const lastCueIdRef = useRef("");
  const pendingCueRef = useRef<ProjectionCue | null>(null);
  const activatedRef = useRef(false);
  const boardingAudioRef = useRef<HTMLAudioElement | null>(null);
  const celebrationAudioRef = useRef<HTMLAudioElement | null>(null);
  const cleanupTimersRef = useRef(new Set<number>());
  const checkedInRef = useRef<LiveAttendee[]>([]);
  const snapshotRef = useRef<LiveEventSnapshot | null>(null);
  const sharedCursorRef = useRef<number | null>(null);
  const planetCanvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    activatedRef.current = activated;
  }, [activated]);

  useEffect(() => {
    if (!activated || activeEntrance || !arrivalQueue.length) return;
    const nextEntrance = arrivalQueue[0];
    const timer = window.setTimeout(() => {
      setArrivalQueue((current) =>
        current[0]?.key === nextEntrance.key ? current.slice(1) : current,
      );
      setActiveEntrance((current) => current ?? nextEntrance);
    }, 0);
    return () => window.clearTimeout(timer);
  }, [activated, activeEntrance, arrivalQueue]);

  useEffect(() => {
    if (!activeEntrance) return;
    const timer = window.setTimeout(() => setActiveEntrance(null), ARRIVAL_DISPLAY_MS);
    return () => window.clearTimeout(timer);
  }, [activeEntrance]);

  const checkedIn = useMemo(
    () => (snapshot?.attendees ?? [])
      .filter((attendee) => attendee.checkedInAt)
      .sort((a, b) => (a.checkedInAt ?? "").localeCompare(b.checkedInAt ?? "")),
    [snapshot],
  );
  const checkedInSignature = checkedIn.map((attendee) => attendee.id).join("\u0000");
  useEffect(() => {
    checkedInRef.current = checkedIn;
  }, [checkedIn]);
  const total = snapshot?.total ?? 0;
  const rate = total ? Math.round((checkedIn.length / total) * 100) : 0;

  const scheduleCleanup = useCallback((callback: () => void, delay: number) => {
    const timer = window.setTimeout(() => {
      cleanupTimersRef.current.delete(timer);
      callback();
    }, delay);
    cleanupTimersRef.current.add(timer);
    return timer;
  }, []);

  const handleCue = useCallback((cue: ProjectionCue) => {
    if (!activatedRef.current) return;
    if (cue.type === "boarding") {
      setCueBanner("登車廣播播放中");
      const sound = boardingAudioRef.current;
      if (sound) {
        sound.pause();
        sound.currentTime = 0;
        void sound.play().catch(() => setCueBanner("請點一下畫面後再播放廣播"));
      }
      scheduleCleanup(() => setCueBanner(""), 9000);
      return;
    }

    setCueBanner("全場能量已解鎖");
    setCelebrationSeed(Date.now());
    const sound = celebrationAudioRef.current;
    if (sound) {
      sound.pause();
      sound.currentTime = 0;
      void sound.play().catch(() => setCueBanner("全場能量已解鎖"));
    }
    scheduleCleanup(() => {
      setCueBanner("");
      setCelebrationSeed(0);
    }, 5200);
  }, [scheduleCleanup]);

  const applySnapshot = useCallback((nextSnapshot: LiveEventSnapshot | null) => {
    if (!nextSnapshot) {
      setSnapshot(null);
      snapshotRef.current = null;
      currentEventIdRef.current = "";
      initializedRef.current = false;
      seenAttendeesRef.current = new Set<string>();
      pendingCueRef.current = null;
      setArrivalQueue([]);
      setActiveEntrance(null);
      return;
    }
    const isNewEvent = currentEventIdRef.current !== nextSnapshot.eventId;
    if (isNewEvent) {
      currentEventIdRef.current = nextSnapshot.eventId;
      initializedRef.current = false;
      seenAttendeesRef.current = new Set<string>();
      pendingCueRef.current = null;
      setArrivalQueue([]);
      setActiveEntrance(null);
      setFloatingNames([]);
    }

    const arrived = nextSnapshot.attendees.filter((attendee) => attendee.checkedInAt);
    if (!initializedRef.current) {
      arrived.forEach((attendee) => seenAttendeesRef.current.add(attendee.id));
      lastCueIdRef.current = nextSnapshot.cue?.id ?? "";
      if (nextSnapshot.cue && !activatedRef.current) pendingCueRef.current = nextSnapshot.cue;
      initializedRef.current = true;
    } else {
      const newlyArrived = arrived.filter((attendee) => !seenAttendeesRef.current.has(attendee.id));
      newlyArrived.forEach((attendee) => seenAttendeesRef.current.add(attendee.id));
      if (newlyArrived.length) {
        const now = Date.now();
        const nextEntrances = newlyArrived
          .sort((left, right) => (left.checkedInAt ?? "").localeCompare(right.checkedInAt ?? ""))
          .map((attendee) => ({
            key: `${attendee.id}-${now}`,
            attendee,
          }));
        setArrivalQueue((current) => [...current, ...nextEntrances]);
      }
      if (nextSnapshot.cue && nextSnapshot.cue.id !== lastCueIdRef.current) {
        lastCueIdRef.current = nextSnapshot.cue.id;
        if (activatedRef.current) handleCue(nextSnapshot.cue);
        else pendingCueRef.current = nextSnapshot.cue;
      }
    }
    setSnapshot(nextSnapshot);
    snapshotRef.current = nextSnapshot;
  }, [handleCue]);

  useEffect(() => {
    const cleanupTimers = cleanupTimersRef.current;
    const boardingAudio = new Audio("/audio/boarding-announcement.mp3");
    const celebrationAudio = new Audio("/audio/energy-celebration.mp3");
    boardingAudio.preload = "auto";
    celebrationAudio.preload = "auto";
    boardingAudioRef.current = boardingAudio;
    celebrationAudioRef.current = celebrationAudio;

    let disposed = false;
    const poll = async () => {
      try {
        const currentSharedCursor = sharedCursorRef.current;
        const query = new URLSearchParams({ mode: "projection" });
        if (currentSharedCursor !== null) query.set("after", String(currentSharedCursor));
        const response = await fetch(`/api/shared-checkin?${query}`, { cache: "no-store" });
        if (!response.ok) throw new Error("sync_failed");
        const body = (await response.json()) as { event?: SharedProjectionEvent | null };
        if (!disposed) {
          const sharedEvent = body.event ?? null;
          if (!sharedEvent) {
            sharedCursorRef.current = null;
            applySnapshot(null);
          } else if (sharedEvent.attendees) {
            sharedCursorRef.current = sharedEvent.cursor;
            applySnapshot({
              eventId: sharedEvent.eventId,
              fileName: sharedEvent.eventName,
              total: sharedEvent.total,
              revision: sharedEvent.cursor,
              updatedAt: new Date().toISOString(),
              attendees: sharedEvent.attendees,
              cue: sharedEvent.cue,
            });
          } else if (snapshotRef.current?.eventId !== sharedEvent.eventId) {
            sharedCursorRef.current = null;
          } else {
            const attendees = new Map(snapshotRef.current.attendees.map((attendee) => [attendee.id, attendee]));
            for (const change of sharedEvent.changes ?? []) {
              if (change.checkedInAt) attendees.set(change.id, change);
              else attendees.delete(change.id);
            }
            sharedCursorRef.current = sharedEvent.cursor;
            applySnapshot({
              ...snapshotRef.current,
              fileName: sharedEvent.eventName,
              total: sharedEvent.total,
              revision: sharedEvent.cursor,
              updatedAt: new Date().toISOString(),
              attendees: [...attendees.values()],
              cue: sharedEvent.cue,
            });
          }
          setConnected(true);
        }
      } catch {
        if (!disposed) setConnected(false);
      }
    };
    void poll();
    const interval = window.setInterval(() => void poll(), POLL_INTERVAL_MS);
    return () => {
      disposed = true;
      window.clearInterval(interval);
      cleanupTimers.forEach((timer) => window.clearTimeout(timer));
      cleanupTimers.clear();
      boardingAudio.pause();
      celebrationAudio.pause();
      boardingAudioRef.current = null;
      celebrationAudioRef.current = null;
    };
  }, [applySnapshot]);

  useEffect(() => {
    const canvas = planetCanvasRef.current;
    if (!canvas) return;
    const draw = () => {
      const bounds = canvas.getBoundingClientRect();
      const ratio = Math.min(2, window.devicePixelRatio || 1);
      canvas.width = Math.max(1, Math.round(bounds.width * ratio));
      canvas.height = Math.max(1, Math.round(bounds.height * ratio));
      const context = canvas.getContext("2d");
      if (!context) return;
      context.scale(ratio, ratio);
      const hidden = new Set([
        activeEntrance?.attendee.id,
        ...arrivalQueue.map((entrance) => entrance.attendee.id),
      ].filter((id): id is string => Boolean(id)));
      checkedIn.forEach((attendee, index) => {
        if (!hidden.has(attendee.id)) drawSettledPlanet(context, attendee, index, bounds.width, bounds.height);
      });
    };
    draw();
    window.addEventListener("resize", draw);
    return () => window.removeEventListener("resize", draw);
  }, [activeEntrance, arrivalQueue, checkedIn]);

  useEffect(() => {
    if (!activated || !checkedInSignature) return;
    const spawnName = () => {
      const attendees = checkedInRef.current;
      if (!attendees.length) return;
      const attendee = attendees[Math.floor(Math.random() * attendees.length)];
      const key = `${attendee.id}-${Date.now()}-${Math.random()}`;
      const floating: FloatingName = {
        key,
        name: attendee.name,
        x: 8 + Math.random() * 80,
        y: 12 + Math.random() * 70,
        scale: 0.8 + Math.random() * 0.7,
        duration: 5 + Math.random() * 3,
      };
      setFloatingNames((current) => [...current.slice(-7), floating]);
      scheduleCleanup(() => {
        setFloatingNames((current) => current.filter((item) => item.key !== key));
      }, floating.duration * 1000);
    };
    spawnName();
    const interval = window.setInterval(spawnName, 1650);
    return () => window.clearInterval(interval);
  }, [activated, checkedInSignature, scheduleCleanup]);

  const activateProjection = async () => {
    for (const sound of [boardingAudioRef.current, celebrationAudioRef.current]) {
      if (!sound) continue;
      sound.muted = true;
      await sound.play().catch(() => undefined);
      sound.pause();
      sound.currentTime = 0;
      sound.muted = false;
    }
    activatedRef.current = true;
    setActivated(true);
    if (pendingCueRef.current) {
      const pendingCue = pendingCueRef.current;
      pendingCueRef.current = null;
      handleCue(pendingCue);
    }
    void document.documentElement.requestFullscreen?.().catch(() => undefined);
  };

  return (
    <main className={`projection-screen ${activated ? "is-active" : "is-paused"}`}>
      <header className="projection-header">
        <div>
          <span className="projection-kicker">CHECKIN POD · LIVE ENERGY WALL</span>
          <strong>{snapshot?.fileName.replace(/\.csv$/i, "") || "全場能量體"}</strong>
        </div>
        <span className={`projection-connection ${connected ? "is-connected" : ""}`}>
          <i /> {connected ? "現場同步中" : "等待中控台"}
        </span>
      </header>

      <section
        className="energy-field"
        aria-label={`全場能量體，目前 ${checkedIn.length} 位來賓形成 ${checkedIn.length} 顆星球`}
      >
        <div className="energy-halo halo-one" />
        <div className="energy-halo halo-two" />
        <canvas className="energy-planet-canvas" ref={planetCanvasRef} aria-hidden="true" />
        <div className="projection-energy-core">
          <span>{checkedIn.length}</span>
          <small>PLANETS</small>
        </div>
        {activeEntrance ? (() => {
          const attendee = activeEntrance.attendee;
          const appearance = planetAppearanceForId(attendee.id);
          const index = Math.max(0, checkedIn.findIndex((item) => item.id === attendee.id));
          return (
            <span
              className={`energy-planet type-${appearance.type} is-arriving`}
              key={activeEntrance.key}
              style={planetStyle(attendee, index)}
              title={`${attendee.name} · ${appearance.typeLabel}`}
              aria-label={`${attendee.name} 的${appearance.typeLabel}`}
            />
          );
        })() : null}
        {floatingNames.map((floating) => (
          <span
            className="floating-attendee-name"
            key={floating.key}
            style={{
              left: `${floating.x}%`,
              top: `${floating.y}%`,
              "--name-scale": floating.scale,
              "--name-duration": `${floating.duration}s`,
            } as CSSProperties}
          >
            {floating.name}
          </span>
        ))}
      </section>

      {activeEntrance ? (
        <div
          className="projection-arrival"
          key={activeEntrance.key}
          aria-live="assertive"
        >
          <span>NEW PLANET · WELCOME ABOARD</span>
          <strong>{activeEntrance.attendee.name}</strong>
          <small>第 {checkedIn.findIndex((item) => item.id === activeEntrance.attendee.id) + 1} 顆星球已加入全場能量</small>
        </div>
      ) : null}

      {arrivalQueue.length ? (
        <div className="projection-arrival-queue" aria-live="polite">
          <i /> 還有 {arrivalQueue.length} 位等待登場
        </div>
      ) : null}

      {cueBanner ? <div className="projection-cue-banner" aria-live="assertive"><i />{cueBanner}<i /></div> : null}

      {celebrationSeed ? (
        <div className="projection-burst" aria-hidden="true">
          {Array.from({ length: 100 }, (_, index) => (
            <i key={index} style={burstStyle(index, celebrationSeed)} />
          ))}
        </div>
      ) : null}

      <footer className="projection-footer">
        <div className="projection-progress-copy">
          <span>全場能量</span>
          <strong>{rate}%</strong>
        </div>
        <div className="projection-progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={rate}>
          <i style={{ width: `${rate}%` }} />
        </div>
        <span>{checkedIn.length} / {total || "—"} 位已抵達</span>
      </footer>

      {!activated ? (
        <div className="projection-start">
          <div className="projection-start-card">
            <span className="projection-start-mark">✦</span>
            <p>PROJECTOR MODE</p>
            <h1>啟動全場能量牆</h1>
            <span>按下後會進入全螢幕，並允許中控台播放登車廣播與彩蛋音效。</span>
            <button type="button" onClick={() => void activateProjection()}>開始投影</button>
          </div>
        </div>
      ) : null}
    </main>
  );
}
