# YouTube Supertonic Dubber

A Chrome/Brave extension that **dubs YouTube videos in real time**. It pulls the
video's captions, translates them with Google Gemini, synthesizes speech with a
local [Supertonic](https://github.com/supertone-inc) TTS server, and plays the
dubbed audio in sync over the original video.

Everything runs locally — captions, translation, and TTS all go through a small
Node backend on your machine. Your Gemini API key never leaves your computer.

---

## How it works

```
YouTube tab ──▶ Extension ──▶ Local backend (:3000) ──┬─▶ yt-dlp        (captions)
                                                       ├─▶ Gemini API    (translation)
                                                       └─▶ Supertonic    (:7788, TTS)
```

1. You open a YouTube video and click **Start dubbing**.
2. The backend fetches the original-language captions with `yt-dlp`.
3. Gemini translates them into your target language (skipped if the video
   already has captions in that language).
4. Each line is sent to your local Supertonic server and turned into speech.
5. The extension plays each clip at its caption timestamp, muting the original
   audio and (optionally) pausing the video if the next clip isn't ready yet.

---

## Prerequisites

You need all four before the extension will work:

| Requirement | Why | Notes |
|---|---|---|
| **Node.js 18+** | Runs the backend | `node --version` |
| **yt-dlp** | Downloads captions (browser fetches get blocked by YouTube) | On `PATH`, or in `.venv/bin/yt-dlp` |
| **Gemini API key** | Translates captions | Free key from [Google AI Studio](https://aistudio.google.com/apikey) |
| **A running Supertonic TTS server** | Generates the dubbed audio | Must listen on `http://127.0.0.1:7788` and expose `POST /v1/tts` |
| **Chrome or Brave** | Loads the extension | Any Chromium browser with Manifest V3 |

> **Supertonic** is a separate TTS engine. The backend expects it to accept
> `POST /v1/tts` with a JSON body `{ text, voice, lang, speed, steps, response_format: "wav" }`
> and return WAV audio. Point `SUPERTONIC_URL` at your instance if it runs
> elsewhere.

---

## Setup

### 1. Backend

```bash
cd backend
npm install
cp .env.example .env        # then edit .env and set GEMINI_API_KEY
npm start
```

You should see `Dub backend on http://127.0.0.1:3000`. Verify with:

```bash
curl http://127.0.0.1:3000/health
```

**Environment variables** (all optional except the key — see `backend/.env.example`):

| Variable | Default | Purpose |
|---|---|---|
| `GEMINI_API_KEY` | — | **Required.** Your Gemini API key. |
| `PORT` | `3000` | Backend port. |
| `GEMINI_MODEL` | `gemini-flash-lite-latest` | Translation model. |
| `SUPERTONIC_URL` | `http://127.0.0.1:7788` | Your Supertonic server. |
| `YTDLP_PATH` | auto | Path to `yt-dlp`. Defaults to `.venv/bin/yt-dlp`, then `PATH`. |
| `YTDLP_COOKIES_FROM_BROWSER` | — | Set to `chrome`/`brave`/`firefox`/`safari`/`edge` to fix caption rate-limits (HTTP 429). |

### 2. Supertonic TTS server

Start your Supertonic server so it listens on `http://127.0.0.1:7788`. Confirm
the backend can reach it via the `supertonic` field in `/health`.

### 3. Extension

1. Open `chrome://extensions` (or `brave://extensions`).
2. Enable **Developer mode** (top-right).
3. Click **Load unpacked** and select the `extension/` folder.
4. Pin **Supertonic Dubber** to your toolbar.

---

## Usage

1. Open any YouTube video that has captions.
2. Click the **Supertonic Dubber** icon.
3. Choose your options:
   - **Dub into** — target language (Arabic, English, Spanish, French, German,
     and more).
   - **Voice** — five male (M1–M5) and five female (F1–F5) voices.
   - **Base speed** — playback rate of the synthesized speech (0.7–2.0).
   - **Quality (steps)** — TTS denoising steps; higher is better but slower (5–12).
   - **Paste SRT** *(optional)* — supply your own transcript to dub instead of
     the video's captions.
   - **Pause video if a chunk isn't ready yet** — keeps audio in sync on slower
     machines.
4. Click **Start dubbing**. Progress shows in the popup. Click **Stop** to end.

---

## Standalone CLI (`dub.py`)

`dub.py` is an independent helper, unrelated to the extension. It takes an SRT/VTT
file and renders a single timeline-aligned WAV using **Gemini TTS**:

```bash
pip install google-genai
export GEMINI_API_KEY=your_key
python dub.py input.srt output.wav --voice Zephyr
```

---

## Troubleshooting

- **"This video has no captions."** — The video has no caption track. Paste an
  SRT in the popup instead.
- **HTTP 429 / rate limited** — YouTube is throttling caption downloads. Wait a
  few minutes, or set `YTDLP_COOKIES_FROM_BROWSER=chrome` (or your browser) in
  `backend/.env` to fetch as a logged-in user.
- **No audio / backend unreachable** — Make sure `npm start` is running and
  `curl http://127.0.0.1:3000/health` succeeds. Chromium blocks page→loopback
  requests via Private Network Access; the backend grants it, but you may need
  to allow local network access if your browser prompts.
- **TTS errors** — Confirm your Supertonic server is up at `SUPERTONIC_URL` and
  responds to `POST /v1/tts`.

---

## Privacy

Captions, translation requests, and TTS all run through your own local backend.
Caption text is sent to Google's Gemini API for translation; nothing else leaves
your machine. Your API key lives only in `backend/.env`, which is gitignored.
