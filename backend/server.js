import express from "express";
import cors from "cors";
import { GoogleGenAI, Type } from "@google/genai";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const execFileP = promisify(execFile);

const PORT = Number(process.env.PORT || 3000);
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-flash-lite-latest";
const SUPERTONIC_URL = (process.env.SUPERTONIC_URL || "http://127.0.0.1:7788").replace(/\/$/, "");
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

// yt-dlp handles YouTube's PoToken/signature gating that makes in-browser
// caption (timedtext) fetches 404. Prefer the project venv copy, then PATH.
const YTDLP = (() => {
  if (process.env.YTDLP_PATH) return process.env.YTDLP_PATH;
  const venv = path.resolve(import.meta.dirname, "../.venv/bin/yt-dlp");
  return existsSync(venv) ? venv : "yt-dlp";
})();

// Optional: reuse your browser's YouTube cookies so requests look logged-in.
// This is the most effective fix for HTTP 429 (rate limit) on caption fetches.
// e.g. YTDLP_COOKIES_FROM_BROWSER=brave  (also: chrome, firefox, safari, edge)
const YTDLP_COOKIES_FROM_BROWSER = process.env.YTDLP_COOKIES_FROM_BROWSER || "";

// Throttle + let yt-dlp retry transient failures so we stay under the limiter.
// --ignore-no-formats-error: we only want subtitles, so don't abort with
// "Requested format is not available" when the player client returns a format
// set that lacks yt-dlp's default pick (e.g. format 18).
const YTDLP_THROTTLE_ARGS = [
  "--sleep-requests", "1",
  "--retries", "5",
  "--extractor-retries", "3",
  "--ignore-no-formats-error",
];

function ytdlpBaseArgs() {
  const args = ["--no-warnings", ...YTDLP_THROTTLE_ARGS];
  if (YTDLP_COOKIES_FROM_BROWSER) {
    args.push("--cookies-from-browser", YTDLP_COOKIES_FROM_BROWSER);
  }
  return args;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const is429 = (err) => /\b429\b|Too Many Requests/i.test(String(err?.stderr || err?.message || ""));

// Run yt-dlp with our base flags, retrying on HTTP 429 with exponential backoff
// (yt-dlp doesn't internally retry subtitle 429s, so we handle them here).
async function runYtdlp(extraArgs, { retries = 3 } = {}) {
  const args = [...ytdlpBaseArgs(), ...extraArgs];
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await execFileP(YTDLP, args, { maxBuffer: 128 * 1024 * 1024 });
    } catch (err) {
      lastErr = err;
      if (!is429(err) || attempt === retries) throw err;
      const wait = Math.min(60000, 5000 * 2 ** attempt); // 5s, 10s, 20s, 40s…
      console.warn(`yt-dlp 429 — retry ${attempt + 1}/${retries} in ${wait / 1000}s`);
      await sleep(wait);
    }
  }
  throw lastErr;
}

if (!GEMINI_API_KEY) {
  console.error("Missing GEMINI_API_KEY. Set it before starting (see .env.example).");
  process.exit(1);
}

const ai = new GoogleGenAI({ apiKey: GEMINI_API_KEY });

const app = express();
// Chrome/Brave Private Network Access: a fetch from a public site (youtube.com)
// to a local address (127.0.0.1) requires the preflight to grant PNA explicitly.
app.use((req, res, next) => {
  if (req.headers["access-control-request-private-network"]) {
    res.setHeader("Access-Control-Allow-Private-Network", "true");
  }
  next();
});
app.use(cors());
app.use(express.json({ limit: "20mb" }));

// Translate the whole transcript in one Gemini call. The model only returns
// { id, translatedText } per chunk; timings are merged back here so the model
// can never corrupt the timeline.
async function translateChunks({ chunks, sourceLang, targetLang }) {
  const compact = chunks.map((c) => ({ id: c.id, text: c.text }));

  const prompt = [
    `You are translating subtitles for spoken video dubbing.`,
    `Source language: ${sourceLang}. Target language: ${targetLang}.`,
    ``,
    `Rules:`,
    `- Translate every chunk. Return exactly one entry per input id.`,
    `- Translation must read naturally when spoken aloud.`,
    `- Keep each translation roughly the same spoken length as the source so it fits the original timing.`,
    `- Use the surrounding chunks for context, but translate each chunk's own meaning.`,
    `- Do not merge, split, reorder, or drop chunks.`,
    `- Skip non-speech annotations (e.g. "تصفيق", "[Applause]", "[Music]", "[Laughter]", "(موسيقى)", sound effects, speaker labels). For such chunks return an empty translatedText "" so nothing is spoken.`,
    `- Write all numbers as digits in Western/English form (0-9), e.g. "2025", "15%", not spelled out and not in Arabic-Indic numerals (٠-٩).`,
    `- Keep technical terms, product/brand names, programming keywords, acronyms, and units in English (Latin script) — e.g. "JavaScript", "API", "Docker", "GPU", "useState", "GitHub". Do not transliterate or translate them; keep the surrounding sentence in the target language.`,
    ``,
    `Input chunks (JSON):`,
    JSON.stringify(compact),
  ].join("\n");

  const response = await ai.models.generateContent({
    model: GEMINI_MODEL,
    contents: prompt,
    config: {
      responseMimeType: "application/json",
      responseSchema: {
        type: Type.ARRAY,
        items: {
          type: Type.OBJECT,
          properties: {
            id: { type: Type.INTEGER },
            translatedText: { type: Type.STRING },
          },
          required: ["id", "translatedText"],
          propertyOrdering: ["id", "translatedText"],
        },
      },
    },
  });

  const translated = JSON.parse(response.text);
  const byId = new Map(translated.map((t) => [t.id, t.translatedText]));

  return chunks.map((c) => ({
    ...c,
    translatedText: (byId.get(c.id) ?? "").trim(),
  }));
}

// Parse YouTube's json3 timedtext into timed chunks.
function parseJson3(body) {
  const data = JSON.parse(body);
  const events = Array.isArray(data.events) ? data.events : [];
  const chunks = [];
  for (const ev of events) {
    if (!Array.isArray(ev.segs)) continue;
    const text = ev.segs.map((s) => s.utf8 || "").join("").replace(/\s+/g, " ").trim();
    if (!text) continue;
    const start = (ev.tStartMs || 0) / 1000;
    const end = start + (ev.dDurationMs || 0) / 1000;
    chunks.push({ id: chunks.length, start, end, text });
  }
  return chunks;
}

// Pick the caption track in the video's ORIGINAL language. Auto-translated
// tracks are avoided so we never dub a translation of a translation.
function chooseCaptionLang(meta, prefer) {
  const manual = meta.subtitles || {};
  const auto = meta.automatic_captions || {};
  const vlang = meta.language || null; // original audio language, e.g. "en"

  const wanted = [];
  if (prefer) wanted.push(prefer);
  if (vlang) wanted.push(vlang, `${vlang}-orig`);

  // Manual subs are author-provided and safe (usually the original language).
  for (const k of wanted) if (manual[k]) return k;
  if (vlang && manual[vlang]) return manual[vlang];
  const manualKeys = Object.keys(manual);

  // Auto captions: only the original-language track (never a translation).
  for (const k of wanted) if (auto[k]) return k;
  if (vlang) {
    const origKey = Object.keys(auto).find((k) => k === `${vlang}-orig` || k === vlang);
    if (origKey) return origKey;
  }

  // Last resort: any manual track, then any auto track explicitly tagged -orig.
  if (manualKeys.length) return manualKeys[0];
  const origAuto = Object.keys(auto).find((k) => k.endsWith("-orig"));
  if (origAuto) return origAuto;
  return Object.keys(auto)[0] || null;
}

// Find a caption track already in the target language so we can dub it directly
// instead of translating. Manual (author-provided) tracks win over auto ones.
// Matches "ar" against keys like "ar", "ar-SA", "ar-orig".
function findTargetLang(meta, target) {
  if (!target) return null;
  const t = String(target).toLowerCase();
  const matches = (k) => {
    const kk = k.toLowerCase();
    return kk === t || kk.startsWith(`${t}-`) || kk.startsWith(`${t}.`);
  };
  const manual = meta.subtitles || {};
  const auto = meta.automatic_captions || {};
  return (
    Object.keys(manual).find(matches) || Object.keys(auto).find(matches) || null
  );
}

app.post("/captions", async (req, res) => {
  const { videoUrl, videoId, preferLang, targetLang } = req.body || {};
  const url =
    videoUrl || (videoId ? `https://www.youtube.com/watch?v=${videoId}` : null);
  if (!url || !/^https:\/\/(www\.)?youtube\.com\/watch\?/.test(url)) {
    return res.status(400).json({ error: "Provide a YouTube watch URL or videoId." });
  }

  let tmp;
  try {
    tmp = await mkdtemp(path.join(os.tmpdir(), "yt-dub-"));

    // 1) Metadata: which caption tracks exist + the original language.
    const { stdout } = await runYtdlp(["-J", "--skip-download", url]);
    const meta = JSON.parse(stdout);

    // Prefer an existing track in the target language (skip our translation).
    // Otherwise fall back to the original-language track and translate later.
    let lang = findTargetLang(meta, targetLang);
    const alreadyTarget = Boolean(lang);
    if (!lang) lang = chooseCaptionLang(meta, preferLang);
    if (!lang) {
      return res.status(404).json({ error: "This video has no captions. Paste an SRT instead." });
    }

    // 2) Download just that track as json3.
    await runYtdlp([
      "--skip-download",
      "--write-subs",
      "--write-auto-subs",
      "--sub-langs", lang,
      "--sub-format", "json3",
      "--sleep-subtitles", "1",
      "-o", path.join(tmp, "%(id)s.%(ext)s"),
      url,
    ]);

    const files = await readdir(tmp);
    const file = files.find((f) => f.endsWith(".json3"));
    if (!file) {
      return res.status(404).json({ error: `No downloadable captions for language "${lang}".` });
    }

    const chunks = parseJson3(await readFile(path.join(tmp, file), "utf8"));
    if (!chunks.length) {
      return res.status(404).json({ error: "Captions were empty." });
    }
    res.json({ lang, alreadyTarget, title: meta.title || null, chunks });
  } catch (error) {
    console.error("captions failed:", error);
    if (is429(error)) {
      return res.status(429).json({
        error:
          "YouTube is rate-limiting caption downloads (HTTP 429). Wait a few " +
          "minutes, set YTDLP_COOKIES_FROM_BROWSER=brave (or chrome) in the " +
          "backend env, or paste an SRT instead.",
      });
    }
    res.status(500).json({ error: String(error?.stderr || error?.message || error) });
  } finally {
    if (tmp) await rm(tmp, { recursive: true, force: true }).catch(() => {});
  }
});

app.get("/health", (_req, res) => {
  res.json({ ok: true, model: GEMINI_MODEL, supertonic: SUPERTONIC_URL, ytdlp: YTDLP });
});

app.post("/translate-full", async (req, res) => {
  try {
    const { chunks, sourceLang = "auto", targetLang = "Arabic" } = req.body;

    if (!Array.isArray(chunks) || chunks.length === 0) {
      return res.status(400).json({ error: "Missing or empty chunks array." });
    }

    const translatedChunks = await translateChunks({ chunks, sourceLang, targetLang });
    res.json({ chunks: translatedChunks });
  } catch (error) {
    console.error("translate-full failed:", error);
    res.status(500).json({ error: String(error?.message || error) });
  }
});

app.post("/tts-chunk", async (req, res) => {
  try {
    const { text, lang = "ar", voice = "M1", speed = 1.05, steps = 8 } = req.body;

    if (!text || typeof text !== "string") {
      return res.status(400).json({ error: "Missing text." });
    }

    const upstream = await fetch(`${SUPERTONIC_URL}/v1/tts`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text, voice, lang, speed, steps, response_format: "wav" }),
    });

    if (!upstream.ok) {
      const detail = await upstream.text();
      throw new Error(`Supertonic ${upstream.status}: ${detail}`);
    }

    const audio = Buffer.from(await upstream.arrayBuffer());
    res.setHeader("Content-Type", "audio/wav");
    res.send(audio);
  } catch (error) {
    console.error("tts-chunk failed:", error);
    res.status(500).json({ error: String(error?.message || error) });
  }
});

app.listen(PORT, () => {
  console.log(`Dub backend on http://127.0.0.1:${PORT}`);
  console.log(`  Gemini model:   ${GEMINI_MODEL}`);
  console.log(`  Supertonic at:  ${SUPERTONIC_URL}`);
});
