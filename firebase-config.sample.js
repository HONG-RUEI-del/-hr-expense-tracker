// 1. 到 https://console.firebase.google.com/ 建立一個新專案（免費 Spark 方案即可）
// 2. 專案內新增一個「Web應用程式」，複製產生的設定值貼到下面
// 3. 左側選單「Build → Authentication」→「開始使用」→ 啟用「Email/Password」登入方式
// 4. 「Authentication → Users」手動新增使用者帳號（email + 密碼）——這個系統不開放自助註冊，
//    有誰要用，都是在這裡幫他/她開帳號
// 5. 左側選單「Build → Firestore Database」→ 建立資料庫（正式環境模式即可，之後在下方步驟6貼規則）
// 6. 到 Firestore「規則」分頁，貼上以下規則後發布：
//
//    rules_version = '2';
//    service cloud.firestore {
//      match /databases/{database}/documents {
//        match /claims/{docId} {
//          allow read, write: if request.auth != null;
//        }
//      }
//    }
//
//    這組規則要求「必須是登入的帳號」才能讀寫資料，比之前任何人都能改的版本嚴謹很多。
//    如果之後還要更細（例如只能改自己建立的單據），可以再請我幫忙調整規則。
//
// 7. 把下面五個值換成你自己專案的值，並把檔名改成 firebase-config.js（跟 index.html 同一層）

const firebaseConfig = {
  apiKey: "YOUR_API_KEY",
  authDomain: "YOUR_PROJECT.firebaseapp.com",
  projectId: "YOUR_PROJECT_ID",
  storageBucket: "YOUR_PROJECT.appspot.com",
  messagingSenderId: "YOUR_SENDER_ID",
  appId: "YOUR_APP_ID"
};
