# 鴻睿自動化 費用單追蹤系統

追蹤「廠內加班誤餐費申請單」與「國內出差請款單」目前的簽核進度（待主管簽核 / 待副總核准 / 待會計或領款 / 已領款 / 已退回），並標示逾期未送件的單據。

## 本機測試

因為使用了 Firebase，用瀏覽器直接打開 `index.html` 通常也能動（file:// 協定），若遇到讀取失敗，改用一個簡易本機伺服器：

```
# 有安裝 Python 的話
python -m http.server 8000
# 然後瀏覽 http://localhost:8000
```

## 設定 Firebase（免費）

1. 前往 https://console.firebase.google.com/ 建立新專案（Spark 免費方案即可）
2. 專案總覽 → 新增「Web應用程式」，複製產生的 `firebaseConfig`
3. 左側選單「Build → Authentication」→「開始使用」→ 啟用「Email/Password」登入方式
4. 「Authentication → Users」手動新增使用者帳號（email + 密碼）——這個系統不開放自助註冊，
   有誰要用，都是在這裡幫他/她開帳號
5. 左側選單「Build → Firestore Database」→ 建立資料庫
6. 到 Firestore「規則」分頁，貼上（詳見 `firebase-config.sample.js` 內的說明與注意事項）：

   ```
   rules_version = '2';
   service cloud.firestore {
     match /databases/{database}/documents {
       match /claims/{docId} {
         allow read, write: if request.auth != null;
       }
     }
   }
   ```

7. 複製 `firebase-config.sample.js` 為 `firebase-config.js`，貼上你自己的設定值
8. 打開 `index.html`，用剛剛在 Authentication 開的帳號登入即可使用

> 現在寫入保護是靠 Firebase Authentication（必須登入公司帳號才能讀寫資料），比之前「誰都能改」的版本嚴謹很多，
> 每筆單據也會記錄是哪個帳號建立/最後修改的（編輯視窗底部會顯示）。
> 如果之後想再收緊成「只能改自己建立的單據」，可以再請我協助調整 Firestore 規則。
> `app.js` 裡原本那組共用密碼（`APP_PASSWORD`/`REQUIRE_PASSWORD`）現在已經是多餘的雙重保護，
> 預設是關閉的（`REQUIRE_PASSWORD = false`），不影響使用，之後想清掉也可以再說。

## 部署到 GitHub Pages

1. 建立一個新的 GitHub repository（例如 `hr-expense-tracker`）
2. 把這個資料夾內的檔案（`index.html`、`style.css`、`app.js`、`firebase-config.js`）推上去
   - **注意**：`firebase-config.js` 內的內容會是公開可見的，這是正常的（Firebase 網頁端設定值本來就不是密鑰），真正的保護要靠 Firestore 規則
3. Repository → Settings → Pages → Source 選 `main` 分支 / root，儲存
4. 幾分鐘後即可透過 `https://<你的帳號>.github.io/hr-expense-tracker/` 使用

## 欄位說明

**廠內加班誤餐費**：申請人、部門、身分（台籍/外籍）、加班日期、加班原因、金額、狀態
**國內出差請款單**：申請人、部門、身分、出差地點、出差起訖日、事由、金額（誤餐費+舟車費+其他費用發票明細，自動加總）、狀態

「費用基準表」按鈕內有兩份 PDF 裡的計算基準，方便核算金額時對照，但系統本身不會自動計算金額（避免計算邏輯出錯導致金額有誤，金額請對照紙本單據人工填寫）。

「送件期限」自動計算：加班誤餐費為次月5日，出差請款單為出差月份最後一日；超過期限且尚未「已領款/已退回」會顯示紅字「已逾期」。
