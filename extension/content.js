const MAX_PARALLEL_TTS = 5;

// Caption lines are merged into segments of this many lines, and each segment
// becomes ONE TTS request. One continuous utterance per 5 lines removes the
// per-line silence and gives the model enough context to read naturally.
const GROUP_SIZE = 5;

const state = {
  active: false,
  settings: null,
  chunks: [],            // raw translated caption lines { id, start, end, text, translatedText }
  segments: [],          // playback/TTS units { id, start, end, text } (5 lines merged)
  audioUrls: new Map(),  // segment id -> blob URL (generated, cached — never redone)
  failed: new Set(),     // segment ids that failed TTS (or have no speech)
  inFlight: new Set(),   // segment ids whose TTS request is currently running
  priorityIndex: 0,      // generation starts here, runs to the end, then wraps to 0
  activeJobs: 0,
  dubAudio: null,
  currentIndex: -1,
  pausedForBuffer: false,
  unlockWaiting: false,
  video: null,
};

// Merge consecutive caption lines into segments. Each segment spans from the
// first line's start to the last line's end; its text is the non-empty
// translations joined into one utterance (skipped annotations leave gaps).
function buildSegments(chunks, groupSize) {
  const segments = [];
  for (let i = 0; i < chunks.length; i += groupSize) {
    const group = chunks.slice(i, i + groupSize);
    const text = group
      .map((c) => (c.translatedText || "").trim())
      .filter(Boolean)
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
    segments.push({
      id: segments.length,
      start: group[0].start,
      end: group[group.length - 1].end,
      text,
    });
  }
  return segments;
}

// ---------- status / overlay ----------

let overlay;
let lastStatusText = "";
function status(text) {
  console.log("[dubber]", text);
  lastStatusText = text;
  if (!overlay) {
    overlay = document.createElement("div");
    overlay.style.cssText =
      "position:fixed;z-index:99999;bottom:16px;left:16px;max-width:340px;" +
      "background:rgba(0,0,0,.8);color:#fff;font:13px system-ui;padding:8px 12px;" +
      "border-radius:8px;pointer-events:none;white-space:pre-wrap;";
    document.body.appendChild(overlay);
  }
  overlay.textContent = `Dubber: ${text}`;
  overlay.style.display = state.active || text ? "block" : "none";
  try {
    chrome.runtime.sendMessage({ type: "DUB_STATUS", text });
  } catch {}
}

// ---------- captions ----------

// Captions are fetched on the backend with yt-dlp (via the service worker),
// which handles YouTube's PoToken/signature gating that makes direct in-page
// timedtext requests 404.
async function fetchCaptionChunks(settings) {
  const targetLang = settings?.targetLangCode || null;

  // 1) Fast path: scrape captions straight from the page's own YouTube session
  //    (like other transcript extensions). No backend, no IP rate-limit/429.
  const videoId = new URLSearchParams(location.search).get("v");
  if (videoId) {
    const scraped = await chrome.runtime
      .sendMessage({ type: "BK_SCRAPE_CAPTIONS", videoId, targetLang })
      .catch(() => null);
    if (scraped && !scraped.error && (scraped.chunks || []).length) {
      return {
        chunks: scraped.chunks,
        alreadyTarget: Boolean(scraped.alreadyTarget),
        lang: scraped.lang || null,
      };
    }
    const reason = scraped?.error || "no response";
    console.warn("[dubber] in-page caption scrape unavailable, using yt-dlp:", reason);
    status(`page scrape failed (${reason}); trying yt-dlp…`);
  }

  // 2) Fallback: yt-dlp on the backend (handles odd cases the page can't).
  const data = await chrome.runtime.sendMessage({
    type: "BK_CAPTIONS",
    videoUrl: location.href,
    targetLang,
  });
  if (!data || data.error) {
    throw new Error(data?.error || "Caption worker returned no response.");
  }
  // alreadyTarget: the video already had captions in the target language, so we
  // can dub them as-is and skip the Gemini translation pass.
  return {
    chunks: data.chunks || [],
    alreadyTarget: Boolean(data.alreadyTarget),
    lang: data.lang || null,
  };
}

// ---------- pasted SRT / VTT fallback ----------

const TS_RE =
  /(\d{1,2}):(\d{2}):(\d{2})[,.](\d{1,3})\s*-->\s*(\d{1,2}):(\d{2}):(\d{2})[,.](\d{1,3})/;

function tsToSeconds(h, m, s, ms) {
  return (
    Number(h) * 3600 +
    Number(m) * 60 +
    Number(s) +
    Number(ms.padEnd(3, "0")) / 1000
  );
}

function parseSrt(raw) {
  const text = raw.replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim();
  const blocks = text.split(/\n\s*\n/);
  const chunks = [];
  for (const block of blocks) {
    const m = block.match(TS_RE);
    if (!m) continue;
    const start = tsToSeconds(m[1], m[2], m[3], m[4]);
    const end = tsToSeconds(m[5], m[6], m[7], m[8]);
    const after = block.slice(block.indexOf(m[0]) + m[0].length);
    const cue = after
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)
      .join(" ")
      .replace(/<[^>]+>/g, "")
      .replace(/\s+/g, " ")
      .trim();
    if (cue) chunks.push({ id: chunks.length, start, end, text: cue });
  }
  return chunks;
}

// ---------- translation ----------

async function translateAll(chunks, settings) {
  const data = await chrome.runtime.sendMessage({
    type: "BK_TRANSLATE",
    chunks: chunks.map((c) => ({ id: c.id, text: c.text })),
    sourceLang: "auto",
    targetLang: settings.targetLangName,
  });
  if (!data || data.error) {
    throw new Error(data?.error || "Translation worker returned no response.");
  }
  const byId = new Map(data.chunks.map((c) => [c.id, c.translatedText]));
  return chunks.map((c) => ({ ...c, translatedText: (byId.get(c.id) || "").trim() }));
}

// ---------- TTS queue ----------

function base64ToBlobUrl(b64, mime) {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return URL.createObjectURL(new Blob([bytes], { type: mime || "audio/wav" }));
}

async function ttsSegment(segment, settings) {
  const data = await chrome.runtime.sendMessage({
    type: "BK_TTS",
    // Trailing "..." gives Supertonic a short closing pause so the last word
    // isn't clipped and segments don't run into each other.
    text: `${segment.text}...`,
    lang: settings.targetLangCode,
    voice: settings.voice,
    speed: settings.speed,
    steps: settings.steps,
  });
  if (!data || data.error) {
    throw new Error(data?.error || "TTS worker returned no response.");
  }
  return base64ToBlobUrl(data.b64, data.mime);
}

// Pick the highest-priority segment still needing TTS. Scan order is rotated to
// start at `priorityIndex` (the cursor's segment), run to the end, then wrap to
// the beginning — so a seek makes generation resume right at the playhead.
// Already-generated (audioUrls), failed/no-speech, and in-flight segments are
// skipped, so nothing is ever reworked.
function pickNextSegment() {
  const n = state.segments.length;
  if (!n) return -1;
  const start = Math.min(Math.max(0, state.priorityIndex), n - 1);
  for (let k = 0; k < n; k++) {
    const i = (start + k) % n;
    const seg = state.segments[i];
    if (!seg.text) continue;
    if (state.audioUrls.has(seg.id)) continue;
    if (state.failed.has(seg.id)) continue;
    if (state.inFlight.has(seg.id)) continue;
    return i;
  }
  return -1;
}

function pumpTtsQueue() {
  while (state.active && state.activeJobs < MAX_PARALLEL_TTS) {
    const idx = pickNextSegment();
    if (idx < 0) break; // nothing left to generate
    const segment = state.segments[idx];
    state.inFlight.add(segment.id);
    state.activeJobs++;
    ttsSegment(segment, state.settings)
      .then((url) => state.audioUrls.set(segment.id, url))
      .catch((err) => {
        console.error("[dubber] TTS failed", segment.id, err);
        state.failed.add(segment.id);
      })
      .finally(() => {
        state.inFlight.delete(segment.id);
        state.activeJobs--;
        reportProgress();
        tryResumeBuffer();
        pumpTtsQueue();
      });
  }
}

function reportProgress() {
  if (!state.active) return;
  const ready = state.audioUrls.size;
  const total = state.segments.length;
  status(`audio ready ${ready}/${total}${state.failed.size ? ` (${state.failed.size} failed)` : ""}`);
}

// ---------- playback ----------

function indexForTime(t) {
  let idx = -1;
  for (let i = 0; i < state.segments.length; i++) {
    if (state.segments[i].start <= t) idx = i;
    else break;
  }
  return idx;
}

function stopAudio() {
  if (state.dubAudio) {
    state.dubAudio.pause();
    state.dubAudio.src = "";
    state.dubAudio = null;
  }
}

function onPlayErr(err) {
  if (err && err.name === "NotAllowedError") {
    promptUnlock();
  } else {
    console.error("[dubber] audio play failed", err);
    status(`audio play failed: ${err?.message || err}`);
  }
}

// Start a segment's dub audio anchored to the playhead: `offset` is how far the
// cursor (in video time) already is into the cue. Playback rate = video rate ×
// the segment's fit rate, so the dub is compressed to land inside its window;
// the audio start position is the offset mapped through that same fit rate.
function playIndex(idx, offset = 0) {
  stopAudio();
  state.currentIndex = idx;
  const segment = state.segments[idx];
  const url = state.audioUrls.get(segment.id);
  if (!url) return;

  const audio = new Audio(url);
  audio.preservesPitch = true;
  audio.mozPreservesPitch = true;
  audio.webkitPreservesPitch = true;
  state.dubAudio = audio;

  const begin = () => {
    if (state.dubAudio !== audio) return; // superseded while metadata loaded
    const fit = fitRateFor(segment, audio);
    audio.playbackRate = (state.video.playbackRate || 1) * fit;
    if (offset > 0) {
      const apos = offset * fit; // video offset → compressed audio position
      const dur = Number.isFinite(audio.duration) ? audio.duration : apos + 1;
      if (apos >= dur) return; // this cue's audio is already over
      audio.currentTime = apos;
    }
    if (!state.video.paused) audio.play().catch(onPlayErr);
  };

  // We need the duration to compute the fit rate, so always wait for metadata.
  if (!Number.isFinite(audio.duration)) {
    audio.addEventListener("loadedmetadata", begin, { once: true });
  } else {
    begin();
  }
}

// Browsers block our injected Audio element from auto-playing with sound when
// the page never received a user gesture (YouTube autoplays the video itself).
// Catch that case once and replay from the current spot after a click.
function promptUnlock() {
  if (state.unlockWaiting) return;
  state.unlockWaiting = true;
  status("Click anywhere on the video once to enable dubbed audio.");
  const onGesture = () => {
    document.removeEventListener("pointerdown", onGesture, true);
    state.unlockWaiting = false;
    state.currentIndex = -1;
    syncAudio();
  };
  document.addEventListener("pointerdown", onGesture, true);
}

// How far the dub audio may drift from the cursor before we nudge it back.
const DRIFT_TOLERANCE = 0.12; // seconds

// Auto-fit: each dub is generated at natural speed (≈1×), then sped up just
// enough to fit inside its original caption window. The rate is
// (generated audio duration) / (original window), clamped so we never slow
// below natural and never get unintelligibly fast. Pitch is preserved so the
// voice doesn't turn chipmunky. Cached per segment once metadata is known.
const MIN_FIT_RATE = 1.0;
const MAX_FIT_RATE = 1.6;

function fitRateFor(segment, audio) {
  if (segment.fitRate) return segment.fitRate;
  if (!audio || !Number.isFinite(audio.duration) || audio.duration <= 0) return 1;
  const windowDur = Math.max(0.1, segment.end - segment.start);
  const raw = audio.duration / windowDur;
  segment.fitRate = Math.min(MAX_FIT_RATE, Math.max(MIN_FIT_RATE, raw));
  return segment.fitRate;
}

// The core sync step: keep the playing dub audio anchored to the video's
// current time (audioTime = videoTime - chunk.start). Driven by both a rAF
// loop (tight, foreground) and `timeupdate` (covers background throttling).
function syncAudio() {
  if (!state.active || !state.video) return;
  const t = state.video.currentTime;
  const idx = indexForTime(t);

  if (idx < 0) {
    if (state.currentIndex !== -1) {
      stopAudio();
      state.currentIndex = -1;
    }
    return;
  }

  const segment = state.segments[idx];

  // Moved into a different cue — switch the audio (anchored at the offset).
  if (idx !== state.currentIndex) {
    // Let an overrunning dub finish its tail before advancing, so the last word
    // is never clipped. Only when moving FORWARD by normal playback — a seek
    // clears currentIndex to -1 and stops the audio first, so this won't fire.
    if (idx > state.currentIndex && state.currentIndex >= 0) {
      const prev = state.dubAudio;
      if (prev && !prev.ended) {
        if (state.video.paused) return; // hold position; resume handles it
        if (prev.paused) prev.play().catch(onPlayErr);
        const prevSeg = state.segments[state.currentIndex];
        prev.playbackRate =
          (state.video.playbackRate || 1) * (prevSeg ? fitRateFor(prevSeg, prev) : 1);
        return; // wait for the tail; rAF re-checks and advances once it ends
      }
    }
    if (state.audioUrls.has(segment.id)) {
      playIndex(idx, Math.max(0, t - segment.start));
    } else if (state.failed.has(segment.id)) {
      stopAudio();
      state.currentIndex = idx; // nothing to play, move on
    } else if (state.settings.pauseToSync && !state.pausedForBuffer) {
      state.pausedForBuffer = true;
      state.video.pause();
      status(`buffering segment ${idx + 1}/${state.segments.length}…`);
    }
    return;
  }

  // Same cue — correct drift, match rate, and resume if the video is playing.
  const audio = state.dubAudio;
  if (!audio || !Number.isFinite(audio.duration)) return;
  const fit = fitRateFor(segment, audio);
  const target = (t - segment.start) * fit; // video offset → compressed audio time
  if (target > audio.duration) return; // dub for this cue has ended; stay silent

  const rate = (state.video.playbackRate || 1) * fit;
  if (audio.playbackRate !== rate) audio.playbackRate = rate;
  if (Math.abs(audio.currentTime - target) > DRIFT_TOLERANCE) {
    audio.currentTime = Math.min(target, audio.duration);
  }
  if (!state.video.paused && audio.paused && !audio.ended) {
    audio.play().catch(onPlayErr);
  }
}

// Thin wrappers so existing call sites and listeners keep working.
function onTimeUpdate() {
  syncAudio();
}

let syncRafId = null;
function syncLoop() {
  if (!state.active) {
    syncRafId = null;
    return;
  }
  syncAudio();
  syncRafId = requestAnimationFrame(syncLoop);
}
function startSyncLoop() {
  if (syncRafId == null) syncRafId = requestAnimationFrame(syncLoop);
}
function stopSyncLoop() {
  if (syncRafId != null) {
    cancelAnimationFrame(syncRafId);
    syncRafId = null;
  }
}

function tryResumeBuffer() {
  if (!state.pausedForBuffer || !state.active) return;
  const idx = indexForTime(state.video.currentTime);
  if (idx < 0) return;
  const segment = state.segments[idx];
  if (state.audioUrls.has(segment.id) || state.failed.has(segment.id)) {
    state.pausedForBuffer = false;
    state.video.play().catch(() => {});
  }
}

function onVideoPause() {
  if (state.pausedForBuffer) return; // we paused it; leave dub audio alone
  if (state.dubAudio && !state.dubAudio.ended) state.dubAudio.pause();
}
function onVideoPlay() {
  syncAudio(); // realign and resume the dub at the current cursor position
}
function onVideoSeeking() {
  stopAudio(); // drop stale audio the instant a scrub/seek begins
  state.currentIndex = -1;
}
function onVideoSeeked() {
  state.pausedForBuffer = false;
  state.currentIndex = -1;
  // Reprioritize TTS generation around the new cursor: the picker will now
  // start at this segment and run to the end, then wrap. Anything already
  // generated stays cached and is skipped.
  const idx = indexForTime(state.video.currentTime);
  state.priorityIndex = idx < 0 ? 0 : idx;
  pumpTtsQueue();
  syncAudio(); // re-anchor playback immediately to the new cursor position
}
function onRateChange() {
  const audio = state.dubAudio;
  if (!audio) return;
  const seg = state.segments[state.currentIndex];
  audio.playbackRate = (state.video.playbackRate || 1) * (seg ? fitRateFor(seg, audio) : 1);
}

function attachVideoListeners() {
  const v = state.video;
  v.addEventListener("timeupdate", onTimeUpdate);
  v.addEventListener("pause", onVideoPause);
  v.addEventListener("play", onVideoPlay);
  v.addEventListener("seeking", onVideoSeeking);
  v.addEventListener("seeked", onVideoSeeked);
  v.addEventListener("ratechange", onRateChange);
}
function detachVideoListeners() {
  const v = state.video;
  if (!v) return;
  v.removeEventListener("timeupdate", onTimeUpdate);
  v.removeEventListener("pause", onVideoPause);
  v.removeEventListener("play", onVideoPlay);
  v.removeEventListener("seeking", onVideoSeeking);
  v.removeEventListener("seeked", onVideoSeeked);
  v.removeEventListener("ratechange", onRateChange);
}

// ---------- lifecycle ----------

async function startDubbing(settings) {
  if (state.active) stopDubbing();
  state.video = document.querySelector("video");
  if (!state.video) throw new Error("No video element found on this page.");

  state.settings = settings;
  state.active = true;
  state.chunks = [];
  state.segments = [];
  state.audioUrls.clear();
  state.failed.clear();
  state.inFlight.clear();
  state.priorityIndex = 0;
  state.activeJobs = 0;
  state.currentIndex = -1;
  state.pausedForBuffer = false;
  state.unlockWaiting = false;

  let captionChunks;
  let alreadyTarget = false; // captions already in the target language?
  if (settings.srt && settings.srt.trim()) {
    status("parsing pasted SRT…");
    captionChunks = parseSrt(settings.srt);
    if (!captionChunks.length) {
      throw new Error("Couldn't parse any timed cues from the pasted SRT.");
    }
  } else {
    status("fetching captions…");
    const cap = await fetchCaptionChunks(settings);
    captionChunks = cap.chunks;
    alreadyTarget = cap.alreadyTarget;
    if (!captionChunks.length) throw new Error("This video has no captions. Paste an SRT instead.");
  }

  if (alreadyTarget) {
    // Video already has target-language captions — dub them directly, no translation.
    status(`using ${settings.targetLangName} captions (${captionChunks.length} lines)…`);
    state.chunks = captionChunks.map((c) => ({ ...c, translatedText: c.text }));
  } else {
    status(`translating ${captionChunks.length} lines…`);
    state.chunks = await translateAll(captionChunks, settings);
  }
  state.segments = buildSegments(state.chunks, GROUP_SIZE);
  // No-speech segments (annotations only) get no TTS — mark them done/silent up
  // front so the picker skips them and the sync loop never waits on them.
  for (const seg of state.segments) if (!seg.text) state.failed.add(seg.id);

  // Begin generating at the segment under the cursor (video may not be at 0).
  const startIdx = indexForTime(state.video.currentTime);
  state.priorityIndex = startIdx < 0 ? 0 : startIdx;

  state.video.muted = true;
  attachVideoListeners();
  reportProgress();
  pumpTtsQueue();
  startSyncLoop();
  syncAudio(); // kick off if playback is already past the first cue
  syncDubButton();
}

function stopDubbing() {
  state.active = false;
  stopSyncLoop();
  detachVideoListeners();
  stopAudio();
  if (state.video) state.video.muted = false;
  for (const url of state.audioUrls.values()) URL.revokeObjectURL(url);
  state.audioUrls.clear();
  state.failed.clear();
  state.inFlight.clear();
  state.chunks = [];
  state.segments = [];
  state.priorityIndex = 0;
  state.pausedForBuffer = false;
  state.unlockWaiting = false;
  state.currentIndex = -1;
  if (overlay) overlay.style.display = "none";
  syncDubButton();
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "START_DUB") {
    startDubbing(message.settings)
      .then(() => sendResponse({ ok: true }))
      .catch((err) => {
        status(`error: ${err.message}`);
        stopDubbing();
        sendResponse({ error: err.message });
      });
    return true; // async response
  }
  if (message?.type === "STOP_DUB") {
    stopDubbing();
    sendResponse({ ok: true });
    return false;
  }
  if (message?.type === "GET_STATE") {
    sendResponse({
      active: state.active,
      text: lastStatusText,
      ready: state.audioUrls.size,
      total: state.segments.length,
    });
    return false;
  }
});

// ---------- in-page launch button ----------

const SETTING_DEFAULTS = {
  targetLang: "ar|Arabic",
  targetLangCode: "ar",
  targetLangName: "Arabic",
  voice: "M1",
  speed: 1.0,
  steps: 8,
  pauseToSync: true,
};

// Mirror the choices offered in popup.html so both UIs stay in sync.
const LANG_OPTIONS = [
  ["ar|Arabic", "Arabic"],
  ["en|English", "English"],
  ["es|Spanish", "Spanish"],
  ["fr|French", "French"],
  ["de|German", "German"],
  ["it|Italian", "Italian"],
  ["pt|Portuguese", "Portuguese"],
  ["ru|Russian", "Russian"],
  ["hi|Hindi", "Hindi"],
  ["ja|Japanese", "Japanese"],
  ["ko|Korean", "Korean"],
  ["tr|Turkish", "Turkish"],
  ["id|Indonesian", "Indonesian"],
  ["vi|Vietnamese", "Vietnamese"],
];
const VOICE_OPTIONS = [
  ["M1", "Male 1 (M1)"], ["M2", "Male 2 (M2)"], ["M3", "Male 3 (M3)"],
  ["M4", "Male 4 (M4)"], ["M5", "Male 5 (M5)"], ["F1", "Female 1 (F1)"],
  ["F2", "Female 2 (F2)"], ["F3", "Female 3 (F3)"], ["F4", "Female 4 (F4)"],
  ["F5", "Female 5 (F5)"],
];

async function loadSettings() {
  const { settings } = await chrome.storage.local.get("settings");
  const s = { ...SETTING_DEFAULTS, ...(settings || {}) };
  if (s.targetLang && s.targetLang.includes("|")) {
    const [code, name] = s.targetLang.split("|");
    s.targetLangCode = code;
    s.targetLangName = name;
  }
  return s; // no SRT here; the in-page button always uses video captions
}

let dubUI;        // wrapper holding the gear + dub buttons
let dubButton;
let gearButton;
let settingsPanel;

function syncDubButton() {
  if (!dubButton) return;
  dubButton.textContent = state.active ? "■ Stop dubbing" : "🎙 Dub this video";
  dubButton.style.background = state.active ? "#c5221f" : "#0b57d0";
}

// ---------- in-page settings panel ----------

function buildSettingsPanel() {
  const panel = document.createElement("div");
  panel.id = "yt-dubber-settings";
  panel.style.cssText =
    "position:absolute;top:52px;right:12px;z-index:61;display:none;" +
    "width:240px;padding:12px;border-radius:10px;background:#1f1f1f;color:#fff;" +
    "font:13px system-ui,sans-serif;box-shadow:0 4px 16px rgba(0,0,0,.5);";
  const langOpts = LANG_OPTIONS.map(
    ([v, l]) => `<option value="${v}">${l}</option>`
  ).join("");
  const voiceOpts = VOICE_OPTIONS.map(
    ([v, l]) => `<option value="${v}">${l}</option>`
  ).join("");
  panel.innerHTML =
    `<div style="font-weight:700;margin-bottom:8px;">Dubbing options</div>` +
    `<label style="display:block;margin-top:8px;font-weight:600;">Dub into` +
    `<select id="ytd-lang" style="width:100%;margin-top:4px;padding:5px;">${langOpts}</select></label>` +
    `<label style="display:block;margin-top:8px;font-weight:600;">Voice` +
    `<select id="ytd-voice" style="width:100%;margin-top:4px;padding:5px;">${voiceOpts}</select></label>` +
    `<div style="display:flex;gap:8px;">` +
    `<label style="flex:1;display:block;margin-top:8px;font-weight:600;">Speed` +
    `<input id="ytd-speed" type="number" min="0.7" max="2" step="0.05" style="width:100%;margin-top:4px;padding:5px;box-sizing:border-box;"></label>` +
    `<label style="flex:1;display:block;margin-top:8px;font-weight:600;">Quality` +
    `<input id="ytd-steps" type="number" min="5" max="12" step="1" style="width:100%;margin-top:4px;padding:5px;box-sizing:border-box;"></label>` +
    `</div>` +
    `<label style="display:flex;align-items:center;margin-top:10px;font-weight:600;cursor:pointer;">` +
    `<input id="ytd-pause" type="checkbox" style="margin-right:6px;">Pause if a chunk isn't ready</label>` +
    `<div id="ytd-hint" style="margin-top:8px;font-size:11px;color:#9aa;min-height:14px;"></div>`;

  // Stop player keyboard/click handlers from stealing focus or toggling play.
  for (const ev of ["click", "dblclick", "keydown", "mousedown", "pointerdown"]) {
    panel.addEventListener(ev, (e) => e.stopPropagation());
  }
  // Persist on any change.
  panel.addEventListener("change", saveSettingsFromPanel);
  return panel;
}

async function populateSettingsPanel() {
  if (!settingsPanel) return;
  const s = await loadSettings();
  settingsPanel.querySelector("#ytd-lang").value = s.targetLang;
  settingsPanel.querySelector("#ytd-voice").value = s.voice;
  settingsPanel.querySelector("#ytd-speed").value = s.speed;
  settingsPanel.querySelector("#ytd-steps").value = s.steps;
  settingsPanel.querySelector("#ytd-pause").checked = s.pauseToSync;
}

async function saveSettingsFromPanel() {
  if (!settingsPanel) return;
  const targetLang = settingsPanel.querySelector("#ytd-lang").value;
  const [code, name] = targetLang.split("|");
  const s = {
    targetLang,
    targetLangCode: code,
    targetLangName: name,
    voice: settingsPanel.querySelector("#ytd-voice").value,
    speed: Number(settingsPanel.querySelector("#ytd-speed").value) || 1.05,
    steps: Number(settingsPanel.querySelector("#ytd-steps").value) || 8,
    pauseToSync: settingsPanel.querySelector("#ytd-pause").checked,
  };
  await chrome.storage.local.set({ settings: s });
  const hint = settingsPanel.querySelector("#ytd-hint");
  if (hint) {
    hint.textContent = state.active
      ? "Saved — restart dubbing to apply."
      : "Saved.";
  }
}

function toggleSettingsPanel() {
  if (!settingsPanel) return;
  const showing = settingsPanel.style.display !== "none";
  if (showing) {
    settingsPanel.style.display = "none";
  } else {
    populateSettingsPanel();
    settingsPanel.style.display = "block";
  }
}

function closeSettingsPanel() {
  if (settingsPanel) settingsPanel.style.display = "none";
}

// Dismiss the panel when clicking elsewhere on the page.
document.addEventListener("click", (e) => {
  if (!settingsPanel || settingsPanel.style.display === "none") return;
  if (settingsPanel.contains(e.target) || (gearButton && gearButton.contains(e.target))) return;
  closeSettingsPanel();
});

function onDubButtonClick(e) {
  e.preventDefault();
  e.stopPropagation();
  if (state.active) {
    stopDubbing();
    return;
  }
  dubButton.disabled = true;
  dubButton.textContent = "Starting…";
  loadSettings()
    .then((settings) => startDubbing(settings))
    .catch((err) => {
      status(`error: ${err.message}`);
      stopDubbing();
    })
    .finally(() => {
      dubButton.disabled = false;
      syncDubButton();
    });
}

function mountDubButton() {
  // Only on watch pages; tear down elsewhere.
  if (!location.pathname.startsWith("/watch")) {
    if (dubUI) {
      dubUI.remove();
      dubUI = dubButton = gearButton = null;
    }
    if (settingsPanel) {
      settingsPanel.remove();
      settingsPanel = null;
    }
    return;
  }
  const player =
    document.querySelector(".html5-video-player") ||
    document.getElementById("movie_player");
  if (!player) return;
  if (dubUI && player.contains(dubUI)) return; // already mounted

  if (dubUI) dubUI.remove();
  if (settingsPanel) settingsPanel.remove();

  dubUI = document.createElement("div");
  dubUI.id = "yt-dubber-ui";
  dubUI.style.cssText =
    "position:absolute;top:12px;right:12px;z-index:60;display:flex;gap:6px;align-items:center;";

  gearButton = document.createElement("button");
  gearButton.id = "yt-dubber-gear";
  gearButton.title = "Dubbing options";
  gearButton.textContent = "⚙";
  gearButton.style.cssText =
    "border:0;border-radius:18px;width:34px;height:34px;color:#fff;background:#3c4043;" +
    "font:600 16px system-ui,sans-serif;cursor:pointer;box-shadow:0 1px 4px rgba(0,0,0,.4);opacity:.92;";
  gearButton.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    toggleSettingsPanel();
  });
  gearButton.addEventListener("dblclick", (e) => e.stopPropagation());

  dubButton = document.createElement("button");
  dubButton.id = "yt-dubber-launch";
  dubButton.style.cssText =
    "border:0;border-radius:18px;padding:8px 12px;color:#fff;font:600 13px system-ui,sans-serif;" +
    "cursor:pointer;box-shadow:0 1px 4px rgba(0,0,0,.4);opacity:.92;";
  dubButton.addEventListener("click", onDubButtonClick);
  // Keep clicks from reaching the player (play/pause/fullscreen).
  dubButton.addEventListener("dblclick", (e) => e.stopPropagation());

  dubUI.appendChild(gearButton);
  dubUI.appendChild(dubButton);
  player.appendChild(dubUI);

  settingsPanel = buildSettingsPanel();
  player.appendChild(settingsPanel);

  syncDubButton();
}

// YouTube is a SPA: re-mount on navigation and stop any dub from the old video.
window.addEventListener("yt-navigate-finish", () => {
  if (state.active) stopDubbing();
  setTimeout(mountDubButton, 600);
});

// The player may not exist yet at document_idle; retry briefly, then rely on
// an observer for later layout swaps (theater/fullscreen rebuilds the player).
let mountTries = 0;
const mountTimer = setInterval(() => {
  mountDubButton();
  if ((dubButton && document.body.contains(dubButton)) || ++mountTries > 20) {
    clearInterval(mountTimer);
  }
}, 500);

// Re-attach if YouTube rebuilds the player (theater/fullscreen toggles).
// Debounced so we don't run on every DOM mutation.
let mountQueued = false;
const playerObserver = new MutationObserver(() => {
  if (mountQueued) return;
  mountQueued = true;
  requestAnimationFrame(() => {
    mountQueued = false;
    mountDubButton();
  });
});
playerObserver.observe(document.documentElement, { childList: true, subtree: true });
