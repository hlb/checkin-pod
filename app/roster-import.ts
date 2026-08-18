import readExcelFile from "read-excel-file/browser";

import { parseCsv } from "./checkin-core.ts";
import type { OriginalRow } from "./checkin-core.ts";

export const ACCUPASS_COMPLETED_SHEET = "票券資訊(已完成)";
export const XLSX_MIME_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

export type ParsedRoster = {
  headers: string[];
  rows: OriginalRow[];
};

type SpreadsheetCell = string | number | boolean | Date | null;

function cellText(value: SpreadsheetCell) {
  if (value === null) return "";
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

export function rowsFromSpreadsheet(matrix: SpreadsheetCell[][]): ParsedRoster {
  if (matrix.length < 2) {
    throw new Error(`${ACCUPASS_COMPLETED_SHEET} 需要有標題列與至少一筆票券資料。`);
  }

  const headers = matrix[0].map((value, index) => cellText(value).trim() || `column_${index + 1}`);
  const rows = matrix.slice(1).map((values) =>
    Object.fromEntries(headers.map((header, index) => [header, cellText(values[index] ?? null)])),
  );
  return { headers, rows };
}

export async function parseAccupassWorkbook(source: Blob | ArrayBuffer): Promise<ParsedRoster> {
  const sheets = await readExcelFile(source);
  const completed = sheets.find((candidate) => candidate.sheet === ACCUPASS_COMPLETED_SHEET);
  if (!completed) {
    const available = sheets.map((candidate) => candidate.sheet).join("、") || "無";
    throw new Error(
      `找不到 ACCUPASS 工作表「${ACCUPASS_COMPLETED_SHEET}」。檔案中的工作表：${available}。`,
    );
  }
  return rowsFromSpreadsheet(completed.data as SpreadsheetCell[][]);
}

export async function parseRosterFile(file: File): Promise<ParsedRoster> {
  const lowerName = file.name.toLowerCase();
  if (lowerName.endsWith(".xlsx") || file.type === XLSX_MIME_TYPE) {
    return parseAccupassWorkbook(file);
  }
  if (lowerName.endsWith(".csv") || file.type === "text/csv") {
    return parseCsv(await file.text());
  }
  throw new Error("請選擇 Luma／KKTIX CSV，或 ACCUPASS 匯出的 Excel（.xlsx）檔案。");
}
