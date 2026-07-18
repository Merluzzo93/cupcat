// Subtitle translation for the translate_captions tool — the pure text side (prompting Claude,
// parsing its reply, serializing SRT), kept free of EditorDocument so it stays unit-testable.
// The timeline plumbing (collecting timeline-mapped segments, placing caption clips) lives in
// executor.ts, which reuses the same helpers add_captions uses.

import { oneShotText } from "./agent-chat";

/** Segments sent to Claude per request. Keeps the reply well inside oneShotText's output budget
 * even for verbose languages (a segment is a subtitle-length phrase, not a paragraph). */
const CHUNK_SIZE = 80;

const TRANSLATOR_SYSTEM = `You are a professional subtitle translator. Translate each numbered segment into the target language.
Rules:
- Reply with ONLY a JSON array — no prose, no explanations, no code fences: [{"i": <segment number>, "text": "<translation>"}, …]
- One entry per input segment, keeping the EXACT same index numbers. Never merge, split, drop, or reorder segments.
- These are subtitles: keep each segment's meaning, tone, energy, and punctuation style; match natural spoken register, not literary prose.
- Translate each segment so it reads correctly in sequence (consistent terminology, names, and pronouns across segments).
- Keep numbers, proper names, and brand names as-is unless the target language requires otherwise.`;

/** Extract the model's translations from its reply as an index → text map. Robust to code fences,
 * surrounding prose, alternate key names (index/t), plain string arrays, and — as a last resort —
 * truncated/invalid JSON (per-object regex salvage of whatever parses). */
export function parseTranslatedSegments(raw: string): Map<number, string> {
  const out = new Map<number, string>();
  let s = raw.trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence?.[1]) s = fence[1].trim();

  const start = s.indexOf("[");
  const end = s.lastIndexOf("]");
  if (start !== -1 && end > start) {
    try {
      const arr: unknown = JSON.parse(s.slice(start, end + 1));
      if (Array.isArray(arr)) {
        arr.forEach((item, pos) => {
          if (typeof item === "string") {
            if (!out.has(pos)) out.set(pos, item);
            return;
          }
          if (!item || typeof item !== "object") return;
          const o = item as Record<string, unknown>;
          const idxRaw = o.i ?? o.index;
          const idx = typeof idxRaw === "number" ? idxRaw : typeof idxRaw === "string" ? Number(idxRaw) : Number.NaN;
          const text = typeof o.text === "string" ? o.text : typeof o.t === "string" ? o.t : undefined;
          if (Number.isInteger(idx) && idx >= 0 && typeof text === "string") out.set(idx, text);
        });
        if (out.size > 0) return out;
      }
    } catch {
      /* fall through to regex salvage */
    }
  }

  // Salvage: pick every {"i": N, …"text": "…"} object that parses on its own (handles a reply cut
  // off mid-array or wrapped in commentary the block parse above choked on).
  const re = /\{\s*"(?:i|index)"\s*:\s*"?(\d+)"?\s*,\s*(?:"[^"]*"\s*:\s*"(?:[^"\\]|\\.)*"\s*,\s*)*"(?:text|t)"\s*:\s*"((?:[^"\\]|\\.)*)"/g;
  for (const m of s.matchAll(re)) {
    try {
      out.set(Number(m[1]), JSON.parse(`"${m[2]}"`) as string);
    } catch {
      out.set(Number(m[1]), m[2]!);
    }
  }
  return out;
}

/** Overlay parsed translations onto the originals: any segment the model skipped keeps its source
 * text (an untranslated caption beats a hole in the subtitle track). */
export function mergeTranslations(texts: string[], translations: Map<number, string>): string[] {
  return texts.map((t, i) => {
    const tr = translations.get(i)?.trim();
    return tr && tr.length > 0 ? tr : t;
  });
}

/** Translate segment texts into targetLanguage with Claude (same auth as the chat agent).
 * Returns an array aligned 1:1 with the input; untranslatable gaps fall back to the original. */
export async function translateSegments(texts: string[], targetLanguage: string): Promise<string[]> {
  const out: string[] = [];
  for (let base = 0; base < texts.length; base += CHUNK_SIZE) {
    const chunk = texts.slice(base, base + CHUNK_SIZE);
    const user = [
      `Target language: ${targetLanguage}`,
      "",
      "Segments:",
      ...chunk.map((t, i) => `${i}: ${t.replace(/\s*\n\s*/g, " ")}`),
      "",
      "Return the JSON array now.",
    ].join("\n");
    const raw = await oneShotText(TRANSLATOR_SYSTEM, user);
    const parsed = parseTranslatedSegments(raw);
    if (parsed.size === 0) {
      throw new Error(`Translation failed — Claude's reply contained no parsable segments (got: ${raw.slice(0, 160)}…)`);
    }
    out.push(...mergeTranslations(chunk, parsed));
  }
  return out;
}

/** Seconds → SRT timestamp (HH:MM:SS,mmm — comma decimal, zero-padded). */
export function srtTimestamp(seconds: number): string {
  const ms = Math.max(0, Math.round(seconds * 1000));
  const pad = (n: number, w: number) => String(n).padStart(w, "0");
  return `${pad(Math.floor(ms / 3_600_000), 2)}:${pad(Math.floor(ms / 60_000) % 60, 2)}:${pad(Math.floor(ms / 1000) % 60, 2)},${pad(ms % 1000, 3)}`;
}

/** Parse SRT or WebVTT text into cues. Tolerant: optional cue numbers/ids, comma or dot decimals,
 * missing hours (VTT "MM:SS.mmm"), CRLF, WEBVTT header/NOTE blocks, inline tags stripped. */
export function parseSubtitles(raw: string): { startSeconds: number; endSeconds: number; text: string }[] {
  const toSec = (ts: string): number | null => {
    const m = ts.trim().match(/^(?:(\d{1,2}):)?(\d{1,2}):(\d{2})[.,](\d{1,3})$/);
    if (!m) return null;
    return (m[1] ? Number(m[1]) * 3600 : 0) + Number(m[2]) * 60 + Number(m[3]) + Number(m[4]!.padEnd(3, "0")) / 1000;
  };
  const cues: { startSeconds: number; endSeconds: number; text: string }[] = [];
  for (const block of raw.replace(/\r/g, "").replace(/^﻿/, "").split(/\n{2,}/)) {
    const lines = block.split("\n").filter((l) => l.trim().length > 0);
    if (!lines.length || /^(WEBVTT|NOTE|STYLE|REGION)\b/.test(lines[0]!)) continue;
    const ti = lines.findIndex((l) => l.includes("-->"));
    if (ti < 0) continue;
    const [a, b] = lines[ti]!.split("-->");
    const start = toSec(a ?? "");
    const end = toSec((b ?? "").trim().split(/\s/).filter(Boolean)[0] ?? "");
    if (start == null || end == null || end <= start) continue;
    const text = lines
      .slice(ti + 1)
      .join(" ")
      .replace(/<[^>]+>/g, "")
      .trim();
    if (text) cues.push({ startSeconds: start, endSeconds: end, text });
  }
  return cues.sort((x, y) => x.startSeconds - y.startSeconds);
}

/** Serialize cues as a standard SubRip file: 1-based counter, `start --> end`, text, blank line. */
export function toSrt(cues: { startSeconds: number; endSeconds: number; text: string }[]): string {
  return cues
    .map((c, i) => `${i + 1}\n${srtTimestamp(c.startSeconds)} --> ${srtTimestamp(c.endSeconds)}\n${c.text.trim()}\n`)
    .join("\n");
}
