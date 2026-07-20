// Chapter detection from what is actually said. Reuses the cached transcript, so on a video that
// has already been transcribed (captions, clipping, filler removal) this costs one short model call
// and nothing else — no second pass over the media.

import { oneShotText } from "./agent-chat";
import { transcribe, type Transcript } from "./transcribe";

export interface Chapter {
  startSeconds: number;
  title: string;
}

const SYSTEM = [
  "You split a video's transcript into chapters, the way a good YouTube description does.",
  "Reply with ONLY a JSON array, no prose, no code fence.",
  'Each element: {"t": 123.4, "title": "What this section covers"}',
  "Rules:",
  "- The first chapter MUST start at t=0.",
  "- Chapters follow topic changes, not fixed intervals. A section that runs long stays one chapter.",
  "- Titles are 2-6 words, concrete and specific to what is said. No numbering, no 'Part 1', no clickbait.",
  "- Write titles in the same language as the transcript.",
  "- Aim for one chapter every 1-4 minutes of material; never more than 20 in total.",
].join("\n");

/** Compact transcript for the prompt: one line per ~15s window, so long videos still fit. */
function transcriptDigest(tr: Transcript): string {
  const lines: string[] = [];
  let bucketStart = 0;
  let buf: string[] = [];
  const flush = () => {
    if (buf.length) lines.push(`[${bucketStart.toFixed(0)}s] ${buf.join(" ")}`);
    buf = [];
  };
  for (const seg of tr.segments) {
    if (seg.start - bucketStart >= 15) {
      flush();
      bucketStart = seg.start;
    }
    buf.push(seg.text.trim());
  }
  flush();
  return lines.join("\n");
}

/** Tolerant parse: strips prose/fences, drops malformed or out-of-range entries. Pure. */
export function parseChapters(raw: string, durationSeconds: number): Chapter[] {
  const start = raw.indexOf("[");
  const end = raw.lastIndexOf("]");
  if (start < 0 || end <= start) return [];
  let arr: unknown;
  try {
    arr = JSON.parse(raw.slice(start, end + 1));
  } catch {
    return [];
  }
  if (!Array.isArray(arr)) return [];
  const out: Chapter[] = [];
  for (const it of arr) {
    if (!it || typeof it !== "object") continue;
    const o = it as Record<string, unknown>;
    const t = typeof o.t === "number" ? o.t : Number.NaN;
    const title = typeof o.title === "string" ? o.title.trim() : "";
    if (!Number.isFinite(t) || t < 0 || !title) continue;
    if (durationSeconds > 0 && t > durationSeconds) continue;
    out.push({ startSeconds: Math.round(t * 10) / 10, title });
  }
  out.sort((a, b) => a.startSeconds - b.startSeconds);
  // Collapse chapters that land on the same second, and force the first one to 0 — a description
  // whose first chapter starts at 00:07 is rejected by YouTube.
  const dedup: Chapter[] = [];
  for (const c of out) {
    if (dedup.length && Math.abs(dedup[dedup.length - 1]!.startSeconds - c.startSeconds) < 1) continue;
    dedup.push(c);
  }
  if (dedup.length) dedup[0] = { ...dedup[0]!, startSeconds: 0 };
  return dedup;
}

/** mm:ss, or h:mm:ss past an hour — the format YouTube parses. */
export function chapterTimestamp(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const two = (n: number) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${two(m)}:${two(sec)}` : `${m}:${two(sec)}`;
}

export async function detectChapters(
  srcPath: string,
  opts: { durationSeconds?: number; language?: string; onProgress?: (t: string) => void } = {},
): Promise<{ chapters: Chapter[]; language: string }> {
  const progress = opts.onProgress ?? (() => {});
  progress("Reading what's said…");
  const tr = await transcribe(srcPath, opts.language);
  if (!tr || tr.segments.length === 0) {
    throw new Error("No speech found in this video — chapters are built from what's said.");
  }
  progress("Finding the topic changes…");
  const user = [
    `Video duration: ${(opts.durationSeconds ?? 0).toFixed(0)}s. Transcript language: ${tr.language}.`,
    "",
    "TRANSCRIPT (one line per ~15s):",
    transcriptDigest(tr),
  ].join("\n");
  const raw = await oneShotText(SYSTEM, user, { maxTokens: 2000 });
  const chapters = parseChapters(raw, opts.durationSeconds ?? 0);
  if (chapters.length === 0) throw new Error("Couldn't work out chapter boundaries for this video.");
  return { chapters, language: tr.language };
}
