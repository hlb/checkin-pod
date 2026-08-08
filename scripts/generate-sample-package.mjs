import { execFileSync } from "node:child_process";
import { copyFile, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const sampleBlockSize = 150;
const checkedPerBlock = 100;
const pendingQrNumbers = Array.from({ length: 10 }, (_, index) => 101 + index);
const sampleConfigs = [
  {
    attendeeCount: 150,
    packageName: "checkin-pod-sample-150",
    csvName: "luma-sample-150.csv",
    statusDescription: "第 001–100 位已有 checked_in_at，第 101–150 位尚未報到。",
  },
  {
    attendeeCount: 10_000,
    packageName: "checkin-pod-sample-10000",
    csvName: "luma-sample-10000.csv",
    statusDescription: "每 150 人為一組：前 100 位已有 checked_in_at，後 50 位尚未報到。",
  },
];
const workspace = await mkdtemp(join(tmpdir(), "checkin-pod-sample-"));
const sharedQrDirectory = join(workspace, "shared-pending-qrcodes");

function csvEscape(value) {
  const text = String(value ?? "");
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function pad(value) {
  return String(value).padStart(3, "0");
}

function qrValue(numberText) {
  return `https://luma.com/check-in/checkin-pod-demo?pk=checkin-pod-sample-${numberText}`;
}

function buildCsv(attendeeCount) {
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
  const createdAtStart = Date.parse("2026-08-01T01:00:00.000Z");
  const rows = Array.from({ length: attendeeCount }, (_, index) => {
    const number = index + 1;
    const numberText = pad(number);
    const checkedInAt = index % sampleBlockSize < checkedPerBlock
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
      new Date(createdAtStart + index * 60_000).toISOString(),
      "approved",
      checkedInAt,
      qrValue(numberText),
      ticketName,
    ];
  });

  return [headers, ...rows]
    .map((row) => row.map(csvEscape).join(","))
    .join("\r\n");
}

try {
  await mkdir(sharedQrDirectory, { recursive: true });
  for (const number of pendingQrNumbers) {
    const numberText = pad(number);
    execFileSync("qrencode", [
      "-l", "H",
      "-m", "4",
      "-s", "8",
      "-o", join(sharedQrDirectory, `${numberText}-guest-${numberText}.png`),
      qrValue(numberText),
    ]);
  }

  const archivePaths = [];
  for (const config of sampleConfigs) {
    const packageRoot = join(workspace, config.packageName);
    const qrDirectory = join(packageRoot, "pending-qrcodes");
    const archivePath = resolve("public", `${config.packageName}.zip`);
    await mkdir(qrDirectory, { recursive: true });

    const csv = buildCsv(config.attendeeCount);
    await writeFile(join(packageRoot, config.csvName), `\uFEFF${csv}\r\n`, "utf8");

    for (const number of pendingQrNumbers) {
      const numberText = pad(number);
      const fileName = `${numberText}-guest-${numberText}.png`;
      await copyFile(join(sharedQrDirectory, fileName), join(qrDirectory, fileName));
    }

    const readme = `Checkin Pod｜Luma QR 報到測試包（${config.attendeeCount.toLocaleString("en-US")} 人）

內容：
- ${config.csvName}：${config.attendeeCount.toLocaleString("en-US")} 位匿名測試來賓。
- ${config.statusDescription}
- pending-qrcodes/：第 101–110 位的 10 張 QR Code，可用掃描器或鏡頭測試報到。
- 150 人與 10,000 人範例的第 001–150 位使用相同 QR Code；兩份 ZIP 內的測試 QR 圖可以共用。

使用方式：
1. 在 /admin 匯入 ${config.csvName}。
2. 開啟 /scan，或直接在 /admin 使用掃描器。
3. 依序掃描 pending-qrcodes 裡的 PNG；每張都對應 CSV 中一位尚未報到來賓。

所有姓名、Email、電話與 QR Code 都是測試資料，不對應真實人物或有效活動票券。
`;
    await writeFile(join(packageRoot, "README.txt"), readme, "utf8");

    await mkdir(dirname(archivePath), { recursive: true });
    await rm(archivePath, { force: true });
    execFileSync("zip", ["-q", "-r", archivePath, config.packageName], { cwd: workspace });
    archivePaths.push(archivePath);
  }

  console.log(archivePaths.join("\n"));
} finally {
  await rm(workspace, { recursive: true, force: true });
}
