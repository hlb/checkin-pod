import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  applyScanToEvent,
  attendeeForServerImport,
  csvEscape,
  defaultDisplayFields,
  filterEligibleAttendees,
  labelForField,
  minimizeOriginalRow,
  parseCsv,
  scanKeysFor,
  toAttendees,
} from "../app/checkin-core.ts";
import { parseAccupassWorkbook } from "../app/roster-import.ts";

const kktixFixtureUrl = new URL("./fixtures/kktix-sample.csv", import.meta.url);
const accupassFixtureUrl = new URL("./fixtures/accupass-sample.xlsx", import.meta.url);

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
  };
}

test("parses quoted Luma CSV values and preserves embedded newlines", () => {
  const parsed = parseCsv('\uFEFFguest_id,name,note\r\n1,"王, 小明","第一行\n第二行"\r\n');
  assert.deepEqual(parsed.headers, ["guest_id", "name", "note"]);
  assert.equal(parsed.rows[0].name, "王, 小明");
  assert.equal(parsed.rows[0].note, "第一行\n第二行");
  assert.throws(() => parseCsv('id,name\n1,"未結束'), /未關閉的引號/);
});

test("neutralizes spreadsheet formulas in exported CSV cells", () => {
  assert.equal(csvEscape("=HYPERLINK(\"https://example.test\")"), "\"'=HYPERLINK(\"\"https://example.test\"\")\"");
  assert.equal(csvEscape("+cmd"), "'+cmd");
  assert.equal(csvEscape("-1+1"), "'-1+1");
  assert.equal(csvEscape("@SUM(1,2)"), "\"'@SUM(1,2)\"");
  assert.equal(csvEscape("  =1+1"), "'  =1+1");
  assert.equal(csvEscape("\t=1+1"), "'\t=1+1");
  assert.equal(csvEscape("一般票"), "一般票");
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

test("imports KKTIX attendee fields, QR serials, payment status, and attendance times", async () => {
  const importedAt = "2026-08-07T01:00:00.000Z";
  const parsed = parseCsv(await readFile(kktixFixtureUrl, "utf8"));
  const allAttendees = toAttendees(parsed.rows, importedAt);
  const attendees = filterEligibleAttendees(allAttendees);

  assert.equal(allAttendees.length, 3);
  assert.equal(attendees.length, 2);
  assert.deepEqual(
    defaultDisplayFields(parsed.headers),
    ["聯絡人 姓名", "票種", "聯絡人 Email"],
  );
  assert.equal(attendees[0].name, "測試來賓甲");
  assert.equal(attendees[0].email, "kktix-one@example.com");
  assert.equal(attendees[0].phone, "0912345678");
  assert.equal(attendees[0].ticket, "一般票");
  assert.equal(attendees[0].approvalStatus, "paid");
  assert.equal(attendees[0].qrValue, "0123456789abcdef0123456789abcdef");
  assert.equal(attendees[0].checkedInAt, "2026-08-07T18:58:42+08:00");
  assert.ok(attendees[0].scanKeys.includes("ab12"));
  assert.ok(attendees[0].scanKeys.includes("223456789"));
  assert.equal(attendees[1].checkedInAt, null);
  assert.equal(labelForField("聯絡人 姓名"), "姓名");
  assert.equal(labelForField("聯絡人 Email"), "Email");

  const event = {
    version: 1,
    fileName: "kktix.csv",
    importedAt,
    headers: parsed.headers,
    attendees,
    revision: 1,
  };
  const scan = applyScanToEvent(
    event,
    "ABCDEF0123456789ABCDEF0123456789",
    "2026-08-07T11:30:00.000Z",
  );
  assert.equal(scan.outcome.kind, "success");
  assert.equal(scan.outcome.attendee.name, "測試來賓乙");
});

test("imports the completed-ticket sheet from an ACCUPASS Excel workbook", async () => {
  const importedAt = "2026-08-18T01:00:00.000Z";
  const fixture = await readFile(accupassFixtureUrl);
  const parsed = await parseAccupassWorkbook(
    fixture.buffer.slice(fixture.byteOffset, fixture.byteOffset + fixture.byteLength),
  );
  const allAttendees = toAttendees(parsed.rows, importedAt);
  const attendees = filterEligibleAttendees(allAttendees);

  assert.equal(allAttendees.length, 3);
  assert.equal(attendees.length, 3);
  assert.deepEqual(
    defaultDisplayFields(parsed.headers),
    ["參加人姓名", "票券細節", "參加人Email"],
  );
  assert.equal(attendees[0].name, "測試來賓甲");
  assert.equal(attendees[0].email, "accupass-one@example.com");
  assert.equal(attendees[0].phone, "0912000001");
  assert.equal(attendees[0].ticket, "一般票 $0 * 1");
  assert.equal(attendees[0].qrValue, "AP-TICKET-001");
  assert.ok(attendees[0].scanKeys.includes("ap-ticket-001"));
  assert.ok(attendees[0].scanKeys.includes("ap-order-001"));
  assert.equal(labelForField("票券細節"), "票種");
  assert.equal(labelForField("參加人Email"), "Email");

  const event = {
    version: 1,
    fileName: "accupass.xlsx",
    importedAt,
    headers: parsed.headers,
    attendees,
    revision: 1,
  };
  const firstScan = applyScanToEvent(event, "AP-TICKET-001", "2026-08-18T02:00:00.000Z");
  const duplicate = applyScanToEvent(firstScan.event, "AP-TICKET-001", "2026-08-18T02:00:01.000Z");
  const unknown = applyScanToEvent(duplicate.event, "AP-TICKET-999", "2026-08-18T02:00:02.000Z");
  assert.equal(firstScan.outcome.kind, "success");
  assert.equal(duplicate.outcome.kind, "duplicate");
  assert.equal(unknown.outcome.kind, "unknown");

  const payload = attendeeForServerImport(attendees[0], ["表單額外欄位1"], 0);
  assert.deepEqual(payload.original, { 表單額外欄位1: "範例公司" });
  assert.equal("票號" in payload.original, false);
  assert.equal("訂單編號" in payload.original, false);
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

test("minimizes server-bound original rows to selected non-credential fields", () => {
  const minimized = minimizeOriginalRow({
    name: "王小明",
    email: "ming@example.com",
    qr_code_url: "https://lu.ma/check-in?pk=alpha",
    company: "Example Co.",
    dietary_notes: "私人飲食備註",
  }, ["company"]);

  assert.deepEqual(minimized, {
    company: "Example Co.",
  });
  assert.equal("dietary_notes" in minimized, false);
  assert.equal("qr_code_url" in minimized, false);
});

test("uses opaque attendee IDs and only sends selected PII plus transient scan keys", () => {
  const [attendee] = toAttendees([{
    guest_id: "source-guest-id",
    name: "王小明",
    email: "ming@example.com",
    phone_number: "0912345678",
    qr_code_url: "https://lu.ma/check-in?pk=alpha",
    company: "Example Co.",
  }], "2026-08-07T00:00:00.000Z");
  const payload = attendeeForServerImport({ ...attendee, id: "raw-personal-identifier" }, ["company"], 0);

  assert.equal(attendee.id, "guest-1");
  assert.ok(attendee.scanKeys.every((key) => !attendee.id.includes(key)));
  assert.equal(payload.id, "guest-1");
  assert.equal(payload.email, "");
  assert.equal(payload.phone, "");
  assert.equal(payload.ticket, "");
  assert.deepEqual(payload.original, { company: "Example Co." });
  assert.ok(payload.scanKeys.includes("alpha"));
  assert.equal("qrValue" in payload, false);
});
