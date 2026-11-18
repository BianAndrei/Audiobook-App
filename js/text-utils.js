// Text helpers shared by the parser, reader and narrator.

const INVISIBLE = /[­​‌‍⁠﻿]/g;
const ABBREVIATION = /(?:^|[\s(“"‘'])(?:Mr|Mrs|Ms|Messrs|Dr|St|Jr|Sr|Prof|Rev|Gen|Col|Capt|Lt|Sgt|Mt|Ft|vs|etc|viz|cf|al|No|Nos|Vol|Vols|Ch|pp|p|fig|Fig|ed|eds|Hon|Gov|Sen|Rep|Inc|Ltd|Co|Bros|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)\.$/;
const INITIAL = /(?:^|\s)[A-Z]\.$/;
const MAX_SENTENCE = 420;

/** Remove invisible formatting characters and normalise Unicode. */
export function cleanText(text) {
  return String(text).normalize("NFC").replace(INVISIBLE, "");
}

/** Collapse runs of whitespace but keep explicit line breaks (poetry, addresses). */
export function tidyBlock(text) {
  return cleanText(text)
    .replace(/[ \t\f\v\r ]+/g, " ")
    .split("\n").map(line => line.trim()).join("\n")
    .replace(/\n{2,}/g, "\n")
    .trim();
}

let segmenter = null;
function getSegmenter() {
  if (!segmenter && typeof Intl !== "undefined" && Intl.Segmenter) {
    segmenter = new Intl.Segmenter("en", { granularity: "sentence" });
  }
  return segmenter;
}

/** Split a block into sentences that keep their own punctuation (for natural intonation). */
export function splitSentences(text) {
  const clean = tidyBlock(text);
  if (!clean) return [];
  const seg = getSegmenter();
  let raw;
  if (seg) raw = Array.from(seg.segment(clean), part => part.segment);
  else raw = clean.match(/[^.!?…]+(?:[.!?…]+["”’')\]]*\s*|$)/g) || [clean];

  // Merge splits made after abbreviations / initials ("Mr. Darcy", "J. R. R. Tolkien").
  const merged = [];
  for (const piece of raw) {
    const prev = merged[merged.length - 1];
    if (prev !== undefined && (ABBREVIATION.test(prev.trimEnd()) || INITIAL.test(prev.trimEnd()))) {
      merged[merged.length - 1] = prev + piece;
    } else {
      merged.push(piece);
    }
  }

  // Attach tiny fragments (closing quotes, stray punctuation) to the previous sentence.
  const result = [];
  for (const piece of merged) {
    const trimmed = piece.trim();
    if (!trimmed) continue;
    if (result.length && !/[\p{L}\p{N}]/u.test(trimmed)) {
      result[result.length - 1] += " " + trimmed;
      continue;
    }
    result.push(...splitLong(trimmed));
  }
  return result;
}

/** Keep any one narrated unit short enough for fast synthesis and smooth highlighting. */
function splitLong(sentence) {
  if (sentence.length <= MAX_SENTENCE) return [sentence];
  const out = [];
  let rest = sentence;
  while (rest.length > MAX_SENTENCE) {
    const window = rest.slice(0, MAX_SENTENCE);
    let cut = -1;
    for (const mark of ["; ", ": ", " — ", "—", ", ", " "]) {
      const at = window.lastIndexOf(mark);
      if (at > MAX_SENTENCE * 0.4) { cut = at + mark.length; break; }
    }
    if (cut <= 0) cut = MAX_SENTENCE;
    out.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) out.push(rest);
  return out;
}

export function countWords(text) {
  const m = String(text).match(/[\p{L}\p{N}]+(?:['’-][\p{L}\p{N}]+)*/gu);
  return m ? m.length : 0;
}

/** True when a sentence has something a voice can actually say. */
export function isSpeakable(text) {
  return /[\p{L}\p{N}]/u.test(text);
}

/** Light clean-up before sending text to Kokoro. */
export function speechText(text) {
  return cleanText(text)
    .replace(/\[(?:\d+|[a-z])\]/g, "")       // footnote markers [12]
    .replace(/\s*\n\s*/g, ", ")              // verse line breaks become gentle pauses
    .replace(/[*_#~^|<>{}]+/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim()
    .slice(0, 1900);
}

export function titleCase(text) {
  const small = new Set(["a", "an", "and", "as", "at", "but", "by", "for", "in", "of", "on", "or", "the", "to", "with"]);
  return text.toLowerCase().split(/\s+/).map((word, i) =>
    i > 0 && small.has(word) ? word : word.charAt(0).toUpperCase() + word.slice(1)).join(" ");
}

/** "pdfcoffee.com_counterfeit-gods-timothy-keller-pdf-free.pdf" -> "Counterfeit Gods Timothy Keller" */
export function titleFromFilename(name) {
  let base = String(name).replace(/\.[a-z0-9]{2,5}$/i, "");
  base = base.replace(/^[\w-]+\.(?:com|org|net|io|ru|info)[_\s-]+/i, "");
  base = base.replace(/[_]+|(?<=\w)-(?=\w)/g, " ").replace(/\s+/g, " ").trim();
  base = base.replace(/\b(?:pdf|epub|txt|free|ebook|download)\b/gi, "").replace(/\s+/g, " ").trim();
  return titleCase(base || "Untitled");
}

export function hashString(text) {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export function formatDuration(seconds) {
  seconds = Math.max(0, Math.round(seconds));
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (h) return `${h} h ${m} min`;
  if (m) return `${m} min`;
  return seconds ? "< 1 min" : "0 min";
}

export function dayKey(date = new Date()) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}
