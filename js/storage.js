// IndexedDB persistence: books, parsed contents, images, annotations, daily stats, settings.

const DB_NAME = "classic-bookshelf";
const DB_VERSION = 1;
let dbPromise = null;

function open() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains("books")) db.createObjectStore("books", { keyPath: "id" });
      if (!db.objectStoreNames.contains("contents")) db.createObjectStore("contents", { keyPath: "id" });
      if (!db.objectStoreNames.contains("images")) {
        const images = db.createObjectStore("images", { keyPath: "key" });
        images.createIndex("bookId", "bookId");
      }
      if (!db.objectStoreNames.contains("annotations")) {
        const notes = db.createObjectStore("annotations", { keyPath: "id", autoIncrement: true });
        notes.createIndex("bookId", "bookId");
      }
      if (!db.objectStoreNames.contains("stats")) db.createObjectStore("stats", { keyPath: "day" });
      if (!db.objectStoreNames.contains("kv")) db.createObjectStore("kv", { keyPath: "key" });
    };
    req.onsuccess = () => {
      req.result.onversionchange = () => req.result.close();
      resolve(req.result);
    };
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error("Close other Classic Bookshelf tabs and reload."));
  });
  return dbPromise;
}

function promisify(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function tx(stores, mode, work) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const t = db.transaction(stores, mode);
    let result;
    Promise.resolve(work(t)).then(value => { result = value; }, error => { t.abort(); reject(error); });
    t.oncomplete = () => resolve(result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error || new Error("Storage transaction aborted."));
  });
}

export async function requestPersistence() {
  try { if (navigator.storage?.persist) await navigator.storage.persist(); } catch { /* optional */ }
}

// ---- change notifications (the sync module listens) ----------------------
const listeners = new Set();
export const onChange = fn => listeners.add(fn);
const changed = what => { for (const fn of listeners) { try { fn(what); } catch { /* listener bug */ } } };

// ---- books ---------------------------------------------------------------
export const getAllBooks = () => tx("books", "readonly", t => promisify(t.objectStore("books").getAll()));
export const getBook = id => tx("books", "readonly", t => promisify(t.objectStore("books").get(id)));
export const putBook = book => tx("books", "readwrite", t => promisify(t.objectStore("books").put(book)));

export async function updateBook(id, patch) {
  return tx("books", "readwrite", async t => {
    const store = t.objectStore("books");
    const book = await promisify(store.get(id));
    if (!book) return null;
    Object.assign(book, patch);
    store.put(book);
    return book;
  }).then(book => { changed("books"); return book; });
}

export async function saveImportedBook(book, content, images) {
  return tx(["books", "contents", "images"], "readwrite", t => {
    t.objectStore("books").put(book);
    t.objectStore("contents").put({ id: book.id, chapters: content.chapters });
    const store = t.objectStore("images");
    for (const [path, blob] of images) store.put({ key: `${book.id}|${path}`, bookId: book.id, blob });
  });
}

export const getContent = id => tx("contents", "readonly", t => promisify(t.objectStore("contents").get(id)));

export async function getImage(bookId, path) {
  const row = await tx("images", "readonly", t => promisify(t.objectStore("images").get(`${bookId}|${path}`)));
  return row?.blob || null;
}

export async function deleteBook(id) {
  return tx(["books", "contents", "images", "annotations"], "readwrite", async t => {
    t.objectStore("books").delete(id);
    t.objectStore("contents").delete(id);
    for (const name of ["images", "annotations"]) {
      const keys = await promisify(t.objectStore(name).index("bookId").getAllKeys(id));
      for (const key of keys) t.objectStore(name).delete(key);
    }
  });
}

// ---- annotations (bookmarks, highlights, notes) --------------------------
export const getAnnotations = bookId =>
  tx("annotations", "readonly", t => promisify(t.objectStore("annotations").index("bookId").getAll(bookId)));
export const getAllAnnotations = () => tx("annotations", "readonly", t => promisify(t.objectStore("annotations").getAll()));
/** Stable identity of a note across devices/windows (local ids are per-database). */
export const noteKey = note => `${note.bookId}|${note.createdAt}`;

export async function addAnnotation(note) {
  // Stamped on the caller's object too, so in-memory copies keep the same identity (noteKey).
  note.createdAt = note.updatedAt = Date.now();
  const id = await tx("annotations", "readwrite", t => promisify(t.objectStore("annotations").add({ ...note })));
  changed("annotations");
  return id;
}
export async function putAnnotation(note, { touch = true } = {}) {
  if (touch) note.updatedAt = Date.now();
  const id = await tx("annotations", "readwrite", t => promisify(t.objectStore("annotations").put(note)));
  changed("annotations");
  return id;
}
export async function deleteAnnotation(id, { remember = true } = {}) {
  const note = await tx("annotations", "readwrite", async t => {
    const store = t.objectStore("annotations");
    const row = await promisify(store.get(id));
    store.delete(id);
    return row;
  });
  // Remember the deletion so other windows don't bring the note back.
  if (note && remember) await setKV("deletedNotes", [...(await getKV("deletedNotes", [])), noteKey(note)].slice(-2000));
  changed("annotations");
}

// ---- reading stats -------------------------------------------------------
export const getAllStats = () => tx("stats", "readonly", t => promisify(t.objectStore("stats").getAll()));

export async function bumpStats(day, delta) {
  return tx("stats", "readwrite", async t => {
    const store = t.objectStore("stats");
    const row = (await promisify(store.get(day))) || { day, read: 0, listen: 0, pages: 0, words: 0 };
    for (const key of ["read", "listen", "pages", "words"]) row[key] += Number(delta[key]) || 0;
    store.put(row);
    return row;
  }).then(row => { changed("stats"); return row; });
}
export const putStats = row => tx("stats", "readwrite", t => promisify(t.objectStore("stats").put(row)));

// ---- key/value (settings, folder sync, calibration) ----------------------
export async function getKV(key, fallback = null) {
  const row = await tx("kv", "readonly", t => promisify(t.objectStore("kv").get(key)));
  return row ? row.value : fallback;
}
export async function setKV(key, value) {
  await tx("kv", "readwrite", t => promisify(t.objectStore("kv").put({ key, value })));
  changed(`kv:${key}`);
}
