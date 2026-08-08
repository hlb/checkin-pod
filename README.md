# Checkin Pod｜活動報到輔助機

Checkin Pod 是活動現場使用的 QR Code 報到系統。活動主辦單位可以匯入 Luma 或 KKTIX CSV，使用 USB 掃描器或電腦鏡頭完成報到，並在投影畫面顯示即時進度。

![Checkin Pod 活動報到輔助機](docs/assets/checkin-pod-event-check-in-assistant.webp)

> 專案狀態：開源準備中。Security Review 的程式修正已完成。專案採用 Apache License 2.0。公開 repository 前仍需確認 Git history 沒有活動資料或秘密。

## 主要功能

- 匯入 Luma 與 KKTIX CSV 名單。
- 支援單機與多機報到模式。
- 支援 USB 鍵盤模式 QR Code 掃描器。
- 支援瀏覽器相機掃描。
- 使用原子資料庫寫入防止多工作站重複報到。
- 每次掃描立即寫入伺服器，投影畫面取得最新狀態。
- 每場活動使用獨立 `event_id` 保存名單與報到紀錄。
- 提供活動歷史、活動改名、活動還原與永久刪除。
- 提供即時投影畫面與現場控制指令。
- 匯出保留原始欄位的報到結果 CSV。
- 提供 150 人與 10,000 人測試資料。
- 提供 10,000 人、50 工作站壓力測試腳本與報告。

## 畫面與權限

| 路徑 | 用途 | 存取方式 |
|---|---|---|
| `/` | 中控台 | 管理員密碼 |
| `/admin` | 中控台別名 | 管理員密碼 |
| `/scan` | 報到工作站 | 目前活動或工作站連結 |
| `/projection` | 投影畫面 | 公開 |
| `/benchmark` | 效能示範 | 公開 |

`/` 與 `/admin` 共用有期限的簽章工作階段 Cookie。`/scan` 的多機連結只在首次啟用時交換工作站權杖，之後使用 HttpOnly Cookie。`/projection` 會公開顯示活動名稱與報到進度，預設使用匿名來賓名稱。管理員可以選擇姓名遮罩或完整姓名。

## 技術組成

- Node.js 22.13+
- React 19
- Vinext、Vite
- Cloudflare Workers runtime
- Cloudflare D1 / SQLite
- Inter Variable、Noto Sans TC Variable（自託管網頁字型）
- 經人工檢查的 forward-only SQL migrations
- IndexedDB、Local Storage、BroadcastChannel

完整元件、資料流與信任邊界請看 [系統架構文件](docs/architecture.md)。

## 本機啟動

需求：Node.js 22.13 或更新版本。

```bash
npm install
cp .env.example .env.local
```

編輯 `.env.local`，設定管理員帳號、強密碼與獨立的 session secret：

```dotenv
ADMIN_USERNAME=admin
ADMIN_PASSWORD=replace-with-a-long-random-password
SESSION_SECRET=replace-with-at-least-32-random-characters
```

正式環境也可以用 `ADMIN_USERS_JSON` 建立多個具名帳號。每次登入、登出與管理操作都會寫入 audit log。

啟動開發伺服器：

```bash
npm run dev
```

預設畫面：

- 中控台：<http://localhost:3000/admin>
- 報到工作站：<http://localhost:3000/scan>
- 投影畫面：<http://localhost:3000/projection>
- 效能示範：<http://localhost:3000/benchmark>

## 報到模式

| 項目 | 單機模式 | 多機模式 |
|---|---|---|
| 預設 | 是 | 否 |
| 操作資料來源 | D1 | D1 |
| 報到寫入 | 每筆 D1 原子更新 | 每筆 D1 原子更新 |
| 瀏覽器資料 | IndexedDB 活動快取 | IndexedDB 活動快取 |
| 工作站數 | 一台主要工作站 | 每場最多 100 台 |
| 網路需求 | 報到時需要連線 | 報到時需要連線 |

### 單機模式

管理畫面與報到畫面使用同一台電腦、同一個瀏覽器使用者。每次掃描與手動報到都立即寫入 D1。IndexedDB 保存活動快取、完整原始欄位與顯示設定。

### 多機模式

中控台為每個入口建立獨立工作站連結。啟用密鑰位於 URL fragment，不會送進 access log 或 Referer。伺服器交換密鑰後設定 HttpOnly 工作站 Cookie，畫面立即清除網址中的密鑰。D1 使用條件更新完成報到判定。每筆請求使用 `requestId` 保證冪等性。工作站可以改名、停用與換發連結。

## CSV 匯入

系統會辨識常見 Luma 與 KKTIX 欄位，包括：

- 姓名、Email、電話、票種
- Luma `qr_code_url`、`approval_status`
- KKTIX QR Code 序號、票券付款狀態、Attendance Book
- 報名序號、訂單編號與檢查碼

系統會納入可報到狀態。CSV 檔案上限為 50 MB。完整原始欄位保存在單機 IndexedDB，供畫面設定與匯出使用。伺服器只保存報到必要欄位與管理員選取的顯示欄位，單筆最小化 JSON 上限為 20 KB。單場活動上限為 10,000 人。

CSV 匯出會中和 `=`、`+`、`-`、`@` 與控制字元開頭的試算表公式，並保留標準 CSV quoting。

## 範例資料

首頁提供兩份 ZIP：

- `public/checkin-pod-sample-150.zip`
- `public/checkin-pod-sample-10000.zip`

兩份資料的前 150 位來賓共用 QR Code。ZIP 內提供第 101–110 位的測試 QR 圖。

重新產生範例前，請安裝系統指令 `qrencode` 與 `zip`：

```bash
npm run sample:generate
```

所有提交至 repository 的 CSV 與 QR 圖都必須使用合成資料。活動主辦單位的真實名單不得提交至 Git。

## 現場操作

1. 匯入 CSV，選擇單機或多機模式。
2. 設定來賓畫面要顯示的欄位。
3. 開啟 `/scan`，使用掃描器或相機完成報到。
4. 在投影電腦開啟 `/projection`，按「開始投影」。
5. 活動進行中定期匯出 CSV 備份。
6. 活動結束後依資料保存政策匯出或刪除活動。

USB 掃描器目前使用鍵盤輸入模式。掃描結尾建議設定為 Enter。Web Serial 尚未實作。

localhost 環境的投影電腦可以使用報到電腦的區網 IP，例如 `http://192.168.1.23:3000/projection`。主機防火牆需要允許 Node 接受區網連線。

## 資料保存

- IndexedDB 保存目前活動快取、完整原始欄位、最新報到狀態與顯示設定。D1 是報到操作的資料來源。
- Local Storage 只保存非秘密的工作站識別資料。工作站權杖保存在 HttpOnly Cookie。
- D1 保存活動、最小化參加者資料、掃描鍵雜湊、工作站權杖雜湊、報到紀錄與管理操作 audit log。
- 公開投影 API 提供活動名稱、總人數、公開顯示名稱、報到時間與投影指令。公開 ID 不使用內部 attendee ID。
- 每場活動預設保留 30 天。請求處理與每日排程會刪除到期活動及其關聯資料。
- 永久刪除活動會串聯刪除該活動的參加者、掃描鍵、工作站與活動紀錄。

部署單位需要建立資料保存期限、隱私告知與刪除流程。詳細風險與建議請看 [Security Review](docs/security-review.md)。

## 驗證

```bash
npm test
npm run lint
npm audit --omit=dev
```

目前 `npm test` 包含 TypeScript、production build 與 43 項測試。`npm run lint` 已通過 ESLint 與 accessibility 檢查。

壓力測試：

```bash
npm run dev
npm run stress
```

目前保存的基準結果為 10,000 人、50 工作站、10,542 個掃描 API 請求，平均 `496.86 req/s`，p95 `135.3 ms`。完整結果在 [壓力測試報告](reports/stress-test-10000x50.md)。

## 常用指令

| 指令 | 用途 |
|---|---|
| `npm run dev` | 啟動開發環境 |
| `npm run build` | 建立 production bundle |
| `npm start` | 啟動本機 production server |
| `npm test` | 執行型別、建置與測試 |
| `npm run lint` | 執行 ESLint 與 accessibility 檢查 |
| `npm run stress` | 執行多工作站壓力測試 |
| `npm run sample:generate` | 重新產生合成範例資料 |

## 部署

目前 repository 使用 `.openai/hosting.json` 定義 Sites 專案與 D1 binding。`worker/index.ts` 是 Cloudflare Worker 入口。部署環境需要提供：

- `ADMIN_USERNAME` 與 `ADMIN_PASSWORD`，或 `ADMIN_USERS_JSON`
- 至少 32 個字元的獨立 `SESSION_SECRET`
- 名稱為 `DB` 的 D1 binding
- `LOGIN_RATE_LIMITER`、`SCAN_RATE_LIMITER`、`SCAN_IP_RATE_LIMITER`、`UNKNOWN_SCAN_RATE_LIMITER` 與 `UNKNOWN_SCAN_IP_RATE_LIMITER` bindings
- 靜態資產 binding
- HTTPS

production config 已定義每天 `03:17 UTC` 的資料保存排程。本次安全版本採清空重建策略，不保留舊活動資料。Sites 部署會執行 `drizzle/0007_reset_production.sql`，依外鍵順序刪除舊資料表並立即建立目前 schema。

```bash
npx wrangler d1 execute <database-name> --remote --file scripts/reset-d1.sql
```

reset 會永久刪除活動、參加者、QR scan keys、工作站、報到紀錄、audit 與 legacy projection 資料。部署完成後，請驗證登入、登出、限流、安全標頭、CSV 匯入、單機與多機即時報到、投影、活動還原、到期清除與永久刪除。

`scripts/reset-d1.sql` 提供非 Sites 部署的人工 reset。`drizzle/0000`–`0006` 保留給 migration regression tests 與需要保留既有資料的部署者。

## 參與開發

請先閱讀 [AGENTS.md](AGENTS.md)、[系統架構文件](docs/architecture.md) 與 [Security Review](docs/security-review.md)。變更需要保留單機與多機的即時資料一致性、掃描冪等性、每場活動隔離與參加者資料最小化。

## 授權

本專案採用 [Apache License 2.0](LICENSE)。此授權允許商業使用、修改與散布，並提供明確的專利授權。散布時需要保留授權與著作權標示，修改過的檔案需要標示變更。Inter 與 Noto Sans TC 使用 SIL Open Font License 1.1。完整資訊請看 [第三方授權聲明](THIRD_PARTY_NOTICES.md)。
