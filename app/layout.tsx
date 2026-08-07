import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "抵達｜Luma QR 報到台",
  description: "匯入 Luma CSV、快速掃描 QR Code、在瀏覽器本機保存並匯出活動報到紀錄。",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="zh-Hant">
      <body>{children}</body>
    </html>
  );
}
