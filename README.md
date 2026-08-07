# 抵達｜Luma QR 報到台

匯入 Luma 活動來賓 CSV，以 USB 條碼掃描器完成報到，並把結果匯出成 CSV。完整名單與報到紀錄保存在管理電腦瀏覽器的 IndexedDB；跨裝置投影只同步必要的公開資訊。

## 啟動

需要 Node.js 22.13 或更新版本。

```bash
npm install
cp .env.example .env.local
# 編輯 .env.local，設定 ADMIN_PASSWORD
npm run dev
```

看到終端機顯示 Local URL 後可使用三個畫面：

- 管理畫面：[http://localhost:3000/admin](http://localhost:3000/admin)
- 來賓掃描畫面：[http://localhost:3000/scan](http://localhost:3000/scan)
- 投影能量牆：[http://localhost:3000/projection](http://localhost:3000/projection)

`/` 與 `/admin` 需要輸入 `ADMIN_PASSWORD`；來賓與投影畫面維持公開。登入只保留在該瀏覽器工作階段，中控台右上角選單可手動登出。登出會結束公開投影並讓投影牆歸零，本機的名單與報到紀錄仍會保留，之後登入即可繼續使用或匯出。

管理畫面與來賓掃描畫面要使用同一台電腦上的同一個瀏覽器，才能共用完整名單。正式網站的投影能量牆可在另一台連網電腦開啟相同網域的 `/projection`；使用 localhost 開發時，則以報到電腦的區網 IP（例如 `http://192.168.1.23:3000/projection`）開啟，並確認防火牆允許 Node 接受連線。

## 現場使用

1. 匯入 Luma 匯出的 CSV；程式會辨識 `qr_code_url`，並在有 `approval_status` 時只納入 `approved` 來賓。
2. 在管理畫面的「來賓畫面顯示內容」勾選掃描成功後要顯示的 CSV 欄位。
3. 開啟來賓掃描畫面，將 XD-2002W 維持在 USB 鍵盤模式。建議設定掃描結尾為 Enter；即使沒有 Enter，完整代碼停頓 0.1 秒後也會自動送出。報到成功／失敗提示音預設關閉，可在右上角「掃描設定」中開啟。
4. 掃描成功後，來賓畫面會顯示所選資料；管理畫面也會同步顯示目前掃描的人並更新名單。
5. 在投影電腦開啟 `/projection` 並按「開始投影」。每位已報到來賓會形成一顆專屬星球，星球總數永遠等於已報到人數；新報到者的星球會從畫面外飛入，姓名也會首次登場。中控台另可播放登車廣播或觸發全場彩蛋。
6. 報到紀錄與顯示設定會即時保存在同一個瀏覽器。關閉後再開啟仍可恢復，重新開啟管理頁時也會把目前狀態送回投影牆。
7. 按「匯出結果」，原始欄位會保留，並增加 `local_check_in_status` 與 `local_checked_in_at`。

請固定使用同一台報到電腦、同一個瀏覽器與同一個瀏覽器使用者；清除網站資料或使用私密瀏覽會移除本機紀錄。投影同步只傳送已報到者的姓名、報到時間、總人數與控制指令，不會傳送 Email、電話、QR Code 或問卷內容。活動進行中仍建議定期匯出 CSV 備份。

## 驗證

```bash
npm test
```

如需重新產生 150 人範例 ZIP，請先安裝系統指令 `qrencode` 與 `zip`，再執行 `npm run sample:generate`。
