# AGENTS.md

本文件提供維護者與 coding agents 在 Checkin Pod repository 內工作的共同規則。規則適用於 repository 根目錄與所有子目錄。

## 專案目標

Checkin Pod 提供活動現場 QR Code 報到。系統的優先順序如下：

1. 正確判定報到與重複掃描。
2. 保護活動參加者資料與工作站權杖。
3. 維持單機模式在網路不穩時可使用。
4. 維持多機模式的原子性與冪等性。
5. 提供活動主辦單位可以直接理解的介面與文件。

## 技術地圖

- `app/page.tsx`：管理中控台。
- `app/scan/page.tsx`：USB 鍵盤與相機掃描畫面。
- `app/projection/page.tsx`：公開投影畫面。
- `app/benchmark/`：公開效能示範。
- `app/checkin-core.ts`：CSV、IndexedDB、單機掃描與安全匯出。
- `app/shared-checkin.ts`：多機與單機備份的 client API。
- `app/api/shared-checkin/route.ts`：活動、名單、工作站、掃描與投影 API。
- `app/admin-auth.ts`、`app/lane-auth.ts`：簽章管理 session 與工作站 Cookie。
- `app/shared-checkin-sql.ts`：runtime D1 schema 與原子報到 SQL。
- `worker/index.ts`：管理登入、登出、路由保護、安全標頭、限流與排程入口。
- `drizzle/`：經人工檢查的 forward-only D1 migrations。
- `tests/`：單元、policy、rendered HTML 與 SQLite 行為測試。
- `scripts/`：範例資料與壓力測試工具。
- `docs/`：架構與安全文件。

## 工作原則

- 先閱讀 `README.md`、`docs/architecture.md` 與相關測試。
- 保留使用者未提交的檔案與修改。工作目錄可能包含真實活動 CSV。
- 不讀取、輸出、提交或移動未被任務明確指定的活動名單。
- 使用 `rg` 搜尋檔案與文字。
- 使用 `apply_patch` 編輯文字檔。
- 避免破壞性 Git 指令。
- 每次修改聚焦一個可說明的目的。
- 新增套件前說明需求、安全面與 bundle 影響。

## 隱私與秘密

- 只把合成參加者資料放進 repository。
- 真實姓名、Email、電話、票號、QR Code 與原始 CSV 都視為個人資料。
- `.env*`、管理密碼、`SESSION_SECRET`、工作站權杖與 session Cookie 都視為秘密。
- 不在 log、錯誤訊息、測試 snapshot、URL 範例或文件中放入真實秘密。
- API 回傳參加者資料時採最小欄位集合。
- 掃描鍵與工作站權杖在伺服器端只保存雜湊。
- 公開投影資料只保留活動名稱、統計、依活動隱私設定產生的顯示名稱、時間與控制指令。預設只顯示匿名來賓。
- 涉及資料保存、刪除與公開欄位的變更需要同步更新 `docs/security-review.md`。

## 認證與授權不變條件

- `/` 與 `/admin` 需要有效管理員 session。
- 管理 API 需要管理員 session。
- `/scan` 的啟用 API 需要 event、lane 與一次性 bootstrap token。啟用後的多機 API 使用有範圍的 HttpOnly lane Cookie。
- `/projection` 與 `/benchmark` 保持公開。
- 工作站停用或換發後，舊 token 立即失效。
- 管理 session cookie 使用 `HttpOnly`、`SameSite=Strict` 與 production `Secure`。
- 管理 session 使用獨立 `SESSION_SECRET` 簽章，最長有效 8 小時。
- 工作站 bootstrap secret 只放在 URL fragment，交換後立即從網址與瀏覽器資料移除。
- 新增 API action 時先定義 actor、資料範圍、輸入上限、重放行為與 rate limit。
- 狀態變更使用 POST、PUT、PATCH 或 DELETE。GET 保持唯讀。

## 報到與同步不變條件

- 單場活動最多 10,000 位可報到者。
- 單場活動最多 100 個啟用工作站。
- 多機報到使用條件更新，只有第一個請求得到 success。
- 每筆掃描使用 request ID。相同 request ID 重送得到相同結果。
- ordered changes feed 是多機中控台 cursor 的唯一推進來源。
- 單筆掃描回應不可跳過其他工作站較早產生的 activity。
- 未知 QR Code 不改變參加者資料。
- undo 保留 activity 並清除報到時間。
- 背景同步只更新同一個 `event_id`。
- 載入歷史活動需要明確切換目前活動。
- 永久刪除需要有效管理 session 與活動專屬確認字串。
- 刪除活動需要由外鍵 cascade 清除 attendees、scan keys、lanes 與 activity。

## 瀏覽器儲存

- IndexedDB `checkin-pod` 保存目前活動與背景圖片。
- 單機模式以 IndexedDB 為操作來源。
- 多機工作站的待送佇列保存在 Local Storage，每站最多 100 筆。
- Local Storage 與 IndexedDB 不保存可重播的 lane token。舊格式 token 只能用於一次 migration，成功交換後立即刪除。
- BroadcastChannel 只負責同瀏覽器分頁通知。
- 儲存格式變更需要提供 migration 或相容讀取。
- 清除本機資料與刪除伺服器活動是兩個不同操作。

## UI 與文案

- 使用繁體中文。
- 使用簡單肯定句。
- 全站使用 `Inter Variable` 與 `Noto Sans TC Variable` 自託管字型。數字使用等寬數字設定。
- 品牌主色使用 `#FF9E1B`、`#FFD23F`、`#0E0F12`、`#F4F1E8`、`#57D98A` 與 `#FF6B5E`。共用色彩從 `app/globals.css` 的 design tokens 取用。
- 可讀文字的 CSS `font-size` 不得小於 `18px`。大型標題與數字維持原有視覺層級。
- 操作按鈕使用明確動詞。
- 錯誤訊息說明目前狀態與下一步。
- 掃描成功、重複與未知結果需要有清楚且互異的視覺狀態。
- 相機掃描結果不可遮住相機預覽。
- 鍵盤模式保持 input focus，支援 Enter terminator 與短暫停頓送出。
- Web Serial 目前不在實作範圍。
- 新增互動時保留 keyboard、focus、label 與 aria 支援。

## 資料庫與 migration

- `app/shared-checkin-sql.ts` 是新環境的 runtime schema 來源。
- `scripts/reset-d1.sql` 是明確放棄全部既有資料時使用的破壞性重建工具。執行前需要確認 D1 的精確目標與維護者授權。
- schema 變更需要新增下一個編號的 `drizzle/*.sql` forward migration，並同步更新 runtime schema。
- migration SQL 需要人工檢查 D1 / SQLite 相容性、資料回填、外鍵與 rollback 影響。
- 保留既有 migration，不重寫已發佈 migration。
- 新欄位提供安全預設值與向後相容策略。
- 查詢參加者、掃描鍵與 activity cursor 時維持索引路徑。
- schema 上限與 TypeScript policy 上限保持一致。
- 測試需要從空資料庫依序套用全部 migration，並驗證 runtime schema 的同等行為。
- reset SQL 需要依外鍵順序刪除資料表，並以 SQLite 測試驗證可完整清除 shared check-in schema。

## 測試與驗證

一般變更完成後執行：

```bash
npm test
npm run lint
git diff --check
```

依賴或發佈相關變更另執行：

```bash
npm audit --omit=dev
npm audit
```

多機、資料庫或同步變更需要增加對應測試。高風險變更需要執行 `npm run stress`。壓力測試會建立並刪除專用測試活動，僅能對明確的測試環境執行。

測試至少涵蓋：

- 未登入管理請求被拒絕。
- 錯誤、停用與舊工作站 token 被拒絕。
- 同票競態只有一個 success。
- 相同 request ID 重送維持冪等。
- 10,001 人匯入被拒絕。
- projection 不回傳 Email、電話、QR Code 與原始欄位。
- lane scan 只回傳固定識別欄位與 server-side allowlist 的 display values。
- lane token 不出現在 query、Local Storage、IndexedDB 或 API response。
- 讀取 lane metadata 的 GET 不可寫入資料庫；活動訊號使用 POST heartbeat。
- 登入、scan 與 unknown scan 限流回覆 429 與 `Retry-After`。
- CSV 匯出會中和試算表公式前綴。
- 到期活動由請求清理與每日排程移除。
- 活動刪除完整 cascade。
- 150 與 10,000 人範例共用指定 QR Code。

目前 repository 的 TypeScript、production build、43 項測試與 lint 都需要維持通過。

## 文件同步

以下變更需要更新 `README.md` 與 `docs/architecture.md`：

- 新路徑或 API action。
- 認證與授權模式。
- 瀏覽器儲存或 D1 schema。
- 單機或多機同步流程。
- 部署 binding 與環境變數。
- 容量與壓力測試結果。

安全控制、個人資料範圍或已知風險改變時，同步更新 `docs/security-review.md` 的狀態與驗證日期。

## 開源發佈檢查

- repository 已加入維護者選定的 `LICENSE`。
- 真實活動 CSV、QR 圖、匯出檔與秘密不在工作樹、Git index 與 Git history。
- `.gitignore` 涵蓋活動名單與匯出檔的安全預設。
- `npm test`、`npm run lint`、`npm audit --omit=dev` 通過。
- 開發工具鏈漏洞完成升級或有明確風險接受紀錄。
- Security Review 的 findings 已修正、緩解或由維護者正式接受並記錄。
- README 的部署、隱私、授權與維護狀態準確。
