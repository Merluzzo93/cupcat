// Local speaker diarization via the sherpa-onnx offline CLI (pyannote segmentation +
// speaker-embedding clustering). Fully offline like whisper/piper; the desktop shell ships
// sherpa-onnx-offline-speaker-diarization.exe + both .onnx models in sidecars/diarize/ and points
// CUPCAT_DIARIZE_BIN / CUPCAT_DIARIZE_DIR at it (main.rs), mirroring the whisper/piper wiring.
//
// Quality is best-effort/EXPERIMENTAL: clean multi-speaker recordings diarize well; overlapping
// speech, music beds, or very short turns degrade both boundaries and the speaker count.
// Results are cached per source path so get_transcript can tag words with speakers WITHOUT
// re-running (or ever auto-running) the slow diarization pass.

import { mkdir, readdir } from "node:fs/promises";
import { cpus } from "node:os";
import { basename, dirname, extname, join } from "node:path";
import { FFMPEG_BIN, mediaDir } from "./config";
import { run } from "./proc";

// Same env-override pattern as WHISPER_BIN in transcribe.ts: the desktop shell sets both vars to
// the bundled sidecars; dev mode falls back to a PATH lookup with models next to the exe.
const DIARIZE_BIN = process.env.CUPCAT_DIARIZE_BIN ?? "sherpa-onnx-offline-speaker-diarization";
const DIARIZE_DIR =
  process.env.CUPCAT_DIARIZE_DIR ??
  (DIARIZE_BIN.includes("/") || DIARIZE_BIN.includes("\\") ? dirname(DIARIZE_BIN) : "");

export interface SpeakerTurn {
  speaker: string;
  startSeconds: number;
  endSeconds: number;
}
export interface Diarization {
  turns: SpeakerTurn[];
  speakerCount: number;
}

// Per-source-path result cache. Keyed by path only (not options): the LAST explicit run wins, which
// is exactly what get_transcript should reflect when it tags words with speakers afterwards.
const cache = new Map<string, Diarization>();

/** The already-computed diarization for a media path, if identify_speakers ran on it this session.
 * get_transcript uses this to tag words without triggering a (slow) diarization run itself. */
export function cachedDiarization(path: string): Diarization | null {
  return cache.get(path) ?? null;
}

/** REPLACE the cached diarization for a path with human-corrected turns (set_speaker_turns).
 * identify_speakers can attribute similar voices to the wrong turn; when the user corrects the
 * attribution by ear, this override is what get_transcript's word tagging reflects from then on —
 * same last-write-wins semantics as re-running the diarizer. Turns are assumed validated (sorted,
 * non-overlapping) by the caller. */
export function overrideDiarization(path: string, turns: SpeakerTurn[]): Diarization {
  const result: Diarization = { turns, speakerCount: new Set(turns.map((t) => t.speaker)).size };
  cache.set(path, result);
  return result;
}

/** Locate the two .onnx models by NAME PATTERN rather than hardcoding filenames, so swapping the
 * bundled models (e.g. a different embedding extractor) keeps working without a code change. */
async function resolveModels(): Promise<{ segmentation: string; embedding: string } | null> {
  let onnx: string[] = [];
  try {
    onnx = (await readdir(DIARIZE_DIR)).filter((n) => n.toLowerCase().endsWith(".onnx"));
  } catch {
    return null;
  }
  const seg = onnx.find((n) => /segmentation/i.test(n));
  const emb = onnx.find((n) => !/segmentation/i.test(n));
  if (!seg || !emb) return null;
  return { segmentation: join(DIARIZE_DIR, seg), embedding: join(DIARIZE_DIR, emb) };
}

/** Parse the CLI's stdout turn lines ("0.318 -- 4.865 speaker_00") and relabel speakers "S1","S2"…
 * in order of first appearance — stable, human-readable labels that survive round-trips through
 * get_transcript word tags. */
function parseTurns(stdout: string): SpeakerTurn[] {
  const turns: SpeakerTurn[] = [];
  const labels = new Map<string, string>();
  for (const line of stdout.split(/\r?\n/)) {
    const m = line.match(/^\s*(\d+(?:\.\d+)?)\s*--\s*(\d+(?:\.\d+)?)\s+speaker[_ ]?(\d+)/i);
    if (!m) continue;
    const raw = m[3]!;
    let label = labels.get(raw);
    if (!label) {
      label = `S${labels.size + 1}`;
      labels.set(raw, label);
    }
    turns.push({ speaker: label, startSeconds: Number(m[1]), endSeconds: Number(m[2]) });
  }
  turns.sort((a, b) => a.startSeconds - b.startSeconds);
  return turns;
}

export interface DiarizeOptions {
  /** Exact speaker count when the user knows it — clustering to N is far more reliable than
   * threshold-based cluster discovery, so pass it whenever available. */
  numSpeakers?: number;
}

/**
 * Diarize the speakers in a media file. Converts to the 16 kHz mono wav sherpa-onnx requires,
 * runs the offline diarization CLI, and returns speaker turns labeled "S1","S2"… (order of first
 * appearance). Returns null when the sidecar/models are missing or the file has no usable audio;
 * throws with an actionable message when the CLI itself fails.
 */
export async function diarizeSpeakers(mediaPath: string, opts: DiarizeOptions = {}): Promise<Diarization | null> {
  const models = await resolveModels();
  if (!models) return null;

  const outDir = join(mediaDir, ".transcripts");
  await mkdir(outDir, { recursive: true });
  // Distinct suffix from whisper's "<base>.16k.wav": identify_speakers and get_transcript can run
  // concurrently on the same asset, and two ffmpeg processes racing on one output corrupt it.
  const wav = join(outDir, `${basename(mediaPath, extname(mediaPath))}.diar16k.wav`);
  const conv = await run(FFMPEG_BIN, ["-y", "-i", mediaPath, "-vn", "-ar", "16000", "-ac", "1", wav]);
  if (conv.code !== 0) return null;

  // Keep some cores free for the UI/export, same reasoning as the whisper thread cap. The CLI has
  // no global thread flag — segmentation and embedding each take their own.
  const threads = Math.min(8, Math.max(2, cpus().length - 4));
  const args = [
    `--segmentation.pyannote-model=${models.segmentation}`,
    `--embedding.model=${models.embedding}`,
    `--segmentation.num-threads=${threads}`,
    `--embedding.num-threads=${threads}`,
  ];
  const n = opts.numSpeakers;
  if (n && Number.isFinite(n) && n >= 1) {
    args.push(`--clustering.num-clusters=${Math.round(n)}`);
  } else {
    // Unknown speaker count: the sherpa-onnx default threshold (0.5) over-splits — the official
    // pyannote+eres2net example uses 0.90 (higher = fewer clusters), which keeps single-speaker
    // recordings from fragmenting into phantom speakers.
    args.push("--clustering.cluster-threshold=0.90");
  }
  args.push(wav);

  let res;
  try {
    res = await run(DIARIZE_BIN, args);
  } catch (e) {
    // Bun.spawn throws (rather than resolving nonzero) when the binary itself is missing.
    throw new Error(
      `Speaker diarization not runnable at "${DIARIZE_BIN}" — set CUPCAT_DIARIZE_BIN to sherpa-onnx-offline-speaker-diarization.exe (bundled under sidecars/diarize). (${e instanceof Error ? e.message : String(e)})`,
    );
  }
  const turns = parseTurns(res.stdout);
  if (res.code !== 0 && turns.length === 0) {
    const tail = res.stderr.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).slice(-3).join(" | ");
    throw new Error(`Speaker diarization failed (exit ${res.code})${tail ? `: ${tail}` : ""}`);
  }
  const result: Diarization = { turns, speakerCount: new Set(turns.map((t) => t.speaker)).size };
  cache.set(mediaPath, result);
  return result;
}

/** Which speaker (if any) was talking at a source-media time — used by get_transcript to tag
 * words. Words just outside a turn (up to 0.25s) still match: segmentation boundaries and whisper
 * word timestamps disagree by a hair around turn changes. */
export function speakerAt(d: Diarization, seconds: number): string | undefined {
  let best: { speaker: string; dist: number } | null = null;
  for (const t of d.turns) {
    const dist = seconds < t.startSeconds ? t.startSeconds - seconds : seconds > t.endSeconds ? seconds - t.endSeconds : 0;
    if (dist === 0) return t.speaker;
    if (dist <= 0.25 && (!best || dist < best.dist)) best = { speaker: t.speaker, dist };
  }
  return best?.speaker;
}
