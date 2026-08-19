declare module "read-excel-file/browser" {
  type ExcelCell = string | number | boolean | Date | null;

  type ExcelSheet = {
    sheet: string;
    data: ExcelCell[][];
  };

  export default function readExcelFile(source: Blob | ArrayBuffer): Promise<ExcelSheet[]>;
}
