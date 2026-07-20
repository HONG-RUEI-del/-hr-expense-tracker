// ---------- Constants ----------
// EMPLOYEES and DEPARTMENTS come from employees.js (generated from the HR roster export)

const STATUS_LABELS = {
  pending_supervisor: "待主管簽核",
  pending_vp: "待副總核准",
  pending_accounting: "待會計/領款",
  paid: "已領款",
  returned: "已退回"
};

const TYPE_LABELS = { overtime: "廠內加班", trip: "國內出差" };

// ---------- 會計科目對照（給「匯出工作表1格式」用） ----------
// 部門 -> 會科分類（製造/工程/業務/管理），對照公司零用金撥補表的「會科分類」欄
const DEPT_ACCOUNTING_CATEGORY = {
  "機工課": "製造", "膠工課": "製造", "電工課": "製造", "電控課": "製造",
  "製造部": "製造", "廠長室": "製造", "倉庫課": "製造", "總經理室": "製造",
  "工程部": "工程",
  "業務部": "業務",
  "生管課": "管理", "總務課": "管理", "採購課": "管理", "會計課": "管理"
};

// 會科分類 -> 各類費用對應的會科編號/會科名稱
const ACCOUNTING_CODES = {
  "製造": { travel: { code: "5154", name: "製費-旅費" }, welfare: { code: "5166", name: "製費-職工福利" }, other: { code: "5169", name: "製費-其他製造費用" } },
  "工程": { travel: { code: "6814", name: "研發-旅費" }, welfare: { code: "6829", name: "研發-職工福利" }, other: { code: "6834", name: "研發-其他費用" } },
  "業務": { travel: { code: "6614", name: "銷售-旅費" }, welfare: { code: "6629", name: "銷售-職工福利" }, other: { code: "6634", name: "銷售-其他費用" } },
  "管理": { travel: { code: "6714", name: "管理-旅費" }, welfare: { code: "6729", name: "管理-職工福利" }, other: { code: "6734", name: "管理-其他費用" } }
};

function accountFor(department, kind) {
  const category = DEPT_ACCOUNTING_CATEGORY[department];
  const codes = ACCOUNTING_CODES[category];
  return codes ? codes[kind] : { code: "", name: "" };
}

// Change this to whatever internal password you want to require for add/edit/delete.
// This only gates the UI in this browser session; it is NOT real security.
// See firebase-config.sample.js for notes on proper Firestore access rules.
const APP_PASSWORD = "00154";
// Set to true to require APP_PASSWORD again before add/edit/delete.
const REQUIRE_PASSWORD = false;

// ---------- Firebase ----------
let db = null;
let auth = null;
let currentUser = null;
let claims = [];
let unsubscribe = null;

function initFirebase() {
  if (typeof firebaseConfig === "undefined") {
    showConfigWarning();
    return;
  }
  try {
    firebase.initializeApp(firebaseConfig);
    db = firebase.firestore();
    auth = firebase.auth();
    auth.onAuthStateChanged(handleAuthChange);
  } catch (e) {
    console.error(e);
    showConfigWarning();
  }
}

function showConfigWarning() {
  document.getElementById("appRoot").hidden = true;
  document.getElementById("loginScreen").hidden = false;
  document.getElementById("loginForm").innerHTML = `
    <img src="assets/logo.png" alt="鴻睿自動化" class="login-logo">
    <h2>費用單追蹤系統</h2>
    <p class="login-error">尚未設定 Firebase。請將 <code>firebase-config.sample.js</code> 複製為
    <code>firebase-config.js</code>，填入你自己 Firebase 專案的設定值後重新整理頁面。</p>
  `;
}

// 登入狀態改變（登入/登出/頁面剛載入時判斷是否已有登入 session）
function handleAuthChange(user) {
  currentUser = user;
  if (user) {
    document.getElementById("loginScreen").hidden = true;
    document.getElementById("appRoot").hidden = false;
    document.getElementById("currentUserEmail").textContent = user.email;
    if (!unsubscribe) listenClaims();
  } else {
    if (unsubscribe) { unsubscribe(); unsubscribe = null; }
    claims = [];
    document.getElementById("appRoot").hidden = true;
    document.getElementById("loginScreen").hidden = false;
  }
}

document.getElementById("loginForm").addEventListener("submit", (e) => {
  e.preventDefault();
  const email = document.getElementById("loginEmail").value.trim();
  const password = document.getElementById("loginPassword").value;
  const errorEl = document.getElementById("loginError");
  errorEl.hidden = true;
  auth.signInWithEmailAndPassword(email, password).catch((err) => {
    const friendly = ["auth/invalid-credential", "auth/wrong-password", "auth/user-not-found"].includes(err.code)
      ? "帳號或密碼錯誤" : err.message;
    errorEl.textContent = "登入失敗：" + friendly;
    errorEl.hidden = false;
  });
});

document.getElementById("btnLogout").addEventListener("click", () => {
  auth.signOut();
});

function listenClaims() {
  unsubscribe = db.collection("claims").orderBy("createdAt", "desc")
    .onSnapshot((snap) => {
      claims = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      render();
    }, (err) => {
      console.error(err);
      document.getElementById("listWrap").innerHTML =
        `<div class="empty-state">讀取資料失敗，請確認 Firestore 規則與網路連線。（${err.message}）</div>`;
    });
}

// ---------- State ----------
let state = { type: "all", status: "all", dept: "", search: "" };

// ---------- Init UI ----------
function populateDeptSelects() {
  const filterDept = document.getElementById("filterDept");
  const fDepartment = document.getElementById("fDepartment");
  fDepartment.insertAdjacentHTML("beforeend", `<option value="" disabled selected>請選擇部門</option>`);
  DEPARTMENTS.forEach(d => {
    filterDept.insertAdjacentHTML("beforeend", `<option value="${d}">${d}</option>`);
    fDepartment.insertAdjacentHTML("beforeend", `<option value="${d}">${d}</option>`);
  });
}

// ---------- Name autocomplete (reusable: 申請人 + 每一位同行人員) ----------
// 名冊工號是6碼（例如000025），畫面上只顯示5碼、固定00開頭（例如00025）
function formatEmployeeId(id) {
  return "00" + String(Number(id)).padStart(3, "0");
}

// 掛在一組 (輸入框, 下拉清單容器) 上，回傳的 closeDropdown() 給外部（例如點外面關閉）呼叫。
// onSelect(employee) 由呼叫端決定選到人之後要做什麼（填姓名、順便帶部門等）。
function attachNameAutocomplete(inputEl, dropdownEl, onSelect) {
  let matches = [];
  let activeIndex = -1;

  function render(query) {
    const q = query.trim().toLowerCase();
    matches = !q ? EMPLOYEES : EMPLOYEES.filter(e =>
      e.name.toLowerCase().includes(q) || e.id.includes(q)
    );
    activeIndex = -1;
    dropdownEl.innerHTML = matches.length === 0
      ? `<div class="autocomplete-empty">找不到符合的人員（名冊沒有這個人也可以直接手動輸入）</div>`
      : matches.map((e, i) =>
          `<div class="autocomplete-item" data-index="${i}"><span>${escapeHtml(e.name)} <span class="ac-id">${escapeHtml(formatEmployeeId(e.id))}</span></span><span class="ac-dept">${escapeHtml(e.dept)}</span></div>`
        ).join("");
    dropdownEl.hidden = false;
  }

  function select(emp) {
    onSelect(emp);
    dropdownEl.hidden = true;
  }

  inputEl.addEventListener("input", () => render(inputEl.value));
  inputEl.addEventListener("focus", () => render(inputEl.value));

  dropdownEl.addEventListener("click", (e) => {
    const item = e.target.closest(".autocomplete-item");
    if (!item) return;
    select(matches[Number(item.dataset.index)]);
  });

  inputEl.addEventListener("keydown", (e) => {
    if (dropdownEl.hidden || matches.length === 0) return;
    const items = dropdownEl.querySelectorAll(".autocomplete-item");
    if (e.key === "ArrowDown") {
      e.preventDefault();
      activeIndex = Math.min(activeIndex + 1, items.length - 1);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      activeIndex = Math.max(activeIndex - 1, 0);
    } else if (e.key === "Enter") {
      if (activeIndex >= 0) {
        e.preventDefault();
        select(matches[activeIndex]);
      }
      return;
    } else if (e.key === "Escape") {
      dropdownEl.hidden = true;
      return;
    } else {
      return;
    }
    items.forEach((el, i) => el.classList.toggle("active", i === activeIndex));
    items[activeIndex]?.scrollIntoView({ block: "nearest" });
  });

  return () => { dropdownEl.hidden = true; };
}

document.addEventListener("click", (e) => {
  if (e.target.closest(".autocomplete-wrap")) return;
  document.querySelectorAll(".autocomplete-list").forEach(el => { el.hidden = true; });
});

const fApplicant = document.getElementById("fApplicant");
attachNameAutocomplete(fApplicant, document.getElementById("applicantSuggest"), (emp) => {
  fApplicant.value = emp.name;
  if (DEPARTMENTS.includes(emp.dept)) {
    document.getElementById("fDepartment").value = emp.dept;
  }
});

// ---------- Meal fee auto-calc ----------
function timeToMinutes(hhmm) {
  if (!hhmm) return null;
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
}

// 誤餐費是累加制：每跨過一個時間門檻（例如12:00、19:30、22:30）就多加一筆該門檻對應的金額，
// 不是「取最高門檻」。例如出差從9:00到23:30，台籍 = 50(過12:00)+130(過19:30)+130(過22:30) = 310。
// 門檻是否算「跨過」：開始時間要在門檻之前（含）、結束時間要在門檻之後（含），也就是那個門檻的用餐時段真的在外面。
// 結束時間若數值上比開始時間早，代表跨過午夜，換算成隔天的分鐘數（+1440）再比較。
function cumulativeMealFee(startTime, endTime, thresholds) {
  const s = timeToMinutes(startTime);
  let e = timeToMinutes(endTime);
  if (s === null || e === null) return 0;
  if (e < s) e += 24 * 60;
  return thresholds.reduce((total, { min, amount }) => (s <= min && e >= min) ? total + amount : total, 0);
}

// 廠內加班誤餐費：以「加班開始/結束時間」對照基準表（見費用基準表按鈕）
// 結束時間比開始時間早就視為跨過午夜（例如加班到隔天凌晨），沿用同一套累加門檻邏輯。
function computeOvertimeMeal(startTime, endTime, nationality) {
  const t1930 = 19 * 60 + 30, t2230 = 22 * 60 + 30;
  const thresholds = nationality === "外籍"
    ? [{ min: t2230, amount: 50 }]
    : [{ min: t1930, amount: 80 }, { min: t2230, amount: 50 }];
  return cumulativeMealFee(startTime, endTime, thresholds);
}

// 國內出差誤餐費：以「出廠/進廠時間」對照基準表，兩個時間都要有才能正確累加計算
function computeTripMeal(outTime, inTime, nationality) {
  const t1200 = 12 * 60, t1930 = 19 * 60 + 30, t2230 = 22 * 60 + 30;
  const thresholds = nationality === "外籍"
    ? [{ min: t1200, amount: 50 }, { min: t1930, amount: 50 }, { min: t2230, amount: 130 }]
    : [{ min: t1200, amount: 50 }, { min: t1930, amount: 130 }, { min: t2230, amount: 130 }];
  return cumulativeMealFee(outTime, inTime, thresholds);
}

// 國內出差舟車費：車輛類型 x 公里數（見費用基準表按鈕）
const MILEAGE_RATES = { "主管配車": 3, "私人汽車": 6.5, "私人機車": 5 };

function computeMileageFee(vehicleType, km) {
  const rate = MILEAGE_RATES[vehicleType];
  const distance = Number(km);
  if (!rate || !distance) return 0;
  return Math.round(rate * distance);
}

function updateMileageFee() {
  const fee = computeMileageFee(document.getElementById("fVehicleType").value, document.getElementById("fMileageKm").value);
  document.getElementById("fMileageFee").value = fee;
  syncAmount();
}

function currentType() { return document.getElementById("fType").value; }

function updateMealFee() {
  if (document.getElementById("fMealFeeZero").checked) {
    document.getElementById("fMealFee").value = 0;
    syncAmount();
    return;
  }
  const type = currentType();
  // 誤餐費是每個人各自依身分算好再相加：申請人一份 + 每位同行人員一份
  const nationalities = [document.getElementById("fNationality").value, ...companions.map(c => c.nationality || "台籍")];
  const feePerPerson = (nat) => type === "overtime"
    ? computeOvertimeMeal(document.getElementById("fOTStart").value, document.getElementById("fOTEnd").value, nat)
    : computeTripMeal(document.getElementById("fTripOutTime").value, document.getElementById("fTripInTime").value, nat);
  const fee = nationalities.reduce((sum, nat) => sum + feePerPerson(nat), 0);
  document.getElementById("fMealFee").value = fee;
  syncAmount();
}

function syncAmount() {
  const meal = Number(document.getElementById("fMealFee").value) || 0;
  const isTrip = currentType() === "trip";
  const mileage = isTrip ? (Number(document.getElementById("fMileageFee").value) || 0) : 0;
  const other = isTrip ? invoiceItems.reduce((sum, it) => sum + itemTotal(it), 0) : 0;
  document.getElementById("fAmount").value = Math.round(meal + mileage + other);
}

// ---------- 同行人員（可複選，各自填工令） ----------
let companions = [];
let companionSeq = 0;
let companionsLocked = false;

function renderCompanions() {
  const list = document.getElementById("companionsList");
  const dis = companionsLocked ? "disabled" : "";
  if (companions.length === 0) {
    list.innerHTML = `<p class="invoice-empty">尚未新增同行人員，點右上角「＋ 新增同行人員」。</p>`;
  } else {
    list.innerHTML = companions.map(c => `
      <div class="invoice-item" data-id="${c.uid}">
        <div class="invoice-item-row">
          <div class="autocomplete-wrap">
            <input type="text" data-field="name" placeholder="輸入姓名搜尋" value="${escapeHtml(c.name)}" autocomplete="off" ${dis}>
            <div class="autocomplete-list companion-suggest" hidden></div>
          </div>
        </div>
        <div class="invoice-item-row">
          <select data-field="nationality" ${dis}>
            <option value="台籍" ${c.nationality !== "外籍" ? "selected" : ""}>台籍</option>
            <option value="外籍" ${c.nationality === "外籍" ? "selected" : ""}>外籍</option>
          </select>
          <input type="text" data-field="workOrder" placeholder="工令" value="${escapeHtml(c.workOrder)}" ${dis}>
        </div>
        <div class="invoice-item-footer">
          <span></span>
          <button type="button" class="btn-remove" data-action="remove" ${dis}>刪除</button>
        </div>
      </div>
    `).join("");
    // 每一列的姓名輸入框都要各自掛上搜尋下拉，跟申請人共用同一套邏輯
    list.querySelectorAll(".invoice-item").forEach(row => {
      const uid = Number(row.dataset.id);
      const nameInput = row.querySelector('[data-field="name"]');
      const dropdown = row.querySelector(".companion-suggest");
      attachNameAutocomplete(nameInput, dropdown, (emp) => {
        nameInput.value = emp.name;
        const item = companions.find(c => c.uid === uid);
        if (item) item.name = emp.name;
      });
    });
  }
}

document.getElementById("btnAddCompanion").addEventListener("click", () => {
  // 預設同行人員的工令跟申請人一樣，通常同一趟出差/加班都是同個工令，各自還是可以改
  const applicantWorkOrder = document.getElementById("fWorkOrder").value.trim();
  companions.push({ uid: ++companionSeq, name: "", nationality: "台籍", workOrder: applicantWorkOrder });
  renderCompanions();
  updateMealFee();
});

document.getElementById("companionsList").addEventListener("click", (e) => {
  if (e.target.dataset.action !== "remove") return;
  const uid = Number(e.target.closest(".invoice-item").dataset.id);
  companions = companions.filter(c => c.uid !== uid);
  renderCompanions();
  updateMealFee();
});

document.getElementById("companionsList").addEventListener("input", (e) => {
  const field = e.target.dataset.field;
  if (!field) return;
  const uid = Number(e.target.closest(".invoice-item").dataset.id);
  const item = companions.find(c => c.uid === uid);
  if (!item) return;
  item[field] = e.target.value;
  if (field === "nationality") updateMealFee();
});

// ---------- 其他費用發票收據明細（可新增多張） ----------
const OTHER_CATEGORIES = ["油資", "製造費用", "其他"];
const VOUCHER_TYPES = ["發票", "收據"];
let invoiceItems = [];
let invoiceItemSeq = 0;
let otherItemsLocked = false;

// 收據沒有稅額可以拆（不是正式統一發票），只有發票才算5%稅額
function itemTax(item) {
  if (item.voucherType === "收據") return 0;
  return Math.round((Number(item.amount) || 0) * 0.05);
}
function itemTotal(item) { return (Number(item.amount) || 0) + itemTax(item); }

function renderInvoiceItems() {
  const list = document.getElementById("invoiceItemsList");
  const dis = otherItemsLocked ? "disabled" : "";
  if (invoiceItems.length === 0) {
    list.innerHTML = `<p class="invoice-empty">尚未新增發票收據，點右上角「＋ 新增發票收據」。</p>`;
  } else {
    list.innerHTML = invoiceItems.map(item => `
      <div class="invoice-item" data-id="${item.uid}">
        <div class="invoice-item-row">
          <select data-field="category" ${dis}>
            ${OTHER_CATEGORIES.map(c => `<option value="${c}" ${c === item.category ? "selected" : ""}>${c}</option>`).join("")}
          </select>
          <select data-field="voucherType" ${dis}>
            ${VOUCHER_TYPES.map(v => `<option value="${v}" ${v === item.voucherType ? "selected" : ""}>${v}</option>`).join("")}
          </select>
        </div>
        <div class="invoice-item-row">
          ${item.voucherType === "收據" ? "" : `<input type="text" data-field="invoiceNo" placeholder="發票號碼" value="${escapeHtml(item.invoiceNo)}" ${dis}>`}
          <input type="number" data-field="amount" min="0" step="1" placeholder="${item.voucherType === "收據" ? "金額" : "未稅金額"}" value="${item.amount}" ${dis} ${item.voucherType === "收據" ? 'style="grid-column: 1 / -1"' : ""}>
        </div>
        <div class="invoice-item-footer">
          <span>稅額 $${itemTax(item)}　小計（含稅）$${itemTotal(item)}</span>
          <button type="button" class="btn-remove" data-action="remove" ${dis}>刪除</button>
        </div>
      </div>
    `).join("");
  }
  const total = invoiceItems.reduce((sum, it) => sum + itemTotal(it), 0);
  document.getElementById("otherItemsTotalDisplay").textContent = "$" + total.toLocaleString();
  syncAmount();
}

document.getElementById("btnAddInvoice").addEventListener("click", () => {
  invoiceItems.push({ uid: ++invoiceItemSeq, category: "油資", voucherType: "發票", invoiceNo: "", amount: 0 });
  renderInvoiceItems();
});

document.getElementById("invoiceItemsList").addEventListener("click", (e) => {
  if (e.target.dataset.action !== "remove") return;
  const uid = Number(e.target.closest(".invoice-item").dataset.id);
  invoiceItems = invoiceItems.filter(it => it.uid !== uid);
  renderInvoiceItems();
});

document.getElementById("invoiceItemsList").addEventListener("input", (e) => {
  const field = e.target.dataset.field;
  if (!field) return;
  const row = e.target.closest(".invoice-item");
  const uid = Number(row.dataset.id);
  const item = invoiceItems.find(it => it.uid === uid);
  if (!item) return;
  item[field] = field === "amount" ? Number(e.target.value) || 0 : e.target.value;
  // 選收據就不需要發票號碼了，欄位會整列重畫成收據不用發票號碼
  if (field === "voucherType" && item.voucherType === "收據") item.invoiceNo = "";
  if (field === "voucherType") {
    renderInvoiceItems();
    return;
  }
  // 金額變動只更新該列的稅額/小計文字，不整個重畫，避免輸入到一半失焦
  if (field === "amount") {
    row.querySelector(".invoice-item-footer span").textContent =
      `稅額 $${itemTax(item)}　小計（含稅）$${itemTotal(item)}`;
  }
  const total = invoiceItems.reduce((sum, it) => sum + itemTotal(it), 0);
  document.getElementById("otherItemsTotalDisplay").textContent = "$" + total.toLocaleString();
  syncAmount();
});

document.getElementById("fOTStart").addEventListener("change", updateMealFee);
document.getElementById("fOTEnd").addEventListener("change", updateMealFee);
document.getElementById("fTripOutTime").addEventListener("change", updateMealFee);
document.getElementById("fTripInTime").addEventListener("change", updateMealFee);
document.getElementById("fNationality").addEventListener("change", updateMealFee);
document.getElementById("fMealFee").addEventListener("input", syncAmount);
document.getElementById("fVehicleType").addEventListener("change", updateMileageFee);
document.getElementById("fMileageKm").addEventListener("input", updateMileageFee);

function applyMealFeeZeroDisabledState(disabled) {
  document.getElementById("fMealFee").disabled = disabled;
}

document.getElementById("fMealFeeZero").addEventListener("change", (e) => {
  applyMealFeeZeroDisabledState(e.target.checked);
  updateMealFee();
});

function deadlineFor(claim) {
  if (claim.type === "overtime") {
    const d = new Date(claim.dateStart + "T00:00:00");
    let y = d.getFullYear(), m = d.getMonth() + 1 + 1; // next month
    if (m > 12) { m -= 12; y += 1; }
    return `${y}-${String(m).padStart(2, "0")}-05`;
  } else {
    const base = claim.dateEnd || claim.dateStart;
    const d = new Date(base + "T00:00:00");
    const lastDay = new Date(d.getFullYear(), d.getMonth() + 1, 0);
    return lastDay.toISOString().slice(0, 10);
  }
}

function isOverdue(claim) {
  if (claim.status === "paid" || claim.status === "returned") return false;
  const dl = deadlineFor(claim);
  const today = new Date().toISOString().slice(0, 10);
  return today > dl;
}

// ---------- Render ----------
let selectedIds = new Set();

function updateBulkActionBar(filteredIds) {
  // 篩選條件變了之後，選取範圍以外的單據就自動取消勾選，避免「看不到卻還選著」
  selectedIds.forEach(id => { if (!filteredIds.has(id)) selectedIds.delete(id); });
  const bar = document.getElementById("bulkActionBar");
  bar.hidden = selectedIds.size === 0;
  document.getElementById("bulkSelectedCount").textContent = `已選 ${selectedIds.size} 筆`;
  const allChecked = filteredIds.size > 0 && [...filteredIds].every(id => selectedIds.has(id));
  const selectAll = document.getElementById("selectAllCheckbox");
  selectAll.checked = allChecked;
  selectAll.indeterminate = !allChecked && [...filteredIds].some(id => selectedIds.has(id));
}

function render() {
  const tbody = document.getElementById("claimsBody");
  const empty = document.getElementById("emptyState");

  const counts = { all: claims.length, pending_supervisor: 0, pending_vp: 0, pending_accounting: 0, paid: 0, returned: 0 };
  claims.forEach(c => { if (counts[c.status] !== undefined) counts[c.status]++; });
  Object.keys(counts).forEach(k => {
    const el = document.getElementById("cnt-" + k);
    if (el) el.textContent = counts[k];
  });

  let filtered = claims.filter(c => {
    if (state.type !== "all" && c.type !== state.type) return false;
    if (state.status !== "all" && c.status !== state.status) return false;
    if (state.dept && c.department !== state.dept) return false;
    if (state.search) {
      const s = state.search.toLowerCase();
      const hay = `${c.applicant} ${c.reason || ""} ${c.location || ""}`.toLowerCase();
      if (!hay.includes(s)) return false;
    }
    return true;
  });

  tbody.innerHTML = "";
  empty.hidden = filtered.length > 0;

  filtered.forEach(c => {
    const overdue = isOverdue(c);
    const dateDisplay = c.type === "trip" && c.dateEnd && c.dateEnd !== c.dateStart
      ? `${c.dateStart} ~ ${c.dateEnd}` : c.dateStart;
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td><input type="checkbox" class="row-select" data-id="${c.id}" ${selectedIds.has(c.id) ? "checked" : ""}></td>
      <td><span class="type-badge type-${c.type}">${TYPE_LABELS[c.type]}</span></td>
      <td>${escapeHtml(c.applicant)}</td>
      <td>${escapeHtml(c.department || "")}</td>
      <td>${dateDisplay}</td>
      <td>${escapeHtml(c.type === "trip" ? (c.location || "") + " " + (c.reason || "") : (c.reason || ""))}</td>
      <td>$${Number(c.amount || 0).toLocaleString()}</td>
      <td>${deadlineFor(c)}${overdue ? '<span class="overdue-flag">已逾期</span>' : ""}</td>
      <td><span class="status-badge status-${c.status}">${STATUS_LABELS[c.status]}</span></td>
      <td class="row-actions"></td>
    `;
    tr.querySelector(".row-select").addEventListener("click", (e) => {
      e.stopPropagation();
      if (e.target.checked) selectedIds.add(c.id); else selectedIds.delete(c.id);
      updateBulkActionBar(new Set(filtered.map(x => x.id)));
    });
    tr.addEventListener("click", () => openEdit(c));
    tbody.appendChild(tr);
  });

  updateBulkActionBar(new Set(filtered.map(c => c.id)));
}

function escapeHtml(s) {
  return String(s || "").replace(/[&<>"']/g, m => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[m]));
}

// ---------- Filters wiring ----------
document.getElementById("typeTabs").addEventListener("click", (e) => {
  if (!e.target.dataset.type) return;
  state.type = e.target.dataset.type;
  document.querySelectorAll("#typeTabs .chip").forEach(c => c.classList.remove("active"));
  e.target.classList.add("active");
  render();
});

document.getElementById("statusTabs").addEventListener("click", (e) => {
  if (!e.target.closest("[data-status]")) return;
  const btn = e.target.closest("[data-status]");
  state.status = btn.dataset.status;
  document.querySelectorAll("#statusTabs .chip").forEach(c => c.classList.remove("active"));
  btn.classList.add("active");
  render();
});

document.getElementById("filterDept").addEventListener("change", (e) => {
  state.dept = e.target.value;
  render();
});

document.getElementById("filterSearch").addEventListener("input", (e) => {
  state.search = e.target.value.trim();
  render();
});

// ---------- 多選刪除 ----------
document.getElementById("selectAllCheckbox").addEventListener("click", (e) => {
  const visibleIds = [...document.querySelectorAll("#claimsBody .row-select")].map(cb => cb.dataset.id);
  visibleIds.forEach(id => { if (e.target.checked) selectedIds.add(id); else selectedIds.delete(id); });
  render();
});

document.getElementById("btnBulkClear").addEventListener("click", () => {
  selectedIds.clear();
  render();
});

document.getElementById("btnBulkDelete").addEventListener("click", () => {
  requirePassword(async () => {
    if (selectedIds.size === 0) return;
    if (!confirm(`確定要刪除選取的 ${selectedIds.size} 筆單據嗎？此動作無法復原。`)) return;
    try {
      await Promise.all([...selectedIds].map(id => db.collection("claims").doc(id).delete()));
      selectedIds.clear();
    } catch (err) {
      alert("刪除失敗：" + err.message);
    }
  });
});

// ---------- Modal open/close ----------
const modalOverlay = document.getElementById("modalOverlay");
const claimForm = document.getElementById("claimForm");

function resetForm() {
  claimForm.reset();
  document.getElementById("fId").value = "";
  document.getElementById("fStatus").value = "pending_supervisor";
  document.getElementById("auditInfo").hidden = true;
  document.getElementById("fMealFee").value = 0;
  document.getElementById("fVehicleType").value = "";
  document.getElementById("fMileageKm").value = 0;
  document.getElementById("fMileageFee").value = 0;
  document.getElementById("fMealFeeZero").checked = false;
  ["fOTStart", "fOTEnd", "fTripOutTime", "fTripInTime", "fMealFee", "fVehicleType", "fMileageKm", "fMileageFee",
    "fAmount", "fMealFeeZero"].forEach(id => {
    document.getElementById(id).disabled = false;
  });
  invoiceItems = [];
  otherItemsLocked = false;
  document.getElementById("btnAddInvoice").disabled = false;
  renderInvoiceItems();
  companions = [];
  renderCompanions();
  previousStartDate = "";
}

// 出差結束日預設跟出差起始日同一天（大部分出差都是當天來回），
// 只有在使用者還沒手動把結束日改成別的日期時才會自動同步。
let previousStartDate = "";
document.getElementById("fDateStart").addEventListener("change", () => {
  const startVal = document.getElementById("fDateStart").value;
  const endEl = document.getElementById("fDateEnd");
  if (!endEl.value || endEl.value === previousStartDate) {
    endEl.value = startVal;
  }
  previousStartDate = startVal;
});

function setFormModeByType(type) {
  document.getElementById("fType").value = type;
  const isOvertime = type === "overtime";
  document.getElementById("rowNationality").style.display = "grid";
  document.getElementById("rowLocation").style.display = isOvertime ? "none" : "flex";
  document.getElementById("rowDateEnd").style.display = isOvertime ? "none" : "flex";
  document.getElementById("rowOTTime").style.display = isOvertime ? "grid" : "none";
  document.getElementById("rowTripTime").style.display = isOvertime ? "none" : "grid";
  document.getElementById("rowMileage").style.display = isOvertime ? "none" : "grid";
  document.getElementById("rowMileageFee").style.display = isOvertime ? "none" : "flex";
  document.getElementById("rowOtherItems").style.display = isOvertime ? "none" : "block";
  document.getElementById("labelDateStart").firstChild.textContent =
    (isOvertime ? "加班日期 " : "出差起始日 ");
  document.getElementById("labelReason").textContent = isOvertime ? "加班原因" : "事由";
  document.getElementById("labelAmount").firstChild.textContent =
    (isOvertime ? "金額（元，＝誤餐費，金額鎖定） " : "金額（元，＝誤餐費＋舟車費＋其他費用總金額，金額鎖定） ");
  document.getElementById("modalTitle").textContent =
    (document.getElementById("fId").value ? "編輯" : "新增") + (isOvertime ? "廠內加班誤餐費申請單" : "國內出差請款單");
  updateMealFee();
  updateMileageFee();
  renderInvoiceItems();
}

// ---------- Sidebar drawer ----------
const sidebar = document.getElementById("sidebar");
const sidebarBackdrop = document.getElementById("sidebarBackdrop");

function openSidebar() {
  sidebar.classList.add("open");
  sidebarBackdrop.hidden = false;
}
function closeSidebar() {
  sidebar.classList.remove("open");
  sidebarBackdrop.hidden = true;
}
document.getElementById("btnSidebarToggle").addEventListener("click", () => {
  sidebar.classList.contains("open") ? closeSidebar() : openSidebar();
});
sidebarBackdrop.addEventListener("click", closeSidebar);

document.getElementById("btnAddOvertime").addEventListener("click", () => {
  closeSidebar();
  requirePassword(() => {
    resetForm();
    setFormModeByType("overtime");
    document.getElementById("btnDelete").hidden = true;
    modalOverlay.hidden = false;
  });
});

document.getElementById("btnAddTrip").addEventListener("click", () => {
  closeSidebar();
  requirePassword(() => {
    resetForm();
    setFormModeByType("trip");
    document.getElementById("btnDelete").hidden = true;
    modalOverlay.hidden = false;
  });
});

function openEdit(claim) {
  requirePassword(() => {
    resetForm();
    setFormModeByType(claim.type);
    document.getElementById("fId").value = claim.id;
    document.getElementById("fApplicant").value = claim.applicant || "";
    document.getElementById("fWorkOrder").value = claim.workOrder || "";
    companions = Array.isArray(claim.companions)
      ? claim.companions.map(c => ({ uid: ++companionSeq, name: c.name || "", nationality: c.nationality || "台籍", workOrder: c.workOrder || "" }))
      : [];
    renderCompanions();
    document.getElementById("fDepartment").value = claim.department || "";
    document.getElementById("fNationality").value = claim.nationality || "台籍";
    document.getElementById("fLocation").value = claim.location || "";
    document.getElementById("fDateStart").value = claim.dateStart || "";
    document.getElementById("fDateEnd").value = claim.dateEnd || "";
    previousStartDate = claim.dateStart || "";
    document.getElementById("fReason").value = claim.reason || "";
    document.getElementById("fOTStart").value = claim.otStart || "";
    document.getElementById("fOTEnd").value = claim.otEnd || "";
    document.getElementById("fTripOutTime").value = claim.tripOutTime || "";
    document.getElementById("fTripInTime").value = claim.tripInTime || "";
    document.getElementById("fMealFee").value = claim.mealFee || 0;
    document.getElementById("fVehicleType").value = claim.vehicleType || "";
    document.getElementById("fMileageKm").value = claim.mileageKm || 0;
    document.getElementById("fMileageFee").value = claim.mileageFee || 0;
    if (Array.isArray(claim.otherItems) && claim.otherItems.length > 0) {
      invoiceItems = claim.otherItems.map(it => ({ uid: ++invoiceItemSeq, category: it.category || "油資", voucherType: it.voucherType || "發票", invoiceNo: it.invoiceNo || "", amount: Number(it.amount) || 0 }));
    } else if (claim.otherFee) {
      // 舊資料相容：以前是單一其他費用欄位，轉成一筆發票明細
      invoiceItems = [{ uid: ++invoiceItemSeq, category: claim.otherCategory || "油資", voucherType: "發票", invoiceNo: claim.invoiceNo || "", amount: Number(claim.otherFee) || 0 }];
    }
    renderInvoiceItems();
    document.getElementById("fStatus").value = claim.status || "pending_supervisor";
    document.getElementById("fNote").value = claim.note || "";
    document.getElementById("fMealFeeZero").checked = !!claim.mealFeeZero;
    applyMealFeeZeroDisabledState(!!claim.mealFeeZero);
    // renderInvoiceItems() above recomputes fAmount from the parts; overwrite with the actually-saved
    // amount last in case it was manually adjusted away from the auto-sum.
    document.getElementById("fAmount").value = claim.amount || 0;
    document.getElementById("modalTitle").textContent = "編輯" + (claim.type === "overtime" ? "廠內加班誤餐費申請單" : "國內出差請款單");
    document.getElementById("btnDelete").hidden = false;
    const auditInfo = document.getElementById("auditInfo");
    if (claim.createdBy || claim.updatedBy) {
      auditInfo.textContent = `建立者：${claim.createdBy || "未知"}${claim.updatedBy && claim.updatedBy !== claim.createdBy ? "　最後修改：" + claim.updatedBy : ""}`;
      auditInfo.hidden = false;
    }
    modalOverlay.hidden = false;
  });
}

// 表單填到一半，點旁邊的半透明遮罩不會關閉（避免不小心點到就整份不見），
// 只能按右上角 ✕ 或「取消」才會關閉；按 ✕ 會再跳出確認，避免不小心點到弄丟已填的內容。
function closeModal() { modalOverlay.hidden = true; }
document.getElementById("modalClose").addEventListener("click", () => {
  if (confirm("確定要關閉嗎？尚未儲存的內容會遺失。")) closeModal();
});
document.getElementById("btnCancel").addEventListener("click", closeModal);

claimForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const id = document.getElementById("fId").value;
  const data = {
    type: document.getElementById("fType").value,
    applicant: document.getElementById("fApplicant").value.trim(),
    workOrder: document.getElementById("fWorkOrder").value.trim(),
    companions: companions
      .filter(c => c.name.trim())
      .map(c => ({ name: c.name.trim(), nationality: c.nationality || "台籍", workOrder: c.workOrder.trim() })),
    department: document.getElementById("fDepartment").value,
    nationality: document.getElementById("fNationality").value,
    location: document.getElementById("fLocation").value.trim(),
    dateStart: document.getElementById("fDateStart").value,
    dateEnd: document.getElementById("fDateEnd").value,
    reason: document.getElementById("fReason").value.trim(),
    otStart: document.getElementById("fOTStart").value,
    otEnd: document.getElementById("fOTEnd").value,
    tripOutTime: document.getElementById("fTripOutTime").value,
    tripInTime: document.getElementById("fTripInTime").value,
    mealFee: Number(document.getElementById("fMealFee").value) || 0,
    vehicleType: document.getElementById("fVehicleType").value,
    mileageKm: Number(document.getElementById("fMileageKm").value) || 0,
    mileageFee: Number(document.getElementById("fMileageFee").value) || 0,
    otherItems: invoiceItems.map(it => ({
      category: it.category, voucherType: it.voucherType, invoiceNo: it.invoiceNo, amount: Number(it.amount) || 0,
      tax: itemTax(it), total: itemTotal(it)
    })),
    otherFee: invoiceItems.reduce((sum, it) => sum + (Number(it.amount) || 0), 0),
    otherTax: invoiceItems.reduce((sum, it) => sum + itemTax(it), 0),
    otherTotal: invoiceItems.reduce((sum, it) => sum + itemTotal(it), 0),
    mealFeeZero: document.getElementById("fMealFeeZero").checked,
    amount: Math.round(Number(document.getElementById("fAmount").value) || 0),
    status: document.getElementById("fStatus").value,
    note: document.getElementById("fNote").value.trim(),
    updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
    updatedBy: currentUser ? currentUser.email : ""
  };

  try {
    if (id) {
      await db.collection("claims").doc(id).update(data);
    } else {
      data.createdAt = firebase.firestore.FieldValue.serverTimestamp();
      data.createdBy = currentUser ? currentUser.email : "";
      await db.collection("claims").add(data);
    }
    closeModal();
  } catch (err) {
    alert("儲存失敗：" + err.message);
  }
});

document.getElementById("btnDelete").addEventListener("click", async () => {
  const id = document.getElementById("fId").value;
  if (!id) return;
  if (!confirm("確定要刪除這筆單據嗎？此動作無法復原。")) return;
  try {
    await db.collection("claims").doc(id).delete();
    closeModal();
  } catch (err) {
    alert("刪除失敗：" + err.message);
  }
});

// ---------- Rates modal ----------
document.getElementById("btnRates").addEventListener("click", () => { document.getElementById("ratesOverlay").hidden = false; });
document.getElementById("ratesClose").addEventListener("click", () => { document.getElementById("ratesOverlay").hidden = true; });
document.getElementById("ratesOverlay").addEventListener("click", (e) => { if (e.target.id === "ratesOverlay") document.getElementById("ratesOverlay").hidden = true; });

// ---------- Password gate ----------
let pwPendingAction = null;
let pwUnlocked = sessionStorage.getItem("hr_unlocked") === "1";

function requirePassword(action) {
  if (!REQUIRE_PASSWORD || pwUnlocked) { action(); return; }
  pwPendingAction = action;
  document.getElementById("pwInput").value = "";
  document.getElementById("pwOverlay").hidden = false;
  document.getElementById("pwInput").focus();
}

document.getElementById("pwConfirm").addEventListener("click", () => {
  const val = document.getElementById("pwInput").value;
  if (val === APP_PASSWORD) {
    pwUnlocked = true;
    sessionStorage.setItem("hr_unlocked", "1");
    document.getElementById("pwOverlay").hidden = true;
    if (pwPendingAction) pwPendingAction();
    pwPendingAction = null;
  } else {
    alert("密碼錯誤");
  }
});
document.getElementById("pwCancel").addEventListener("click", () => {
  document.getElementById("pwOverlay").hidden = true;
  pwPendingAction = null;
});
document.getElementById("pwInput").addEventListener("keydown", (e) => {
  if (e.key === "Enter") document.getElementById("pwConfirm").click();
});

// ---------- Excel export ----------
document.getElementById("btnExport").addEventListener("click", () => {
  const rows = claims.map(c => ({
    "類型": TYPE_LABELS[c.type],
    "申請人": c.applicant,
    "申請人工令": c.workOrder || "",
    "同行人員": Array.isArray(c.companions) && c.companions.length > 0
      ? c.companions.map(p => `${p.name}(工令:${p.workOrder || "無"})`).join("; ")
      : "",
    "部門": c.department,
    "身分": c.nationality,
    "出差地點": c.location || "",
    "日期(起)": c.dateStart,
    "日期(迄)": c.dateEnd || "",
    "事由/原因": c.reason,
    "加班開始": c.otStart || "",
    "加班結束": c.otEnd || "",
    "出廠時間": c.tripOutTime || "",
    "進廠時間": c.tripInTime || "",
    "誤餐費": c.mealFee || 0,
    "不列誤餐費": c.mealFeeZero ? "是" : "否",
    "車輛類型": c.vehicleType || "",
    "公里數": c.mileageKm || 0,
    "舟車費": c.mileageFee || 0,
    "發票張數": Array.isArray(c.otherItems) ? c.otherItems.length : 0,
    "發票明細": Array.isArray(c.otherItems)
      ? c.otherItems.map(it => `${it.category}(${it.voucherType || "發票"}) ${it.invoiceNo || "(無號碼)"} $${it.amount}`).join("; ")
      : "",
    "其他費用未稅金額": c.otherFee || 0,
    "其他費用稅額": c.otherTax || 0,
    "其他費用總金額": c.otherTotal || 0,
    "金額": c.amount,
    "送件期限": deadlineFor(c),
    "是否逾期": isOverdue(c) ? "是" : "否",
    "狀態": STATUS_LABELS[c.status],
    "備註": c.note || ""
  }));
  const ws = XLSX.utils.json_to_sheet(rows);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "費用單");
  const today = new Date().toISOString().slice(0, 10);
  XLSX.writeFile(wb, `費用單追蹤_${today}.xlsx`);
});

// ---------- 匯出會計格式（比照零用金撥補申請表「工作表1」欄位） ----------
// 一張單可能拆成好幾列：誤餐費、舟車費、每張發票各自一列，「專案名稱」「統編」欄位系統沒存，留空給人工補。
function buildAccountingRows(claim) {
  const dept = claim.department;
  const category = DEPT_ACCOUNTING_CATEGORY[dept] || "";
  const workOrder = claim.workOrder || "無工令";
  const rows = [];

  function addRow(label, amount, kind, extra = {}) {
    if (!amount) return;
    const acc = accountFor(dept, kind);
    rows.push({
      "部門": category,
      "工令": extra.workOrder || workOrder,
      "專案名稱": "",
      "備註": label,
      "部門&備註": category + label,
      "會科編號": acc.code,
      "會科": acc.name,
      "統編": extra.taxId || "",
      "日期1": claim.dateStart || "",
      "發票號碼": extra.invoiceNo || "",
      "未稅": extra.untaxed !== undefined ? extra.untaxed : "",
      "稅金": extra.tax !== undefined ? extra.tax : "",
      "含稅/金額": amount,
      "合計": "",
      "領款人": "",
      "簽名": ""
    });
  }

  if (claim.type === "overtime") {
    addRow("廠內加班誤餐費", claim.amount, "welfare");
  } else {
    if (claim.mealFee) addRow("國內出差誤餐費", claim.mealFee, "travel");
    if (claim.mileageFee) addRow("舟車費", claim.mileageFee, "travel");
    (claim.otherItems || []).forEach(it => {
      if (!it.total) return;
      addRow(it.category, it.total, it.category === "油資" ? "travel" : "other",
        { untaxed: it.amount, tax: it.tax, invoiceNo: it.invoiceNo });
    });
  }

  if (rows.length === 0) {
    addRow(claim.type === "overtime" ? "廠內加班誤餐費" : "國內出差誤餐費", claim.amount,
      claim.type === "overtime" ? "welfare" : "travel");
  }

  rows[0]["合計"] = claim.amount;
  rows[0]["領款人"] = claim.applicant;
  return rows;
}

document.getElementById("btnExportAccounting").addEventListener("click", () => {
  // 先依申請人分開，同一人的單再依日期新到舊排序
  const sortedClaims = [...claims].sort((a, b) => {
    const byApplicant = (a.applicant || "").localeCompare(b.applicant || "", "zh-Hant");
    if (byApplicant !== 0) return byApplicant;
    return (b.dateStart || "").localeCompare(a.dateStart || "");
  });
  const rows = sortedClaims.flatMap(buildAccountingRows);
  const ws = XLSX.utils.json_to_sheet(rows, {
    header: ["部門", "工令", "專案名稱", "備註", "部門&備註", "會科編號", "會科", "統編", "日期1", "發票號碼", "未稅", "稅金", "含稅/金額", "合計", "領款人", "簽名"]
  });
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "工作表1");
  const today = new Date().toISOString().slice(0, 10);
  XLSX.writeFile(wb, `會計格式匯出_${today}.xlsx`);
});

// ---------- Boot ----------
populateDeptSelects();
initFirebase();
