import assert from "node:assert/strict";
import test from "node:test";

import {
  applyScanToEvent,
  liveSnapshotFromEvent,
  parseCsv,
  scanKeysFor,
  toAttendees,
} from "../app/checkin-core.ts";

function sampleEvent() {
  const importedAt = "2026-08-07T01:00:00.000Z";
  const rows = [
    {
      guest_id: "guest-1",
      name: "王小明",
      email: "ming@example.com",
      qr_code_url: "https://lu.ma/check-in?pk=alpha",
      ticket_name: "一般票",
    },
    {
      guest_id: "guest-2",
      name: "陳美玲",
      email: "mei@example.com",
      qr_code_url: "https://lu.ma/check-in?pk=beta",
      ticket_name: "VIP",
    },
  ];
  return {
    version: 1,
    fileName: "guests.csv",
    importedAt,
    headers: Object.keys(rows[0]),
    attendees: toAttendees(rows, importedAt),
    revision: 4,
    writerToken: "private-writer-token",
  };
}

test("parses quoted Luma CSV values and preserves embedded newlines", () => {
  const parsed = parseCsv('\uFEFFguest_id,name,note\r\n1,"王, 小明","第一行\n第二行"\r\n');
  assert.deepEqual(parsed.headers, ["guest_id", "name", "note"]);
  assert.equal(parsed.rows[0].name, "王, 小明");
  assert.equal(parsed.rows[0].note, "第一行\n第二行");
  assert.throws(() => parseCsv('id,name\n1,"未結束'), /未關閉的引號/);
});

test("derives scan keys from the full QR URL, pk, email, and guest id", () => {
  const event = sampleEvent();
  assert.deepEqual(scanKeysFor("https://lu.ma/check-in?pk=ALPHA"), [
    "https://lu.ma/check-in?pk=alpha",
    "alpha",
  ]);
  assert.ok(event.attendees[0].scanKeys.includes("alpha"));
  assert.ok(event.attendees[0].scanKeys.includes("ming@example.com"));
  assert.ok(event.attendees[0].scanKeys.includes("guest-1"));
});

test("applies consecutive scans to the latest event without losing either arrival", () => {
  const first = applyScanToEvent(sampleEvent(), "alpha", "2026-08-07T02:00:00.000Z");
  const second = applyScanToEvent(first.event, "beta", "2026-08-07T02:00:01.000Z");

  assert.equal(first.outcome.kind, "success");
  assert.equal(second.outcome.kind, "success");
  assert.equal(second.event.revision, 6);
  assert.deepEqual(
    second.event.attendees.map((attendee) => attendee.checkedInAt),
    ["2026-08-07T02:00:00.000Z", "2026-08-07T02:00:01.000Z"],
  );
});

test("reports duplicate and unknown scans without changing an existing check-in time", () => {
  const first = applyScanToEvent(sampleEvent(), "alpha", "2026-08-07T02:00:00.000Z");
  const duplicate = applyScanToEvent(first.event, "alpha", "2026-08-07T02:00:02.000Z");
  const unknown = applyScanToEvent(duplicate.event, "not-on-list", "2026-08-07T02:00:03.000Z");

  assert.equal(duplicate.outcome.kind, "duplicate");
  assert.equal(duplicate.outcome.attendee.checkedInAt, "2026-08-07T02:00:00.000Z");
  assert.equal(unknown.outcome.kind, "unknown");
  assert.equal(unknown.event.lastScan.code, "not-on-list");
  assert.equal(unknown.event.revision, 7);
});

test("projection snapshots contain only checked-in public fields and the revision", () => {
  const checked = applyScanToEvent(sampleEvent(), "alpha", "2026-08-07T02:00:00.000Z").event;
  const snapshot = liveSnapshotFromEvent(checked);

  assert.equal(snapshot.revision, 5);
  assert.equal(snapshot.attendees.length, 1);
  assert.deepEqual(Object.keys(snapshot.attendees[0]).sort(), ["checkedInAt", "id", "name"]);
  assert.doesNotMatch(JSON.stringify(snapshot), /ming@example\.com|private-writer-token/);
});
