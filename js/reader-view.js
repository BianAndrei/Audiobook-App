// The open book: full-window pagination with CSS columns (two-page spread on wide windows,
// one column on narrow ones, or continuous scroll), slide page turns, sentence highlighting,
// selection and click-to-jump.

import { getImage } from "./storage.js";

const SLIDE_MS = 380;
const MARGINS = { narrow: 0.045, normal: 0.07, wide: 0.105 };
const FONT_SCALE = { garamond: 1.12, baskerville: 1.04, sf: 0.95 };

export class ReaderView extends EventTarget {
  constructor(root) {
    super();
    this.root = root;
    this.desk = root.querySelector(".desk");
    this.bookEl = root.querySelector(".book");
    this.viewport = root.querySelector(".text-viewport");
    this.flow = root.querySelector(".flow");
    this.folios = [root.querySelector(".folio-left"), root.querySelector(".folio-right")];
    this.book = null;
    this.chapters = [];
    this.chapter = 0;
    this.view = 0;
    this.colCount = 1;
    this.spans = [];
    this.imageUrls = [];
    this.annotations = [];
    this.speaking = -1;
    this.layout = null;
    this.settings = {};
    this.animations = [];
    this.busy = Promise.resolve();
    this.bindEvents();
  }

  // ---- public API --------------------------------------------------------
  async open(book, chapters, settings, at) {
    this.book = book;
    this.chapters = chapters;
    this.settings = { ...settings };
    this.applyTypography();
    this.flow.lang = (book.language || "en").slice(0, 12);
    this.spans = [];
    this.chapter = -1;
    await document.fonts.ready;
    await this.showChapter(at?.c ?? 0, { sentence: at?.s ?? 0, emit: true });
  }

  close() {
    this.restingAnchor = null;
    this.cancelAnimation();
    this.revokeImages(this.imageUrls);
    this.imageUrls = [];
    this.flow.replaceChildren();
    this.spans = [];
    this.book = null;
  }

  get isScroll() { return this.settings.layout === "scroll"; }
  get perView() { return this.layout?.spread ? 2 : 1; }
  get viewCount() { return Math.max(1, Math.ceil(this.colCount / this.perView)); }

  async updateSettings(settings) {
    const anchor = this.firstVisibleSentence();
    this.settings = { ...settings };
    this.applyTypography();
    await document.fonts.ready;
    this.relayout(anchor);
  }

  async showChapter(c, { sentence = 0, atEnd = false, emit = true } = {}) {
    c = Math.max(0, Math.min(this.chapters.length - 1, c));
    if (c !== this.chapter || !this.spans.length) {
      this.chapter = c;
      await this.renderChapter();
    }
    this.relayout(atEnd ? null : sentence, { atEnd, emit });
  }

  /** Make sure sentence s of chapter c is on screen (slides when it is the next/previous page). */
  async reveal(c, s, { animate = true } = {}) {
    if (c !== this.chapter) {
      if (animate && Math.abs(c - this.chapter) === 1 && !this.isScroll) return this.turn(c - this.chapter, { toSentence: s, force: true });
      return this.showChapter(c, { sentence: s });
    }
    if (this.isScroll) { this.spans[s]?.scrollIntoView({ block: "center", behavior: "smooth" }); return; }
    const target = Math.floor(this.colOf(s) / this.perView);
    if (target === this.view) return;
    if (animate && Math.abs(target - this.view) === 1) return this.turn(target - this.view, { force: true });
    this.goToView(target);
  }

  isSentenceVisible(c, s) {
    if (c !== this.chapter || !this.spans[s]) return false;
    if (this.isScroll) {
      const r = this.spans[s].getBoundingClientRect(), v = this.viewport.getBoundingClientRect();
      return r.bottom > v.top && r.top < v.bottom;
    }
    return Math.floor(this.colOf(s) / this.perView) === this.view;
  }

  /**
   * For a sentence that continues past the current page: the fraction of it (by line length)
   * that sits on this page or earlier. null when the sentence doesn't cross the page edge.
   */
  splitFraction(s) {
    if (this.isScroll || !this.spans[s] || !this.layout) return null;
    const rects = [...this.spans[s].getClientRects()].filter(r => r.width > 1);
    if (rects.length < 2) return null;
    const origin = this.flow.getBoundingClientRect().left;
    let upTo = 0, total = 0, onView = false, beyond = false;
    for (const r of rects) {
      const view = Math.floor(Math.floor((r.left - origin + 2) / this.layout.step) / this.perView);
      total += r.width;
      if (view <= this.view) upTo += r.width;
      if (view === this.view) onView = true;
      if (view > this.view) beyond = true;
    }
    return onView && beyond && total ? upTo / total : null;
  }

  setSpeaking(c, s) {
    this.spans[this.speaking]?.classList.remove("speaking");
    this.speaking = c === this.chapter ? s : -1;
    this.spans[this.speaking]?.classList.add("speaking");
  }

  flash(s) {
    const span = this.spans[s];
    if (!span) return;
    span.classList.remove("flash");
    void span.offsetWidth;
    span.classList.add("flash");
    setTimeout(() => span.classList.remove("flash"), 1700);
  }

  setAnnotations(list) {
    this.annotations = list;
    this.paintAnnotations();
  }

  next() { return this.turn(1); }
  prev() { return this.turn(-1); }

  firstVisibleSentence() {
    if (!this.spans.length) return 0;
    if (this.isScroll) {
      const top = this.viewport.getBoundingClientRect().top;
      return this.search(i => this.spans[i].getBoundingClientRect().bottom > top + 4);
    }
    const firstCol = this.view * this.perView;
    return this.search(i => this.colOf(i, true) >= firstCol);
  }

  lastVisibleSentence() {
    if (!this.spans.length) return 0;
    if (this.isScroll) {
      const bottom = this.viewport.getBoundingClientRect().bottom;
      return Math.max(0, this.search(i => this.spans[i].getBoundingClientRect().top >= bottom) - 1);
    }
    const nextCol = (this.view + 1) * this.perView;
    return Math.max(0, this.search(i => this.colOf(i) >= nextCol) - 1);
  }

  pageInfo() {
    if (this.isScroll) {
      const max = Math.max(1, this.viewport.scrollHeight - this.viewport.clientHeight);
      return { page: 1, pages: 1, fraction: this.viewport.scrollTop / max };
    }
    return { page: this.view * this.perView + 1, pages: this.colCount, fraction: this.viewCount > 1 ? this.view / (this.viewCount - 1) : 1 };
  }

  // ---- rendering ---------------------------------------------------------
  applyTypography() {
    const s = this.settings;
    this.bookEl.dataset.font = s.font;
    this.bookEl.classList.toggle("justify", !!s.justify);
    this.bookEl.classList.toggle("scroll", this.isScroll);
    this.bookEl.style.setProperty("--font-size", `${this.fontPx()}px`);
    this.bookEl.style.setProperty("--line-height", String(s.lineHeight));
  }

  fontPx() { return this.settings.fontSize * (FONT_SCALE[this.settings.font] || 1); }

  async renderChapter() {
    this.cancelAnimation();
    const chapter = this.chapters[this.chapter];
    const old = this.imageUrls;
    this.imageUrls = [];
    const fragment = document.createDocumentFragment();
    const spans = [];
    let first = true;
    const imageJobs = [];

    for (const block of chapter.blocks) {
      if (block.k === "hr") {
        const hr = document.createElement("div");
        hr.className = "fleuron";
        hr.textContent = "* * *";
        hr.setAttribute("aria-hidden", "true");
        fragment.append(hr);
        continue;
      }
      if (block.k === "img") {
        const figure = document.createElement("figure");
        figure.className = "plate";
        const img = document.createElement("img");
        img.alt = block.alt || "";
        img.decoding = "async";
        figure.append(img);
        fragment.append(figure);
        imageJobs.push(getImage(this.book.id, block.src).then(blob => {
          if (!blob) { figure.remove(); return; }
          const url = URL.createObjectURL(blob);
          this.imageUrls.push(url);
          img.src = url;
          return img.decode().catch(() => {});
        }));
        continue;
      }
      const tag = block.k === "h" ? (block.lvl <= 2 ? "h2" : "h3") : block.k === "q" ? "blockquote" : "p";
      const el = document.createElement(tag);
      el.className = `b-${block.k}`;
      if (block.k === "p" && first) { el.classList.add("opening"); first = false; }
      if (block.k === "h") first = true;
      for (const sentence of block.s) {
        const span = document.createElement("span");
        span.className = "s";
        span.dataset.i = String(spans.length);
        span.textContent = sentence;
        el.append(span, block.k === "h" ? "\n" : " ");
        spans.push(span);
      }
      fragment.append(el);
    }

    this.flow.replaceChildren(fragment);
    this.spans = spans;
    this.speaking = -1;
    if (imageJobs.length) await Promise.race([Promise.all(imageJobs), new Promise(r => setTimeout(r, 2500))]);
    this.revokeImages(old);
    this.paintAnnotations();
  }

  revokeImages(urls) { for (const url of urls) URL.revokeObjectURL(url); }

  paintAnnotations() {
    for (const span of this.flow.querySelectorAll(".s.hl, .s.noted")) {
      span.classList.remove("hl", "hl-amber", "hl-green", "hl-blue", "hl-rose", "noted");
    }
    for (const note of this.annotations) {
      if (note.c !== this.chapter || note.kind !== "highlight") continue;
      for (let i = note.s; i <= (note.e ?? note.s); i++) {
        const span = this.spans[i];
        if (!span) continue;
        span.classList.add("hl", `hl-${note.color || "amber"}`);
        if (note.note) span.classList.add("noted");
      }
    }
  }

  computeLayout() {
    const rect = this.desk.getBoundingClientRect();
    const W = Math.max(300, rect.width), H = Math.max(300, rect.height);
    const font = this.fontPx();
    const outer = Math.max(24, Math.round(W * (MARGINS[this.settings.margins] || MARGINS.normal)));
    const spread = !this.isScroll && W >= 900;
    const gap = Math.max(56, Math.round(W * 0.065));
    const measure = font * (spread ? 34 : 36);
    let textW = spread ? Math.min((W - outer * 2 - gap) / 2, measure) : Math.min(W - outer * 2, measure);
    textW = Math.floor(Math.max(220, textW));
    const viewW = spread ? textW * 2 + gap : textW;
    const top = this.isScroll ? 0 : 8;
    const textH = Math.floor(this.isScroll ? H - 90 : H - top - 118);
    const left = Math.floor((W - viewW) / 2);
    return { spread, textW, textH, gap, viewW, left, top, step: textW + gap, margin: Math.max(44, Math.min(140, left)) };
  }

  relayout(anchorSentence = null, { atEnd = false, emit = true } = {}) {
    this.cancelAnimation();
    const L = this.layout = this.computeLayout();
    const st = this.bookEl.style;
    this.bookEl.classList.toggle("spread", L.spread);
    this.bookEl.classList.toggle("single", !L.spread && !this.isScroll);
    for (const [k, v] of Object.entries({
      "--text-w": L.textW, "--text-h": L.textH, "--gap": L.gap, "--view-w": L.viewW,
      "--book-left": L.left, "--book-top": L.top, "--margin": L.margin,
    })) st.setProperty(k, `${v}px`);
    st.setProperty("--cols", L.spread ? "2" : "1");

    if (this.isScroll) {
      this.flow.style.transform = "";
      if (atEnd) this.viewport.scrollTop = this.viewport.scrollHeight;
      else if (anchorSentence != null && this.spans[anchorSentence]) {
        this.viewport.scrollTop = 0;
        const top = this.spans[anchorSentence].getBoundingClientRect().top - this.viewport.getBoundingClientRect().top;
        this.viewport.scrollTop = Math.max(0, top - 24);
      } else this.viewport.scrollTop = 0;
      if (emit) this.emitPage();
      return;
    }
    this.viewport.scrollTop = 0;
    this.viewport.scrollLeft = 0;
    this.flow.style.transform = "translateX(0px)";
    const tail = [this.spans[this.spans.length - 1], ...this.flow.querySelectorAll(":scope > .plate, :scope > .fleuron")].filter(Boolean);
    this.colCount = Math.max(1, ...tail.map(el => this.colOfElement(el, true) + 1));
    let view = 0;
    if (atEnd) view = this.viewCount - 1;
    else if (anchorSentence != null && this.spans[anchorSentence]) view = Math.floor(this.colOf(anchorSentence) / this.perView);
    this.goToView(view, { emit });
  }

  translateFor(view) { return `translateX(${-view * this.perView * this.layout.step}px)`; }

  goToView(view, { emit = true } = {}) {
    this.view = Math.max(0, Math.min(this.viewCount - 1, view));
    if (this.isScroll) return;
    this.flow.style.transform = this.translateFor(this.view);
    this.updateFolios();
    this.restingAnchor = this.pageAnchor();
    if (emit) this.emitPage();
  }

  updateFolios() {
    const first = this.view * this.perView;
    const label = n => (n < this.colCount ? `${n + 1} of ${this.colCount}` : "");
    this.folios[0].textContent = label(first);
    this.folios[1].textContent = this.layout?.spread ? label(first + 1) : "";
  }

  emitPage() {
    if (!this.isScroll) this.restingAnchor = this.pageAnchor();
    this.dispatchEvent(new CustomEvent("page", { detail: { c: this.chapter, s: this.firstVisibleSentence(), anchor: this.pageAnchor() } }));
  }

  /** A sentence that starts on this page, so reopening at it lands on this exact page (the first
   *  visible sentence may have begun on the previous page). */
  pageAnchor() {
    const first = this.firstVisibleSentence();
    if (this.isScroll || !this.spans.length) return first;
    const firstCol = this.view * this.perView, nextCol = firstCol + this.perView;
    const i = this.search(j => this.colOf(j) >= firstCol);
    return this.spans[i] && this.colOf(i) < nextCol ? i : first;
  }

  // ---- geometry ----------------------------------------------------------
  colOfElement(el, useEnd = false) {
    const rects = el.getClientRects();
    if (!rects.length) return 0;
    const rect = useEnd ? rects[rects.length - 1] : rects[0];
    const origin = this.flow.getBoundingClientRect().left;
    return Math.max(0, Math.floor((rect.left - origin + 2) / this.layout.step));
  }

  colOf(i, useEnd = false) { return this.spans[i] ? this.colOfElement(this.spans[i], useEnd) : 0; }

  search(predicate) {
    let lo = 0, hi = this.spans.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (predicate(mid)) hi = mid; else lo = mid + 1;
    }
    return Math.min(lo, Math.max(0, this.spans.length - 1));
  }

  // ---- page turning ------------------------------------------------------
  turn(dir, opts = {}) {
    // Serialise turns so rapid input never interleaves chapter loads, and never queue more
    // than one extra turn (holding a key or clicking fast cannot run away through the book).
    if (!opts.force && this.queuedTurns >= 2) return Promise.resolve(false);
    this.queuedTurns = (this.queuedTurns || 0) + 1;
    const job = this.busy.then(() => this.doTurn(dir, opts)).finally(() => { this.queuedTurns--; });
    this.busy = job.catch(() => {});
    return job;
  }

  async doTurn(dir, { toSentence = null } = {}) {
    if (this.isScroll) {
      const v = this.viewport;
      const atEdge = dir > 0 ? v.scrollTop + v.clientHeight >= v.scrollHeight - 4 : v.scrollTop <= 2;
      if (!atEdge) { v.scrollBy({ top: dir * v.clientHeight * 0.9, behavior: "smooth" }); return true; }
      const c = this.chapter + dir;
      if (c < 0 || c >= this.chapters.length) return false;
      await this.showChapter(c, { sentence: toSentence ?? 0, atEnd: dir < 0 && toSentence == null });
      return true;
    }
    this.cancelAnimation();
    const animate = this.settings.pageTurn !== "none" && !matchMedia("(prefers-reduced-motion: reduce)").matches;
    const targetView = this.view + dir;
    if (targetView >= 0 && targetView < this.viewCount) {
      const from = this.translateFor(this.view);
      this.goToView(targetView, { emit: false });
      if (animate) this.track(this.flow.animate([{ transform: from }, { transform: this.translateFor(targetView) }],
        { duration: SLIDE_MS, easing: "cubic-bezier(.25,.8,.25,1)" }));
    } else {
      const c = this.chapter + dir;
      if (c < 0 || c >= this.chapters.length) { this.bump(dir); return false; }
      if (animate) {
        await this.viewport.animate([{ opacity: 1, transform: "none" }, { opacity: 0, transform: `translateX(${-dir * 48}px)` }],
          { duration: 150, easing: "ease-in", fill: "forwards" }).finished.catch(() => {});
      }
      this.chapter = c;
      await this.renderChapter();
      this.relayout(dir > 0 ? (toSentence ?? 0) : null, { atEnd: dir < 0, emit: false });
      if (animate) {
        this.viewport.getAnimations().forEach(a => a.cancel());
        this.track(this.viewport.animate([{ opacity: 0, transform: `translateX(${dir * 48}px)` }, { opacity: 1, transform: "none" }],
          { duration: 260, easing: "cubic-bezier(.2,.8,.2,1)" }));
      }
    }
    this.emitPage();
    this.dispatchEvent(new CustomEvent("turn", { detail: { dir } }));
    return true;
  }

  track(animation) {
    this.animations.push(animation);
    animation.finished.finally(() => { this.animations = this.animations.filter(a => a !== animation); }).catch(() => {});
  }

  cancelAnimation() {
    for (const a of this.animations) a.finish();
    this.animations = [];
  }

  bump(dir) {
    this.bookEl.animate([{ transform: "translateX(0)" }, { transform: `translateX(${-dir * 12}px)` }, { transform: "translateX(0)" }],
      { duration: 280, easing: "ease-out" });
  }

  // ---- events ------------------------------------------------------------
  bindEvents() {
    this.flow.addEventListener("click", event => {
      const sel = getSelection();
      if (sel && !sel.isCollapsed) return;
      const span = event.target.closest(".s");
      if (!span) return;
      this.dispatchEvent(new CustomEvent("sentence-click", { detail: { c: this.chapter, s: Number(span.dataset.i) } }));
    });
    this.flow.addEventListener("dblclick", event => {
      const span = event.target.closest(".s");
      if (!span) return;
      getSelection()?.removeAllRanges();
      this.dispatchEvent(new CustomEvent("sentence-dblclick", { detail: { c: this.chapter, s: Number(span.dataset.i) } }));
    });
    const reportSelection = () => {
      const sel = getSelection();
      if (!sel || sel.isCollapsed || !sel.rangeCount) return;
      const range = sel.getRangeAt(0);
      if (!this.flow.contains(range.commonAncestorContainer)) return;
      const spanOf = node => (node.nodeType === 1 ? node : node.parentElement)?.closest?.(".s");
      let a = spanOf(range.startContainer), b = spanOf(range.endContainer);
      if (!a) a = this.spans.find(span => range.intersectsNode(span));
      if (!b) b = [...this.spans].reverse().find(span => range.intersectsNode(span));
      if (!a || !b) return;
      const s = Number(a.dataset.i), e = Number(b.dataset.i);
      this.dispatchEvent(new CustomEvent("selection", { detail: { c: this.chapter, s: Math.min(s, e), e: Math.max(s, e), rect: range.getBoundingClientRect(), text: sel.toString() } }));
    };
    this.flow.addEventListener("mouseup", () => setTimeout(reportSelection, 0));
    this.flow.addEventListener("keyup", reportSelection);

    for (const zone of this.root.querySelectorAll(".turn-zone")) {
      zone.addEventListener("click", () => { zone.blur(); this.turn(zone.classList.contains("next") ? 1 : -1); });
    }

    // Trackpad / mouse wheel: one gesture = one page. A gesture is a stream of wheel events
    // (including macOS momentum scrolling) with no pause longer than GESTURE_GAP ms, so a
    // single swipe can never skip several pages.
    const GESTURE_GAP = 240;
    let gesture = null;
    this.desk.addEventListener("wheel", event => {
      if (this.isScroll || !this.book || event.ctrlKey) return; // ctrl = pinch-zoom
      event.preventDefault();
      const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? 400 : 1;
      gesture ||= { dx: 0, dy: 0, fired: false, timer: 0 };
      gesture.dx += event.deltaX * unit;
      gesture.dy += event.deltaY * unit;
      clearTimeout(gesture.timer);
      gesture.timer = setTimeout(() => { gesture = null; }, GESTURE_GAP);
      if (gesture.fired) return;
      const ax = Math.abs(gesture.dx), ay = Math.abs(gesture.dy);
      if (ax > 45 && ax > ay * 1.2) { gesture.fired = true; this.turn(gesture.dx > 0 ? 1 : -1); }
      else if (ay > 80 && ay > ax * 1.2) { gesture.fired = true; this.turn(gesture.dy > 0 ? 1 : -1); }
    }, { passive: false });

    for (const corner of this.desk.querySelectorAll(".corner")) {
      corner.addEventListener("click", () => { corner.blur(); this.turn(Number(corner.dataset.dir)); });
    }

    let touch = null;
    this.desk.addEventListener("pointerdown", e => { if (e.pointerType === "touch") touch = { x: e.clientX, y: e.clientY }; });
    this.desk.addEventListener("pointerup", e => {
      if (!touch || e.pointerType !== "touch") return;
      const dx = e.clientX - touch.x, dy = e.clientY - touch.y;
      touch = null;
      if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy) * 1.4) this.turn(dx < 0 ? 1 : -1);
    });

    let scrollTimer = 0;
    this.viewport.addEventListener("scroll", () => {
      if (!this.isScroll) { this.viewport.scrollLeft = 0; this.viewport.scrollTop = 0; return; }
      clearTimeout(scrollTimer);
      scrollTimer = setTimeout(() => this.emitPage(), 160);
    });

    let resizeTimer = 0;
    new ResizeObserver(() => {
      if (!this.book) return;
      clearTimeout(resizeTimer);
      // By now the text has already reflowed to the new size, so measuring "what's on screen"
      // would be off by a page; use the sentence remembered from when the page was last shown.
      const anchor = this.isScroll ? this.firstVisibleSentence() : (this.restingAnchor ?? this.firstVisibleSentence());
      resizeTimer = setTimeout(() => this.relayout(anchor), 120);
    }).observe(this.desk);
  }
}
