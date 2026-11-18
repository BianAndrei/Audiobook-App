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
  });
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
export const addAnnotation = note =>
  tx("annotations", "readwrite", t => promisify(t.objectStore("annotations").add({ ...note, createdAt: Date.now() })));
export const putAnnotation = note => tx("annotations", "readwrite", t => promisify(t.objectStore("annotations").put(note)));
export const deleteAnnotation = id => tx("annotations", "readwrite", t => promisify(t.objectStore("annotations").delete(id)));

// ---- reading stats -------------------------------------------------------
export const getAllStats = () => tx("stats", "readonly", t => promisify(t.objectStore("stats").getAll()));

export async function bumpStats(day, delta) {
  return tx("stats", "readwrite", async t => {
    const store = t.objectStore("stats");
    const row = (await promisify(store.get(day))) || { day, read: 0, listen: 0, pages: 0, words: 0 };
    for (const key of ["read", "listen", "pages", "words"]) row[key] += Number(delta[key]) || 0;
    store.put(row);
    return row;
  });
}

// ---- key/value (settings, folder sync, calibration) ----------------------
export async function getKV(key, fallback = null) {
  const row = await tx("kv", "readonly", t => promisify(t.objectStore("kv").get(key)));
  return row ? row.value : fallback;
}
export const setKV = (key, value) => tx("kv", "readwrite", t => promisify(t.objectStore("kv").put({ key, value })));
