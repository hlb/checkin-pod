import type { Metadata } from "next";
import "@fontsource-variable/inter/opsz.css";
import "@fontsource-variable/noto-sans-tc";
import "./globals.css";

export const metadata: Metadata = {
  title: "Checkin Pod｜活動報到輔助機",
  description: "匯入 Luma 或 KKTIX CSV，由 Checkin Pod 掃描 QR Code、保存並匯出活動報到紀錄。",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="zh-Hant">
      <body>{children}</body>
    </html>
  );
}
