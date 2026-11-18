// Library rendering: Continue Reading cards, cover grid, list view and generated covers.

import { hashString } from "./text-utils.js";

const PALETTES = [
  ["#7b8fa3", "#3f5166"], ["#c9805f", "#8a4632"], ["#6f9579", "#365a43"], ["#9180ad", "#54467a"],
  ["#c8a35e", "#86672d"], ["#5f84a8", "#2c4a6b"], ["#b06474", "#6b3341"], ["#6d6a66", "#2f2d2b"],
  ["#4f8f93", "#245457"], ["#a3715a", "#5e3a2a"],
];

export const COLLECTIONS = [
  { id: "all", label: "All Books", icon: "i-books", test: () => true },
  { id: "reading", label: "Reading Now", icon: "i-clock", test: b => (b.percent || 0) > 0 && !b.finishedAt },
  { id: "finished", label: "Finished", icon: "i-done", test: b => !!b.finishedAt },
  { id: "epub", label: "Books", icon: "i-books", test: b => b.format === "epub" },
  { id: "pdf", label: "PDFs", icon: "i-doc", test: b => b.format === "pdf" },
  { id: "txt", label: "Text Files", icon: "i-text", test: b => b.format === "txt" },
];

export const el = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
};

export function icon(name, extra = "") {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("class", `icon ${extra}`.trim());
  const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
  use.setAttribute("href", `#${name}`);
  svg.append(use);
  return svg;
}

/** Cover: the book's own artwork, otherwise a quiet gradient cover with the title. */
export function createCover(book, coverUrl) {
  if (coverUrl) {
    const cover = el("span", "cover");
    const img = el("img");
    img.src = coverUrl;
    img.alt = "";
    img.decoding = "async";
    img.draggable = false;
    cover.append(img);
    return cover;
  }
  const seed = hashString(`${book.title}|${book.author}`);
  const [c1, c2] = PALETTES[seed % PALETTES.length];
  const cover = el("span", "cover generated");
  cover.style.setProperty("--c1", c1);
  cover.style.setProperty("--c2", c2);
  const len = (book.title || "").length;
  const top = el("span");
  const title = el("span", "g-title", book.title || "Untitled");
  title.style.setProperty("--title-size", `${len > 60 ? 13 : len > 34 ? 15 : len > 16 ? 17 : 20}px`);
  top.append(title, el("span", "g-rule"));
  cover.append(top, el("span", "g-author", book.author || ""));
  return cover;
}

export class LibraryView {
  constructor({ grid, list, continueEl, headEl, scroller, onOpen, onListen, onMore }) {
    Object.assign(this, { grid, list, continueEl, headEl, scroller, onOpen, onListen, onMore });
    this.mode = "shelf";
    this.books = [];
    this.recent = [];
    this.coverUrls = new Map();
    this.importing = new Map();
    this.estimate = () => "";
    this.emptyMessage = null;
  }

  /** @param visible books in the current collection/search; @param all every book (cover cache). */
  setBooks(visible, { all = visible, recent = [], estimate } = {}) {
    const ids = new Set(all.map(b => b.id));
    for (const [id, url] of this.coverUrls) if (!ids.has(id)) { URL.revokeObjectURL(url); this.coverUrls.delete(id); }
    for (const book of all) if (book.thumb && !this.coverUrls.has(book.id)) this.coverUrls.set(book.id, URL.createObjectURL(book.thumb));
    this.books = visible;
    this.recent = recent;
    if (estimate) this.estimate = estimate;
    this.render();
  }

  coverFor(book) { return this.coverUrls.get(book.id) || null; }

  setImporting(key, info) {
    if (info) this.importing.set(key, info); else this.importing.delete(key);
    this.render();
  }

  render() {
    this.renderContinue();
    this.grid.hidden = this.mode !== "shelf";
    this.list.hidden = this.mode !== "list";
    this.headEl.replaceChildren();
    if (this.recent.length) this.headEl.append(el("h2", null, "All Books"));
    if (this.mode === "shelf") this.renderGrid(); else this.renderList();
  }

  renderContinue() {
    this.continueEl.replaceChildren();
    if (!this.recent.length) return;
    this.continueEl.append(el("h2", null, "Continue Reading"));
    const row = el("div", "continue-row");
    for (const book of this.recent) {
      const card = el("div", "continue-card");
      card.tabIndex = 0;
      card.setAttribute("role", "button");
      card.setAttribute("aria-label", `Resume ${book.title}`);
      const slot = el("div", "cover-slot");
      const cover = createCover(book, this.coverFor(book));
      slot.append(cover);
      const info = el("div");
      info.append(el("div", "t", book.title), el("div", "a", book.author || "Unknown author"));
      const pct = Math.floor(book.percent || 0);
      const progress = el("div", "progress");
      const fill = el("span");
      fill.style.width = `${Math.max(2, pct)}%`;
      progress.append(fill);
      info.append(progress, el("div", "meta", `${pct}% · ${this.estimate(book)}`));
      const actions = el("div", "actions");
      const resume = el("button", "btn-secondary", "Resume");
      const listen = el("button", "btn-secondary accent");
      listen.append(icon("i-play", "solid"), document.createTextNode("Listen"));
      resume.addEventListener("click", e => { e.stopPropagation(); this.onOpen(book, cover); });
      listen.addEventListener("click", e => { e.stopPropagation(); this.onListen(book, cover); });
      actions.append(resume, listen);
      info.append(actions);
      card.append(slot, info);
      card.addEventListener("click", () => this.onOpen(book, cover));
      card.addEventListener("keydown", e => { if (e.key === "Enter") this.onOpen(book, cover); });
      row.append(card);
    }
    this.continueEl.append(row);
  }

  status(book) {
    const box = el("span");
    if (book.finishedAt) box.append(el("span", "badge-done", "Finished"));
    else if (!book.openedAt && !(book.percent > 0)) box.append(el("span", "badge-new", "NEW"));
    else box.append(document.createTextNode(`${Math.floor(book.percent || 0)}%`));
    return box;
  }

  moreButton(book) {
    const more = el("button", "more-btn");
    more.title = "More";
    more.setAttribute("aria-label", `More actions for ${book.title}`);
    more.append(icon("i-more"));
    more.addEventListener("click", e => { e.stopPropagation(); this.onMore(book, more); });
    return more;
  }

  renderGrid() {
    const fragment = document.createDocumentFragment();
    for (const info of this.importing.values()) {
      const tile = el("div", "book-tile importing");
      const slot = el("div", "cover-slot");
      slot.append(createCover({ title: info.title, author: "" }, null));
      tile.append(slot, el("div", "import-progress", info.progress != null ? `Importing… ${Math.round(info.progress * 100)}%` : "Importing…"));
      fragment.append(tile);
    }
    for (const book of this.books) {
      const tile = el("div", "book-tile");
      const slot = el("div", "cover-slot");
      const btn = el("button", "cover-btn");
      btn.title = book.author ? `${book.title} — ${book.author}` : book.title;
      btn.setAttribute("aria-label", `Open ${book.title}`);
      const cover = createCover(book, this.coverFor(book));
      btn.append(cover);
      btn.addEventListener("click", () => this.onOpen(book, cover));
      slot.append(btn);
      const info = el("div", "tile-info");
      const text = el("div", "tile-text");
      text.append(el("div", "tile-title", book.title), el("div", "tile-author", book.author || "Unknown author"));
      info.append(text);
      const status = el("div", "tile-status");
      status.append(this.status(book), this.moreButton(book));
      tile.append(slot, info, status);
      fragment.append(tile);
    }
    if (!this.books.length && !this.importing.size) fragment.append(this.emptyState());
    this.grid.replaceChildren(fragment);
  }

  emptyState() {
    const box = el("div", "empty-state");
    box.append(icon("i-books"));
    if (this.emptyMessage) {
      box.append(el("h3", null, this.emptyMessage.title), el("div", null, this.emptyMessage.text));
    } else {
      box.append(el("h3", null, "Your library is empty"),
        el("div", null, "Drag EPUB, PDF or TXT files here, or click Add Books."));
    }
    return box;
  }

  renderList() {
    const fragment = document.createDocumentFragment();
    if (this.books.length) {
      const head = el("div", "list-head");
      head.append(el("span"), el("span", null, "Title"), el("span", "a", "Author"), el("span", null, "Progress"), el("span", "w", "Last opened"), el("span"));
      fragment.append(head);
    } else {
      fragment.append(this.emptyState());
    }
    for (const book of this.books) {
      const row = el("div", "list-row");
      row.tabIndex = 0;
      row.setAttribute("role", "button");
      const slot = el("div", "cover-slot");
      const cover = createCover(book, this.coverFor(book));
      slot.append(cover);
      const pct = Math.floor(book.percent || 0);
      const progress = el("div");
      const bar = el("div", "progress");
      const fill = el("span");
      fill.style.width = `${pct}%`;
      bar.append(fill);
      progress.append(el("div", "p", book.finishedAt ? "Finished" : `${pct}%`), bar);
      row.append(slot, el("div", "t", book.title), el("div", "a", book.author || "—"), progress,
        el("div", "w", book.openedAt ? relativeDay(book.openedAt) : "Never"), this.moreButton(book));
      row.addEventListener("click", () => this.onOpen(book, cover));
      row.addEventListener("keydown", e => { if (e.key === "Enter") this.onOpen(book, cover); });
      fragment.append(row);
    }
    this.list.replaceChildren(fragment);
  }
}

function relativeDay(ts) {
  const days = Math.floor((Date.now() - ts) / 86400000);
  if (days <= 0) return "Today";
  if (days === 1) return "Yesterday";
  if (days < 30) return `${days} days ago`;
  return new Date(ts).toLocaleDateString();
}
