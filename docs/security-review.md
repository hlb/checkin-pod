# Checkin Pod Security Review

審查日期：2026-08-08

修正驗證日期：2026-08-08

審查基準：`main` at `798ef9d`，修正基準為本文件同一 working tree

審查者：Codex 靜態、動態與資料流驗證
狀態：16 項 finding 已修正或緩解；開源發佈仍有維護者操作項目

## 1. 結論

本次修正完成 lane response 最小化、HttpOnly 工作站 session、登入與掃描限流、HMAC 管理 session、全站 security headers、投影隱私控制、伺服器資料最小化、30 天預設保存期限、具名管理員 audit、CSV 公式防護、POST logout、唯讀 GET、legacy API 移除、composite foreign keys 與漏洞通報政策。

production dependencies 的 audit 結果為 0。完整 dependency audit 剩下 `image-size` 的兩份 High advisory。上游目前沒有 patched release；產品不需要的 HEIF、ICNS、JXL 與 JXL stream parser 已全域停用並加入惡意 ICNS 防回歸測試。此項狀態為 Mitigated。

程式修正完成後，專案已採用 Apache License 2.0。公開 repository 前仍需由維護者確認工作樹與 Git history 沒有真實活動資料，並使用完整 history secret scanner 再驗證一次。這些操作不會由應用程式碼自動完成。

## 2. 範圍與方法

### 範圍

- Worker gateway、管理登入與 session。
- `/api/shared-checkin` 的 admin、lane 與 public projection scope。
- 單機與多機 browser storage。
- CSV parsing、匯出、scan key normalization、同步與離線佇列。
- D1 runtime schema、migrations、外鍵、retention 與 audit。
- 公開 projection、benchmark 與 response headers。
- dependency audit、tracked secret patterns 與開源資料風險。

### 方法

- 手動 source review、權限矩陣與 trust boundary review。
- SQL injection、XSS、CSRF、credential、session、PII、DoS、replay、retention 與 deletion review。
- TypeScript、production build、Node tests、lint 與 SQLite migration tests。
- production 與完整 npm dependency audit。
- tracked files 與常見 Git history token pattern scan。
- 10,000 attendees、50 clients 的保存壓力測試結果核對。

### 限制

- 未執行獨立第三方 penetration test。
- 未取得 production Cloudflare account、WAF、D1 reset target、Access policy、logs 與 alerts。
- 修正後 security headers 由 render tests 驗證，尚未對下一次 production deployment 做外部 header inspection。
- 未測試實際手機、XD-2002W 掃描器或惡意相機輸入。
- 常見 pattern scan 不能取代 GitHub secret scanning、push protection 或 gitleaks 全規則 history scan。
- 本報告不驗證組織的 incident response、DPA、隱私告知與法規合規性。

## 3. Finding 狀態

| ID | 原等級 | Finding | 狀態 | 主要修正 |
|---|---|---|---|---|
| SEC-001 | High | lane scan 回傳完整參加者資料 | Fixed | 專用最小 DTO；只回傳固定欄位與 server allowlist `displayValues` |
| SEC-002 | High | lane bearer token 在 URL query 與 Local Storage | Fixed | fragment bootstrap、POST 交換 HttpOnly Cookie、立即清除、舊儲存 migration |
| SEC-003 | High | 登入與 scan 缺少 application rate limit | Fixed | Cloudflare bindings 加 local fallback；account/IP、lane/IP、unknown 配額 |
| SEC-004 | High | 真實活動 CSV 可能被提交 | Fixed in repo | `.gitignore` safe default，只 allowlist synthetic fixtures 與 ZIP；發佈前仍需 owner 檢查 history |
| SEC-005 | Medium | 管理 session 可由密碼決定且無期限 | Fixed | 獨立 `SESSION_SECRET` HMAC、隨機 nonce、8 小時 expiry、移除 legacy acceptance |
| SEC-006 | Medium | 主應用缺少完整 security headers | Fixed | 全 route response wrapper 與 CSP、no-referrer、nosniff、frame、permissions、COOP/CORP、HSTS |
| SEC-007 | Medium | 公開 projection 顯示姓名與時間 | Fixed | 預設匿名 `count`，可選 `masked` / `names`，公開 ID 與 attendee ID 分離 |
| SEC-008 | Medium | 完整 original JSON 長期保存 | Fixed | server allowlist、20 KB 上限、30 天預設到期、request 與 Cron 自動清除 |
| SEC-009 | Medium | 開發工具鏈 advisories | Mitigated | 更新所有可修套件、移除 Drizzle 工具鏈、prod audit 0、停用無 patch 圖片 parsers |
| SEC-010 | Medium | 共用管理密碼無身份與 audit | Fixed | `ADMIN_USERS_JSON` 具名帳號、actor audit、來源 IP hash；保留單帳號自架選項 |
| SEC-015 | Medium | CSV 匯出公式注入 | Fixed | 危險前綴加單引號並保留 CSV quoting；公式案例測試 |
| SEC-011 | Low | logout 使用 GET 改變狀態 | Fixed | POST only、Origin 優先的 same-origin 驗證、Fetch Metadata 相容路徑、SameSite Cookie |
| SEC-012 | Low | lane metadata GET 寫入 last seen | Fixed | GET 唯讀；POST `lane_heartbeat` 更新狀態 |
| SEC-013 | Low | legacy API 擴大攻擊面 | Fixed | 刪除 `/api/live-event`、writer token、legacy policy 與資料表 |
| SEC-014 | Low | 資料關聯依賴應用程式 | Fixed | scan key / activity composite foreign keys、lane composite unique、匯入 prevalidation |
| SEC-016 | Low | 沒有漏洞通報政策 | Fixed | 新增根目錄 `SECURITY.md` 與 GitHub private reporting 流程 |

## 4. 修正細節與驗證

### SEC-001、SEC-002 — lane 最小權限與 credential lifecycle

- lane scan result 型別只有 `id`、`name`、`checkedInAt` 與 `displayValues`。
- `displayValues` 由伺服器依活動 `selected_fields_json` 產生。未選 Email、電話、QR Code、approval status 與 `original_json` 不會出現在 response。
- 工作站連結使用 `/scan#event=…&lane=…&token=…`。fragment 不會送到 Worker、proxy access log 或 Referer。
- `activate_lane` 成功後設定 production `__Host-checkin_pod_lane_session`，屬性為 `HttpOnly; Secure; SameSite=Strict; Path=/`。
- 瀏覽器立即用 `history.replaceState()` 清除 fragment。Local Storage 只保存非秘密 lane metadata 與待送 request。
- 舊 IndexedDB lane token 只會被讀取一次以交換 Cookie，成功後立即從儲存內容移除。
- token 換發或 lane revoke 後，D1 token hash 改變或 lane 失效，舊 Cookie 無法再授權。

### SEC-003 — rate limits

| Scope | Binding | 配額 |
|---|---|---|
| 登入帳號 | `LOGIN_RATE_LIMITER` | 10 / 60 seconds |
| 登入來源 IP | `LOGIN_RATE_LIMITER` | 10 / 60 seconds |
| scan lane | `SCAN_RATE_LIMITER` | 900 / 60 seconds |
| scan 來源 IP | `SCAN_IP_RATE_LIMITER` | 60,000 / 60 seconds |
| unknown lane | `UNKNOWN_SCAN_RATE_LIMITER` | 60 / 60 seconds |
| unknown 來源 IP | `UNKNOWN_SCAN_IP_RATE_LIMITER` | 3,000 / 60 seconds |

超限回覆 429 與 `Retry-After: 60`。lane 配額限制單一工作站，較高的 IP 配額容納同一 NAT 後方最多 100 個工作站與已驗證的 10,000 × 50 尖峰。本機與沒有 binding 的測試環境使用有界 process-local window。Cloudflare 的 binding 計數是 per-location 且最終一致，因此 production 仍建議用 account-level WAF rule 與監控補強。

### SEC-004 — repository 資料安全

`.gitignore` 預設忽略 CSV、TSV、Excel 與一般 ZIP，只允許 `tests/fixtures/*.csv` 和兩份明確的 synthetic sample ZIP。文件與 AGENTS 規則禁止讀取或提交未被任務指定的活動名單。

此控制防止一般 `git add .` 收入名單。它不能移除已存在於歷史的資料，也不能判斷維護者電腦上的未追蹤檔案是否為真實資料。公開前仍需要 owner 完成人工分類與完整 history scan。

### SEC-005、SEC-010 — 管理身份、session 與 audit

- `ADMIN_USERNAME` / `ADMIN_PASSWORD` 提供單一自架帳號。
- `ADMIN_USERS_JSON` 提供多個具名帳號，並取代單帳號設定。
- `SESSION_SECRET` 與密碼分離，長度至少 32 字元。
- HMAC-SHA-256 claims 包含版本、actor、簽發、到期與隨機 nonce。Cookie 最長 8 小時。
- production Cookie 使用 `__Host-` prefix、`HttpOnly`、`Secure` 與 `SameSite=Strict`。
- 登入、登出、匯入、同步、attendee mutation、lane mutation、投影設定、cue、活動狀態、改名與刪除都記錄 actor、action、event、時間、request ID 與雜湊來源。
- audit 不保存明文 IP、密碼、session、lane token 或 attendee row。

多團隊正式環境仍建議在 Worker 前方加入 Cloudflare Access 或其他具 MFA 與 lifecycle 的 IdP。內建帳號沒有角色區分。

### SEC-006、SEC-011、SEC-012 — HTTP 基線

- Worker 對一般頁面、API、redirect 與 error response 統一加入 security headers。
- production HTTPS 加入一年 HSTS。
- 相機權限只允許 self；microphone、geolocation、payment、USB 與 serial 關閉。
- logout 只接受 POST。來源驗證優先比對 Origin；Origin 缺少或為 `null` 時才依序驗證同來源 Referer 與 `Sec-Fetch-Site: same-origin`。
- 登入 POST 使用相同來源驗證。跨站 Origin 永遠優先拒絕，不會被 Fetch Metadata 覆蓋。
- lane GET 保持唯讀。last seen 使用經認證的 POST heartbeat。

目前 CSP 為了 Vinext runtime 仍允許 inline script/style。它提供來源、frame、object、form 與 connect 邊界，但不是 strict nonce CSP。框架支援穩定後應改用 nonce/hash。

### SEC-007、SEC-008 — projection privacy、data minimization 與 retention

- 新活動預設 `projection_privacy=count`，顯示名稱固定為「來賓」。
- `masked` 只顯示遮罩姓名；`names` 是管理員明確選擇的完整姓名模式。
- public payload 使用 `guest-${position}`，不公開 attendee ID。
- D1 固定欄位只保存報到與活動復原需要的資料；`original_json` 只包含選定顯示欄位與 operational aliases。
- 完整 CSV row 只留在單機 IndexedDB，供畫面與匯出。
- server 端單筆最小化 JSON 上限從 100 KB 降為 20 KB。
- CSV 在讀入記憶體前限制為 50 MB。登入與 shared API 依實際 request stream bytes 執行 4 KB / 4 MB 上限，不信任 `Content-Length`。
- 新活動預設 `expires_at = created_at + 30 days`；API 接受 1–365 天。
- API request 最多每分鐘補做一次到期清除。Worker Cron 在每天 `03:17 UTC` 執行清除。
- event delete 透過 foreign keys cascade 清除 attendees、scan keys、lanes 與 activity。

公開投影仍公開活動名稱、總數與報到時間。敏感活動應維持匿名並在站點前方加入額外存取控制。

### SEC-009 — dependencies

已升級 React、React Server DOM、Cloudflare Vite plugin、Workers types、Vite、Wrangler 與 Vinext，並執行可用的 `npm audit fix`。Drizzle ORM / Kit 不在 runtime path，已移除以縮小工具鏈；SQL migrations 改為人工檢查的 forward-only files。

完整 audit 剩下：

- [`image-size` ICNS infinite loop advisory](https://github.com/advisories/GHSA-w3rx-r6r6-pgpr)
- [`image-size` JXL / HEIF infinite loop advisory](https://github.com/advisories/GHSA-5p2g-fcmc-qvqq)

兩份 advisory 目前都沒有 patched version。`vite.config.ts` 在 import Vinext 前全域呼叫 `disableTypes(["heif", "icns", "jxl", "jxl-stream"])`。產品圖片路徑使用 JPG、PNG 與 WebP。安全測試傳入惡意 ICNS header，確認 parser 在讀取內容前以 disabled type 拒絕。

不要執行 `npm audit fix --force`。目前 npm 建議會把 Vinext 降級到不相容版本，並重新擴大已清理的依賴面。上游發布 patched `image-size` 後應立即升級並移除例外。

### SEC-013、SEC-014 — attack surface 與 relational integrity

- `/api/live-event` route、writer token、legacy policy tests 與 `live_event_state` 已移除。
- projection 只使用 shared API。
- migration `0005` 移除舊 `__CONFLICT__` sentinel，重建 scan keys 與 activity，加入 composite foreign keys。
- 匯入在寫入前驗證同一 scan key 不會指向不同 attendee，避免再用非法 sentinel 表示衝突。
- migration tests 會依序建立資料庫並驗證 foreign keys、cascade、expiry 與 legacy table absence。

### SEC-015、SEC-016 — 安全匯出與 disclosure

- `csvEscape()` 對公式與控制字元前綴加上單引號，再依 RFC-style CSV 規則 quote。
- 測試涵蓋 `=HYPERLINK(...)`、`+cmd`、`-1+1`、`@SUM(...)`、tab、CR 與 LF。
- `SECURITY.md` 提供 GitHub Private Vulnerability Reporting、3 個工作日初次回覆、支援版本與 coordinated disclosure 流程。

## 5. 其他攻擊面判定

| 類別 | 修正後判定 |
|---|---|
| SQL injection | SQL values 使用 D1 parameter binding。動態 `IN` 只依陣列長度產生 `?`。未發現直接注入路徑。 |
| XSS | React escaping；source 沒有 `eval`、`new Function`、`innerHTML` 或 `dangerouslySetInnerHTML`。全站 CSP 提供防禦深度。 |
| CSRF | Admin / lane Cookie 使用 SameSite=Strict。登入與登出使用 Origin 優先的 same-origin 驗證；無 Origin 的瀏覽器導覽只接受同來源 Referer 或 Fetch Metadata。JSON mutations 不接受 form encoding。 |
| SSRF | 未發現由使用者控制任意遠端 URL 的 server fetch。圖片 optimizer 使用同站 asset binding。 |
| Path traversal | API 不接受 filesystem path。CSV 與背景圖片在瀏覽器處理。 |
| Secret storage | 管理秘密在 environment；admin / lane session 在 HttpOnly Cookie；D1 只保存 lane token hash。 |
| Replay | scan request ID 保證冪等。lane token 可 revoke / rotate。管理 session 有期限與隨機 nonce。 |
| Availability | payload、attendee、lane、queue、scan 與 unknown scan 都有上限。Cloudflare binding 非全球強一致，列為剩餘風險。 |
| Spreadsheet export | 危險公式前綴已中和並有測試。 |
| Data deletion | 手動確認刪除與 expiry cleanup 都使用 event cascade；audit 證據獨立保留。 |

## 6. 資料庫重建、migration 與 rollback

本次正式部署由維護者選擇清空重建，不保存舊活動資料。Sites 會執行 `drizzle/0007_reset_production.sql`，依外鍵順序刪除 shared check-in、admin audit 與 legacy tables，並立即建立目前 schema。`scripts/reset-d1.sql` 提供非 Sites 部署的人工 reset。

| Migration | 內容 | 風險控制 |
|---|---|---|
| `0004_illegal_triathlon.sql` | admin audit、projection privacy、expiry、既有活動 +30 天 backfill | 套用前確認活動保存政策；完成後核對 expiry index |
| `0005_true_zaran.sql` | lane composite unique、刪除 conflict sentinel、重建 activity / scan keys composite FKs | 僅用於保留資料的部署路徑；先執行 foreign key integrity check |
| `0006_blue_toxin.sql` | 移除 `live_event_state` | 先確認 production 沒有 legacy client；資料表內容不可自動回復 |
| `0007_reset_production.sql` | 刪除全部活動與 audit tables，重建目前 schema | 維護者已明確接受永久刪除；部署後確認活動數為 0 |

本次部署順序是停止寫入、由 Sites 執行 reset/rebuild migration、部署 Worker、執行 smoke tests。舊活動、audit 與 legacy snapshot 會永久刪除。rollback 會再次清空 D1，再部署相容的 Worker，不執行資料回復。

`0004`–`0006` 保留給 migration regression tests 與需要保留資料的其他部署者。這些部署者應先在 preview / staging 確認 row counts、foreign keys 與 expiry。

## 7. 驗證結果

| 檢查 | 結果 | 備註 |
|---|---|---|
| `npm test` | Pass | TypeScript、production build、43/43 tests |
| `npm run lint` | Pass | 0 errors、0 warnings |
| `git diff --check` | Pass | 沒有 whitespace errors |
| `npm audit --omit=dev` | Pass | 0 vulnerabilities |
| `npm audit` | Mitigated | 2 High；同一個無 patched release 的 `image-size` parser dependency path |
| migration tests | Pass | expiry、composite FKs、cascade、legacy removal |
| auth / render tests | Pass | signed expiry session、Cookie、Origin、同來源 Fetch Metadata fallback、跨站拒絕、logout、headers、legacy absence |
| rate / privacy tests | Pass | 429、Retry-After、匿名 projection、lane DTO allowlist |
| CSV export tests | Pass | 公式與控制字元前綴中和 |
| tracked secret pattern scan | Pass | 沒有實際 credential；只保留範例名稱與測試值 |
| Git history common token pattern scan | Pass | 常見 pattern 沒有命中實際 credential |
| 10,000 × 50 公開 benchmark 保存報告 | Pass | `496.86 req/s`、0 unexpected failures |
| 10,000 × 50 安全修正後回歸 | Pass | `283.19 req/s`、p95 `224.1 ms`、22/22 checks、0 unexpected failures、cleanup complete |

本表需要在合併前以最新 working tree 重新執行。production header inspection、Cron 執行、Cloudflare binding、D1 reset 與 runtime schema 重建需要在部署後驗證。

## 8. Open-source release gate

### 程式與文件

- [x] 修正或緩解 SEC-001 至 SEC-016。
- [x] `.gitignore` 採名單與匯出檔 safe default。
- [x] 加入 `SECURITY.md` 與私人漏洞通報管道。
- [x] TypeScript、build、tests、lint 與 production audit 通過。
- [x] 未修 dependency advisory 有明確技術緩解、測試與升級條件。
- [x] README、AGENTS、architecture 與本報告同步。

### 維護者公開前操作

- [x] 採用 Apache License 2.0 並加入 `LICENSE`。
- [ ] 確認 repository 工作樹中的所有 CSV、QR 圖、匯出檔與 ZIP 都是合成資料；真實活動檔移到 repository 外。
- [ ] 使用 gitleaks 或同級工具掃描完整 Git history，並啟用 GitHub secret scanning 與 push protection。
- [ ] 確認 `SECURITY.md` 的 GitHub Private Vulnerability Reporting URL 在公開 repository 可用。
- [ ] 為 production 建立 D1 reset runbook、Cron 監控、rate-limit 告警、incident response 與隱私告知。
- [ ] 部署後外部驗證 headers、登入限流、scan 限流、projection privacy、retention Cron 與永久刪除。

## 9. 重新審查條件

以下變更需要重新做 threat model 與 security regression：

- 新增登入方式、角色、Cloudflare Access 或第三方 IdP。
- 改變 lane bootstrap、Cookie、URL 或離線儲存格式。
- 公開 projection 加入新欄位或改變預設隱私模式。
- D1 保存更多 CSV 欄位、延長 retention 或改變 delete cascade。
- 引入新的 image parser、file upload、remote fetch、Web Serial 或硬體整合。
- Vinext、React Server Components、Vite、Wrangler 或 Cloudflare runtime major upgrade。
