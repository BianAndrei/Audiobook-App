// Kokoro narration engine.
//
// - Sentences are synthesised through the local server proxy (/api/tts/speech -> Kokoro :8880).
// - Up to PREFETCH sentences ahead are requested in the background; every request in a
//   session shares one AbortController, so skipping/jumping cancels stale work instantly.
// - Decoded AudioBuffers are scheduled back-to-back on the Web Audio clock: no gaps, and
//   no object URLs to leak. Played buffers are released as soon as each source ends.
// - Pause suspends the AudioContext (resumes mid-sentence); a jump starts a new session.

import { speechText, isSpeakable, countWords } from "./text-utils.js";

const PREFETCH = 3;
const SCHEDULE_AHEAD = 2;     // sources queued on the audio clock at once
const ENDPOINT = "/api/tts";

export const CURATED_VOICES = [
  { id: "bf_emma", name: "Emma", accent: "British", gender: "Female" },
  { id: "bm_george", name: "George", accent: "British", gender: "Male" },
  { id: "bm_lewis", name: "Lewis", accent: "British", gender: "Male" },
  { id: "af_heart", name: "Heart", accent: "American", gender: "Female" },
  { id: "af_bella", name: "Bella", accent: "American", gender: "Female" },
  { id: "am_adam", name: "Adam", accent: "American", gender: "Male" },
  { id: "am_michael", name: "Michael", accent: "American", gender: "Male" },
];

export function describeVoice(id) {
  const curated = CURATED_VOICES.find(v => v.id === id);
  if (curated) return curated;
  const [prefix, rest = id] = id.split("_");
  const accent = { a: "American", b: "British" }[prefix?.[0]] || "Other";
  const gender = { f: "Female", m: "Male" }[prefix?.[1]] || "";
  const name = rest.split("_")[0];
  return { id, name: name.charAt(0).toUpperCase() + name.slice(1), accent, gender };
}

export class TTSEngine extends EventTarget {
  /**
   * @param {object} source  { text(loc) -> string|null, next(loc) -> loc|null, key(loc) -> string }
   */
  constructor(source) {
    super();
    this.source = source;
    this.voice = "bf_emma";
    this.speed = 1;
    this.ctx = null;
    this.session = null;
    this.state = "idle"; // idle | loading | playing | paused
    this.current = null; // loc currently being spoken (or where playback will start)
  }

  // ---- public API --------------------------------------------------------
  async listVoices() {
    const res = await fetch(`${ENDPOINT}/voices`);
    if (!res.ok) throw new Error("voice list unavailable");
    const data = await res.json();
    const ids = (data.voices || []).map(v => (typeof v === "string" ? v : v.id || v.name)).filter(Boolean);
    return ids.filter(id => /^[ab][fm]_/.test(id));
  }

  /** Load the model + voice pack ahead of time so the first sentence starts quickly. */
  async warmUp(voice = this.voice) {
    if (this.warmed === voice) return;
    this.warmed = voice;
    try {
      await fetch(`${ENDPOINT}/speech`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ input: "Ready.", voice, speed: this.speed, response_format: "wav" }),
      });
    } catch { this.warmed = null; }
  }

  /** How far through the currently audible sentence playback is (0–1), or null. */
  currentProgress() {
    const session = this.session;
    if (!session || !this.ctx || this.state !== "playing") return null;
    const now = this.ctx.currentTime;
    const entry = session.timeline.find(item => now >= item.start && now < item.end);
    if (!entry) return null;
    return { loc: entry.loc, elapsed: now - entry.start, duration: entry.end - entry.start };
  }

  get isActive() { return this.state === "playing" || this.state === "loading" || this.state === "paused"; }

  /** Start (or resume) narration. Must be called from a user gesture the first time. */
  async play(loc = this.current) {
    this.ensureContext();
    if (this.state === "paused" && this.session && (!loc || this.sameLoc(loc, this.current))) {
      await this.ctx.resume();
      this.setState(this.session.started ? "playing" : "loading");
      return;
    }
    if (!loc) return;
    this.startSession(loc);
  }

  pause() {
    if (!this.session || this.state === "paused") return;
    this.ctx?.suspend();
    this.setState("paused");
  }

  toggle(loc) {
    if (this.state === "playing" || this.state === "loading") this.pause();
    else this.play(loc);
  }

  stop() {
    this.endSession();
    this.setState("idle");
  }

  /** Jump to a sentence. Keeps playing if we were playing, otherwise just moves the cursor. */
  jump(loc, { autoplay = false } = {}) {
    const wasPlaying = this.state === "playing" || this.state === "loading";
    this.current = loc;
    if (wasPlaying || autoplay) {
      this.ensureContext();
      this.startSession(loc);
    } else {
      this.endSession();
      this.setState("idle");
    }
  }

  setVoice(voice) {
    if (voice === this.voice) return;
    this.voice = voice;
    this.restartIfPlaying();
  }

  setSpeed(speed) {
    if (Math.abs(speed - this.speed) < 0.001) return;
    this.speed = speed;
    this.restartIfPlaying();
  }

  /** Speak a short sample with a voice, independent of the book position. */
  async preview(voice, text) {
    this.ensureContext();
    const wasPlaying = this.state === "playing" || this.state === "loading";
    if (wasPlaying) this.pause();
    await this.ctx.resume();
    this.previewSource?.stop();
    const controller = new AbortController();
    const buffer = await this.synthesise(text, voice, this.speed, controller.signal);
    const node = this.ctx.createBufferSource();
    node.buffer = buffer;
    node.connect(this.ctx.destination);
    this.previewSource = node;
    await new Promise(resolve => { node.onended = resolve; node.start(); });
    this.previewSource = null;
    if (this.state === "paused" && this.session) this.ctx.suspend();
  }

  // ---- internals ---------------------------------------------------------
  ensureContext() {
    if (!this.ctx) {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      this.ctx = new Ctx({ latencyHint: "playback" });
    }
    // Autoplay policies: resume() inside the click handler unlocks audio.
    if (this.ctx.state !== "running" && this.state !== "paused") this.ctx.resume().catch(() => {});
  }

  sameLoc(a, b) { return a && b && this.source.key(a) === this.source.key(b); }

  setState(state) {
    if (this.state === state) return;
    this.state = state;
    this.dispatchEvent(new CustomEvent("state", { detail: { state } }));
  }

  emit(type, detail) { this.dispatchEvent(new CustomEvent(type, { detail })); }

  restartIfPlaying() {
    if (this.state === "playing" || this.state === "loading") this.startSession(this.current);
    else if (this.state === "paused") { this.endSession(); this.setState("idle"); }
  }

  endSession() {
    const old = this.session;
    if (!old) return;
    this.session = null;
    old.controller.abort();
    cancelAnimationFrame(old.frame);
    for (const node of old.sources) { node.onended = null; try { node.stop(); } catch { /* not started */ } node.disconnect(); }
    old.sources.clear();
    old.pending.clear();
    old.wake?.();
  }

  async synthesise(text, voice, speed, signal) {
    // If Kokoro is restarting (502 / connection refused), keep retrying for ~30 s before giving up.
    const backoff = [400, 800, 1500, 2500, 4000, 6000, 8000, 8000];
    let lastError;
    for (let attempt = 0; attempt <= backoff.length; attempt++) {
      try {
        const res = await fetch(`${ENDPOINT}/speech`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ input: text, voice, speed, response_format: "wav" }),
          signal,
        });
        if (!res.ok) {
          let message = `Kokoro returned ${res.status}`;
          try { message = (await res.json()).error || message; } catch { /* not json */ }
          const error = new Error(message);
          error.retryable = res.status >= 500;
          throw error;
        }
        const data = await res.arrayBuffer();
        return await this.ctx.decodeAudioData(data);
      } catch (error) {
        if (signal.aborted) throw error;
        lastError = error;
        const retryable = error.retryable !== false && (error.retryable || error instanceof TypeError || attempt === 0);
        if (!retryable || attempt === backoff.length) break;
        if (attempt === 1) this.emit("waiting", {});
        await new Promise((resolve, reject) => {
          const timer = setTimeout(resolve, backoff[attempt]);
          signal.addEventListener("abort", () => { clearTimeout(timer); reject(signal.reason); }, { once: true });
        });
      }
    }
    throw lastError;
  }

  startSession(loc) {
    this.endSession();
    const ctx = this.ctx;
    if (ctx.state === "suspended") ctx.resume().catch(() => {});
    const session = {
      controller: new AbortController(), pending: new Map(), sources: new Set(), chain: Promise.resolve(),
      timeline: [], frame: 0, started: false, wake: null,
      voice: this.voice, speed: this.speed,
    };
    this.session = session;
    this.current = loc;
    this.setState("loading");
    this.emit("sentence", { loc, scheduled: false });
    this.run(session, loc).catch(error => {
      if (this.session !== session || session.controller.signal.aborted) return;
      this.endSession();
      this.setState("idle");
      this.emit("error", { message: error.message || String(error) });
    });
  }

  request(session, loc) {
    const key = this.source.key(loc);
    if (session.pending.has(key)) return;
    const raw = this.source.text(loc);
    const text = raw && isSpeakable(raw) ? speechText(raw) : "";
    // Requests run one after another: Kokoro shares its compute between concurrent requests,
    // so a serial pipeline delivers the sentence we need *next* soonest while still staying
    // PREFETCH sentences ahead of playback.
    const promise = text
      ? session.chain.then(() => this.synthesise(text, session.voice, session.speed, session.controller.signal))
          .then(buffer => ({ buffer, words: countWords(text) }))
      : Promise.resolve({ buffer: null, words: 0 });
    promise.catch(() => {}); // handled when awaited
    session.chain = promise.catch(() => {});
    session.pending.set(key, promise);
  }

  prefetchFrom(session, loc) {
    let cursor = loc;
    for (let i = 0; i <= PREFETCH && cursor; i++) {
      this.request(session, cursor);
      cursor = this.source.next(cursor);
    }
  }

  async run(session, startLoc) {
    const ctx = this.ctx;
    let loc = startLoc;
    let clock = 0;

    const tick = () => {
      if (this.session !== session) return;
      const now = ctx.currentTime;
      const active = session.timeline.find(item => now >= item.start && now < item.end);
      if (active && !this.sameLoc(active.loc, this.current)) {
        this.current = active.loc;
        this.emit("sentence", { loc: active.loc, scheduled: true });
      }
      session.frame = requestAnimationFrame(tick);
    };
    session.frame = requestAnimationFrame(tick);

    while (loc && this.session === session) {
      this.prefetchFrom(session, loc);
      const key = this.source.key(loc);
      const { buffer, words } = await session.pending.get(key);
      session.pending.delete(key);
      if (this.session !== session) return;

      if (buffer) {
        const node = ctx.createBufferSource();
        node.buffer = buffer;
        node.connect(ctx.destination);
        const start = Math.max(clock, ctx.currentTime + 0.05);
        clock = start + buffer.duration;
        const entry = { loc, start, end: clock };
        session.timeline.push(entry);
        session.sources.add(node);
        node.onended = () => {
          session.sources.delete(node);
          node.disconnect();           // release the decoded audio for GC
          session.timeline = session.timeline.filter(e => e !== entry);
          session.wake?.();
        };
        node.start(start);
        if (!session.started) {
          session.started = true;
          if (this.state === "loading") this.setState("playing");
        }
        this.emit("measure", { words, seconds: buffer.duration, speed: session.speed });
      }

      loc = this.source.next(loc);
      // Keep at most SCHEDULE_AHEAD sources queued; wait for the oldest to finish.
      while (this.session === session && session.sources.size >= SCHEDULE_AHEAD) {
        await new Promise(resolve => { session.wake = resolve; });
        session.wake = null;
      }
    }
    // Drain the remaining audio, then finish.
    while (this.session === session && session.sources.size) {
      await new Promise(resolve => { session.wake = resolve; });
      session.wake = null;
    }
    if (this.session === session) {
      this.endSession();
      this.setState("idle");
      this.emit("ended", {});
    }
  }
}
