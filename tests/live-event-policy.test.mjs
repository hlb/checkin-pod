import assert from "node:assert/strict";
import test from "node:test";

import { sha256Hex } from "../app/admin-auth.ts";
import {
  cleanLiveEventSnapshot,
  isLiveEventWriterAuthorized,
  isStaleLiveEventSnapshot,
  toPublicLiveEventSnapshot,
} from "../app/live-event-policy.ts";

function snapshot(revision = 1) {
  return {
    eventId: "event-1",
    fileName: "guests.csv",
    total: 1,
    revision,
    updatedAt: "2026-08-07T01:00:00.000Z",
    attendees: [],
  };
}

test("validates and bounds public projection snapshots", () => {
  const now = "2026-08-07T02:00:00.000Z";
  const valid = cleanLiveEventSnapshot({
    ...snapshot(),
    attendees: [{ id: "guest-1", name: "王小明", checkedInAt: "2026-08-07T01:30:00.000Z" }],
  }, null, now);
  assert.equal(valid.updatedAt, now);
  assert.equal(valid.attendees[0].name, "王小明");
  assert.equal(cleanLiveEventSnapshot({ ...snapshot(), total: 201 }, null, now), null);
  assert.equal(cleanLiveEventSnapshot({ ...snapshot(), revision: -1 }, null, now), null);
  assert.equal(cleanLiveEventSnapshot({ ...snapshot(), attendees: [{ id: 1 }] }, null, now), null);
});

test("requires admin authorization to create or replace an event", () => {
  assert.equal(isLiveEventWriterAuthorized({
    current: null,
    incomingEventId: "event-1",
    isAdmin: false,
    suppliedTokenHash: "",
  }), false);
  assert.equal(isLiveEventWriterAuthorized({
    current: snapshot(),
    incomingEventId: "event-2",
    isAdmin: true,
    suppliedTokenHash: "",
  }), true);
});

test("allows the registered event token but rejects the wrong token", async () => {
  const writerTokenHash = await sha256Hex("writer-secret");
  const current = { ...snapshot(2), writerTokenHash };
  assert.equal(isLiveEventWriterAuthorized({
    current,
    incomingEventId: "event-1",
    isAdmin: false,
    suppliedTokenHash: await sha256Hex("writer-secret"),
  }), true);
  assert.equal(isLiveEventWriterAuthorized({
    current,
    incomingEventId: "event-1",
    isAdmin: false,
    suppliedTokenHash: await sha256Hex("wrong-secret"),
  }), false);
});

test("rejects stale revisions and never exposes the writer token hash", () => {
  const current = { ...snapshot(3), writerTokenHash: "private-hash" };
  assert.equal(isStaleLiveEventSnapshot(current, snapshot(2)), true);
  assert.equal(isStaleLiveEventSnapshot(current, snapshot(4)), false);
  const visible = toPublicLiveEventSnapshot(current);
  assert.equal("writerTokenHash" in visible, false);
  assert.equal(visible.revision, 3);
});
