// Turns EPUB / PDF / TXT files into a uniform, sentence-segmented book model.
//
// Book model:
//   { format, title, author, language, cover: Blob|null, images: Map<path, Blob>,
//     chapters: [{ title, blocks: [Block] }] }
//   Block: { k: "h", lvl, s: [sentences] } | { k: "p"|"q"|"v"|"li"|"cap", s: [...] }
//        | { k: "hr" } | { k: "img", src, alt }
//
// Book contents are never inserted as HTML: the reader rebuilds DOM nodes with textContent.

import { splitSentences, tidyBlock, countWords, titleFromFilename, cleanText } from "./text-utils.js";

const MAX_FILE = 300 * 1024 * 1024;
const MAX_ENTRY = 40 * 1024 * 1024;
const MAX_IMAGE = 8 * 1024 * 1024;
const MAX_IMAGES_TOTAL = 80 * 1024 * 1024;
const MAX_SENTENCES_PER_CHAPTER = 700;
const IMAGE_TYPES = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp" };
const OPS_NS = "http://www.idpf.org/2007/ops";
const XLINK_NS = "http://www.w3.org/1999/xlink";

export async function parseBookFile(file, { onProgress = () => {} } = {}) {
  if (file.size > MAX_FILE) throw new Error("This file is larger than 300 MB.");
  const buffer = await file.arrayBuffer();
  const head = new Uint8Array(buffer.slice(0, 5));
  const ext = (file.name.split(".").pop() || "").toLowerCase();
  let parsed;
  if (head[0] === 0x50 && head[1] === 0x4b) parsed = await parseEpub(buffer, onProgress);
  else if (String.fromCharCode(...head) === "%PDF-") parsed = await parsePdf(buffer, onProgress);
  else if (ext === "txt" || file.type.startsWith("text/")) parsed = parseTxt(buffer, file.name);
  else throw new Error("Unsupported file. Choose an EPUB, PDF, or TXT book.");
  if (!parsed.title) parsed.title = titleFromFilename(file.name);
  parsed.chapters = normaliseChapters(parsed.chapters);
  if (!parsed.chapters.length) throw new Error("No readable text was found in this book.");
  return { parsed, buffer };
}

export async function fileId(buffer) {
  const hash = await crypto.subtle.digest("SHA-256", buffer);
  return Array.from(new Uint8Array(hash).slice(0, 16), b => b.toString(16).padStart(2, "0")).join("");
}

/** Summary numbers stored on the book record (keeps the library light-weight). */
export function summarise(chapters) {
  const counts = [], words = [], titles = [];
  for (const chapter of chapters) {
    let n = 0, w = 0;
    for (const block of chapter.blocks) if (block.s) { n += block.s.length; for (const s of block.s) w += countWords(s); }
    counts.push(n); words.push(w); titles.push(chapter.title);
  }
  return {
    chapterTitles: titles, chapterCounts: counts, chapterWords: words,
    totalSentences: counts.reduce((a, b) => a + b, 0), totalWords: words.reduce((a, b) => a + b, 0),
  };
}

function normaliseChapters(chapters) {
  const out = [];
  for (const chapter of chapters) {
    const blocks = chapter.blocks.filter(b => b.k === "hr" || b.k === "img" || (b.s && b.s.length));
    if (!blocks.some(b => b.s?.length || b.k === "img")) continue;
    let part = [], count = 0, partNo = 1;
    const push = () => {
      if (!part.length) return;
      out.push({ title: partNo === 1 ? chapter.title : `${chapter.title} (part ${partNo})`, blocks: part });
      part = []; count = 0; partNo++;
    };
    for (const block of blocks) {
      if (count >= MAX_SENTENCES_PER_CHAPTER && block.k !== "h") push();
      part.push(block);
      count += block.s ? block.s.length : 0;
    }
    push();
  }
  return out;
}

// ---------------------------------------------------------------------------
// XML helpers
function parseXml(text, label) {
  // Drop any DOCTYPE with an internal subset (entity definitions) before parsing.
  const safe = text.replace(/<!DOCTYPE[^>[]*\[[\s\S]*?\]\s*>/i, "");
  const doc = new DOMParser().parseFromString(safe, "application/xml");
  if (doc.getElementsByTagName("parsererror").length) throw new Error(`Could not read ${label}.`);
  return doc;
}

function parseXhtml(text) {
  const safe = text.replace(/<!DOCTYPE[^>[]*\[[\s\S]*?\]\s*>/i, "");
  let doc = new DOMParser().parseFromString(safe, "application/xhtml+xml");
  if (doc.getElementsByTagName("parsererror").length) doc = new DOMParser().parseFromString(safe, "text/html");
  return doc;
}

const byLocal = (root, name) => Array.from(root.getElementsByTagNameNS("*", name));
const firstLocal = (root, name) => root.getElementsByTagNameNS("*", name)[0] || null;

function resolvePath(base, href) {
  const url = new URL(href, `https://book.invalid/${base}`);
  if (url.origin !== "https://book.invalid") return null; // external reference: ignore
  try { return decodeURIComponent(url.pathname.slice(1)); } catch { return null; }
}

// ---------------------------------------------------------------------------
// EPUB
async function parseEpub(buffer, onProgress) {
  if (typeof JSZip === "undefined") throw new Error("EPUB support library failed to load.");
  const zip = await JSZip.loadAsync(buffer);
  const entrySize = entry => entry?._data?.uncompressedSize ?? 0;
  const readText = async path => {
    const entry = zip.file(path);
    if (!entry) throw new Error(`EPUB is missing ${path}.`);
    if (entrySize(entry) > MAX_ENTRY) throw new Error("An EPUB section is too large.");
    return entry.async("string");
  };

  const container = parseXml(await readText("META-INF/container.xml"), "EPUB container");
  const opfPath = firstLocal(container, "rootfile")?.getAttribute("full-path");
  if (!opfPath) throw new Error("EPUB package file not found.");
  const opf = parseXml(await readText(opfPath), "EPUB package");

  const meta = firstLocal(opf, "metadata");
  const dc = name => meta ? tidyBlock(firstLocal(meta, name)?.textContent || "") : "";
  const title = dc("title");
  const author = byLocal(meta || opf, "creator").map(n => tidyBlock(n.textContent)).filter(Boolean).slice(0, 2).join(" & ");
  const language = dc("language") || "en";

  const manifest = new Map();
  for (const item of byLocal(opf, "item")) {
    const href = item.getAttribute("href");
    const path = href ? resolvePath(opfPath, href) : null;
    if (!path) continue;
    manifest.set(item.getAttribute("id"), {
      path, type: (item.getAttribute("media-type") || "").toLowerCase(),
      props: (item.getAttribute("properties") || "").split(/\s+/),
    });
  }

  // Table of contents titles keyed by document path.
  const tocTitles = new Map();
  const navItem = [...manifest.values()].find(i => i.props.includes("nav"));
  if (navItem) {
    try {
      const nav = parseXhtml(await readText(navItem.path));
      const navs = byLocal(nav, "nav");
      const toc = navs.find(n => /\btoc\b/.test(n.getAttributeNS(OPS_NS, "type") || n.getAttribute("epub:type") || "")) || navs[0];
      for (const a of toc ? byLocal(toc, "a") : []) {
        const href = a.getAttribute("href");
        const path = href && resolvePath(navItem.path, href.split("#")[0]);
        const label = tidyBlock(a.textContent).replace(/\n/g, " ");
        if (path && label && !tocTitles.has(path)) tocTitles.set(path, label);
      }
    } catch { /* fall back to NCX / headings */ }
  }
  if (!tocTitles.size) {
    const ncxId = firstLocal(opf, "spine")?.getAttribute("toc");
    const ncx = ncxId && manifest.get(ncxId);
    if (ncx) {
      try {
        const doc = parseXml(await readText(ncx.path), "EPUB NCX");
        for (const point of byLocal(doc, "navPoint")) {
          const src = firstLocal(point, "content")?.getAttribute("src");
          const label = tidyBlock(firstLocal(point, "text")?.textContent || "");
          const path = src && resolvePath(ncx.path, src.split("#")[0]);
          if (path && label && !tocTitles.has(path)) tocTitles.set(path, label);
        }
      } catch { /* optional */ }
    }
  }

  // Images (cover + illustrations) are stored as Blobs, never as URLs into the zip.
  const images = new Map();
  let imageBytes = 0;
  const loadImage = async path => {
    if (images.has(path)) return images.get(path) ? path : null;
    const ext = path.split(".").pop().toLowerCase();
    const entry = zip.file(path);
    const size = entrySize(entry);
    if (!entry || !IMAGE_TYPES[ext] || size > MAX_IMAGE || imageBytes + size > MAX_IMAGES_TOTAL) {
      images.set(path, null);
      return null;
    }
    imageBytes += size;
    images.set(path, new Blob([await entry.async("arraybuffer")], { type: IMAGE_TYPES[ext] }));
    return path;
  };

  // Cover detection: EPUB3 property, EPUB2 <meta name="cover">, then naming conventions.
  let coverPath = [...manifest.values()].find(i => i.props.includes("cover-image"))?.path;
  if (!coverPath) {
    const metaCover = byLocal(opf, "meta").find(m => m.getAttribute("name") === "cover")?.getAttribute("content");
    coverPath = manifest.get(metaCover)?.path;
  }
  if (!coverPath) coverPath = [...manifest.entries()].find(([id, i]) => i.type.startsWith("image/") && /cover/i.test(id + i.path))?.[1].path;
  let cover = null;
  if (coverPath && await loadImage(coverPath)) cover = images.get(coverPath);

  const spine = byLocal(opf, "itemref").map(ref => manifest.get(ref.getAttribute("idref"))).filter(Boolean);
  const chapters = [];
  for (let i = 0; i < spine.length; i++) {
    onProgress(i / spine.length);
    const item = spine[i];
    if (!/html|xml/.test(item.type) || item.props.includes("nav")) continue;
    const doc = parseXhtml(await readText(item.path));
    const body = firstLocal(doc, "body");
    if (!body) continue;
    const imgRefs = [];
    const blocks = extractBlocks(body, src => {
      const path = resolvePath(item.path, src);
      if (path) imgRefs.push(path);
      return path;
    });
    for (const path of imgRefs) await loadImage(path);
    const kept = blocks.filter(b => b.k !== "img" || images.get(b.src));
    // Skip a spine page that only repeats the cover image.
    if (kept.length === 1 && kept[0].k === "img" && kept[0].src === coverPath) continue;
    const heading = kept.find(b => b.k === "h")?.s.join(" ");
    const docTitle = tidyBlock(firstLocal(doc, "title")?.textContent || "");
    chapters.push({ title: tocTitles.get(item.path) || heading || docTitle || `Section ${chapters.length + 1}`, blocks: kept });
  }
  // Keep only the images that are actually referenced.
  const used = new Map();
  for (const chapter of chapters) for (const b of chapter.blocks) if (b.k === "img") used.set(b.src, images.get(b.src));
  return { format: "epub", title, author, language, cover, chapters, images: used };
}

const SKIP_TAGS = new Set(["script", "style", "noscript", "head", "title", "template", "iframe", "object", "embed",
  "audio", "video", "math", "button", "input", "select", "textarea", "rt", "rp"]);
const BLOCK_TAGS = new Set(["p", "div", "section", "article", "header", "footer", "aside", "main", "body", "blockquote",
  "figure", "figcaption", "ul", "ol", "li", "dl", "dt", "dd", "table", "thead", "tbody", "tfoot", "tr", "td", "th",
  "caption", "pre", "address", "hgroup", "h1", "h2", "h3", "h4", "h5", "h6", "nav", "center", "details", "summary"]);

function epubType(el) {
  return (el.getAttributeNS?.(OPS_NS, "type") || el.getAttribute?.("epub:type") || "") + " " + (el.getAttribute?.("role") || "");
}

function extractBlocks(body, resolveImage) {
  const blocks = [];
  let buffer = "";
  let bufferCtx = null;

  const flush = () => {
    if (!bufferCtx) { buffer = ""; return; }
    const ctx = bufferCtx;
    let text = tidyBlock(buffer);
    buffer = ""; bufferCtx = null;
    if (!text) return;
    let kind = ctx.k;
    if (kind === "h") text = text.replace(/\n+/g, " ");
    else if (kind !== "li" && kind !== "cap" && text.includes("\n")) kind = "v";
    const s = kind === "v" ? splitVerse(text) : splitSentences(text);
    if (!s.length) return;
    // hgroup: merge consecutive heading lines into one heading block.
    const prev = blocks[blocks.length - 1];
    if (kind === "h" && ctx.group && prev?.k === "h" && prev.group === ctx.group) { prev.s.push(...s); return; }
    blocks.push(kind === "h" ? { k: "h", lvl: ctx.lvl, s, group: ctx.group } : { k: kind, s });
  };

  const walk = (node, ctx) => {
    for (let child = node.firstChild; child; child = child.nextSibling) {
      if (child.nodeType === 3 || child.nodeType === 4) {
        if (!bufferCtx) {
          if (!/\S/.test(child.nodeValue)) continue;
          bufferCtx = ctx;
        }
        buffer += child.nodeValue;
        continue;
      }
      if (child.nodeType !== 1) continue;
      const tag = (child.localName || "").toLowerCase();
      if (SKIP_TAGS.has(tag)) continue;
      const type = epubType(child);
      if (/\b(?:pagebreak|doc-pagebreak|noteref|doc-noteref)\b/.test(type)) continue;
      if (tag === "sup" && /^\s*[\d*†‡]+\s*$/.test(child.textContent)) continue; // footnote refs
      if (tag === "br") { buffer += "\n"; continue; }
      if (tag === "hr") { flush(); blocks.push({ k: "hr" }); continue; }
      if (tag === "img" || tag === "image") {
        const src = child.getAttribute("src") || child.getAttribute("href") || child.getAttributeNS(XLINK_NS, "href");
        const path = src && !src.startsWith("data:") ? resolveImage(src) : null;
        if (path) { flush(); blocks.push({ k: "img", src: path, alt: cleanText(child.getAttribute("alt") || "") }); }
        continue;
      }
      if (tag === "svg") { walk(child, ctx); continue; }
      if (!BLOCK_TAGS.has(tag)) { walk(child, ctx); continue; }

      flush();
      let next = ctx;
      if (/^h[1-6]$/.test(tag)) next = { k: "h", lvl: Number(tag[1]), group: ctx.group };
      else if (tag === "hgroup") next = { k: "h", lvl: 2, group: Symbol("hgroup") };
      else if (ctx.k === "h") next = { ...ctx, lvl: Math.min(6, ctx.lvl + 1) };
      else if (tag === "blockquote") next = { k: "q" };
      else if (tag === "pre") next = { k: "v" };
      else if (tag === "li" || tag === "dt" || tag === "dd") next = { k: ctx.k === "q" ? "q" : "li" };
      else if (tag === "figcaption" || tag === "caption") next = { k: "cap" };
      else if (/\b(?:z3998:poem|z3998:verse|z3998:song)\b/.test(type)) next = { k: "v", verse: true };
      else if (!ctx.k) next = { k: "p" };
      walk(child, next);
      flush();
    }
  };
  walk(body, { k: "p" });
  flush();
  for (const block of blocks) delete block.group;
  return blocks;
}

/** Verse keeps its line structure: one narrated unit per sentence, but line breaks preserved. */
function splitVerse(text) {
  const units = [];
  let current = "";
  for (const line of text.split("\n")) {
    current = current ? `${current}\n${line}` : line;
    if (/[.!?…]["”’)]*$/.test(line) || current.length > 300) { units.push(current); current = ""; }
  }
  if (current) units.push(current);
  return units.filter(u => /\S/.test(u));
}

// ---------------------------------------------------------------------------
// PDF
let pdfjsPromise = null;
function loadPdfJs() {
  pdfjsPromise ||= import("/vendor/pdfjs/pdf.min.mjs").then(lib => {
    lib.GlobalWorkerOptions.workerSrc = "/vendor/pdfjs/pdf.worker.min.mjs";
    return lib;
  });
  return pdfjsPromise;
}

async function parsePdf(buffer, onProgress) {
  const pdfjs = await loadPdfJs();
  const pdf = await pdfjs.getDocument({
    data: new Uint8Array(buffer.slice(0)), isEvalSupported: false, enableXfa: false,
    cMapUrl: "/vendor/pdfjs/cmaps/", cMapPacked: true, standardFontDataUrl: "/vendor/pdfjs/standard_fonts/",
  }).promise;
  try {
    const { info } = await pdf.getMetadata().catch(() => ({ info: {} }));
    const cover = await renderPdfCover(pdf).catch(() => null);
    const pages = [];
    for (let n = 1; n <= pdf.numPages; n++) {
      onProgress(n / pdf.numPages * 0.9);
      const page = await pdf.getPage(n);
      const content = await page.getTextContent();
      pages.push(pdfLines(content.items));
      page.cleanup();
    }
    stripRunningHeads(pages);
    const paragraphs = assembleParagraphs(pages);
    if (paragraphs.reduce((sum, p) => sum + p.text.length, 0) < 200) {
      throw new Error("This PDF has no text layer (it is a scanned image). Run OCR on it first.");
    }
    const outline = await pdfOutline(pdf).catch(() => []);
    const chapters = pdfChapters(paragraphs, outline, pdf.numPages);
    const title = cleanText(info?.Title || "").trim();
    return {
      format: "pdf", title: /^(untitled|microsoft word|document)/i.test(title) ? "" : title,
      author: cleanText(info?.Author || "").trim(), language: "en", cover, chapters, images: new Map(),
    };
  } finally {
    await pdf.destroy();
  }
}

async function renderPdfCover(pdf) {
  const page = await pdf.getPage(1);
  const base = page.getViewport({ scale: 1 });
  const viewport = page.getViewport({ scale: 520 / base.width });
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(viewport.width);
  canvas.height = Math.round(viewport.height);
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvasContext: ctx, viewport }).promise;
  page.cleanup();
  // A nearly blank first page makes a poor cover: let the app draw a cloth cover instead.
  const sample = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
  let ink = 0;
  for (let i = 0; i < sample.length; i += 4 * 16) if (sample[i] + sample[i + 1] + sample[i + 2] < 600) ink++;
  if (ink < sample.length / (4 * 16) * 0.02) return null;
  return new Promise(resolve => canvas.toBlob(resolve, "image/jpeg", 0.86));
}

function pdfLines(items) {
  const lines = [];
  let cur = null;
  for (const item of items) {
    if (typeof item.str !== "string") continue;
    const x = item.transform[4], y = item.transform[5];
    const h = Math.abs(item.height) || Math.hypot(item.transform[2], item.transform[3]) || 10;
    if (item.str.trim()) {
      if (cur && Math.abs(y - cur.y) <= Math.max(2, cur.h * 0.6)) {
        const raised = y > cur.y + cur.h * 0.15 && h < cur.h * 0.8;
        if (!(raised && /^\s*[\d*†]+\s*$/.test(item.str))) { // superscript footnote numbers
          const gap = x - cur.xEnd;
          if (gap > cur.h * 0.16 && !/\s$/.test(cur.text) && !/^\s/.test(item.str)) cur.text += " ";
          cur.text += item.str;
          cur.xEnd = Math.max(cur.xEnd, x + item.width);
        }
      } else {
        cur = { x, y, h, xEnd: x + item.width, text: item.str };
        lines.push(cur);
      }
    }
    if (item.hasEOL) cur = null;
  }
  for (const line of lines) line.text = cleanText(line.text).replace(/\s+/g, " ").trim();
  return lines.filter(l => l.text);
}

function stripRunningHeads(pages) {
  const signature = text => text.toLowerCase().replace(/\d+/g, "#").replace(/\s+/g, " ").trim();
  const counts = new Map();
  for (const lines of pages) {
    const edge = new Set([...lines.slice(0, 2), ...lines.slice(-2)].map(l => signature(l.text)));
    for (const sig of edge) counts.set(sig, (counts.get(sig) || 0) + 1);
  }
  const threshold = Math.max(3, pages.length * 0.2);
  for (let p = 0; p < pages.length; p++) {
    const lines = pages[p];
    const edges = new Set([...lines.slice(0, 2), ...lines.slice(-2)]);
    pages[p] = lines.filter(l => !(edges.has(l) && (
      counts.get(signature(l.text)) >= threshold || /^(?:page\s+)?[\divxlc]{1,5}$/i.test(l.text))));
  }
}

const median = values => {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
};
const percentile = (values, p) => {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
};

function assembleParagraphs(pages) {
  const all = pages.flat();
  const bodyH = median(all.map(l => l.h)) || 10;
  const gaps = [];
  for (const lines of pages) for (let i = 1; i < lines.length; i++) {
    const g = lines[i - 1].y - lines[i].y;
    if (g > 0 && g < bodyH * 4) gaps.push(g);
  }
  const lineGap = median(gaps) || bodyH * 1.2;
  const paragraphs = [];
  let cur = null;
  const ends = text => /[.!?:…]["”’)\]]*$/.test(text);

  pages.forEach((lines, pageIndex) => {
    const left = percentile(lines.map(l => l.x), 0.15);
    const right = percentile(lines.map(l => l.xEnd), 0.85);
    lines.forEach((line, i) => {
      const heading = line.h > bodyH * 1.3 && line.text.length < 140;
      let fresh = !cur;
      if (cur) {
        const prev = i > 0 ? lines[i - 1] : null;
        if (heading !== cur.heading) fresh = true;
        else if (prev) {
          const gap = prev.y - line.y;
          if (gap < 0 || gap > lineGap * 1.45) fresh = true;
          else if (ends(prev.text) && prev.xEnd < right - bodyH * 3) fresh = true;
          else if (line.x > left + bodyH * 1.1 && ends(prev.text)) fresh = true;
        } else {
          // First line on a new page: continue a paragraph that did not finish.
          fresh = ends(cur.text) || heading || line.x > left + bodyH * 1.1;
        }
      }
      if (fresh) {
        if (cur) paragraphs.push(cur);
        cur = { text: line.text, page: pageIndex, heading };
      } else if (/[A-Za-z]-$/.test(cur.text) && /^[a-z]/.test(line.text)) {
        cur.text = cur.text.slice(0, -1) + line.text;
      } else {
        cur.text += " " + line.text;
      }
    });
  });
  if (cur) paragraphs.push(cur);
  return paragraphs;
}

async function pdfOutline(pdf) {
  const outline = await pdf.getOutline();
  if (!outline?.length) return [];
  const entries = [];
  for (const item of outline) {
    try {
      let dest = item.dest;
      if (typeof dest === "string") dest = await pdf.getDestination(dest);
      if (!Array.isArray(dest)) continue;
      const ref = dest[0];
      const page = typeof ref === "number" ? ref : await pdf.getPageIndex(ref);
      entries.push({ title: tidyBlock(item.title || "").replace(/\n/g, " "), page });
    } catch { /* skip unresolved entries */ }
  }
  return entries.sort((a, b) => a.page - b.page);
}

function pdfChapters(paragraphs, outline, pageCount) {
  const toBlock = p => p.heading ? { k: "h", lvl: 2, s: splitSentences(p.text) } : { k: "p", s: splitSentences(p.text) };
  if (outline.length >= 2) {
    const chapters = [];
    if (outline[0].page > 0) chapters.push({ title: "Opening Pages", start: 0, blocks: [] });
    for (const entry of outline) chapters.push({ title: entry.title || `Part ${chapters.length + 1}`, start: entry.page, blocks: [] });
    for (const p of paragraphs) {
      let target = chapters[0];
      for (const c of chapters) if (c.start <= p.page) target = c;
      target.blocks.push(toBlock(p));
    }
    return chapters.map(({ title, blocks }) => ({ title, blocks }));
  }
  const span = pageCount > 60 ? 12 : 8;
  const chapters = new Map();
  for (const p of paragraphs) {
    const index = Math.floor(p.page / span);
    if (!chapters.has(index)) {
      const from = index * span + 1, to = Math.min(pageCount, from + span - 1);
      chapters.set(index, { title: `Pages ${from}–${to}`, blocks: [] });
    }
    chapters.get(index).blocks.push(toBlock(p));
  }
  return [...chapters.values()];
}

// ---------------------------------------------------------------------------
// TXT
const CHAPTER_LINE = /^(?:(?:chapter|book|part|section|letter|act|canto|stave)\s+(?:[0-9]+|[ivxlcdm]+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|[a-z]+teen|twenty[a-z-]*|thirty[a-z-]*)\b.{0,80}|[IVXLC]{1,7}\.?|prologue|epilogue|preface|introduction)$/i;

function parseTxt(buffer, fileName) {
  let text;
  try { text = new TextDecoder("utf-8", { fatal: true }).decode(buffer); }
  catch { text = new TextDecoder("windows-1252").decode(buffer); }
  text = cleanText(text).replace(/\r\n?/g, "\n");

  // Project Gutenberg boilerplate.
  const start = text.match(/\*\*\*\s*START OF (?:THE|THIS) PROJECT GUTENBERG[^\n]*\n/i);
  if (start) text = text.slice(start.index + start[0].length);
  const end = text.match(/\*\*\*\s*END OF (?:THE|THIS) PROJECT GUTENBERG/i);
  if (end) text = text.slice(0, end.index);

  let paragraphs = text.split(/\n\s*\n/).map(p => p.trim()).filter(Boolean);
  const avg = paragraphs.reduce((a, p) => a + p.length, 0) / Math.max(1, paragraphs.length);
  if (paragraphs.length < 5 || avg > 4000) paragraphs = text.split(/\n/).map(p => p.trim()).filter(Boolean);

  const chapters = [];
  let current = { title: "Beginning", blocks: [] };
  let headings = 0;
  for (const raw of paragraphs) {
    const firstLine = raw.split("\n")[0].trim();
    const isHeading = firstLine.length < 90 && CHAPTER_LINE.test(firstLine);
    if (isHeading) {
      headings++;
      if (current.blocks.length) chapters.push(current);
      const rest = raw.split("\n").slice(1).join(" ").trim();
      const title = rest && rest.length < 90 ? `${firstLine}: ${rest}` : firstLine;
      current = { title, blocks: [{ k: "h", lvl: 2, s: [title] }] };
      if (rest && rest.length >= 90) current.blocks.push({ k: "p", s: splitSentences(rest) });
      continue;
    }
    // Hard-wrapped prose: join lines unless the paragraph looks like verse.
    const lines = raw.split("\n");
    const verse = lines.length > 1 && lines.every(l => l.trim().length < 55);
    const block = verse ? { k: "v", s: splitVerse(lines.map(l => l.trim()).join("\n")) } : { k: "p", s: splitSentences(raw.replace(/\n/g, " ")) };
    current.blocks.push(block);
  }
  if (current.blocks.length) chapters.push(current);

  if (headings < 2) {
    // No chapter headings: cut into readable sections of ~80 paragraphs.
    const blocks = chapters.flatMap(c => c.blocks);
    const out = [];
    for (let i = 0; i < blocks.length; i += 80) out.push({ title: `Section ${out.length + 1}`, blocks: blocks.slice(i, i + 80) });
    return { format: "txt", title: titleFromFilename(fileName), author: "", language: "en", cover: null, chapters: out, images: new Map() };
  }
  return { format: "txt", title: titleFromFilename(fileName), author: "", language: "en", cover: null, chapters, images: new Map() };
}

/** Downscale a cover to a light shelf thumbnail (also normalises odd formats). */
export async function makeThumbnail(blob, width = 420) {
  if (!blob) return null;
  try {
    const bitmap = await createImageBitmap(blob);
    const scale = Math.min(1, width / bitmap.width);
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(bitmap.width * scale);
    canvas.height = Math.round(bitmap.height * scale);
    canvas.getContext("2d").drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close();
    return await new Promise(resolve => canvas.toBlob(resolve, "image/jpeg", 0.88));
  } catch {
    return null;
  }
}
