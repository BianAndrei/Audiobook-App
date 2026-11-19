// Keeps a copy of where you are in every book (plus notes, reading stats, settings and the book
// that was open) in the Books folder — Books/.bookshelf-state.json, written by the local server.
// Every window of the app (the Mac app, a browser tab) merges with that file, so whichever one you
// open continues exactly where you left off, and nothing is lost if browser data is cleared.
import * as db from "./storage.js";

const PROGRESS_FIELDS = ["progress", "page", "percent", "finishedAt", "changedAt"];
const STAT_KEYS = ["read", "listen", "pages", "words"];
const WATCHED = new Set(["books", "annotations", "stats", "kv:settings", "kv:session", "kv:calibration"]);

let applying = false;   // true while we write merged data locally (those writes don't re-trigger a sync)
let timer = 0;
let chain = Promise.resolve();

const isObj = v => v !== null && typeof v === "object" && !Array.isArray(v);
const num = v => (Number.isFinite(v) ? v : 0);
const isLoc = v => isObj(v) && Number.isInteger(v.c) && Number.isInteger(v.s) && v.c >= 0 && v.s >= 0;

export function start() {
  db.onChange(what => {
    if (applying || !WATCHED.has(what)) return;
    if (what === "kv:settings") db.setKV("settingsAt", Date.now()).catch(() => {});
    soon(what === "kv:session" ? 300 : 3000);  // opening/closing a book is saved right away
  });
  document.addEventListener("visibilitychange", () => { if (document.hidden) now(); });
}

/** Sync a few seconds from now (changes come in bursts while reading). */
export function soon(ms = 3000) {
  clearTimeout(timer);
  timer = setTimeout(now, ms);
}

/** Sync right away. Resolves to what changed locally ({ books, notes, settings }) or null. */
export function now() {
  clearTimeout(timer);
  const run = chain.then(syncOnce).catch(error => { console.warn("Sync skipped:", error); return null; });
  chain = run;
  return run;
}

async function syncOnce() {
  const res = await fetch("/api/state", { cache: "no-store" });
  if (!res.ok) return null;
  const remote = await res.json();
  if (!isObj(remote)) return null;
  const changes = { books: false, notes: false, settings: null };
  applying = true;
  try {
    const merged = {
      version: 1,
      books: await mergeBooks(remote, changes),
      ...(await mergeNotes(remote, changes)),
      stats: await mergeStats(remote),
      ...(await mergeKV(remote, changes)),
    };
    if (JSON.stringify(merged) !== JSON.stringify(pick(merged, remote))) {
      merged.savedAt = Date.now();
      await fetch("/api/state", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(merged) });
    }
  } finally {
    applying = false;
  }
  return changes;
}

// The saved file's values for the keys we manage, in our key order (so order alone never
// counts as a change).
function pick(merged, remote) {
  const out = {};
  for (const key of Object.keys(merged)) out[key] = remote[key];
  return out;
}

async function mergeBooks(remote, changes) {
  const remoteBooks = isObj(remote.books) ? remote.books : {};
  const out = {};
  for (const [id, r] of Object.entries(remoteBooks)) if (isObj(r)) out[id] = r;
  for (const book of await db.getAllBooks()) {
    const r = out[book.id];
    const patch = {};
    // Position: whichever side changed it last wins.
    if (r && num(r.changedAt) > num(book.changedAt ?? book.openedAt)) {
      for (const f of PROGRESS_FIELDS) if (f in r) patch[f] = r[f];
      if (!isLoc(patch.progress)) delete patch.progress;
      if (patch.page != null && !isLoc(patch.page)) delete patch.page;
      if (!Number.isFinite(patch.percent)) delete patch.percent;
      if (patch.finishedAt != null && !Number.isFinite(patch.finishedAt)) delete patch.finishedAt;
    }
    if (r && num(r.openedAt) > num(book.openedAt)) patch.openedAt = r.openedAt;
    if (Object.keys(patch).length) {
      await db.updateBook(book.id, patch);
      Object.assign(book, patch);
      changes.books = true;
    }
    out[book.id] = {
      title: book.title, author: book.author, fileName: book.fileName, source: book.source,
      progress: book.progress, page: book.page ?? null, percent: book.percent,
      finishedAt: book.finishedAt ?? null, openedAt: book.openedAt ?? null,
      // Books saved before changedAt existed: their last open is when the position last moved.
      changedAt: book.changedAt ?? book.openedAt ?? 0,
    };
  }
  return out;
}

async function mergeNotes(remote, changes) {
  const deleted = new Set([
    ...(Array.isArray(remote.deletedNotes) ? remote.deletedNotes.filter(k => typeof k === "string") : []),
    ...(await db.getKV("deletedNotes", [])),
  ]);
  const bookIds = new Set((await db.getAllBooks()).map(b => b.id));
  const notes = new Map();
  for (const n of Array.isArray(remote.annotations) ? remote.annotations : []) {
    if (isObj(n) && typeof n.bookId === "string" && Number.isFinite(n.createdAt)) {
      const { id, ...rest } = n;
      notes.set(db.noteKey(rest), rest);
    }
  }
  const localKeys = new Set();
  for (const n of await db.getAllAnnotations()) {
    const key = db.noteKey(n);
    localKeys.add(key);
    if (deleted.has(key)) {
      await db.deleteAnnotation(n.id, { remember: false });
      changes.notes = true;
      continue;
    }
    const r = notes.get(key);
    if (r && num(r.updatedAt || r.createdAt) > num(n.updatedAt || n.createdAt)) {
      await db.putAnnotation({ ...r, id: n.id }, { touch: false });
      changes.notes = true;
    } else {
      const { id, ...rest } = n;
      notes.set(key, rest);
    }
  }
  for (const [key, r] of notes) {
    if (deleted.has(key)) notes.delete(key);
    else if (!localKeys.has(key) && bookIds.has(r.bookId)) {
      await db.putAnnotation({ ...r }, { touch: false });
      changes.notes = true;
    }
  }
  const deletedNotes = [...deleted].slice(-2000);
  await db.setKV("deletedNotes", deletedNotes);
  return { annotations: [...notes.values()], deletedNotes };
}

async function mergeStats(remote) {
  const days = new Map();
  for (const r of Array.isArray(remote.stats) ? remote.stats : []) {
    if (isObj(r) && typeof r.day === "string") days.set(r.day, Object.fromEntries([["day", r.day], ...STAT_KEYS.map(k => [k, num(r[k])])]));
  }
  const localDays = new Set();
  for (const l of await db.getAllStats()) {
    localDays.add(l.day);
    const r = days.get(l.day);
    const row = { day: l.day };
    let behind = false;
    for (const k of STAT_KEYS) {
      row[k] = Math.max(num(l[k]), num(r?.[k]));
      if (row[k] > num(l[k])) behind = true;
    }
    if (behind) await db.putStats(row);
    days.set(l.day, row);
  }
  for (const [day, row] of days) if (!localDays.has(day)) await db.putStats(row);
  return [...days.values()].sort((a, b) => a.day.localeCompare(b.day));
}

async function mergeKV(remote, changes) {
  const out = {};
  // Settings: newest wins.
  const local = await db.getKV("settings");
  const localAt = num(await db.getKV("settingsAt", 0));
  const rs = remote.settings;
  if (isObj(rs) && isObj(rs.value) && (!local || num(rs.at) > localAt)) {
    await db.setKV("settings", rs.value);
    await db.setKV("settingsAt", num(rs.at));
    changes.settings = rs.value;
    out.settings = { value: rs.value, at: num(rs.at) };
  } else {
    out.settings = local ? { value: local, at: localAt } : null;
  }
  // Which book was open when the app was last closed: newest wins.
  const session = await db.getKV("session");
  const rsess = remote.session;
  if (isObj(rsess) && num(rsess.at) > num(session?.at)) {
    await db.setKV("session", { bookId: typeof rsess.bookId === "string" ? rsess.bookId : null, at: num(rsess.at) });
    out.session = rsess;
  } else {
    out.session = session || null;
  }
  // Reading-speed calibration: keep ours, adopt the saved one on a fresh install.
  const cal = await db.getKV("calibration");
  if (!cal && isObj(remote.calibration)) await db.setKV("calibration", remote.calibration);
  out.calibration = cal || (isObj(remote.calibration) ? remote.calibration : null);
  return out;
}
