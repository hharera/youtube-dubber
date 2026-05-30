// Backend fetches run here, in the extension's service worker, because a
// content script inherits youtube.com's origin and Chrome's Local Network
// Access (LNA) blocks pages from reaching the 127.0.0.1 loopback. The worker
// uses the extension's host_permissions instead, which is exempt.

const BACKEND = "http://127.0.0.1:3000";

function abToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

async function getCaptions({ videoUrl, preferLang, targetLang }) {
  const res = await fetch(`${BACKEND}/captions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ videoUrl, preferLang, targetLang }),
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    throw new Error(data?.error || `Caption fetch failed: HTTP ${res.status}`);
  }
  return data;
}

async function translateFull({ chunks, sourceLang, targetLang }) {
  const res = await fetch(`${BACKEND}/translate-full`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chunks, sourceLang, targetLang }),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`Translate failed: ${res.status} ${detail}`);
  }
  return res.json();
}

async function ttsChunk({ text, lang, voice, speed, steps }) {
  const res = await fetch(`${BACKEND}/tts-chunk`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text, lang, voice, speed, steps }),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`TTS ${res.status} ${detail}`);
  }
  const buf = await res.arrayBuffer();
  return { b64: abToBase64(buf), mime: res.headers.get("Content-Type") || "audio/wav" };
}

// Runs in the YouTube page's MAIN world (injected via chrome.scripting). Uses
// the page's own InnerTube session to list caption tracks and fetch json3 —
// the same path other transcript extensions use. No backend, no IP rate-limit.
// Must be fully self-contained: it's serialized and injected, so no closures.
async function scrapeCaptionsInPage(videoId, targetLang) {
  const errors = [];
  const cfg = window.ytcfg;
  const key = cfg && cfg.get && cfg.get("INNERTUBE_API_KEY");
  const context = cfg && cfg.get && cfg.get("INNERTUBE_CONTEXT");

  // Recursively find the first value of `wantKey` anywhere in an object tree.
  const deepFind = (root, wantKey) => {
    const stack = [root];
    while (stack.length) {
      const cur = stack.pop();
      if (!cur || typeof cur !== "object") continue;
      if (cur[wantKey] !== undefined) return cur[wantKey];
      for (const k in cur) {
        const v = cur[k];
        if (v && typeof v === "object") stack.push(v);
      }
    }
    return undefined;
  };

  // ---- Method A: captionTracks → timedtext json3 (gives language + alreadyTarget).
  // CRITICAL: read tracks from the LIVE player (movie_player.getPlayerResponse),
  // whose baseUrls already carry the PoToken YouTube's player solved. A fresh
  // InnerTube /player call returns pot-less baseUrls that respond with an empty
  // body, so it's only a last resort.
  try {
    let tracks = [];
    try {
      const mp =
        document.getElementById("movie_player") ||
        document.querySelector(".html5-video-player");
      const pr = mp && mp.getPlayerResponse && mp.getPlayerResponse();
      tracks = pr?.captions?.playerCaptionsTracklistRenderer?.captionTracks || [];
    } catch (e) {
      /* player API not ready */
    }
    if (!tracks.length) {
      const pr = window.ytInitialPlayerResponse;
      tracks = pr?.captions?.playerCaptionsTracklistRenderer?.captionTracks || [];
    }
    if (!tracks.length && key && context) {
      const r = await fetch(`/youtubei/v1/player?key=${encodeURIComponent(key)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ videoId, context }),
      });
      const j = await r.json();
      tracks = j?.captions?.playerCaptionsTracklistRenderer?.captionTracks || [];
    }

    if (tracks.length) {
      const t = (targetLang || "").toLowerCase();
      const isTarget = (tr) =>
        t && (tr.languageCode || "").toLowerCase().split("-")[0] === t;
      let pick =
        tracks.find((tr) => isTarget(tr) && tr.kind !== "asr") ||
        tracks.find((tr) => isTarget(tr));
      const alreadyTarget = Boolean(pick);
      if (!pick) pick = tracks.find((tr) => tr.kind !== "asr") || tracks[0];
      if (pick?.baseUrl) {
        let url = pick.baseUrl;
        url = url.replace(/&fmt=\w+/g, "");
        url += "&fmt=json3";
        const res = await fetch(url);
        const body = res.ok ? await res.text() : "";
        if (!res.ok) {
          errors.push(`timedtext HTTP ${res.status}`);
        } else if (!body) {
          errors.push("timedtext empty (pot-gated)");
        } else {
          const data = JSON.parse(body);
          const chunks = [];
          for (const ev of data?.events || []) {
            if (!Array.isArray(ev.segs)) continue;
            const text = ev.segs.map((s) => s.utf8 || "").join("").replace(/\s+/g, " ").trim();
            if (!text) continue;
            const start = (ev.tStartMs || 0) / 1000;
            chunks.push({ id: chunks.length, start, end: start + (ev.dDurationMs || 0) / 1000, text });
          }
          if (chunks.length) return { chunks, lang: pick.languageCode || null, alreadyTarget };
          errors.push("timedtext no cues");
        }
      } else {
        errors.push("no baseUrl");
      }
    } else {
      errors.push("no captionTracks");
    }
  } catch (e) {
    errors.push(`timedtext: ${e?.message || e}`);
  }

  // ---- Method B: get_transcript (inline text — dodges timedtext 429/PoToken).
  try {
    const params = deepFind(window.ytInitialData, "getTranscriptEndpoint")?.params;
    if (key && context && params) {
      const r = await fetch(`/youtubei/v1/get_transcript?key=${encodeURIComponent(key)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ context, params }),
      });
      if (r.ok) {
        const j = await r.json();
        const initial = deepFind(j, "initialSegments") || [];
        const chunks = [];
        for (const s of initial) {
          const seg = s.transcriptSegmentRenderer;
          if (!seg) continue;
          const text = (
            seg.snippet?.runs?.map((x) => x.text).join("") ||
            seg.snippet?.simpleText ||
            ""
          ).replace(/\s+/g, " ").trim();
          if (!text) continue;
          const start = Number(seg.startMs || 0) / 1000;
          chunks.push({ id: chunks.length, start, end: Number(seg.endMs || 0) / 1000, text });
        }
        // get_transcript returns the default (usually original) language, so we
        // translate it — alwaysTarget stays false.
        if (chunks.length) return { chunks, lang: null, alreadyTarget: false };
        errors.push("get_transcript empty");
      } else {
        errors.push(`get_transcript HTTP ${r.status}`);
      }
    } else {
      errors.push(params ? "no innertube cfg" : "no transcript params");
    }
  } catch (e) {
    errors.push(`get_transcript: ${e?.message || e}`);
  }

  return { error: errors.join(" | ") || "no captions" };
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === "BK_SCRAPE_CAPTIONS") {
    const tabId = _sender?.tab?.id;
    if (!tabId) {
      sendResponse({ error: "No tab to scrape." });
      return false;
    }
    chrome.scripting
      .executeScript({
        target: { tabId },
        world: "MAIN",
        func: scrapeCaptionsInPage,
        args: [msg.videoId, msg.targetLang || null],
      })
      .then((results) => sendResponse(results?.[0]?.result || { error: "No result." }))
      .catch((err) => sendResponse({ error: String(err?.message || err) }));
    return true;
  }
  if (msg?.type === "BK_CAPTIONS") {
    getCaptions(msg)
      .then((data) => sendResponse({ ok: true, ...data }))
      .catch((err) => sendResponse({ error: err.message }));
    return true;
  }
  if (msg?.type === "BK_TRANSLATE") {
    translateFull(msg)
      .then((data) => sendResponse({ ok: true, ...data }))
      .catch((err) => sendResponse({ error: err.message }));
    return true;
  }
  if (msg?.type === "BK_TTS") {
    ttsChunk(msg)
      .then((data) => sendResponse({ ok: true, ...data }))
      .catch((err) => sendResponse({ error: err.message }));
    return true;
  }
});
