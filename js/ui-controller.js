// Application controller: library, importing, reader, narration, popovers, reading goals.

import * as db from "./storage.js";
import { parseBookFile, fileId, summarise, makeThumbnail } from "./book-parser.js";
import { TTSEngine, CURATED_VOICES, describeVoice } from "./tts-engine.js";
import { ReaderView } from "./reader-view.js";
import { LibraryView, COLLECTIONS, createCover, el, icon } from "./library-view.js";
import { countWords, formatDuration, dayKey } from "./text-utils.js";

const $ = id => document.getElementById(id);

// ---------------------------------------------------------------- settings
const DEFAULTS = Object.freeze({
  theme: "auto", font: "original", fontSize: 20, lineHeight: 1.55, margins: "normal", justify: false,
  layout: "paged", pageTurn: "slide", voice: "bf_emma", speed: 1, follow: true, view: "shelf",
  collection: "all", goal: 15,
});
const THEMES = [
  ["auto", "Auto"], ["original", "Original"], ["paper", "Paper"], ["calm", "Calm"],
  ["quiet", "Quiet"], ["focus", "Focus"], ["night", "Night"],
];
const DARK_THEMES = new Set(["quiet", "focus", "night"]);
const FONTS = [
  ["original", "Charter"], ["iowan", "Iowan"], ["newyork", "New York"], ["palatino", "Palatino"],
  ["baskerville", "Baskerville"], ["georgia", "Georgia"], ["garamond", "Garamond"], ["sf", "San Francisco"],
];
const CHOICES = {
  theme: THEMES.map(t => t[0]), font: FONTS.map(f => f[0]), margins: ["narrow", "normal", "wide"],
  layout: ["paged", "scroll"], pageTurn: ["slide", "none"], view: ["shelf", "list"], collection: COLLECTIONS.map(c => c.id),
};
const RANGES = { fontSize: [14, 32], lineHeight: [1.3, 2.0], speed: [0.75, 2.0], goal: [5, 240] };

/** Copy only known keys with valid values (stored data is never trusted blindly). */
function sanitiseSettings(raw) {
  const out = { ...DEFAULTS };
  if (!raw || typeof raw !== "object") return out;
  for (const key of Object.keys(DEFAULTS)) {
    if (!Object.prototype.hasOwnProperty.call(raw, key)) continue;
    const value = raw[key];
    if (CHOICES[key]) { if (CHOICES[key].includes(value)) out[key] = value; }
    else if (RANGES[key]) { if (typeof value === "number" && value >= RANGES[key][0] && value <= RANGES[key][1]) out[key] = value; }
    else if (typeof DEFAULTS[key] === "boolean") { if (typeof value === "boolean") out[key] = value; }
    else if (key === "voice") { if (typeof value === "string" && /^[a-z]{2}_[a-z0-9_]{1,40}$/.test(value)) out[key] = value; }
  }
  return out;
}

// ------------------------------------------------------------------- state
const state = {
  settings: { ...DEFAULTS },
  books: [],
  search: "",
  book: null,
  chapters: null,
  flat: [],
  annotations: [],
  cursor: null,
  pagePos: null,
  voices: CURATED_VOICES.map(v => v.id),
  wpm1: 165,
  readWpm: 230,
  lastTurn: 0,
  lastActivity: Date.now(),
  pending: { read: 0, listen: 0, pages: 0, words: 0 },
};
const systemDark = matchMedia("(prefers-color-scheme: dark)");

const library = new LibraryView({
  grid: $("shelves"), list: $("list"), continueEl: $("continue"), headEl: $("shelves-head"), scroller: $("bookcase"),
  onOpen: (book, coverEl) => openBook(book, coverEl),
  onListen: (book, coverEl) => { tts.ensureContext(); openBook(book, coverEl).then(() => togglePlay()); },
  onMore: (book, anchor) => bookMenu(book, anchor),
});
const reader = new ReaderView($("reader"));
const tts = new TTSEngine({
  key: loc => `${loc.c}:${loc.s}`,
  text: loc => {
    const item = state.flat[loc.c]?.[loc.s];
    if (!item) return null;
    if (item.heading && /^[IVXLC]{1,7}\.?$/.test(item.text.trim())) return `Chapter ${romanToInt(item.text.trim().replace(".", ""))}.`;
    return item.text;
  },
  next: loc => {
    if (state.flat[loc.c] && loc.s + 1 < state.flat[loc.c].length) return { c: loc.c, s: loc.s + 1 };
    for (let c = loc.c + 1; c < state.flat.length; c++) if (state.flat[c].length) return { c, s: 0 };
    return null;
  },
});

function romanToInt(roman) {
  const map = { I: 1, V: 5, X: 10, L: 50, C: 100 };
  let total = 0;
  for (let i = 0; i < roman.length; i++) {
    const v = map[roman[i]], n = map[roman[i + 1]] || 0;
    total += v < n ? -v : v;
  }
  return total;
}

// -------------------------------------------------------------- utilities
function toast(message, { error = false, ms = 3800 } = {}) {
  const t = el("div", `toast${error ? " error" : ""}`, message);
  $("toasts").append(t);
  setTimeout(() => t.remove(), ms);
}

let saveSettingsTimer = 0;
function saveSettings() {
  clearTimeout(saveSettingsTimer);
  saveSettingsTimer = setTimeout(() => db.setKV("settings", state.settings).catch(() => {}), 300);
}

function throttle(fn, ms) {
  let last = 0, timer = 0;
  return (...args) => {
    const now = Date.now();
    clearTimeout(timer);
    if (now - last >= ms) { last = now; fn(...args); }
    else timer = setTimeout(() => { last = Date.now(); fn(...args); }, ms - (now - last));
  };
}

function isDarkTheme(theme = state.settings.theme) {
  return theme === "auto" ? systemDark.matches : DARK_THEMES.has(theme);
}

function applyChrome() {
  const readerOpen = !$("reader").hidden;
  document.body.dataset.ui = (readerOpen ? isDarkTheme() : systemDark.matches) ? "dark" : "light";
  $("reader").dataset.theme = state.settings.theme;
  $("reader").dataset.dark = String(isDarkTheme());
}
systemDark.addEventListener("change", applyChrome);

// ------------------------------------------------------------------ library
function renderCollectionsNav() {
  const nav = $("collections-nav");
  nav.replaceChildren();
  for (const c of COLLECTIONS) {
    const count = state.books.filter(c.test).length;
    if (c.id !== "all" && c.id !== "reading" && c.id !== "finished" && !count) continue;
    const b = el("button", "side-item");
    b.setAttribute("aria-current", String(state.settings.collection === c.id));
    b.append(icon(c.icon), el("span", null, c.label), el("span", "count", String(count)));
    b.addEventListener("click", () => { state.settings.collection = c.id; saveSettings(); refreshLibrary(); });
    nav.append(b);
  }
}

function estimateBook(book) {
  const words = Math.max(0, (book.totalWords || 0) * (1 - (book.percent || 0) / 100));
  return `${formatDuration(words / (state.wpm1 * state.settings.speed) * 60)} left`;
}

async function refreshLibrary() {
  state.books = (await db.getAllBooks()).sort((a, b) => (b.openedAt || b.addedAt) - (a.openedAt || a.addedAt));
  const collection = COLLECTIONS.find(c => c.id === state.settings.collection) || COLLECTIONS[0];
  const q = state.search.trim().toLowerCase();
  let visible = state.books.filter(collection.test);
  if (q) visible = visible.filter(b => `${b.title} ${b.author}`.toLowerCase().includes(q));
  $("collection-name").textContent = collection.label;
  $("lib-count").textContent = `${visible.length} ${visible.length === 1 ? "book" : "books"}`;
  $("view-shelf").setAttribute("aria-pressed", String(state.settings.view === "shelf"));
  $("view-list").setAttribute("aria-pressed", String(state.settings.view === "list"));
  library.mode = state.settings.view;
  library.emptyMessage = q ? { title: "No results", text: `Nothing matches “${state.search}”.` }
    : collection.id !== "all" ? { title: `No books in ${collection.label}`, text: "Books appear here automatically as you read." } : null;
  const recent = collection.id === "all" && !q
    ? state.books.filter(b => b.percent > 0 && !b.finishedAt).slice(0, 3) : [];
  library.setBooks(visible, { all: state.books, recent, estimate: estimateBook });
  renderCollectionsNav();
}

let importChain = Promise.resolve();
function importFile(file, { source = "import", quiet = false } = {}) {
  const job = importChain.then(() => doImport(file, source, quiet));
  importChain = job.catch(() => {});
  return job;
}

async function doImport(file, source, quiet) {
  const key = `import-${Math.random().toString(36).slice(2)}`;
  const title = file.name.replace(/\.[^.]+$/, "");
  library.setImporting(key, { title, progress: 0 });
  try {
    let lastPaint = 0;
    const { parsed, buffer } = await parseBookFile(file, {
      onProgress: p => {
        if (Date.now() - lastPaint < 250) return;
        lastPaint = Date.now();
        library.setImporting(key, { title, progress: p });
      },
    });
    const id = await fileId(buffer);
    const existing = await db.getBook(id);
    if (existing) {
      if (!quiet) toast(`“${existing.title}” is already in your library.`);
      return existing;
    }
    const thumb = await makeThumbnail(parsed.cover, 480);
    const record = {
      id, title: parsed.title, author: parsed.author || "", format: parsed.format, language: parsed.language || "en",
      fileName: file.name, size: file.size, source, thumb,
      addedAt: Date.now(), openedAt: null, finishedAt: null, progress: { c: 0, s: 0 }, percent: 0,
      ...summarise(parsed.chapters),
    };
    await db.saveImportedBook(record, { chapters: parsed.chapters }, parsed.images);
    if (!quiet) toast(`Added “${record.title}”.`);
    return record;
  } catch (error) {
    console.error(error);
    toast(`Couldn't add ${file.name}: ${error.message}`, { error: true, ms: 7000 });
    return null;
  } finally {
    library.setImporting(key, null);
    await refreshLibrary();
  }
}

let syncing = false;
async function syncBooksFolder() {
  if (syncing) return;
  syncing = true;
  try {
    const res = await fetch("/api/books");
    if (!res.ok) return;
    const listing = (await res.json()).books || [];
    const seen = new Set(await db.getKV("folderSeen", []));
    for (const entry of listing) {
      if (typeof entry?.name !== "string") continue;
      const signature = `${entry.name}|${entry.size}|${entry.mtime}`;
      if (seen.has(signature)) continue;
      seen.add(signature);
      await db.setKV("folderSeen", [...seen]);
      try {
        const file = await fetch(`/books/${encodeURIComponent(entry.name)}`);
        if (!file.ok) throw new Error(`HTTP ${file.status}`);
        const blob = await file.blob();
        await importFile(new File([blob], entry.name, { type: blob.type }), { source: "folder", quiet: true });
      } catch (error) {
        toast(`Couldn't load ${entry.name} from the Books folder: ${error.message}`, { error: true });
      }
    }
  } catch { /* server offline */ } finally {
    syncing = false;
  }
}

async function importSampleOnce() {
  if (await db.getKV("sampleImported", false)) return;
  await db.setKV("sampleImported", true);
  try {
    const res = await fetch("/samples/alice.epub");
    if (!res.ok) return;
    const blob = await res.blob();
    await importFile(new File([blob], "alice.epub", { type: "application/epub+zip" }), { source: "sample", quiet: true });
  } catch { /* optional */ }
}

function bookMenu(book, anchor) {
  openPopover(anchor, {
    width: 230,
    build: body => body.append(menu([
      { label: "Open", icon: "i-books", onClick: () => { closePopover(); openBook(book); } },
      { label: "Listen", icon: "i-wave", onClick: () => { closePopover(); tts.ensureContext(); openBook(book).then(() => togglePlay()); } },
      { sep: true },
      book.finishedAt
        ? { label: "Mark as Unread", icon: "i-clock", onClick: () => markBook(book, { finishedAt: null, percent: 0, progress: { c: 0, s: 0 } }) }
        : { label: "Mark as Finished", icon: "i-done", onClick: () => markBook(book, { finishedAt: Date.now(), percent: 100 }) },
      { sep: true },
      { label: "Remove from Library…", danger: true, onClick: () => { closePopover(); confirmDelete(book); } },
    ])),
  });
}

async function markBook(book, patch) {
  closePopover();
  await db.updateBook(book.id, patch);
  await refreshLibrary();
}

function confirmDelete(book) {
  const card = el("div", "confirm");
  card.append(el("h3", null, `Remove “${book.title}”?`),
    el("p", null, "Its highlights, notes and bookmarks will be removed too. The original file isn't touched."));
  const actions = el("div", "actions");
  const cancel = el("button", null, "Cancel");
  const remove = el("button", "danger", "Remove");
  actions.append(cancel, remove);
  card.append(actions);
  const modal = openModal(card);
  cancel.addEventListener("click", modal.close);
  remove.addEventListener("click", async () => {
    modal.close();
    await db.deleteBook(book.id);
    await refreshLibrary();
    toast(`Removed “${book.title}”.`);
  });
  remove.focus();
}

// ------------------------------------------------------------------ reader
async function openBook(book, coverEl) {
  closePopover();
  const content = await db.getContent(book.id);
  if (!content?.chapters?.length) { toast("This book's contents are missing. Try adding it again.", { error: true }); return; }
  state.book = await db.getBook(book.id) || book;
  state.chapters = content.chapters;
  state.flat = content.chapters.map(ch => ch.blocks.flatMap(b => (b.s || []).map(text => ({ text, heading: b.k === "h" }))));
  state.annotations = await db.getAnnotations(book.id);
  state.lastTurn = Date.now();
  state.pagePos = null;
  const at = validLoc(state.book.progress) || { c: 0, s: 0 };
  state.cursor = at;

  const readerEl = $("reader");
  readerEl.hidden = false;
  readerEl.classList.add("entering");
  applyChrome();
  $("reader-title").textContent = state.book.title;
  await reader.open(state.book, state.chapters, state.settings, at);
  reader.setAnnotations(state.annotations);
  tts.current = at;
  tts.warmUp(state.settings.voice);
  if (coverEl) await flyCover(coverEl);
  $("library").hidden = true;
  readerEl.classList.remove("entering");
  db.updateBook(book.id, { openedAt: Date.now() }).catch(() => {});
  updatePlayerTime();
  wakeChrome();
}

function validLoc(loc) {
  if (!loc || !Number.isInteger(loc.c) || !Number.isInteger(loc.s)) return null;
  if (!state.flat[loc.c]) return null;
  return { c: loc.c, s: Math.max(0, Math.min(loc.s, state.flat[loc.c].length - 1)) };
}

/** The cover zooms toward the centre of the window and dissolves into the page. */
async function flyCover(coverEl) {
  if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  const from = coverEl.getBoundingClientRect();
  if (!from.width) return;
  const h = Math.min(innerHeight * 0.72, 640), w = h * (from.width / from.height);
  const to = { left: (innerWidth - w) / 2, top: (innerHeight - h) / 2 };
  const fly = el("div", "flying-cover");
  fly.append(coverEl.cloneNode(true));
  Object.assign(fly.style, { left: `${from.left}px`, top: `${from.top}px`, width: `${from.width}px`, height: `${from.height}px` });
  document.body.append(fly);
  const s = w / from.width;
  const anim = fly.animate([
    { transform: "translate(0,0) scale(1)", opacity: 1 },
    { transform: `translate(${to.left - from.left}px,${to.top - from.top}px) scale(${s})`, opacity: 1, offset: 0.6 },
    { transform: `translate(${to.left - from.left - w * 0.05}px,${to.top - from.top - h * 0.05}px) scale(${s * 1.1})`, opacity: 0 },
  ], { duration: 620, easing: "cubic-bezier(.3,.7,.2,1)" });
  await anim.finished.catch(() => {});
  fly.remove();
}

async function closeBook() {
  closePopover();
  closePanel();
  hideSelectionMenu();
  tts.stop();
  await saveProgressNow();
  flushStats();
  reader.close();
  state.book = null;
  $("library").hidden = false;
  $("reader").hidden = true;
  $("follow-chip").hidden = true;
  applyChrome();
  await refreshLibrary();
}

function globalIndex(loc) {
  let n = 0;
  for (let c = 0; c < loc.c; c++) n += state.book.chapterCounts[c] || 0;
  return n + loc.s;
}

function progressLoc() {
  return (tts.isActive && tts.current) ? tts.current : (state.pagePos || state.cursor);
}

async function saveProgressNow() {
  const book = state.book;
  const loc = book && progressLoc();
  if (!loc) return;
  const total = Math.max(1, book.totalSentences - 1);
  let percent = Math.min(100, globalIndex(loc) / total * 100);
  const patch = { progress: loc, percent, openedAt: Date.now() };
  const atEnd = loc.c === state.chapters.length - 1 && reader.view >= reader.viewCount - 1 && !reader.isScroll;
  if ((percent >= 99.5 || atEnd) && !book.finishedAt) {
    patch.finishedAt = Date.now();
    patch.percent = percent = 100;
    toast(`You finished “${book.title}”.`);
  }
  Object.assign(book, patch);
  await db.updateBook(book.id, patch).catch(() => {});
}
const saveProgress = throttle(saveProgressNow, 1500);

function onPage({ c, s }) {
  const prev = state.pagePos;
  state.pagePos = { c, s };
  if (!tts.isActive) state.cursor = { c, s };
  $("reader-chapter").textContent = state.chapters[c]?.title || "";
  updateBookmarkButton();
  if (!$("follow-chip").hidden && tts.current && reader.isSentenceVisible(tts.current.c, tts.current.s)) $("follow-chip").hidden = true;
  saveProgress();
  updatePlayerTime();
  if (prev && !tts.isActive) {
    const seconds = (Date.now() - state.lastTurn) / 1000;
    const words = wordsBetween(prev, { c, s });
    const wpm = words / (seconds / 60);
    if (words > 40 && wpm > 80 && wpm < 700) state.readWpm = state.readWpm * 0.85 + wpm * 0.15;
  }
  state.lastTurn = Date.now();
}

function wordsBetween(a, b) {
  if (a.c !== b.c || b.s <= a.s) return 0;
  let w = 0;
  for (let i = a.s; i < b.s; i++) w += countWords(state.flat[a.c][i]?.text || "");
  return w;
}

function wordsFrom(loc, toEndOfBook) {
  if (!state.book || !loc) return 0;
  let words = 0;
  const flat = state.flat[loc.c] || [];
  for (let i = loc.s; i < flat.length; i++) words += countWords(flat[i].text);
  if (toEndOfBook) for (let c = loc.c + 1; c < state.flat.length; c++) words += state.book.chapterWords[c] || 0;
  return words;
}

function updatePlayerTime() {
  if (!state.book) return;
  const loc = progressLoc() || { c: 0, s: 0 };
  const minutes = wordsFrom(loc, false) / (state.wpm1 * state.settings.speed);
  $("time-chapter").textContent = `${formatDuration(minutes * 60)} left in chapter`;
}
const updatePlayerTimeSoon = throttle(updatePlayerTime, 2000);

function setCursor(loc) {
  state.cursor = loc;
  for (const span of document.querySelectorAll("#flow .s.cursor")) span.classList.remove("cursor");
  if (loc && loc.c === reader.chapter) reader.spans[loc.s]?.classList.add("cursor");
}

// Toolbar fades away while reading, comes back on mouse movement.
let idleTimer = 0;
function wakeChrome() {
  const r = $("reader");
  r.classList.remove("idle");
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    if (!activePopover && $("side-panel").hidden && !r.hidden) r.classList.add("idle");
  }, 2600);
}
$("reader").addEventListener("pointermove", wakeChrome);

// ------------------------------------------------------------- narration
function startFrom(loc) { tts.jump(loc, { autoplay: true }); }

function togglePlay() {
  if (!state.book) return;
  if (tts.state === "playing" || tts.state === "loading") { tts.pause(); return; }
  if (tts.state === "paused") { tts.play(); return; }
  const visible = state.cursor && reader.isSentenceVisible(state.cursor.c, state.cursor.s);
  startFrom(visible ? state.cursor : { c: reader.chapter, s: reader.firstVisibleSentence() });
}

function stepSentence(dir) {
  if (!state.book) return;
  const base = (tts.isActive && tts.current) || state.cursor || { c: reader.chapter, s: reader.firstVisibleSentence() };
  let loc;
  if (dir > 0) loc = tts.source.next(base);
  else if (base.s > 0) loc = { c: base.c, s: base.s - 1 };
  else for (let c = base.c - 1; c >= 0 && !loc; c--) if (state.flat[c].length) loc = { c, s: state.flat[c].length - 1 };
  if (!loc) return;
  if (tts.isActive) tts.jump(loc);
  else { setCursor(loc); reader.reveal(loc.c, loc.s); }
}

tts.addEventListener("sentence", ({ detail: { loc } }) => {
  if (!state.book) return;
  setCursor(null);
  reader.setSpeaking(loc.c, loc.s);
  if (!reader.isSentenceVisible(loc.c, loc.s)) {
    if (state.settings.follow) {
      reader.reveal(loc.c, loc.s, { animate: true }).then(() => reader.setSpeaking(loc.c, loc.s));
      $("follow-chip").hidden = true;
    } else {
      $("follow-chip").hidden = false;
    }
  }
  saveProgress();
  updatePlayerTimeSoon();
});

// Mid-sentence page turns: when the spoken sentence runs over the page edge, turn the page as
// soon as the voice reaches the words on the next page (not when the sentence ends).
// Kokoro adds a little silence before and after each sentence, so that is discounted.
const LEAD_SILENCE = 0.1, TAIL_SILENCE = 0.3;
let splitTimer = 0, splitTurning = false;
function followWithinSentence() {
  if (!state.settings.follow || splitTurning || !state.book || reader.isScroll) return;
  const p = tts.currentProgress();
  if (!p || p.loc.c !== reader.chapter) return;
  const split = reader.splitFraction(p.loc.s);
  if (split == null) return;
  const speech = Math.max(0.2, p.duration - LEAD_SILENCE - TAIL_SILENCE);
  const spoken = (p.elapsed - LEAD_SILENCE) / speech;
  if (spoken < split) return;
  splitTurning = true;
  reader.turn(1, { force: true }).finally(() => {
    splitTurning = false;
    if (tts.current) reader.setSpeaking(tts.current.c, tts.current.s);
  });
}

tts.addEventListener("state", ({ detail: { state: s } }) => {
  const play = $("btn-play");
  const active = s === "playing" || s === "loading";
  play.querySelector("use").setAttribute("href", active ? "#i-pause" : "#i-play");
  play.classList.toggle("loading", s === "loading");
  play.title = active ? "Pause (Space)" : "Play (Space)";
  $("reader").classList.toggle("playing", active);
  clearInterval(splitTimer);
  if (s === "playing") splitTimer = setInterval(followWithinSentence, 80);
  $("kokoro-lamp").classList.toggle("busy", s === "loading");
  if (s === "idle") reader.setSpeaking(-1, -1);
});

tts.addEventListener("measure", ({ detail: { words, seconds, speed } }) => {
  if (words > 3 && seconds > 0.5) state.wpm1 = state.wpm1 * 0.9 + (words / (seconds / 60)) * speed * 0.1;
  state.pending.words += words;
});
tts.addEventListener("error", ({ detail: { message } }) => {
  toast(`Narration stopped: ${message}`, { error: true, ms: 8000 });
  checkKokoro();
});
let waitingToastAt = 0;
tts.addEventListener("waiting", () => {
  if (Date.now() - waitingToastAt < 15000) return;
  waitingToastAt = Date.now();
  toast("The narrator is restarting — narration will continue in a moment…", { ms: 6000 });
});
tts.addEventListener("ended", () => { toast("End of book."); saveProgressNow(); });

async function checkKokoro() {
  let ok = false;
  try {
    const res = await fetch("/api/health", { cache: "no-store" });
    ok = res.ok && (await res.json()).kokoro;
  } catch { ok = false; }
  for (const id of ["kokoro-lamp", "lib-lamp"]) $(id).classList.toggle("ok", ok);
  $("lib-lamp-text").textContent = ok ? "Narrator ready · offline" : "Narrator off — open “Start Classic Bookshelf”";
  $("kokoro-lamp").title = ok ? "Kokoro is running on this Mac" : "Kokoro voice server is not running";
  return ok;
}

async function loadVoices() {
  try {
    const ids = await tts.listVoices();
    if (ids.length) state.voices = ids;
  } catch { /* keep curated */ }
}

function renderVoice() {
  const v = describeVoice(state.settings.voice);
  $("voice-name").textContent = v.name;
  $("voice-sub").textContent = `${v.accent} · ${v.gender || "Voice"}`;
  const avatar = $("voice-avatar");
  avatar.firstChild.textContent = v.name.charAt(0);
  avatar.classList.toggle("male", v.gender === "Male");
  $("btn-speed").textContent = `${formatSpeed(state.settings.speed)}×`;
  $("btn-follow").setAttribute("aria-pressed", String(state.settings.follow));
}

const formatSpeed = v => (Math.round(v * 100) / 100).toString();

// ------------------------------------------------------------- popovers
let activePopover = null;

function closePopover() {
  if (!activePopover) return;
  activePopover.el.remove();
  activePopover.anchor?.setAttribute("aria-expanded", "false");
  activePopover = null;
}

function openPopover(anchor, { className = "", width, build }) {
  const reopen = activePopover?.anchor === anchor;
  closePopover();
  if (reopen) return null;
  const pop = el("div", `popover ${className}`);
  pop.setAttribute("role", "dialog");
  if (width) pop.style.width = `${width}px`;
  const body = el("div", "popover-body");
  pop.append(body);
  $("popover-root").append(pop);
  activePopover = { el: pop, anchor, body };
  anchor.setAttribute("aria-expanded", "true");
  build(body, pop);
  position(pop, anchor);
  return activePopover;
}

function position(pop, anchor) {
  const a = anchor.getBoundingClientRect();
  const w = pop.offsetWidth, h = pop.offsetHeight;
  const below = a.top < innerHeight / 2;
  const left = Math.max(10, Math.min(innerWidth - w - 10, a.left + a.width / 2 - w / 2));
  pop.style.left = `${left}px`;
  if (below) { pop.style.top = `${a.bottom + 8}px`; pop.style.maxHeight = `${innerHeight - a.bottom - 20}px`; pop.style.transformOrigin = "top center"; }
  else { pop.style.top = `${Math.max(10, a.top - 8 - h)}px`; pop.style.maxHeight = `${a.top - 20}px`; pop.style.transformOrigin = "bottom center"; }
}

function menu(items) {
  const box = el("div", "menu");
  box.setAttribute("role", "menu");
  for (const item of items) {
    if (item.sep) { box.append(el("div", "menu-sep")); continue; }
    if (item.heading) { box.append(el("div", "menu-heading", item.heading)); continue; }
    const b = el("button", `menu-item${item.danger ? " danger" : ""}${item.className ? ` ${item.className}` : ""}`);
    b.setAttribute("role", item.checked != null ? "menuitemradio" : "menuitem");
    if (item.render) item.render(b);
    else {
      if (item.icon) b.append(icon(item.icon));
      b.append(el("span", null, item.label));
    }
    if (item.checked) b.append(icon("i-check", "check"));
    b.addEventListener("click", item.onClick);
    box.append(b);
  }
  return box;
}

function openModal(content) {
  const backdrop = el("div", "modal-backdrop");
  backdrop.append(content);
  $("modal-root").append(backdrop);
  const close = () => { backdrop.remove(); document.removeEventListener("keydown", onKey, true); };
  const onKey = e => { if (e.key === "Escape") { e.stopPropagation(); close(); } };
  document.addEventListener("keydown", onKey, true);
  backdrop.addEventListener("pointerdown", e => { if (e.target === backdrop) close(); });
  return { close };
}

// Voices
$("btn-voice").addEventListener("click", e => {
  openPopover(e.currentTarget, {
    width: 330,
    build: body => {
      const curated = CURATED_VOICES.map(v => v.id);
      const others = state.voices.filter(id => !curated.includes(id));
      const item = id => {
        const v = describeVoice(id);
        return {
          className: "voice-row",
          render: b => {
            const avatar = el("span", `avatar${v.gender === "Male" ? " male" : ""}`, v.name.charAt(0));
            const text = el("span");
            text.append(el("div", "vn", v.name), el("div", "vs", `${v.accent} · ${v.gender || "Voice"}`));
            const preview = el("span", "preview");
            preview.setAttribute("role", "button");
            preview.title = `Preview ${v.name}`;
            preview.append(icon("i-play", "solid"));
            preview.addEventListener("click", async ev => {
              ev.stopPropagation();
              preview.style.opacity = "0.5";
              try { await tts.preview(id, `Hi, I'm ${v.name}. It was the best of times, it was the worst of times.`); }
              catch (error) { toast(`Preview failed: ${error.message}`, { error: true }); checkKokoro(); }
              finally { preview.style.opacity = ""; }
            });
            const check = icon("i-check", "check");
            check.style.visibility = state.settings.voice === id ? "visible" : "hidden";
            b.append(avatar, text, preview, check);
          },
          onClick: () => {
            state.settings.voice = id;
            saveSettings();
            tts.setVoice(id);
            tts.warmUp(id);
            renderVoice();
            closePopover();
          },
        };
      };
      const items = [{ heading: "Recommended voices" }, ...curated.map(item)];
      if (others.length) items.push({ heading: "More voices" }, ...others.map(item));
      body.append(menu(items));
    },
  });
});

// Speed
$("btn-speed").addEventListener("click", e => {
  openPopover(e.currentTarget, {
    className: "speed-panel",
    build: body => {
      const readout = el("div", "speed-readout", `${formatSpeed(state.settings.speed)}×`);
      const range = el("input", "slider");
      Object.assign(range, { type: "range", min: 0.75, max: 2, step: 0.05, value: state.settings.speed });
      range.setAttribute("aria-label", "Narration speed");
      const presets = el("div", "speed-presets");
      const apply = (v, commit) => {
        state.settings.speed = Math.round(v * 100) / 100;
        readout.textContent = `${formatSpeed(state.settings.speed)}×`;
        range.value = state.settings.speed;
        presets.querySelectorAll("button").forEach(b => b.setAttribute("aria-pressed", String(Number(b.dataset.v) === state.settings.speed)));
        renderVoice();
        updatePlayerTime();
        if (commit) { saveSettings(); tts.setSpeed(state.settings.speed); }
      };
      for (const v of [0.75, 1, 1.25, 1.5, 2]) {
        const b = el("button", null, `${v}×`);
        b.dataset.v = String(v);
        b.addEventListener("click", () => apply(v, true));
        presets.append(b);
      }
      range.addEventListener("input", () => apply(Number(range.value), false));
      range.addEventListener("change", () => apply(Number(range.value), true));
      body.append(readout, range, presets);
      apply(state.settings.speed, false);
    },
  });
});

$("btn-follow").addEventListener("click", () => {
  state.settings.follow = !state.settings.follow;
  saveSettings();
  renderVoice();
  toast(state.settings.follow ? "Pages will turn automatically while listening." : "Auto page-turn is off.");
  if (state.settings.follow && tts.current && tts.isActive) reader.reveal(tts.current.c, tts.current.s);
});

// Appearance (Aa)
$("btn-aa").addEventListener("click", e => openPopover(e.currentTarget, { className: "aa-panel", build: buildAaPanel }));

function applySettings() {
  saveSettings();
  applyChrome();
  if (state.book) reader.updateSettings(state.settings);
}
const applySettingsSoon = (() => { let f = 0; return () => { cancelAnimationFrame(f); f = requestAnimationFrame(applySettings); }; })();

function buildAaPanel(body) {
  const s = state.settings;
  // size
  const sizeRow = el("div", "aa-row");
  const size = el("div", "aa-size");
  const smaller = el("button", null, "A");
  const bigger = el("button", null, "A");
  smaller.setAttribute("aria-label", "Smaller text");
  bigger.setAttribute("aria-label", "Larger text");
  const readout = el("div", "aa-size-readout", `${s.fontSize} pt`);
  const setSize = v => { s.fontSize = Math.max(14, Math.min(32, v)); readout.textContent = `${s.fontSize} pt`; applySettingsSoon(); };
  smaller.addEventListener("click", () => setSize(s.fontSize - 1));
  bigger.addEventListener("click", () => setSize(s.fontSize + 1));
  size.append(smaller, bigger);
  sizeRow.append(size, readout);
  body.append(sizeRow);

  // themes
  const themes = el("div", "themes");
  for (const [id, label] of THEMES) {
    const chip = el("button", "theme-chip");
    chip.setAttribute("role", "radio");
    chip.setAttribute("aria-checked", String(s.theme === id));
    chip.append(el("span", `sw ${id}`, "Aa"), el("span", null, label));
    chip.addEventListener("click", () => {
      s.theme = id;
      themes.querySelectorAll(".theme-chip").forEach(x => x.setAttribute("aria-checked", String(x === chip)));
      applySettings();
    });
    themes.append(chip);
  }
  body.append(themes);

  // fonts
  const fonts = el("div", "font-menu aa-section");
  for (const [id, label] of FONTS) {
    const b = el("button", "font-option");
    b.style.fontFamily = `var(--f-${id})`;
    b.setAttribute("role", "radio");
    b.setAttribute("aria-checked", String(s.font === id));
    b.append(el("span", null, label), icon("i-check", "check"));
    b.addEventListener("click", () => {
      s.font = id;
      fonts.querySelectorAll(".font-option").forEach(x => x.setAttribute("aria-checked", String(x === b)));
      applySettings();
    });
    fonts.append(b);
  }
  body.append(fonts);

  // options
  const opts = el("div", "aa-section");
  const segLine = (label, key, options) => {
    const line = el("div", "aa-line");
    const seg = el("div", "mini-seg");
    for (const [value, text] of options) {
      const b = el("button", null, text);
      b.setAttribute("aria-pressed", String(s[key] === value));
      b.addEventListener("click", () => {
        s[key] = value;
        seg.querySelectorAll("button").forEach(x => x.setAttribute("aria-pressed", String(x === b)));
        applySettings();
      });
      seg.append(b);
    }
    line.append(el("span", null, label), seg);
    opts.append(line);
  };
  const toggleLine = (label, get, set) => {
    const line = el("label", "aa-line");
    const t = el("span", "toggle");
    const input = el("input");
    input.type = "checkbox";
    input.checked = get();
    t.append(input, el("span"));
    input.addEventListener("change", () => { set(input.checked); applySettings(); });
    line.append(el("span", null, label), t);
    opts.append(line);
  };
  segLine("Line spacing", "lineHeight", [[1.35, "Tight"], [1.55, "Normal"], [1.8, "Loose"]]);
  segLine("Margins", "margins", [["narrow", "Narrow"], ["normal", "Normal"], ["wide", "Wide"]]);
  toggleLine("Scrolling view", () => s.layout === "scroll", v => { s.layout = v ? "scroll" : "paged"; });
  toggleLine("Justify text", () => s.justify, v => { s.justify = v; });
  toggleLine("Animate page turns", () => s.pageTurn === "slide", v => { s.pageTurn = v ? "slide" : "none"; });
  body.append(opts);
}

// Search inside the book
$("btn-search").addEventListener("click", e => {
  openPopover(e.currentTarget, {
    className: "search-panel",
    build: (body, pop) => {
      body.style.padding = "0";
      const field = el("label", "search-input");
      const input = el("input");
      input.type = "search";
      input.placeholder = "Search in book";
      input.setAttribute("aria-label", "Search in book");
      field.append(icon("i-search"), input);
      const meta = el("div", "search-meta");
      const results = el("div", "search-results");
      body.append(field, meta, results);
      let timer = 0;
      input.addEventListener("input", () => { clearTimeout(timer); timer = setTimeout(() => runSearch(input.value, results, meta), 120); });
      input.focus();
      void pop;
    },
  });
});

function runSearch(query, results, meta) {
  results.replaceChildren();
  const q = query.trim().toLowerCase();
  if (q.length < 2) { meta.textContent = ""; return; }
  let count = 0;
  const fragment = document.createDocumentFragment();
  outer: for (let c = 0; c < state.flat.length; c++) {
    for (let s = 0; s < state.flat[c].length; s++) {
      const text = state.flat[c][s].text;
      const at = text.toLowerCase().indexOf(q);
      if (at < 0) continue;
      count++;
      if (count > 200) break outer;
      const hit = el("button", "search-hit");
      const snip = el("div", "snip");
      const start = Math.max(0, at - 50);
      snip.append(document.createTextNode((start ? "…" : "") + text.slice(start, at)), el("mark", null, text.slice(at, at + q.length)),
        document.createTextNode(text.slice(at + q.length, at + q.length + 80) + (at + q.length + 80 < text.length ? "…" : "")));
      hit.append(el("div", "ch", state.chapters[c].title), snip);
      hit.addEventListener("click", () => goTo({ c, s }, { flash: true }));
      fragment.append(hit);
    }
  }
  meta.textContent = count ? `${count > 200 ? "200+" : count} result${count === 1 ? "" : "s"}` : "No results";
  results.append(fragment);
}

// Contents / bookmarks / notes side panel
function closePanel() {
  $("side-panel").hidden = true;
  $("btn-toc").setAttribute("aria-expanded", "false");
  $("btn-notes").setAttribute("aria-expanded", "false");
}

function openPanel(tab) {
  closePopover();
  const panel = $("side-panel");
  if (!panel.hidden && panel.dataset.tab === tab) { closePanel(); return; }
  panel.dataset.tab = tab;
  panel.replaceChildren();
  const head = el("div", "panel-head");
  const slot = el("div", "cover-slot");
  slot.append(createCover(state.book, library.coverFor(state.book)));
  const text = el("div");
  text.append(el("div", "t", state.book.title), el("div", "a", state.book.author || ""),
    el("div", "p", `${Math.floor(state.book.percent || 0)}% · ${estimateBook(state.book)}`));
  const close = el("button", "panel-close");
  close.setAttribute("aria-label", "Close");
  close.append(icon("i-close"));
  close.addEventListener("click", closePanel);
  head.append(slot, text, close);
  const tabs = el("div", "panel-tabs");
  tabs.setAttribute("role", "tablist");
  const list = el("div", "panel-list");
  const show = which => {
    panel.dataset.tab = which;
    tabs.querySelectorAll("button").forEach(b => b.setAttribute("aria-selected", String(b.dataset.tab === which)));
    list.replaceChildren(which === "contents" ? tocList() : annotationList(which === "bookmarks" ? "bookmark" : "highlight"));
    $("btn-toc").setAttribute("aria-expanded", String(which === "contents"));
    $("btn-notes").setAttribute("aria-expanded", String(which !== "contents"));
  };
  for (const [id, label] of [["contents", "Contents"], ["bookmarks", "Bookmarks"], ["notes", "Notes"]]) {
    const b = el("button", null, label);
    b.dataset.tab = id;
    b.setAttribute("role", "tab");
    b.addEventListener("click", () => show(id));
    tabs.append(b);
  }
  panel.append(head, tabs, list);
  panel.hidden = false;
  show(tab);
  requestAnimationFrame(() => list.querySelector(".current")?.scrollIntoView({ block: "center" }));
}
$("btn-toc").addEventListener("click", () => openPanel("contents"));
$("btn-notes").addEventListener("click", () => openPanel("notes"));

function goTo(loc, { flash = false } = {}) {
  closePopover();
  closePanel();
  if (tts.isActive) { tts.jump(loc); return; }
  reader.showChapter(loc.c, { sentence: loc.s }).then(() => { setCursor(loc); if (flash) reader.flash(loc.s); });
}

function tocList() {
  const book = state.book;
  const box = el("div");
  let running = 0;
  const total = book.totalWords || 1;
  state.chapters.forEach((ch, c) => {
    const pct = Math.round(running / total * 100);
    running += book.chapterWords[c] || 0;
    const b = el("button", `panel-item${c === reader.chapter ? " current" : ""}`);
    b.append(el("span", null, ch.title), el("span", "pct", `${pct}%`));
    b.addEventListener("click", () => goTo({ c, s: 0 }));
    box.append(b);
  });
  return box;
}

const MARK_COLORS = { amber: "#ffcc00", green: "#34c759", blue: "#0a84ff", rose: "#ff375f" };
function annotationList(kind) {
  const items = state.annotations.filter(a => a.kind === kind).sort((a, b) => a.c - b.c || a.s - b.s);
  if (!items.length) {
    return el("div", "panel-empty", kind === "bookmark"
      ? "No bookmarks yet.\nClick the bookmark button in the toolbar or press B."
      : "No highlights or notes yet.\nSelect text on the page to highlight it.");
  }
  const box = el("div");
  for (const a of items) {
    const b = el("button", "panel-item note-card");
    const excerpt = el("div", "excerpt", a.excerpt);
    excerpt.style.setProperty("--mark", kind === "bookmark" ? "#ff453a" : MARK_COLORS[a.color] || MARK_COLORS.amber);
    b.append(excerpt);
    if (a.note) b.append(el("div", "note-text", a.note));
    const meta = el("div", "meta");
    const del = el("button", null, "Delete");
    del.addEventListener("click", async ev => {
      ev.stopPropagation();
      await db.deleteAnnotation(a.id);
      state.annotations = state.annotations.filter(x => x.id !== a.id);
      reader.setAnnotations(state.annotations);
      updateBookmarkButton();
      b.remove();
    });
    meta.append(el("span", null, state.chapters[a.c]?.title || ""), del);
    b.append(meta);
    b.addEventListener("click", () => goTo({ c: a.c, s: a.s }, { flash: true }));
    box.append(b);
  }
  return box;
}

// Bookmarks
function pageBookmark() {
  if (!state.book) return null;
  const first = reader.firstVisibleSentence(), last = reader.lastVisibleSentence();
  return state.annotations.find(a => a.kind === "bookmark" && a.c === reader.chapter && a.s >= first && a.s <= last) || null;
}

function updateBookmarkButton() {
  const mark = pageBookmark();
  $("btn-bookmark").setAttribute("aria-pressed", String(!!mark));
  $("page-ribbon").hidden = !mark;
}

async function toggleBookmark() {
  const existing = pageBookmark();
  if (existing) {
    await db.deleteAnnotation(existing.id);
    state.annotations = state.annotations.filter(a => a !== existing);
  } else {
    const s = reader.firstVisibleSentence();
    const note = { bookId: state.book.id, kind: "bookmark", c: reader.chapter, s, excerpt: (state.flat[reader.chapter][s]?.text || "").slice(0, 220) };
    note.id = await db.addAnnotation(note);
    note.createdAt = Date.now();
    state.annotations.push(note);
  }
  updateBookmarkButton();
}
$("btn-bookmark").addEventListener("click", toggleBookmark);

// Selection menu
let selectionMenu = null;
function hideSelectionMenu() { selectionMenu?.remove(); selectionMenu = null; }

reader.addEventListener("selection", ({ detail }) => {
  hideSelectionMenu();
  const { c, s, e, rect, text } = detail;
  const m = el("div", "select-menu");
  m.setAttribute("role", "toolbar");
  const overlapping = state.annotations.find(a => a.kind === "highlight" && a.c === c && a.s <= e && (a.e ?? a.s) >= s);
  for (const color of ["amber", "green", "blue", "rose"]) {
    const dot = el("button", `dot ${color}`);
    dot.title = `Highlight`;
    dot.addEventListener("click", () => saveHighlight({ c, s, e, color, existing: overlapping }));
    m.append(dot);
  }
  m.append(el("span", "sep"));
  const add = (label, fn) => { const b = el("button", null, label); b.addEventListener("click", fn); m.append(b); };
  add("Add Note", () => editNote({ c, s, e, existing: overlapping }));
  add("Listen", () => { hideSelectionMenu(); getSelection()?.removeAllRanges(); startFrom({ c, s }); });
  add("Copy", () => { navigator.clipboard?.writeText(text).catch(() => {}); hideSelectionMenu(); toast("Copied"); });
  if (overlapping) add("Remove", async () => {
    await db.deleteAnnotation(overlapping.id);
    state.annotations = state.annotations.filter(a => a !== overlapping);
    reader.setAnnotations(state.annotations);
    hideSelectionMenu();
    getSelection()?.removeAllRanges();
  });
  document.body.append(m);
  const w = m.offsetWidth;
  m.style.left = `${Math.max(8, Math.min(innerWidth - w - 8, rect.left + rect.width / 2 - w / 2))}px`;
  m.style.top = `${rect.top > 70 ? rect.top - 48 : rect.bottom + 10}px`;
  selectionMenu = m;
});

async function saveHighlight({ c, s, e, color, existing, note }) {
  hideSelectionMenu();
  getSelection()?.removeAllRanges();
  const excerpt = state.flat[c].slice(s, e + 1).map(x => x.text).join(" ").slice(0, 400);
  if (existing) {
    Object.assign(existing, { s: Math.min(s, existing.s), e: Math.max(e, existing.e ?? existing.s), color: color || existing.color, excerpt });
    if (note !== undefined) existing.note = note;
    await db.putAnnotation(existing);
  } else {
    const record = { bookId: state.book.id, kind: "highlight", c, s, e, color: color || "amber", note: note || "", excerpt };
    record.id = await db.addAnnotation(record);
    record.createdAt = Date.now();
    state.annotations.push(record);
  }
  reader.setAnnotations(state.annotations);
}

function editNote({ c, s, e, existing }) {
  hideSelectionMenu();
  openPopover(reader.spans[s] || $("btn-notes"), {
    className: "note-editor",
    build: body => {
      body.style.padding = "0";
      const area = el("textarea");
      area.maxLength = 4000;
      area.placeholder = "Add a note…";
      area.value = existing?.note || "";
      const actions = el("div", "actions");
      const cancel = el("button", "btn-secondary", "Cancel");
      const save = el("button", "btn-secondary accent", "Save");
      cancel.addEventListener("click", closePopover);
      save.addEventListener("click", async () => {
        await saveHighlight({ c, s, e, color: existing?.color || "amber", existing, note: area.value.trim() });
        closePopover();
      });
      actions.append(cancel, save);
      body.append(area, actions);
      setTimeout(() => area.focus(), 30);
    },
  });
}

// ----------------------------------------------------------- reading goals
async function openGoals() {
  closePopover();
  flushStats();
  await new Promise(r => setTimeout(r, 60));
  const stats = new Map((await db.getAllStats()).map(row => [row.day, row]));
  const books = await db.getAllBooks();
  const today = new Date();
  const dayRow = offset => {
    const d = new Date(today);
    d.setDate(d.getDate() - offset);
    return { date: d, row: stats.get(dayKey(d)) || { read: 0, listen: 0, pages: 0, words: 0 } };
  };
  const active = row => row.read + row.listen >= 60;
  let streak = 0;
  for (let i = active(dayRow(0).row) ? 0 : 1; i < 3650; i++) { if (active(dayRow(i).row)) streak++; else break; }
  const week = Array.from({ length: 7 }, (_, i) => dayRow(6 - i));
  const sum = (rows, key) => rows.reduce((a, r) => a + r.row[key], 0);
  const todayRow = dayRow(0).row;
  const todayMin = (todayRow.read + todayRow.listen) / 60;

  const sheet = el("div", "sheet");
  const head = el("div", "sheet-head");
  const close = el("button", "sheet-close");
  close.setAttribute("aria-label", "Close");
  close.append(icon("i-close"));
  head.append(el("h2", null, "Reading Goals"), close);

  // ring
  const hero = el("div", "goal-hero");
  const ring = el("div", "ring");
  const NS = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("viewBox", "0 0 120 120");
  const circle = cls => { const c = document.createElementNS(NS, "circle"); c.setAttribute("cx", "60"); c.setAttribute("cy", "60"); c.setAttribute("r", "52"); c.setAttribute("class", cls); return c; };
  const track = circle("track"), bar = circle("bar");
  const len = 2 * Math.PI * 52;
  bar.setAttribute("stroke-dasharray", String(len));
  bar.setAttribute("stroke-dashoffset", String(len));
  svg.append(track, bar);
  const label = el("div", "ring-label");
  const minutesEl = el("b", null, String(Math.floor(todayMin)));
  const goalEl = el("span", null, `of ${state.settings.goal} min today`);
  label.append(minutesEl, goalEl);
  ring.append(svg, label);
  const paint = () => {
    goalEl.textContent = `of ${state.settings.goal} min today`;
    bar.setAttribute("stroke-dashoffset", String(len * (1 - Math.min(1, todayMin / state.settings.goal))));
    bar.style.opacity = todayMin > 0.05 ? "1" : "0";
  };
  requestAnimationFrame(() => requestAnimationFrame(paint));

  const text = el("div", "goal-text");
  const done = todayMin >= state.settings.goal;
  text.append(el("h3", null, done ? "Goal reached today. Lovely." : streak ? `${streak}-day streak` : "Start a streak today"),
    el("p", null, done ? `You've read or listened for ${Math.floor(todayMin)} minutes today.`
      : `Read or listen for ${Math.max(1, Math.ceil(state.settings.goal - todayMin))} more minutes to reach today's goal.`));
  const adjust = el("div", "goal-adjust");
  const minus = el("button", null, "−"), plus = el("button", null, "+");
  const goalText = el("span", null, `Daily goal: ${state.settings.goal} min`);
  const setGoal = v => { state.settings.goal = Math.max(5, Math.min(240, v)); goalText.textContent = `Daily goal: ${state.settings.goal} min`; saveSettings(); paint(); };
  minus.addEventListener("click", () => setGoal(state.settings.goal - 5));
  plus.addEventListener("click", () => setGoal(state.settings.goal + 5));
  adjust.append(minus, goalText, plus);
  const weekRow = el("div", "week");
  week.forEach(({ date, row }, i) => {
    const d = el("div", `day${active(row) ? " on" : ""}${i === 6 ? " today" : ""}`);
    d.title = `${date.toLocaleDateString()}: ${formatDuration(row.read + row.listen)}`;
    d.append(el("i"), el("span", null, date.toLocaleDateString(undefined, { weekday: "narrow" })));
    weekRow.append(d);
  });
  text.append(adjust, weekRow);
  hero.append(ring, text);

  const stat = (k, v, sub) => { const s = el("div", "stat"); s.append(el("div", "k", k), el("div", "v", v)); if (sub) s.append(el("div", "sub", sub)); return s; };
  const grid = el("div", "stat-grid");
  grid.append(
    stat("Streak", `${streak} ${streak === 1 ? "day" : "days"}`),
    stat("Reading this week", formatDuration(sum(week, "read"))),
    stat("Listening this week", formatDuration(sum(week, "listen")), `${sum(week, "words").toLocaleString()} words narrated`),
    stat("Pages turned", String(sum(week, "pages")), `${todayRow.pages} today`),
    stat("Books finished", String(books.filter(b => b.finishedAt).length)),
    stat("Reading now", String(books.filter(b => b.percent > 0 && !b.finishedAt).length)),
  );

  sheet.append(head, hero, grid);

  if (state.book) {
    const loc = progressLoc() || { c: 0, s: 0 };
    const listenWpm = state.wpm1 * state.settings.speed;
    const ch = wordsFrom(loc, false), all = wordsFrom(loc, true);
    sheet.append(el("h4", null, state.book.title));
    const g = el("div", "stat-grid");
    g.append(
      stat("Chapter · listening", formatDuration(ch / listenWpm * 60), `at ${formatSpeed(state.settings.speed)}×`),
      stat("Chapter · reading", formatDuration(ch / state.readWpm * 60), `at ${Math.round(state.readWpm)} wpm`),
      stat("Book · listening", formatDuration(all / listenWpm * 60)),
      stat("Book · reading", formatDuration(all / state.readWpm * 60), `${Math.floor(state.book.percent || 0)}% complete`),
    );
    sheet.append(g);
  }

  sheet.append(el("h4", null, "Last 14 days"));
  const days14 = Array.from({ length: 14 }, (_, i) => dayRow(13 - i));
  const max = Math.max(state.settings.goal * 60, ...days14.map(d => d.row.read + d.row.listen));
  const bars = el("div", "bars"), axis = el("div", "bars-axis");
  for (const { date, row } of days14) {
    const b = el("div", "bar");
    b.title = `${date.toLocaleDateString()}: ${formatDuration(row.read)} reading, ${formatDuration(row.listen)} listening`;
    const listen = el("span", "listen"), read = el("span", "read");
    listen.style.height = `${row.listen / max * 100}%`;
    read.style.height = `${row.read / max * 100}%`;
    b.append(listen, read);
    bars.append(b);
    axis.append(el("span", null, String(date.getDate())));
  }
  const legend = el("div", "legend");
  const key = (cls, txt) => { const s = el("span"); const i = el("i", cls); s.append(i, txt); return s; };
  const ki = key("", "Listening"); ki.firstChild.style.background = "var(--accent)";
  const kr = key("", "Reading"); kr.firstChild.style.background = "color-mix(in srgb, var(--accent) 40%, var(--bg-elev))";
  legend.append(ki, kr);
  sheet.append(bars, axis, legend);

  const modal = openModal(sheet);
  close.addEventListener("click", modal.close);
}
$("btn-stats").addEventListener("click", openGoals);

// ------------------------------------------------------------ stats timer
setInterval(() => {
  if (document.hidden) return;
  if (tts.state === "playing") state.pending.listen += 10;
  else if (state.book && Date.now() - state.lastActivity < 120000) state.pending.read += 10;
}, 10000);
setInterval(flushStats, 30000);

function flushStats() {
  const p = state.pending;
  if (!p.read && !p.listen && !p.pages && !p.words) return;
  const delta = { ...p };
  state.pending = { read: 0, listen: 0, pages: 0, words: 0 };
  db.bumpStats(dayKey(), delta).catch(() => {});
  db.setKV("calibration", { wpm1: state.wpm1, readWpm: state.readWpm }).catch(() => {});
}
for (const type of ["pointerdown", "keydown", "wheel"]) addEventListener(type, () => { state.lastActivity = Date.now(); }, { passive: true });
addEventListener("pagehide", () => { flushStats(); saveProgressNow(); });
document.addEventListener("visibilitychange", () => { if (document.hidden) { flushStats(); saveProgressNow(); } });

// ------------------------------------------------------------ wiring
reader.addEventListener("page", ({ detail }) => onPage(detail));
reader.addEventListener("turn", () => { state.pending.pages++; hideSelectionMenu(); });
reader.addEventListener("sentence-click", ({ detail: { c, s } }) => {
  if (selectionMenu) { hideSelectionMenu(); return; }
  if (!$("side-panel").hidden) { closePanel(); return; }
  if (tts.isActive) tts.jump({ c, s }, { autoplay: true });
  else setCursor({ c, s });
});
reader.addEventListener("sentence-dblclick", ({ detail: { c, s } }) => startFrom({ c, s }));

$("btn-back").addEventListener("click", closeBook);
const goHome = () => {
  state.settings.collection = "all";
  state.search = "";
  $("lib-search").value = "";
  saveSettings();
  refreshLibrary();
  $("bookcase").scrollTo({ top: 0, behavior: "smooth" });
};
$("brand-home").addEventListener("click", goHome);
$("brand-home").addEventListener("keydown", e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); goHome(); } });
$("btn-play").addEventListener("click", togglePlay);
$("btn-prev-sentence").addEventListener("click", () => stepSentence(-1));
$("btn-next-sentence").addEventListener("click", () => stepSentence(1));
$("follow-chip").addEventListener("click", () => {
  if (tts.current) reader.reveal(tts.current.c, tts.current.s).then(() => reader.setSpeaking(tts.current.c, tts.current.s));
  $("follow-chip").hidden = true;
});

$("view-shelf").addEventListener("click", () => { state.settings.view = "shelf"; saveSettings(); refreshLibrary(); });
$("view-list").addEventListener("click", () => { state.settings.view = "list"; saveSettings(); refreshLibrary(); });
$("lib-search").addEventListener("input", e => { state.search = e.target.value; refreshLibrary(); });
$("btn-import").addEventListener("keydown", e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); $("file-input").click(); } });
$("file-input").addEventListener("change", async e => {
  const files = [...e.target.files];
  e.target.value = "";
  for (const file of files) await importFile(file);
});

let dragDepth = 0;
const hasFiles = e => [...(e.dataTransfer?.types || [])].includes("Files");
addEventListener("dragenter", e => { if (!hasFiles(e)) return; e.preventDefault(); dragDepth++; $("drop-overlay").hidden = false; });
addEventListener("dragover", e => { if (hasFiles(e)) e.preventDefault(); });
addEventListener("dragleave", e => { if (!hasFiles(e)) return; dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) $("drop-overlay").hidden = true; });
addEventListener("drop", async e => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  dragDepth = 0;
  $("drop-overlay").hidden = true;
  const files = [...e.dataTransfer.files].filter(f => /\.(epub|pdf|txt)$/i.test(f.name));
  if (!files.length) { toast("Drop an EPUB, PDF or TXT file.", { error: true }); return; }
  if (state.book) await closeBook();
  for (const file of files) await importFile(file);
});

document.addEventListener("pointerdown", e => {
  if (activePopover && !activePopover.el.contains(e.target) && !activePopover.anchor.contains(e.target)) closePopover();
  if (selectionMenu && !selectionMenu.contains(e.target)) hideSelectionMenu();
  const panel = $("side-panel");
  if (!panel.hidden && !panel.contains(e.target) && !e.target.closest?.("#btn-toc, #btn-notes")) closePanel();
}, true);

document.addEventListener("keydown", e => {
  const typing = e.target.matches?.("input[type=text], input[type=search], input:not([type]), textarea, select, [contenteditable]");
  if (e.key === "Escape") {
    // Esc closes whatever is open; with nothing open it takes you back to the library.
    const hadOverlay = activePopover || selectionMenu || !$("side-panel").hidden;
    closePopover(); hideSelectionMenu(); closePanel();
    if (!hadOverlay && state.book && !$("modal-root").childElementCount) closeBook();
    return;
  }
  if (typing) return;
  if (!state.book) {
    if ((e.metaKey || e.ctrlKey) && e.key === "f") { e.preventDefault(); $("lib-search").focus(); }
    return;
  }
  if ($("modal-root").childElementCount) return;
  if (e.target.matches?.("input[type=range]")) return;
  wakeChrome();
  if ((e.metaKey || e.ctrlKey) && e.key === "f") { e.preventDefault(); $("btn-search").click(); return; }
  if (e.key === " " || e.code === "Space") { e.preventDefault(); togglePlay(); return; }
  if (e.key === "ArrowRight" || e.key === "PageDown") { e.preventDefault(); e.shiftKey ? stepSentence(1) : reader.next(); }
  else if (e.key === "ArrowLeft" || e.key === "PageUp") { e.preventDefault(); e.shiftKey ? stepSentence(-1) : reader.prev(); }
  else if (e.key === "b" && !e.metaKey && !e.ctrlKey) toggleBookmark();
});

// ------------------------------------------------------------------ start
async function init() {
  try {
    state.settings = sanitiseSettings(await db.getKV("settings"));
    const cal = await db.getKV("calibration");
    if (cal && typeof cal.wpm1 === "number" && cal.wpm1 > 80 && cal.wpm1 < 400) state.wpm1 = cal.wpm1;
    if (cal && typeof cal.readWpm === "number" && cal.readWpm > 80 && cal.readWpm < 700) state.readWpm = cal.readWpm;
  } catch (error) {
    toast(`Storage unavailable: ${error.message}`, { error: true, ms: 10000 });
  }
  tts.voice = state.settings.voice;
  tts.speed = state.settings.speed;
  applyChrome();
  renderVoice();
  await refreshLibrary();
  db.requestPersistence();
  checkKokoro().then(ok => { if (ok) tts.warmUp(state.settings.voice); });
  setInterval(checkKokoro, 20000);
  loadVoices();
  await importSampleOnce();
  await syncBooksFolder();
  addEventListener("focus", () => syncBooksFolder());
}

// ---------------------------------------------------------- installable app
if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(() => {});
let installPrompt = null;
addEventListener("beforeinstallprompt", event => {
  event.preventDefault();
  installPrompt = event;
  $("btn-install").hidden = false;
});
addEventListener("appinstalled", () => {
  installPrompt = null;
  $("btn-install").hidden = true;
  toast("Bookshelf is installed. Find it in your Dock, Launchpad or Applications.");
});
$("btn-install").addEventListener("click", async () => {
  if (!installPrompt) return;
  installPrompt.prompt();
  await installPrompt.userChoice.catch(() => {});
  installPrompt = null;
  $("btn-install").hidden = true;
});
// Double-clicking an EPUB/PDF/TXT in Finder (once the app is installed and set as the opener).
if ("launchQueue" in window) {
  window.launchQueue.setConsumer(async params => {
    const files = params.files || [];
    for (const handle of files) {
      const record = await importFile(await handle.getFile());
      if (record && files.length === 1) { if (state.book) await closeBook(); openBook(record); }
    }
  });
}

init();

window.bookshelf = { state, tts, reader, library };
