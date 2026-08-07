import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const attendeeCount = 150;
const checkedInCount = 100;
const pendingQrCount = 10;
const packageName = "arrival-checkin-sample-150";
const archivePath = resolve("public", `${packageName}.zip`);
const workspace = await mkdtemp(join(tmpdir(), "arrival-checkin-sample-"));
const packageRoot = join(workspace, packageName);
const qrDirectory = join(packageRoot, "pending-qrcodes");

function csvEscape(value) {
  const text = String(value ?? "");
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function pad(value) {
  return String(value).padStart(3, "0");
}

try {
  await mkdir(qrDirectory, { recursive: true });

  const headers = [
    "guest_id",
    "name",
    "first_name",
    "last_name",
    "email",
    "phone_number",
    "created_at",
    "approval_status",
    "checked_in_at",
    "qr_code_url",
    "ticket_name",
  ];
  const checkInStart = Date.parse("2026-08-07T01:00:00.000Z");
  const rows = Array.from({ length: attendeeCount }, (_, index) => {
    const number = index + 1;
    const numberText = pad(number);
    const qrValue = `https://luma.com/check-in/arrival-demo?pk=arrival-sample-${numberText}`;
    const checkedInAt = number <= checkedInCount
      ? new Date(checkInStart + index * 30_000).toISOString()
      : "";
    const ticketName = number % 15 === 0 ? "VIP" : number % 10 === 0 ? "工作人員" : "一般票";
    return [
      `gst-sample-${numberText}`,
      `測試來賓 ${numberText}`,
      `來賓${numberText}`,
      "測試",
      `guest${numberText}@example.com`,
      `0900${String(number).padStart(6, "0")}`,
      new Date(Date.parse("2026-08-01T01:00:00.000Z") + index * 60_000).toISOString(),
      "approved",
      checkedInAt,
      qrValue,
      ticketName,
    ];
  });

  const csv = [headers, ...rows]
    .map((row) => row.map(csvEscape).join(","))
    .join("\r\n");
  await writeFile(join(packageRoot, "luma-sample-150.csv"), `\uFEFF${csv}\r\n`, "utf8");

  for (let number = checkedInCount + 1; number <= checkedInCount + pendingQrCount; number += 1) {
    const numberText = pad(number);
    const qrValue = `https://luma.com/check-in/arrival-demo?pk=arrival-sample-${numberText}`;
    execFileSync("qrencode", [
      "-l", "H",
      "-m", "4",
      "-s", "8",
      "-o", join(qrDirectory, `${numberText}-guest-${numberText}.png`),
      qrValue,
    ]);
  }

  const readme = `抵達｜Luma QR 報到測試包

內容：
- luma-sample-150.csv：150 位匿名測試來賓。
- 第 001–100 位已有 checked_in_at，匯入後會顯示為已報到。
- 第 101–150 位尚未報到。
- pending-qrcodes/：第 101–110 位的 10 張 QR Code，可用掃描器或鏡頭測試報到。

使用方式：
1. 在 /admin 匯入 luma-sample-150.csv。
2. 開啟 /scan，或直接在 /admin 使用掃描器。
3. 依序掃描 pending-qrcodes 裡的 PNG；每張都對應 CSV 中一位尚未報到來賓。

所有姓名、Email、電話與 QR Code 都是測試資料，不對應真實人物或有效活動票券。
`;
  await writeFile(join(packageRoot, "README.txt"), readme, "utf8");

  await mkdir(dirname(archivePath), { recursive: true });
  await rm(archivePath, { force: true });
  execFileSync("zip", ["-q", "-r", archivePath, packageName], { cwd: workspace });
  console.log(archivePath);
} finally {
  await rm(workspace, { recursive: true, force: true });
}
