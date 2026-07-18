// On-device transcription. Two backends, selected by CUPCAT_WHISPER_KIND:
//   "openai" (dev default) — the Python `whisper` CLI on PATH; reads its JSON output file.
//   "cpp"    (bundled app)  — whisper.cpp `whisper-cli.exe`: we resample to 16 kHz mono with
//                             ffmpeg first (whisper.cpp requires it), then parse its JSON.
// Results are cached per source path so the timeline tools don't re-transcribe.

import { mkdir } from "node:fs/promises";
import { cpus } from "node:os";
import { basename, dirname, extname, join } from "node:path";
import { FFMPEG_BIN, mediaDir } from "./config";
import { audioSilences } from "./ffmpeg";
import { run } from "./proc";

const WHISPER_KIND = process.env.CUPCAT_WHISPER_KIND ?? "openai";
const WHISPER_BIN = process.env.CUPCAT_WHISPER_BIN ?? "whisper";
const WHISPER_MODEL = process.env.CUPCAT_WHISPER_MODEL ?? "base";
const WHISPER_MODEL_DIR = process.env.CUPCAT_WHISPER_MODEL_DIR ?? "D:/whisper-models";
const WHISPER_MODEL_FILE = process.env.CUPCAT_WHISPER_MODEL_FILE ?? "";

/** Best ggml model actually present, in quality order. large-v3-turbo (bundled since 0.9.0) makes
 * Italian and other non-English languages essentially error-free where `base` mangled words —
 * A/B on real footage: base "facete allarcata / di rei fotonico" → turbo "faccette all'arcata /
 * direi fotonico", with proper punctuation (which the AI clip curation and captions rely on).
 * An explicit CUPCAT_WHISPER_MODEL_FILE still wins when it exists. */
let bestModelCache: string | null | undefined;
async function resolveBestModel(): Promise<string | null> {
  if (bestModelCache !== undefined) return bestModelCache;
  const sidecarDir = WHISPER_BIN.includes("/") || WHISPER_BIN.includes("\\") ? dirname(WHISPER_BIN) : "";
  const candidates = [
    WHISPER_MODEL_FILE,
    sidecarDir ? join(sidecarDir, "ggml-large-v3-turbo-q5.bin") : "",
    join(WHISPER_MODEL_DIR, "ggml-large-v3-turbo-q5.bin"),
    sidecarDir ? join(sidecarDir, "ggml-base.bin") : "",
    join(WHISPER_MODEL_DIR, "ggml-base.bin"),
  ].filter(Boolean);
  for (const c of candidates) {
    if (await Bun.file(c).exists()) {
      bestModelCache = c;
      return c;
    }
  }
  bestModelCache = null;
  return null;
}

export interface TWord {
  start: number;
  end: number;
  word: string;
}
export interface TSegment {
  start: number;
  end: number;
  text: string;
}
export interface Transcript {
  language: string;
  segments: TSegment[];
  words: TWord[];
}

const cache = new Map<string, Transcript>();

// Whisper (both the openai CLI and whisper.cpp) is known to "hallucinate" text over silence or
// low-level noise — a clean/silent recording should transcribe to nothing, not a stock phrase. These
// are the common, well-documented hallucinated fillers across Whisper models/languages.
const HALLUCINATION_PHRASES = new Set([
  "thank you", "thank you.", "thanks for watching", "thanks for watching.", "please subscribe",
  "subscribe to my channel", "like and subscribe", "don't forget to subscribe", "bye bye", "bye.",
  "see you next time", "goodbye", "[music]", "(music)", "[applause]", "(applause)", "[silence]",
  "(silence)", "www.amara.org", "subtitles by the amara.org community", "translated by",
  "sottotitoli e revisione a cura di qtss", "grazie per l'attenzione", "grazie per aver guardato",
  "iscrivetevi al canale", "sottotitoli a cura di", "www.zootecnicavipiteno.it",
]);
const isHallucinatedPhrase = (text: string): boolean => {
  const norm = text.trim().toLowerCase().replace(/[.!?…]+$/, "");
  return HALLUCINATION_PHRASES.has(norm) || HALLUCINATION_PHRASES.has(`${norm}.`);
};

/** Drop transcript words/segments that are almost certainly hallucinated: text whisper invented over
 * a stretch ffmpeg independently measures as silence, or one of the well-known stock phrases models
 * default to when they have nothing real to transcribe. Cross-validating against real silence
 * detection (rather than trusting whisper's own confidence fields, which differ or are absent across
 * backends) is what makes "a clean tone yields zero lines" hold regardless of backend. */
async function stripHallucinations(path: string, t: Transcript): Promise<Transcript> {
  let silences: { startSeconds: number; endSeconds: number }[] = [];
  try {
    silences = await audioSilences(path, -35, 0.4);
  } catch {
    /* best-effort: fall through to phrase-only filtering below */
  }
  const inSilence = (start: number, end: number): boolean => {
    const dur = Math.max(0.001, end - start);
    for (const s of silences) {
      const overlap = Math.min(end, s.endSeconds) - Math.max(start, s.startSeconds);
      if (overlap / dur > 0.7) return true;
    }
    return false;
  };
  const snapped = snapWordsToSpeech(t.words, silences);
  const words = snapped.filter((w) => !isHallucinatedPhrase(w.word) && !inSilence(w.start, w.end));
  const segments = t.segments.filter((s) => !isHallucinatedPhrase(s.text) && !inSilence(s.start, s.end));
  return { ...t, segments, words };
}

/** Re-anchor real words that whisper timestamped inside measured silence. Whisper's token
 * timestamps compress the first words of a segment into any leading silence (a 3s quiet intro
 * puts "hi guys" at 0.0s while speech starts at 3.3s) — without this, those words are either
 * dropped as hallucinations or captioned seconds early. A mistimed word is pushed forward to
 * the end of its silence (stacking sequentially), but only when real speech follows the
 * silence — trailing-silence text is left in place so the hallucination filter still kills it. */
export function snapWordsToSpeech(
  words: TWord[],
  silences: { startSeconds: number; endSeconds: number }[],
): TWord[] {
  if (silences.length === 0 || words.length === 0) return words;
  const silenceOf = (w: TWord) => {
    const dur = Math.max(0.001, w.end - w.start);
    for (const s of silences) {
      const overlap = Math.min(w.end, s.endSeconds) - Math.max(w.start, s.startSeconds);
      if (overlap / dur > 0.7) return s;
    }
    return null;
  };
  const out = words.map((w) => ({ ...w }));
  let lastGood = -1;
  for (let i = out.length - 1; i >= 0; i--) {
    if (!silenceOf(out[i]!)) {
      lastGood = i;
      break;
    }
  }
  for (let i = 0; i < lastGood; i++) {
    const w = out[i]!;
    const sil = silenceOf(w);
    if (!sil) continue;
    const target = Math.max(sil.endSeconds, i > 0 ? out[i - 1]!.start + 0.02 : 0);
    // A long quiet intro can legitimately displace head words by many seconds (trailing text is
    // already excluded via lastGood); only truly absurd offsets are left to the drop filter.
    if (target - w.start > 10) continue;
    const dur = Math.min(Math.max(0.05, w.end - w.start), 0.15);
    w.start = target;
    w.end = target + dur;
  }
  // Keep starts monotonic so per-word (karaoke) timing never runs backwards.
  for (let i = 1; i < out.length; i++) {
    const p = out[i - 1]!;
    const w = out[i]!;
    if (w.start < p.start + 0.02) w.start = p.start + 0.02;
    if (w.end < w.start + 0.03) w.end = w.start + 0.03;
  }
  return out;
}

/** Detect retakes / false starts in a word-level transcript: the speaker abandons a sentence and
 * re-says it ("So today we— So today we're going to…"). Sentences are word runs separated by ≥0.5 s
 * gaps; when two consecutive sentences START with the same 2+ words (normalized) and the pause
 * between them is short, the EARLIER one is the abandoned take — return its whole time range so the
 * caller deletes the full broken sentence, not just its tail. */
export function detectRetakes(words: TWord[]): { start: number; end: number; text: string }[] {
  const norm = (w: string) => w.toLowerCase().replace(/[^\p{L}\p{N}']/gu, "");
  const sentences: TWord[][] = [];
  let cur: TWord[] = [];
  for (const w of words) {
    if (!norm(w.word)) continue;
    if (cur.length > 0 && w.start - cur[cur.length - 1]!.end >= 0.5) {
      sentences.push(cur);
      cur = [];
    }
    cur.push(w);
  }
  if (cur.length) sentences.push(cur);

  const out: { start: number; end: number; text: string }[] = [];
  for (let i = 0; i + 1 < sentences.length; i++) {
    const a = sentences[i]!;
    const b = sentences[i + 1]!;
    if (a.length < 2 || b.length < 2) continue; // single-word repeats are the stutter detector's job
    const gap = b[0]!.start - a[a.length - 1]!.end;
    if (gap > 3) continue; // a retake follows its false start quickly
    if (norm(a[0]!.word) === norm(b[0]!.word) && norm(a[1]!.word) === norm(b[1]!.word)) {
      out.push({ start: a[0]!.start, end: a[a.length - 1]!.end, text: a.map((w) => w.word).join(" ") });
    }
  }
  return out;
}

// The result cache only fills once a run COMPLETES — without in-flight dedup, two tools asking for
// the same file concurrently (e.g. get_transcript + timeline_view in one agent turn) each spawn their
// own ffmpeg-resample + whisper run, doubling CPU and racing on the same output files.
const inFlight = new Map<string, Promise<Transcript | null>>();

export async function transcribe(path: string, language?: string): Promise<Transcript | null> {
  const key = `${WHISPER_KIND}::${path}::${language ?? ""}`;
  const cached = cache.get(key);
  if (cached) return cached;
  const running = inFlight.get(key);
  if (running) return running;
  const job = (async () => {
    const raw = WHISPER_KIND === "cpp" ? await transcribeCpp(path, language) : await transcribeOpenAI(path, language);
    const result = raw ? await stripHallucinations(path, raw) : raw;
    if (result) cache.set(key, result);
    return result;
  })();
  inFlight.set(key, job);
  try {
    return await job;
  } finally {
    inFlight.delete(key);
  }
}

/** Split a segment's text into evenly-timed words (whisper.cpp doesn't give word timings by default). */
function approximateWords(seg: TSegment): TWord[] {
  const tokens = seg.text.trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return [];
  const per = (seg.end - seg.start) / tokens.length;
  return tokens.map((w, i) => ({ start: seg.start + i * per, end: seg.start + (i + 1) * per, word: w }));
}

// ── whisper.cpp ──────────────────────────────────────────────────────────────

interface CppToken {
  text: string;
  offsets?: { from: number; to: number };
}
interface CppJson {
  result?: { language?: string };
  transcription?: { offsets?: { from: number; to: number }; text: string; tokens?: CppToken[] }[];
}

/** Merge whisper.cpp subword tokens (" termin" + "ato") into words with their real attention
 * timestamps. A new word starts at a token with a leading space; special tokens like [_BEG_]
 * are skipped. Falls back to even splitting when the segment has no usable tokens. */
function tokensToWords(seg: TSegment, tokens: CppToken[] | undefined): TWord[] {
  if (!tokens?.length) return approximateWords(seg);
  const words: TWord[] = [];
  let text = "";
  let from = 0;
  let to = 0;
  const flush = () => {
    const w = text.trim();
    if (w) words.push({ start: from / 1000, end: to / 1000, word: w });
    text = "";
  };
  for (const tk of tokens) {
    if (/^\[_.+\]$/.test(tk.text)) continue; // [_BEG_], [_TT_574]… markers carry no text
    if (text && tk.text.startsWith(" ")) flush();
    if (!text) from = tk.offsets?.from ?? 0;
    text += tk.text;
    to = tk.offsets?.to ?? to;
  }
  flush();
  // Degenerate token timing (all zero-width at 0) → the even split is better than nothing.
  if (words.length && words.every((w) => w.end - w.start <= 0 && w.start === words[0]!.start)) {
    return approximateWords(seg);
  }
  return words;
}

async function transcribeCpp(path: string, language?: string): Promise<Transcript | null> {
  const outDir = join(mediaDir, ".transcripts");
  await mkdir(outDir, { recursive: true });
  const base = basename(path, extname(path));
  const wav = join(outDir, `${base}.16k.wav`);

  const conv = await run(FFMPEG_BIN, ["-y", "-i", path, "-ar", "16000", "-ac", "1", wav]);
  if (conv.code !== 0) return null;

  const model = await resolveBestModel();
  if (!model) return null;
  const outBase = join(outDir, base);
  // whisper.cpp defaults to 4 threads — the large model runs ~1.7x faster at 12 on a 16-core box.
  // Cap below core count so the UI and any export stay responsive while transcribing.
  const threads = Math.min(12, Math.max(4, cpus().length - 4));
  // -ojf (full JSON) adds per-token attention timestamps in the same single run — the source of
  // real word-level timing (the plain -oj JSON only has segment offsets). Verified on real
  // footage: mid-segment token offsets track measured speech onsets/pauses within ~50ms.
  const args = ["-m", model, "-f", wav, "-ojf", "-of", outBase, "-t", String(threads)];
  if (language) args.push("-l", language);
  const { code } = await run(WHISPER_BIN, args);
  const jsonPath = `${outBase}.json`;
  const f = Bun.file(jsonPath);
  if (!(await f.exists())) return code === 0 ? { language: language ?? "en", segments: [], words: [] } : null;

  let data: CppJson;
  try {
    data = (await f.json()) as CppJson;
  } catch {
    return null;
  }
  const raw = (data.transcription ?? [])
    .map((t) => ({
      seg: { start: (t.offsets?.from ?? 0) / 1000, end: (t.offsets?.to ?? 0) / 1000, text: t.text.trim() },
      tokens: t.tokens,
    }))
    .filter((r) => r.seg.text.length > 0);
  const segments: TSegment[] = raw.map((r) => r.seg);
  const words: TWord[] = raw.flatMap((r) => tokensToWords(r.seg, r.tokens));
  return { language: data.result?.language ?? language ?? "en", segments, words };
}

// ── OpenAI whisper (Python CLI) ──────────────────────────────────────────────

interface OpenAiJson {
  language?: string;
  segments?: { start: number; end: number; text: string; words?: { start: number; end: number; word: string }[] }[];
}

async function transcribeOpenAI(path: string, language?: string): Promise<Transcript | null> {
  const outDir = join(mediaDir, ".transcripts");
  await mkdir(outDir, { recursive: true });
  await mkdir(WHISPER_MODEL_DIR, { recursive: true });

  const args = [
    path,
    "--model",
    WHISPER_MODEL,
    "--model_dir",
    WHISPER_MODEL_DIR,
    "--output_format",
    "json",
    "--output_dir",
    outDir,
    "--word_timestamps",
    "True",
    "--fp16",
    "False",
    "--verbose",
    "False",
  ];
  if (language) args.push("--language", language);

  const { code } = await run(WHISPER_BIN, args, { env: { PYTHONUTF8: "1", PYTHONIOENCODING: "utf-8" } });
  const jsonPath = join(outDir, `${basename(path, extname(path))}.json`);
  const f = Bun.file(jsonPath);
  if (!(await f.exists())) return code === 0 ? { language: language ?? "en", segments: [], words: [] } : null;

  let data: OpenAiJson;
  try {
    data = (await f.json()) as OpenAiJson;
  } catch {
    return null;
  }
  const segments: TSegment[] = (data.segments ?? []).map((s) => ({ start: s.start, end: s.end, text: s.text.trim() }));
  const words: TWord[] = [];
  for (const s of data.segments ?? []) for (const w of s.words ?? []) words.push({ start: w.start, end: w.end, word: w.word.trim() });
  return { language: data.language ?? language ?? "en", segments, words };
}

/** Which model transcription will actually use — for diagnostics (feedback bundles). */
export async function whisperModelInfo(): Promise<string> {
  const m = await resolveBestModel();
  if (!m) return "no model found (transcription unavailable)";
  const name = m.replace(/\\/g, "/").split("/").pop() ?? m;
  return `${name} (${WHISPER_KIND})`;
}
