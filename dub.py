# pip install google-genai
#
# Usage:
#   python dub.py input.srt output.wav [--voice Zephyr]
#
# Reads an SRT (or VTT) subtitle file, synthesizes speech for each cue with
# Gemini TTS, fits each clip to its cue duration (truncate or pad with
# silence), and writes a single WAV aligned to the original timeline.

import argparse
import io
import os
import re
import struct
import sys
import wave
from dataclasses import dataclass
from typing import List, Optional

from google import genai
from google.genai import types


# ---------- Subtitle parsing ----------

@dataclass
class Cue:
    start_ms: int
    end_ms: int
    text: str

    @property
    def duration_ms(self) -> int:
        return max(0, self.end_ms - self.start_ms)


_TS = re.compile(
    r"(\d{1,2}):(\d{2}):(\d{2})[,.](\d{1,3})\s*-->\s*"
    r"(\d{1,2}):(\d{2}):(\d{2})[,.](\d{1,3})"
)


def _to_ms(h: str, m: str, s: str, ms: str) -> int:
    return int(h) * 3600000 + int(m) * 60000 + int(s) * 1000 + int(ms.ljust(3, "0"))


def parse_subtitles(path: str) -> List[Cue]:
    with open(path, "r", encoding="utf-8-sig") as f:
        raw = f.read()

    # Strip VTT header and cue settings; SRT works as-is.
    raw = raw.replace("\r\n", "\n").replace("\r", "\n")
    blocks = re.split(r"\n\s*\n", raw.strip())
    cues: List[Cue] = []
    for block in blocks:
        m = _TS.search(block)
        if not m:
            continue
        start = _to_ms(*m.group(1, 2, 3, 4))
        end = _to_ms(*m.group(5, 6, 7, 8))
        # Text is everything after the timestamp line.
        after = block[m.end():].lstrip("\n")
        # Drop trailing cue settings on the timestamp line for VTT.
        lines = [ln for ln in after.split("\n") if ln.strip()]
        text = " ".join(lines).strip()
        # Strip basic HTML/VTT tags.
        text = re.sub(r"<[^>]+>", "", text)
        if text:
            cues.append(Cue(start, end, text))
    return cues


# ---------- TTS ----------

def synthesize(client: genai.Client, model: str, voice: str, text: str) -> bytes:
    """Return WAV bytes for the given text."""
    config = types.GenerateContentConfig(
        temperature=1,
        response_modalities=["audio"],
        speech_config=types.SpeechConfig(
            voice_config=types.VoiceConfig(
                prebuilt_voice_config=types.PrebuiltVoiceConfig(voice_name=voice)
            )
        ),
    )
    contents = [
        types.Content(role="user", parts=[types.Part.from_text(text=text)])
    ]

    audio_chunks: List[bytes] = []
    mime_type: Optional[str] = None
    for chunk in client.models.generate_content_stream(
        model=model, contents=contents, config=config
    ):
        if not chunk.candidates or not chunk.candidates[0].content:
            continue
        parts = chunk.candidates[0].content.parts or []
        for part in parts:
            if part.inline_data and part.inline_data.data:
                audio_chunks.append(part.inline_data.data)
                if mime_type is None:
                    mime_type = part.inline_data.mime_type

    if not audio_chunks:
        raise RuntimeError(f"No audio returned for text: {text!r}")

    raw = b"".join(audio_chunks)
    # If the API already returns a WAV, use it. Otherwise wrap raw PCM.
    if raw[:4] == b"RIFF":
        return raw
    return _wrap_pcm_as_wav(raw, mime_type or "audio/L16;rate=24000")


def _wrap_pcm_as_wav(pcm: bytes, mime_type: str) -> bytes:
    params = _parse_audio_mime_type(mime_type)
    return _build_wav(pcm, params["rate"], params["bits_per_sample"], 1)


def _parse_audio_mime_type(mime_type: str) -> dict:
    bits_per_sample = 16
    rate = 24000
    for param in mime_type.split(";"):
        param = param.strip()
        if param.lower().startswith("rate="):
            try:
                rate = int(param.split("=", 1)[1])
            except (ValueError, IndexError):
                pass
        elif param.startswith("audio/L"):
            try:
                bits_per_sample = int(param.split("L", 1)[1])
            except (ValueError, IndexError):
                pass
    return {"bits_per_sample": bits_per_sample, "rate": rate}


def _build_wav(pcm: bytes, rate: int, bits: int, channels: int) -> bytes:
    bytes_per_sample = bits // 8
    block_align = channels * bytes_per_sample
    byte_rate = rate * block_align
    data_size = len(pcm)
    header = struct.pack(
        "<4sI4s4sIHHIIHH4sI",
        b"RIFF", 36 + data_size, b"WAVE",
        b"fmt ", 16, 1, channels, rate, byte_rate, block_align, bits,
        b"data", data_size,
    )
    return header + pcm


# ---------- WAV reading & timeline assembly ----------

def _read_wav(data: bytes):
    with wave.open(io.BytesIO(data), "rb") as w:
        return {
            "channels": w.getnchannels(),
            "sampwidth": w.getsampwidth(),
            "rate": w.getframerate(),
            "frames": w.readframes(w.getnframes()),
        }


def _ms_to_bytes(ms: int, rate: int, sampwidth: int, channels: int) -> int:
    n_frames = int(round(rate * ms / 1000.0))
    return n_frames * sampwidth * channels


def assemble(cues: List[Cue], clips: List[bytes], out_path: str) -> None:
    decoded = [_read_wav(c) for c in clips]
    rate = decoded[0]["rate"]
    sampwidth = decoded[0]["sampwidth"]
    channels = decoded[0]["channels"]
    for d in decoded:
        if (d["rate"], d["sampwidth"], d["channels"]) != (rate, sampwidth, channels):
            raise RuntimeError("Mismatched audio formats across TTS clips")

    total_ms = max(c.end_ms for c in cues)
    total_bytes = _ms_to_bytes(total_ms, rate, sampwidth, channels)
    track = bytearray(total_bytes)  # silence

    for cue, clip in zip(cues, decoded):
        start = _ms_to_bytes(cue.start_ms, rate, sampwidth, channels)
        slot = _ms_to_bytes(cue.duration_ms, rate, sampwidth, channels)
        frames = clip["frames"]
        if len(frames) > slot:
            frames = frames[:slot]  # truncate to fit cue
        # else: leaves trailing silence in the slot (pad)
        end = start + len(frames)
        if end > len(track):
            track.extend(b"\x00" * (end - len(track)))
        track[start:end] = frames

    with wave.open(out_path, "wb") as w:
        w.setnchannels(channels)
        w.setsampwidth(sampwidth)
        w.setframerate(rate)
        w.writeframes(bytes(track))
    print(f"Wrote {out_path} ({len(track) / (rate * sampwidth * channels):.2f}s)")


# ---------- Main ----------

def main() -> int:
    ap = argparse.ArgumentParser(description="Dub a subtitle file with Gemini TTS.")
    ap.add_argument("input", help="Path to .srt or .vtt subtitle file")
    ap.add_argument("output", help="Path to output .wav file")
    ap.add_argument("--voice", default="Zephyr", help="Prebuilt voice name")
    ap.add_argument("--model", default="gemini-2.5-flash-preview-tts")
    ap.add_argument("--parts-dir", default="parts",
                    help="Directory to store per-cue WAV files")
    args = ap.parse_args()

    os.makedirs(args.parts_dir, exist_ok=True)

    cues = parse_subtitles(args.input)
    if not cues:
        print("No cues found in subtitle file.", file=sys.stderr)
        return 1
    print(f"Parsed {len(cues)} cues.")

    client = genai.Client(api_key=os.environ.get("GEMINI_API_KEY"))

    clips: List[bytes] = []
    for i, cue in enumerate(cues, 1):
        print(f"[{i}/{len(cues)}] {cue.start_ms/1000:.2f}s  {cue.text[:60]!r}")
        part_path = os.path.join(args.parts_dir, f"part_{i:04d}.wav")
        if os.path.exists(part_path):
            with open(part_path, "rb") as f:
                wav = f.read()
        else:
            wav = synthesize(client, args.model, args.voice, cue.text)
            with open(part_path, "wb") as f:
                f.write(wav)
        clips.append(wav)

    assemble(cues, clips, args.output)
    return 0


if __name__ == "__main__":
    sys.exit(main())
