"use strict";

function setLanguage(code) {
  lang = code;
  localStorage.setItem(LS_LANG_KEY, lang);
  // 如果頁面上無下拉選，這行自然不會動作
  if (langSelect) langSelect.value = code;

  const t = document.getElementById("langToggle");
  if (t) {
    t.checked = (code === "en");
    const sw = t.nextElementSibling;            // 就是 .switch
    if (sw && sw.classList.contains("switch")) {
      sw.setAttribute("aria-checked", t.checked ? "true" : "false");  // ➊ 同步可及性狀態
    }
  }

  // 切語言後刷新文案/題目
  loadI18n(lang).catch(()=>{}).finally(() => {
    // 只有唔係總結畫面先重新 render 題目
    if (deck.length && !inSummary) renderCurrent();
  });
}

function lockLanguage(lock) {
  if (langSelect) langSelect.disabled = lock;
  const t = document.getElementById("langToggle");
  if (t) t.disabled = lock;
}

/* ===== Config ===== */
const CSV_URL = "./questions.csv";
const I18N_URLS = { zh: "./i18n.zh.json", en: "./i18n.en.json" };
const LS_WRONG_KEY = "liuk_wrong_ids_v1";
const LS_LANG_KEY = "liuk_lang_v1";

/* ===== DOM ===== */
const langSelect = document.getElementById("langSelect");
const modeSelect = document.getElementById("modeSelect");
const startBtn = document.getElementById("startBtn");
const counterEl = document.getElementById("counter");
const scoreEl = document.getElementById("score");
const qEl = document.getElementById("question");
const optsEl = document.getElementById("options");
const tipEl = document.getElementById("tip");
const navEl = document.getElementById("nav");
const nextBtn = document.getElementById("nextBtn");
const flashBtns = document.getElementById("flashBtns");
const nextCardBtn = document.getElementById("nextCardBtn");
const timerEl = document.getElementById("timer");
const submitBtn = document.getElementById("submitBtn");
const prevBtn = document.getElementById("prevBtn");
const skipBtn = document.getElementById("skipBtn");
const unansweredEl = document.getElementById("unanswered");
const bankSelect = document.getElementById("bankSelect");
const examReadyEl   = document.getElementById("examReady");
const examBeginBtn  = document.getElementById("examBeginBtn");
const examCancelBtn = document.getElementById("examCancelBtn");

/* ===== State ===== */
let lang = localStorage.getItem(LS_LANG_KEY) || "en";
let prevLangForExam = null; // 記錄考試前的語言
if (langSelect) langSelect.value = lang;

let i18n = {};
let allQuestions = [];
let deck = [];
let idx = 0;
let score = 0;
let wrong = 0;
let answered = false;
let wrongIds = loadWrongIds();
let isStarting = false;

/* Exam state */
let examMode = false;
let examAnswers = [];
let examTimerId = null;
let examDeadline = 0;
let inSummary = false; // 是否處於總結畫面（交卷後的成績+清單）

/* ===== 防止考試中誤關閉頁面 ===== */
function enableUnloadWarning() {
  window.onbeforeunload = (e) => {
    if (examMode) {
      e.preventDefault();
      e.returnValue = ""; // 必須 return 空字串，瀏覽器才會顯示提示
    }
  };
}
function openExamReady() {
  examReadyEl?.classList.remove("hidden");
  // 小可及性優化：把焦點放到「Begin」鍵
  setTimeout(() => examBeginBtn?.focus(), 0);
}
function closeExamReady() {
  examReadyEl?.classList.add("hidden");
}

function disableUnloadWarning() {
  window.onbeforeunload = null;
}

/* Review state (after submit) */
let reviewMode = false;
let reviewIdx = 0; // 0..deck.length-1

// 動態建立覆題面板的容器（交卷時會填充）
const reviewContainerId = "reviewPanel";

/* ===== Init ===== */
window.addEventListener("DOMContentLoaded", async () => {
  try { await loadI18n(lang); } catch (e) { console.warn("i18n load failed", e); }
});

// 按 ESC 退出考試
window.addEventListener("keydown", (e) => {
  if (examMode && e.key === "Escape") {
    e.preventDefault();
    exitExamEarly();
  }
});

// （可選）如果你在 HTML 放咗 <button data-action="exit-exam">Exit</button>
navEl?.addEventListener("click", (e) => {
  const btn = e.target.closest("[data-action='exit-exam']");
  if (btn && examMode) exitExamEarly();
});

// === Language toggle wiring ===
const langToggleEl = document.getElementById("langToggle");

// 初始狀態與 localStorage 同步
if (langToggleEl) {
  langToggleEl.checked = (lang === "en");
  langToggleEl.nextElementSibling?.setAttribute("aria-checked", langToggleEl.checked ? "true" : "false");

  langToggleEl.addEventListener("change", () => {
    if (examMode) {
      langToggleEl.checked = true;
      langToggleEl.nextElementSibling?.setAttribute("aria-checked", "true");
      return;
    }
    setLanguage(langToggleEl.checked ? "en" : "zh");
    langToggleEl.nextElementSibling?.setAttribute("aria-checked", langToggleEl.checked ? "true" : "false");
  });
}

/* Single delegation for option clicks */
optsEl.onclick = (e) => {
  const li = e.target.closest("li");
  if (!li) return;

  const mode = modeSelect.value;

  // Flashcards：不處理點擊
  if (mode === "flash") return;

  // Exam：只標「選中」，不即時判分
  if (mode === "exam") {
    const i = Number(li.getAttribute("data-idx"));
    optsEl.querySelectorAll("li").forEach(el => el.classList.remove("selected"));
    li.classList.add("selected");
    examAnswers[idx] = i;
    updateUnansweredUI();
    return;
  }

  // Quiz：即時判分
  if (answered) return;
  answered = true;

  const i = Number(li.getAttribute("data-idx"));
  const q = deck[idx];
  const correct = (i === q.answer_index);

  if (correct) {
    li.classList.add("correct");
    score++;
  } else {
    li.classList.add("wrong");
    addWrong(q.id);
    const allLis = optsEl.querySelectorAll("li");
    if (allLis[q.answer_index]) allLis[q.answer_index].classList.add("correct");
    wrong++;
  }
  updateMeta();
};

nextBtn.addEventListener("click", () => gotoNext(false));
nextCardBtn?.addEventListener("click", () => gotoNext(true));
submitBtn?.addEventListener("click", () => submitExam(false));
prevBtn?.addEventListener("click", gotoPrev);
skipBtn?.addEventListener("click", skipCurrent);

// Start：載入資料然後開始一個 session
startBtn.addEventListener("click", async () => {
  const mode = modeSelect.value;

  // Exam 模式：先顯示準備頁，真正開始在 examBeginBtn 裏處理
  if (mode === "exam") {
    openExamReady();
    return;
  }

  // 其他模式：維持原即時開始
  if (isStarting) return;
  isStarting = true; startBtn.disabled = true;
  try {
    await ensureDataLoaded();
    await startSession(mode);  // quiz / flash / review
  } catch (err) {
    tipEl.textContent = "Failed to load: " + (err && err.message ? err.message : err);
    console.error(err);
  } finally {
    isStarting = false; startBtn.disabled = false;
  }
});

modeSelect.addEventListener("change", async () => {
  if (examMode) { 
    modeSelect.value = "exam";
    tipEl.textContent = i18n.exam_switch_block || "Mode changes are disabled during the exam.";
    return;
  }
  await startSession(modeSelect.value);
});

// 初始化時記住初始值
if (bankSelect) bankSelect.dataset.prev = bankSelect.value || "all";

bankSelect?.addEventListener("change", async () => {
  if (examMode) {
    // 還原返上一次值
    if (bankSelect && bankSelect.dataset.prev) bankSelect.value = bankSelect.dataset.prev;
    tipEl.textContent = i18n.exam_bank_block || "Switching question set is disabled during the exam.";
    return;
  }
  // 非考試模式：更新 prev，並重開 session
  if (bankSelect) bankSelect.dataset.prev = bankSelect.value || "all";
  await startSession(modeSelect.value);
});

examCancelBtn?.addEventListener("click", () => {
  closeExamReady();             // 關 modal，不開始
  tipEl.textContent = i18n.exam_waiting || "Exam not started yet.";
});

examBeginBtn?.addEventListener("click", async () => {
  if (isStarting) return;
  isStarting = true; startBtn.disabled = true;
  try {
    await ensureDataLoaded();
    closeExamReady();           // 關 modal
    await startSession("exam"); // ✅ 真正開始考試、開始倒數、鎖語言
  } catch (err) {
    closeExamReady();
    tipEl.textContent = "Failed to load: " + (err && err.message ? err.message : err);
    console.error(err);
  } finally {
    isStarting = false; startBtn.disabled = false;
  }
});

/* ===== i18n ===== */
async function loadI18n(code) {
  let url = I18N_URLS[code] || I18N_URLS.en;
  let res = await fetch(url, { cache: "no-store" });
  if (!res.ok) {
    url = I18N_URLS.en;
    res = await fetch(url, { cache: "no-store" });
    if (!res.ok) throw new Error("HTTP " + res.status + " for " + url);
  }
  i18n = await res.json();

  document.querySelectorAll("[data-i18n]").forEach(el => {
    const key = el.getAttribute("data-i18n");
    if (i18n[key]) el.textContent = i18n[key];
  });
  document.querySelectorAll("[data-i18n-opt]").forEach(opt => {
    const key = opt.getAttribute("data-i18n-opt");
    if (i18n[key]) opt.textContent = i18n[key];
  });
}

/* ===== Data ===== */
async function ensureDataLoaded() {
  // 已載入就唔再重覆載
  if (allQuestions.length) return;

  try {
    // 先確保 i18n 可用
    try { 
      await loadI18n(lang); 
    } catch { 
      await loadI18n("en"); 
    }

    const res = await fetch(CSV_URL, { cache: "no-store", redirect: "follow" });
    if (!res.ok) throw new Error("HTTP " + res.status + " for " + CSV_URL);

    const blob = await res.blob();
    const MAX_BYTES = 1000000;
    if (blob.size > MAX_BYTES) throw new Error("CSV too large: " + blob.size + " bytes.");

    const text = await blob.text();
    if (/<!doctype html>/i.test(text) || /<html[\s>]/i.test(text)) {
      throw new Error("CSV_URL returned HTML, not CSV.");
    }
    const lineCount = (text.match(/\r?\n/g) || []).length + 1;
    if (lineCount > 10000) throw new Error("CSV has too many lines: " + lineCount);

    allQuestions = parseCSV(text);

    if (!allQuestions.length) {
      tipEl.textContent = "No questions found in CSV.";
    }
  } catch (err) {
    tipEl.textContent = "Failed to load questions: " + (err?.message || err);
    throw err; // 交畀上層處理
  }
}

function renderCurrent() {
  updateMeta();

  if (!deck.length) {
    qEl.textContent = i18n.no_questions || "No questions available. Check questions.csv.";
    optsEl.innerHTML = "";
    navEl.classList.add("hidden");
    flashBtns.classList.add("hidden");
    return;
  }

  const q = deck[idx];
  const qText   = (lang === "en" ? q.question_en : q.question_zh) || q.question_en;
  const options = (lang === "en" ? q.options_en : q.options_zh) || q.options_en;
  const mode    = modeSelect.value;

  qEl.textContent = qText;

  // Flash 模式：只顯示正確答案，禁用互動
  let optsToRender = options;
  let flashOnly = false;
  if (mode === "flash") {
    const ansIdx = q.answer_index;
    optsToRender = [ options[ansIdx] ];
    flashOnly = true;
  }

  const frag = document.createDocumentFragment();
  optsToRender.forEach((opt, i) => {
    const li = document.createElement("li");
    li.textContent = opt;
    li.setAttribute("role", "option");
    if (flashOnly) {
      li.classList.add("correct", "flash-answer");
      li.setAttribute("aria-disabled", "true");
      li.style.pointerEvents = "none";
      li.style.cursor = "default";
    } else {
      li.setAttribute("data-idx", String(i));
    }
    frag.appendChild(li);
  });
  optsEl.innerHTML = "";
  optsEl.appendChild(frag);

  // 控制區
  if (mode === "flash") {
    flashBtns.classList.remove("hidden");
    navEl.classList.add("hidden");
  } else {
    flashBtns.classList.add("hidden");
    navEl.classList.remove("hidden");
    if (mode !== "exam") answered = false;
  }

  // Exam：還原已選
  if (examMode && examAnswers[idx] != null) {
    const sel = optsEl.querySelector('li[data-idx="' + examAnswers[idx] + '"]');
    if (sel) sel.classList.add("selected");
  }

  if (examMode) updateUnansweredUI();
}

/* 洗牌選項並同步中英 */
function shuffleOptionsInPlace(q) {
  const opts = q.options_en.map((en, i) => ({
    en,
    zh: Array.isArray(q.options_zh) ? (q.options_zh[i] || "") : "",
    correct: i === q.answer_index
  }));
  for (let i = opts.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const t = opts[i]; opts[i] = opts[j]; opts[j] = t;
  }
  q.options_en = opts.map(o => o.en);
  q.options_zh = opts.map(o => o.zh);
  q.answer_index = opts.findIndex(o => o.correct);
}

/* ===== Render ===== */
async function startSession(mode) {
  // === reset ===
  inSummary = false;
  score = 0; wrong = 0; idx = 0; answered = false;

  // 移除舊覆核面板
  const oldPanel = document.getElementById(reviewContainerId);
  if (oldPanel) oldPanel.remove();
  reviewMode = false;
  reviewIdx = 0;

  examMode = (mode === "exam");
  clearExamTimer();

  // === Bank 篩選（A/B/C/all）===
  const bank = bankSelect ? (bankSelect.value || "all") : "all";
  let candidate = allQuestions;
  if (bank !== "all") {
    const prefix = `Set ${bank}`;
    candidate = allQuestions.filter(q => (q.topic || "").startsWith(prefix));
  }
  if (mode === "review") {
    const ids = new Set(wrongIds);
    candidate = candidate.filter(q => ids.has(q.id));
  }

  // === 造 deck ===
  if (mode === "exam") {
    deck = shuffle(candidate.map(q => ({ ...q }))).slice(0, Math.min(24, candidate.length));
  } else {
    deck = shuffle(candidate.map(q => ({ ...q })));
  }
  deck.forEach(shuffleOptionsInPlace);

  // === 語言／UI ===
  const exitBtn = document.querySelector("[data-action='exit-exam']");

  if (examMode) {
    // 只在考試模式顯示 Exit
    exitBtn?.classList.remove("hidden");

    enableUnloadWarning();

    if (lang !== "en") prevLangForExam = lang;
    setLanguage("en");
    lockLanguage(true);

    examAnswers = Array(deck.length).fill(null);
    startExamTimer(45 * 60);

    submitBtn.textContent = i18n.submit || "Submit";
    submitBtn.classList.remove("hidden");
    timerEl.classList.remove("hidden");
    prevBtn.classList.remove("hidden");
    skipBtn.classList.remove("hidden");
    unansweredEl.classList.remove("hidden");
    tipEl.textContent = i18n.tip_exam || "Exam mode: 24 questions, 45 minutes. Good luck!";
    updateUnansweredUI();
  } else {
    // 非考試模式隱藏 Exit
    exitBtn?.classList.add("hidden");

    disableUnloadWarning();
    lockLanguage(false);
    if (prevLangForExam) { setLanguage(prevLangForExam); prevLangForExam = null; }
    submitBtn.classList.add("hidden");
    timerEl.classList.add("hidden");
    prevBtn.classList.add("hidden");
    skipBtn.classList.add("hidden");
    unansweredEl.classList.add("hidden");
    tipEl.textContent =
      (mode === "review")
        ? (deck.length ? (i18n.tip_review || "Reviewing your wrong answers.") : (i18n.tip_no_review || "No wrong answers saved yet."))
        : (mode === "flash" ? (i18n.tip_flash || "Flashcards mode: reveal then self-mark.") : "");
  }

  renderCurrent();
}

function gotoPrev() {
  if (!deck.length) return;
  if (idx > 0) {
    idx--;
  } else {
    idx = deck.length - 1; // 循環
  }
  renderCurrent();
}

function skipCurrent() {
  if (!examMode) return;
  examAnswers[idx] = null;
  gotoNext(true);
}

function gotoNext(inFlash) {
  if (!deck.length) return;

  if (idx < deck.length - 1) {
    idx++;
    renderCurrent();
  } else {
    if (examMode) {
      const n = countUnanswered();
      if (n > 0) {
        const first = firstUnansweredIndex();
        if (first >= 0) {
          idx = first;
          tipEl.textContent = (i18n.exam_unanswered_tip || "You still have unanswered questions.");
          renderCurrent();
          return;
        }
      }
      submitExam(false);
    } else {
      finishSession(inFlash);
    }
  }
}

function finishSession(inFlash) {
  qEl.textContent = inFlash
    ? (i18n.flash_done || "Flashcards finished. Switch to Review or Start again.")
    : ((i18n.practice_done || "Practice finished.") + " " + (i18n.correct || "Correct") + ": " + score + "  " + (i18n.wrong || "Wrong") + ": " + wrong);
  optsEl.innerHTML = "";
  navEl.classList.add("hidden");
  flashBtns.classList.add("hidden");
  updateMeta(true);

  // 非考試結束的安全保險：確保移除關頁警示
  disableUnloadWarning();
}

function exitExamEarly() {
  if (!examMode) return;

  const answeredCnt = examAnswers.filter(v => v != null).length;
  const msg = (i18n.exam_exit_confirm || "Exit the exam now?")
            + (answeredCnt ? ` (${answeredCnt} answered will be discarded)` : "");
  const ok = window.confirm(msg);
  if (!ok) return;

  // 清理計時、關頁警示
  clearExamTimer();
  disableUnloadWarning();

  // 解鎖語言，還原考試前語言
  lockLanguage(false);
  if (prevLangForExam) {
    lang = prevLangForExam;
    prevLangForExam = null;
    localStorage.setItem(LS_LANG_KEY, lang);
    if (langSelect) langSelect.value = lang;
    const t = document.getElementById("langToggle");
    if (t) t.checked = (lang === "en");
    try { loadI18n(lang); } catch {}
  }

  // UI 收尾
  submitBtn.classList.add("hidden");
  timerEl.classList.add("hidden");
  prevBtn.classList.add("hidden");
  skipBtn.classList.add("hidden");
  unansweredEl.classList.add("hidden");
  inSummary = false;

  // 還原狀態
  examMode = false;
  examAnswers = [];
  tipEl.textContent = i18n.exam_cancelled || "Exam cancelled. You can start again anytime.";

  // 回到練習
  if (modeSelect) modeSelect.value = "quiz";
  deck = [];
  renderCurrent();
}

/* ===== Exam timer & submit ===== */
function startExamTimer(seconds) {
  examDeadline = Date.now() + seconds * 1000;
  updateTimer();
  examTimerId = setInterval(updateTimer, 1000);
}
function clearExamTimer() {
  if (examTimerId) clearInterval(examTimerId);
  examTimerId = null;
  timerEl?.classList.remove("danger");
}
function updateTimer() {
  const remain = Math.max(0, Math.floor((examDeadline - Date.now()) / 1000));
  const m = String(Math.floor(remain / 60)).padStart(2, "0");
  const s = String(remain % 60).padStart(2, "0");
  timerEl.textContent = `${m}:${s}`;
  if (remain <= 300) timerEl.classList.add("danger");
  if (remain === 0) {
    clearExamTimer();
    submitExam(true); // 時間到：強制交卷，不詢問
  }
}

function countUnanswered() {
  return examAnswers.reduce((n, v) => n + (v == null ? 1 : 0), 0);
}
function firstUnansweredIndex() {
  for (let i = 0; i < examAnswers.length; i++) {
    if (examAnswers[i] == null) return i;
  }
  return -1;
}
function updateUnansweredUI() {
  if (!examMode) return;
  const n = countUnanswered();
  unansweredEl.textContent = `${n} ${i18n.unanswered || "unanswered"}`;
}

/* === 覆題頁 === */
function buildReviewPanel() {
  let panel = document.getElementById(reviewContainerId);
  if (!panel) {
    panel = document.createElement("section");
    panel.id = reviewContainerId;
    panel.className = "review";
    // 插在結果（optsEl）之後
    optsEl.parentNode.insertBefore(panel, optsEl.nextSibling);
  }

  const total = deck.length;
  const head = document.createElement("div");
  head.className = "head";
  const title = document.createElement("div");
  title.innerHTML = `<strong>${i18n.review_title || "Review"}</strong><span class="badge-ans"></span>`;
  const ctrls = document.createElement("div");
  ctrls.innerHTML = `
    <button id="rvPrev" aria-label="Previous">${i18n.previous || "Previous"}</button>
    <span id="rvCounter" class="counter"></span>
    <button id="rvNext" aria-label="Next">${i18n.next || "Next"}</button>
    <button id="rvExit" aria-label="Close" style="margin-left:8px;">${i18n.close || "Close"}</button>
  `;
  head.appendChild(title); head.appendChild(ctrls);

  const qBox = document.createElement("div"); qBox.id = "rvQuestion";
  const ul   = document.createElement("ul");  ul.id = "rvOptions"; ul.className = "options";
  const sheet= document.createElement("div"); sheet.id="rvSheet";   sheet.className = "sheet";

  panel.innerHTML = "";
  panel.appendChild(head);
  panel.appendChild(qBox);
  panel.appendChild(ul);
  panel.appendChild(sheet);

  document.getElementById("rvPrev").onclick = () => { reviewIdx = (reviewIdx>0 ? reviewIdx-1 : total-1); renderReview(); };
  document.getElementById("rvNext").onclick = () => { reviewIdx = (reviewIdx<total-1 ? reviewIdx+1 : 0); renderReview(); };
  document.getElementById("rvExit").onclick = () => { reviewMode = false; panel.remove(); };

  sheet.innerHTML = "";
  for (let i = 0; i < total; i++) {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = String(i + 1);
    const your = examAnswers[i];
    const ok = (your === deck[i].answer_index);
    if (your != null) b.classList.add(ok ? "ok" : "bad");
    b.onclick = () => { reviewIdx = i; renderReview(); };
    sheet.appendChild(b);
  }

  reviewMode = true;
  reviewIdx = 0;
  renderReview();
}

function renderReview() {
  if (!reviewMode) return;
  const total = deck.length;
  const q = deck[reviewIdx];

  const qBox = document.getElementById("rvQuestion");
  const ul   = document.getElementById("rvOptions");
  const sheet= document.getElementById("rvSheet");
  const counter = document.getElementById("rvCounter");
  const badge   = document.querySelector(`#${reviewContainerId} .badge-ans`);

  const your = examAnswers[reviewIdx];
  const ans  = q.answer_index;

  const qText  = q.question_en || "";
  const yourTxt= (your != null) ? (q.options_en[your] || "(no answer)") : "(no answer)";
  const ansTxt = q.options_en[ans];

  qBox.innerHTML = `<h3>${qText}</h3>`;
  badge.textContent = `${(i18n.your_answer || "Your answer")}: ${yourTxt}  |  ${(i18n.correct || "Correct")}: ${ansTxt}`;

  ul.innerHTML = "";
  q.options_en.forEach((opt, i) => {
    const li = document.createElement("li");
    li.textContent = opt;
    if (i === ans) li.classList.add("correct");
    if (your != null && i === your && your !== ans) li.classList.add("wrong");
    ul.appendChild(li);
  });

  Array.from(sheet.children).forEach((btn, i) => {
    btn.classList.toggle("current", i === reviewIdx);
  });
  counter.textContent = `${reviewIdx + 1} / ${total}`;
}

// force=true：時間到自動交卷時不彈確認
async function submitExam(force = false) {
  if (examMode && !force) {
    const n = countUnanswered();
    if (n > 0) {
      const msg = `${n} ${i18n.unanswered || "unanswered"}. ${i18n.submit_anyway || "Submit anyway?"}`;
      const ok = window.confirm(msg);
      if (!ok) {
        const first = firstUnansweredIndex();
        if (first >= 0) {
          idx = first;
          tipEl.textContent = (i18n.exam_unanswered_tip || "Please answer remaining questions.");
          renderCurrent();
        }
        return;
      }
    }
  }

  // 計分 & 存錯題
  let correctCnt = 0;
  deck.forEach((q, i) => {
    const your = examAnswers[i];
    if (your === q.answer_index) correctCnt++;
    else addWrong(q.id);
  });

  // 成績標題
  const total = deck.length || 24;
  const pass = (correctCnt >= 18);
  const title = pass ? (i18n.pass || "PASS") : (i18n.fail || "FAIL");
  qEl.textContent = `${title} — ${correctCnt}/${total}`;

  // 顯示所有題目（正確綠、錯誤紅、未作答當錯）
  const ol = document.createElement("ol");
  deck.forEach((q, i) => {
    const yourIdx = examAnswers[i];
    const ansIdx  = q.answer_index;

    const qText    = (lang === "en" ? q.question_en : (q.question_zh || q.question_en)) || q.question_en;
    const optsShow = (lang === "en" ? q.options_en : (q.options_zh || q.options_en)) || q.options_en;

    const yourText = (yourIdx != null) ? (optsShow[yourIdx] || "(no answer)") : "(no answer)";
    const ansText  = optsShow[ansIdx];

    const li = document.createElement("li");
    li.className = (yourIdx === ansIdx) ? "correct" : "wrong";
    li.innerHTML = `
      <div><strong>${qText}</strong></div>
      <div>${i18n.correct || "Correct"}: ${ansText}</div>
      <div>${i18n.your_answer || "Your answer"}: ${yourText}</div>
    `;
    ol.appendChild(li);
  });

  // 清空題目區，放入清單 + Review按鈕
  optsEl.innerHTML = "";
  const reviewWrap = document.createElement("div");
  reviewWrap.className = "review";
  reviewWrap.appendChild(ol);
  optsEl.appendChild(reviewWrap);

  const openBtn = document.createElement("button");
  openBtn.type = "button";
  openBtn.style.marginTop = "12px";
  openBtn.textContent = i18n.review_all || "Review all questions";
  openBtn.onclick = () => buildReviewPanel();
  optsEl.appendChild(openBtn);

  // === 動作按鈕 ===
  const actions = document.createElement("div");
  actions.className = "actions";
  actions.style.marginTop = "12px";

  // 返回練習
  const btnPractice = document.createElement("button");
  btnPractice.type = "button";
  btnPractice.textContent = i18n.back_to_practice || "Back to Practice";
  btnPractice.style.marginRight = "8px";
  btnPractice.onclick = () => {
    inSummary = false;
    if (modeSelect) modeSelect.value = "quiz";
    startSession("quiz").catch(()=>{});
  };
  actions.appendChild(btnPractice);

  // 立即重考
  const btnRetake = document.createElement("button");
  btnRetake.type = "button";
  btnRetake.textContent = i18n.retake_exam || "Retake Exam";
  btnRetake.onclick = () => {
    inSummary = false;
    startSession("exam");
  };
  actions.appendChild(btnRetake);

  optsEl.appendChild(actions);

  // 交卷後進入總結狀態（避免切語言時重畫題目）
  inSummary = true;

  // —— 收尾 UI ——
  navEl.classList.add("hidden");
  flashBtns.classList.add("hidden");
  clearExamTimer();
  timerEl.classList.add("hidden");
  unansweredEl.classList.add("hidden");
  tipEl.textContent = pass
    ? (i18n.exam_pass_tip || "Congratulations! You passed the mock exam.")
    : (i18n.exam_fail_tip || "Keep practicing. Review the incorrect questions above.");

  // 安全：移除關頁警示
  disableUnloadWarning();

  // 恢復語言控制（如有之前語言）
  lockLanguage(false);
  if (prevLangForExam) {
    lang = prevLangForExam;
    prevLangForExam = null;
    localStorage.setItem(LS_LANG_KEY, lang);
    if (langSelect) langSelect.value = lang;
    const t = document.getElementById("langToggle");
    if (t) t.checked = (lang === "en");
    try { await loadI18n(lang); } catch {}
  }

  // ✅ 正式離開考試模式
  examMode = false;

  // 收起考試相關掣
  submitBtn.classList.add("hidden");
  prevBtn.classList.add("hidden");
  skipBtn.classList.add("hidden");
  document.querySelector("[data-action='exit-exam']")?.classList.add("hidden");

  // 同步下拉選去練習模式（UI 觀感一致）
  if (modeSelect) modeSelect.value = "quiz";
}

/* ===== Meta & wrong answers ===== */
function updateMeta(done) {
  counterEl.textContent = deck.length
    ? ((i18n.meta_q || "Question") + " " + Math.min(idx + 1, deck.length) + " / " + deck.length)
    : ((i18n.meta_q || "Question") + " 0 / 0");
  scoreEl.textContent = (i18n.correct || "Correct") + ": " + score + "   " + (i18n.wrong || "Wrong") + ": " + wrong;
  if (done) tipEl.textContent = "";
}

function loadWrongIds() {
  try {
    const raw = localStorage.getItem(LS_WRONG_KEY);
    if (!raw) return new Set();
    const arr = JSON.parse(raw);
    return new Set(Array.isArray(arr) ? arr : []);
  } catch {
    return new Set();
  }
}
function persistWrongIds() {
  try {
    localStorage.setItem(LS_WRONG_KEY, JSON.stringify(Array.from(wrongIds)));
  } catch {}
}
function addWrong(id) {
  if (!wrongIds.has(id)) {
    wrongIds.add(id);
    persistWrongIds();
  }
}

/* ===== CSV parsing & utils ===== */
function parseCSV(text) {
  const lines = text.trim().split(/\r?\n/);
  if (!lines.length) return [];

  const header = splitCSVLine(lines.shift());
  const idxMap = Object.fromEntries(header.map((h, i) => [String(h || "").trim(), i]));

  const rows = lines.map(line => splitCSVLine(line));
  const list = rows.map((cols, rowIdx) => {
    const get = (key) => {
      const i = idxMap[key];
      const v = (i == null) ? "" : (cols[i] || "");
      return (typeof v === "string") ? v.trim() : v;
    };
    const id = Number(get("id") || (rowIdx + 1));
    return {
      id: isNaN(id) ? (rowIdx + 1) : id,
      topic: get("topic"),
      question_en: get("question_en"),
      question_zh: get("question_zh"),
      options_en: String(get("options_en") || "").split(" | ").map(s => s.trim()).filter(Boolean),
      options_zh: String(get("options_zh") || "").split(" | ").map(s => s.trim()).filter(Boolean),
      answer_index: Number(get("answer_index") || 0)
    };
  });

  return list.filter(q => q.question_en && q.options_en && q.options_en.length > 0);
}

function splitCSVLine(line) {
  const parts = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === "\"") {
      if (inQuotes && line[i + 1] === "\"") { cur += "\""; i++; }
      else { inQuotes = !inQuotes; }
    } else if (ch === "," && !inQuotes) {
      parts.push(cur); cur = "";
    } else {
      cur += ch;
    }
  }
  parts.push(cur);
  return parts;
}

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const t = arr[i];
    arr[i] = arr[j];
    arr[j] = t;
  }
  return arr;
}
