"use strict";

/* ====== Config ====== */
const CSV_URL = "./questions.csv";
const LS_WRONG_KEY = "liuk_wrong_ids_v1";
const LS_LANG_KEY = "liuk_lang_v1";

/* ====== DOM ====== */
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
const showAnswerBtn = document.getElementById("showAnswerBtn");
const markWrongBtn = document.getElementById("markWrongBtn");
const nextCardBtn = document.getElementById("nextCardBtn");

/* ====== State ====== */
let lang = localStorage.getItem(LS_LANG_KEY) || "zh";
langSelect.value = lang;

let allQuestions = [];
let deck = [];
let idx = 0;
let score = 0;
let wrong = 0;
let answered = false;
let wrongIds = loadWrongIds();

/* ====== Init ====== */
langSelect.addEventListener("change", () => {
  lang = langSelect.value;
  localStorage.setItem(LS_LANG_KEY, lang);
  if (deck.length) renderCurrent();
});

startBtn.addEventListener("click", async () => {
  try {
    await ensureDataLoaded();
    startSession(modeSelect.value);
  } catch (err) {
    tipEl.textContent = "Failed to load questions: " + (err && err.message ? err.message : err);
  }
});

modeSelect.addEventListener("change", () => { /* no-op; press Start to rebuild deck */ });

nextBtn.addEventListener("click", () => gotoNext(false));

showAnswerBtn.addEventListener("click", () => revealFlashAnswer());
markWrongBtn.addEventListener("click", () => {
  const cur = deck[idx];
  addWrong(cur.id);
  gotoNext(true);
});
nextCardBtn.addEventListener("click", () => gotoNext(true));

/* ====== Core ====== */
async function ensureDataLoaded() {
  if (allQuestions.length) return;
  const res = await fetch(CSV_URL);
  if (!res.ok) throw new Error("HTTP " + res.status + " for " + CSV_URL);
  const text = await res.text();
  allQuestions = parseCSV(text);
}

function startSession(mode) {
  score = 0; wrong = 0; idx = 0; answered = false;

  if (mode === "review") {
    const ids = Array.from(wrongIds);
    deck = allQuestions.filter(q => ids.includes(q.id));
    tipEl.textContent = deck.length ? "Reviewing your wrong answers." : "No wrong answers saved yet.";
  } else {
    deck = shuffle(allQuestions.slice());
    tipEl.textContent = (mode === "flash") ? "Flashcards mode: reveal then self-mark." : "";
  }

  renderCurrent();
}

function renderCurrent() {
  updateMeta();

  if (!deck.length) {
    qEl.textContent = "No questions available. Check questions.csv.";
    optsEl.innerHTML = "";
    navEl.classList.add("hidden");
    flashBtns.classList.add("hidden");
    return;
  }

  const q = deck[idx];
  const qText = (lang === "en" ? q.question_en : q.question_zh) || q.question_en;
  const options = (lang === "en" ? q.options_en : q.options_zh) || q.options_en;

  qEl.textContent = qText;
  optsEl.innerHTML = "";

  const mode = modeSelect.value;

  if (mode === "flash") {
    flashBtns.classList.remove("hidden");
    navEl.classList.add("hidden");
  } else {
    flashBtns.classList.add("hidden");
    navEl.classList.remove("hidden");
    answered = false;

    options.forEach((opt, i) => {
      const li = document.createElement("li");
      li.textContent = opt;
      li.setAttribute("role", "option");
      li.addEventListener("click", () => {
        if (answered) return;
        answered = true;
        const correct = (i === q.answer_index);
        if (correct) {
          li.classList.add("correct");
          score++;
        } else {
          li.classList.add("wrong");
          addWrong(q.id);
          const allLis = Array.from(optsEl.querySelectorAll("li"));
          if (allLis[q.answer_index]) allLis[q.answer_index].classList.add("correct");
          wrong++;
        }
        updateMeta();
      });
      optsEl.appendChild(li);
    });
  }
}

function revealFlashAnswer() {
  const q = deck[idx];
  const options = (lang === "en" ? q.options_en : q.options_zh) || q.options_en;
  optsEl.innerHTML = "";
  options.forEach((opt, i) => {
    const li = document.createElement("li");
    li.textContent = (i === q.answer_index) ? ("[Answer] " + opt) : opt;
    optsEl.appendChild(li);
  });
}

function gotoNext(inFlash) {
  if (!deck.length) return;
  if (idx < deck.length - 1) {
    idx++;
    renderCurrent();
  } else {
    finishSession(inFlash);
  }
}

function finishSession(inFlash) {
  qEl.textContent = inFlash
    ? "Flashcards finished. Switch to Review to revisit wrong answers, or Start again."
    : ("Practice finished. Correct: " + score + "  Wrong: " + wrong + ". Switch to Review or Start again.");
  optsEl.innerHTML = "";
  navEl.classList.add("hidden");
  flashBtns.classList.add("hidden");
  updateMeta(true);
}

function updateMeta(done) {
  counterEl.textContent = deck.length
    ? ("Question " + Math.min(idx + 1, deck.length) + " / " + deck.length)
    : "Question 0 / 0";
  scoreEl.textContent = "Correct: " + score + "   Wrong: " + wrong;
  if (done) tipEl.textContent = "";
}

/* ====== Wrong answers (localStorage) ====== */
function loadWrongIds() {
  try {
    const raw = localStorage.getItem(LS_WRONG_KEY);
    if (!raw) return new Set();
    const arr = JSON.parse(raw);
    return new Set(Array.isArray(arr) ? arr : []);
  } catch (e) {
    return new Set();
  }
}

function persistWrongIds() {
  try {
    localStorage.setItem(LS_WRONG_KEY, JSON.stringify(Array.from(wrongIds)));
  } catch (e) {
    // ignore quota errors
  }
}

function addWrong(id) {
  if (!wrongIds.has(id)) {
    wrongIds.add(id);
    persistWrongIds();
  }
}

/* ====== CSV parsing and utils ====== */
/*
Expected CSV headers:
id,topic,question_en,question_zh,options_en,options_zh,answer_index
Options are separated by " | " (space-pipe-space).
answer_index is zero-based.
*/
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
      return typeof v === "string" ? v.trim() : v;
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
  return arr;
}