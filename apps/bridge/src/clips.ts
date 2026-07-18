// AI auto-clipping (OpusClip-style): pick the strongest self-contained moments of a long video via
// Claude, then batch-export each as a standalone short — optional 9:16 reframe + burned karaoke
// captions. Works directly on a library SOURCE file (no timeline required), like "upload → clips".
// Two curation modes: SPOKEN (transcript-driven, the default) and VISUAL (ClipAnything-style — scene
// detection + sampled frames judged by Claude vision; used when there is no usable speech, or forced
// with visual:true).

import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { oneShotText, oneShotVision } from "./agent-chat";
import { exportsDir, FFMPEG_BIN, FFPROBE_BIN } from "./config";
import { analyzeVideo, channelBalanceFix, frameToBase64, inputColorFix, probeMedia, withTranscodeSlot } from "./ffmpeg";
import { run } from "./proc";
import { transcribe, type Transcript, type TWord } from "./transcribe";

export interface ClipPick {
  startSeconds: number;
  endSeconds: number;
  title: string;
  hook: string;
  score: number; // 1-100 virality estimate
  reason: string;
}

export interface AutoClipResult {
  file: string;
  title: string;
  hook: string;
  score: number;
  startSeconds: number;
  endSeconds: number;
  reason: string;
}

export type CaptionStyle = "karaoke" | "clean" | "boxed" | "minimal";

export interface AutoClipsArgs {
  srcPath: string;
  durationSeconds: number;
  count: number;
  minSeconds: number;
  maxSeconds: number;
  aspect: "9:16" | "original";
  captions: boolean;
  captionStyle?: CaptionStyle; // default "karaoke"
  titleOverlay?: boolean; // burn the AI title top-center for the first seconds (default true)
  beepWords?: string[]; // words to censor with a beep (brand vocabulary)
  watermarkPath?: string; // brand-kit logo (PNG) overlaid top-right on every clip
  watermarkOpacity?: number; // watermark alpha 0..1 (default 0.85)
  guidance?: string; // free-form user prompt ("only the moments about X")
  visual?: boolean; // force purely-VISUAL curation (scene frames + Claude vision); auto when no speech
  language?: string;
  model?: string;
  onProgress?: (msg: string) => void;
}

const CURATION_SYSTEM = `You are an expert short-form video editor (TikTok/Reels/Shorts). You receive the timed transcript of a long video and must pick the strongest self-contained clips.

Rules for every clip you pick:
- SELF-CONTAINED: understandable with zero outside context; a complete thought with a payoff, never ending mid-sentence.
- HOOK: the first ~3 seconds must grab attention (a question, bold claim, emotion, or curiosity gap). Prefer starting exactly where a strong sentence begins.
- Respect the requested duration range and count. Clips must NOT overlap; spread picks across the whole video when quality allows.
- Cut points must land on sentence boundaries from the transcript (you'll see timestamps; pick times at the start of a first word and the end of a last word).
- "title": a short, punchy social-media title. "hook": the opening line/claim of the clip. Both in the SAME LANGUAGE as the transcript.
- Include exactly ONE relevant emoji in "title" (at the start or end). It brands the clip's name; it is stripped automatically from any burned-in overlay.
- "score": 1-100 virality estimate (hook strength, emotional pull, completeness, shareability). Be honest, not inflated.
- If the user gives guidance (a topic or instruction), it wins over general virality.

Answer with STRICT JSON only — an array like:
[{"start": 12.4, "end": 41.0, "title": "...", "hook": "...", "score": 78, "reason": "..."}]
No markdown fences, no commentary, no trailing text.`;

/** ClipAnything-style visual curation: no transcript — Claude judges sampled frames instead. */
const VISUAL_CURATION_SYSTEM = `You are an expert short-form video editor (TikTok/Reels/Shorts). This video has no usable speech, so you judge PURELY VISUALLY: you receive frames sampled from the video (numbered, each labeled with its exact timestamp) plus the list of detected scene changes, and you must pick the strongest self-contained clips.

Rules for every clip you pick:
- Judge by ACTION and COMPOSITION: motion and energy, faces and emotion, reveals and transformations, striking framing, light or color, anything a viewer would stop scrolling for.
- Frames are sparse samples: a clip is a [start, end] range in seconds that COVERS the strongest frame(s) — start a little before the standout frame so the action is entered naturally. Prefer starting/ending at a listed scene change.
- HOOK: the first ~3 seconds must be the most visually arresting part.
- Respect the requested duration range and count. Clips must NOT overlap; spread picks across the whole video when quality allows.
- "title": a short, punchy social-media title. "hook": one line describing the opening visual moment. Use the user's guidance language if any, else English.
- Include exactly ONE relevant emoji in "title" (at the start or end). It brands the clip's name; it is stripped automatically from any burned-in overlay.
- "score": 1-100 virality estimate (visual hook strength, motion, uniqueness, shareability). Be honest, not inflated.
- If the user gives guidance (a topic or instruction), it wins over general virality.

Answer with STRICT JSON only — an array like:
[{"start": 12.4, "end": 41.0, "title": "...", "hook": "...", "score": 78, "reason": "..."}]
No markdown fences, no commentary, no trailing text.`;

/** Format the transcript compactly for the curation prompt. The cap is sized for Claude's 200k-token
 * context: ~100k chars ≈ 25-30k tokens, which comfortably fits a 2-3 hour talk VERBATIM — a 1-hour
 * video (~50-60k chars) never gets downsampled. Downsampling only kicks in beyond that, trading some
 * pick quality for still-working curation on marathon footage. */
function transcriptForPrompt(tr: Transcript, maxChars = 100_000): string {
  const lines = tr.segments.map((s) => `[${s.start.toFixed(1)}-${s.end.toFixed(1)}] ${s.text.trim()}`);
  let out = lines.join("\n");
  if (out.length > maxChars) {
    // Keep global coverage rather than truncating the tail: drop every other segment until it fits.
    let kept = lines;
    while (out.length > maxChars && kept.length > 50) {
      kept = kept.filter((_, i) => i % 2 === 0);
      out = kept.join("\n");
    }
    out = `${out}\n[NOTE: transcript downsampled to fit — timestamps above are still exact]`;
  }
  return out;
}

function parsePicks(raw: string): ClipPick[] {
  // The model is told "no fences", but strip them anyway if present.
  const text = raw.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "").trim();
  const start = text.indexOf("[");
  const end = text.lastIndexOf("]");
  if (start < 0 || end <= start) throw new Error(`Claude returned no JSON array. First 200 chars: ${text.slice(0, 200)}`);
  const arr = JSON.parse(text.slice(start, end + 1)) as Array<Record<string, unknown>>;
  return arr
    .map((p) => ({
      startSeconds: Number(p.start ?? p.startSeconds ?? Number.NaN),
      endSeconds: Number(p.end ?? p.endSeconds ?? Number.NaN),
      title: String(p.title ?? "Clip"),
      hook: String(p.hook ?? ""),
      score: Math.max(1, Math.min(100, Math.round(Number(p.score ?? 50)) || 50)),
      reason: String(p.reason ?? ""),
    }))
    .filter((p) => Number.isFinite(p.startSeconds) && Number.isFinite(p.endSeconds) && p.endSeconds > p.startSeconds);
}

/** Snap a pick to word boundaries (start of first word, end of last word) + a small breathing pad. */
function snapToWords(pick: ClipPick, words: TWord[], durationSeconds: number): ClipPick {
  const PAD = 0.15;
  let start = pick.startSeconds;
  let end = pick.endSeconds;
  if (words.length) {
    // First word starting at/after the pick (tolerating 0.6s early) → its exact start.
    const first = words.find((w) => w.start >= start - 0.6) ?? words[0]!;
    if (Math.abs(first.start - start) < 2.5) start = first.start;
    // Last word ending at/before the pick end (tolerating 0.6s late) → its exact end.
    const lastCandidates = words.filter((w) => w.end <= end + 0.6);
    const last = lastCandidates.length ? lastCandidates[lastCandidates.length - 1]! : undefined;
    if (last && Math.abs(last.end - end) < 2.5) end = last.end;
  }
  start = Math.max(0, start - PAD);
  end = Math.min(durationSeconds, end + PAD);
  return { ...pick, startSeconds: Math.round(start * 1000) / 1000, endSeconds: Math.round(end * 1000) / 1000 };
}

/** Timestamps to sample for VISUAL curation: one frame at the midpoint of every scene (the segments
 * between detected scene changes), at most `maxFrames` spread evenly across the scene list. With
 * fewer than 3 detected changes the detector saw (nearly) one continuous shot — fall back to a
 * uniform sweep of `uniformCount` frames instead. Pure; exported for tests. */
export function sceneSampleTimes(sceneChanges: number[], durationSeconds: number, maxFrames = 20, uniformCount = 8): number[] {
  const dur = Math.max(0.1, durationSeconds);
  const EPS = 0.05;
  const cuts = [...new Set(sceneChanges.filter((t) => t > EPS && t < dur - EPS))].sort((a, b) => a - b);
  let times: number[];
  if (cuts.length < 3) {
    times = Array.from({ length: uniformCount }, (_, i) => ((i + 0.5) * dur) / uniformCount);
  } else {
    const bounds = [0, ...cuts, dur];
    times = [];
    for (let i = 0; i + 1 < bounds.length; i++) times.push((bounds[i]! + bounds[i + 1]!) / 2);
    if (times.length > maxFrames) {
      // Evenly spaced subset (always keeping the first and last scene) — global coverage over density.
      const idx = new Set<number>();
      for (let i = 0; i < maxFrames; i++) idx.add(Math.round((i * (times.length - 1)) / (maxFrames - 1)));
      times = [...idx].sort((a, b) => a - b).map((i) => times[i]!);
    }
  }
  return times.map((t) => Math.round(Math.min(Math.max(t, EPS), dur - EPS) * 1000) / 1000);
}

/** Snap a VISUAL pick's boundaries to the nearest detected scene change within ±`tolerance`s — with
 * no words there are no sentence boundaries, and shot changes are the natural cut points. Boundaries
 * with no scene change nearby stay put; a snap that would collapse/invert the clip is discarded.
 * Pure; exported for tests. */
export function snapToScenes(pick: ClipPick, sceneChanges: number[], durationSeconds: number, tolerance = 1.5): ClipPick {
  const nearest = (t: number): number => {
    let best = t;
    let bestDist = tolerance;
    for (const sc of sceneChanges) {
      const d = Math.abs(sc - t);
      if (d <= bestDist) {
        bestDist = d;
        best = sc;
      }
    }
    return best;
  };
  let start = nearest(pick.startSeconds);
  let end = nearest(pick.endSeconds);
  if (end - start < 1) {
    // Both boundaries snapped onto (nearly) the same cut — keep the model's own range instead.
    start = pick.startSeconds;
    end = pick.endSeconds;
  }
  start = Math.max(0, start);
  end = Math.min(durationSeconds, Math.max(start + 0.1, end));
  return { ...pick, startSeconds: Math.round(start * 1000) / 1000, endSeconds: Math.round(end * 1000) / 1000 };
}

/** Remove emoji (pictographs, ZWJ sequences, variation selectors, skin tones, keycaps) from text.
 * MEASURED: the ffmpeg sidecar's libass renders emoji as MONOCHROME outlines — burning "🔥 TEST 🚀"
 * via a "Segoe UI Emoji" ASS style onto gray gave signalstats SATAVG/SATMAX = 0 over the title zone
 * (DirectWrite finds the font but libass has no color-glyph support). So AI titles KEEP their emoji
 * in metadata/asset names, but the burned-in title overlay strips them. Pure; exported for tests. */
export function stripEmoji(s: string): string {
  return s
    .replace(/[\p{Extended_Pictographic}\u{1F1E6}-\u{1F1FF}\u{FE0F}\u{200D}\u{20E3}\u{1F3FB}-\u{1F3FF}\u{E0020}-\u{E007F}]/gu, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

/** Claude-vision payload guard. frameToBase64 emits lossless PNG — 16-bit for 10-bit sources
 * (iPhone HDR), measured at 2MB+ per 512px frame; 20 such frames would blow the API's ~32MB
 * request cap. Heavy frames get recompressed to JPEG (~60-120KB); small PNGs pass through.
 * Exported for tests. */
export async function frameForVision(pngB64: string, seq: number): Promise<{ data: string; mediaType: string }> {
  const asPng = { data: pngB64, mediaType: "image/png" };
  if (pngB64.length <= 700_000) return asPng; // ≤ ~0.5MB binary — fine as-is
  const src = join(exportsDir, `_clipvis_${seq}.png`);
  const dst = join(exportsDir, `_clipvis_${seq}.jpg`);
  try {
    await writeFile(src, Buffer.from(pngB64, "base64"));
    const { code } = await run(FFMPEG_BIN, ["-y", "-i", src, "-pix_fmt", "yuvj420p", "-q:v", "4", dst]);
    if (code !== 0) return asPng;
    const buf = await Bun.file(dst).arrayBuffer();
    if (buf.byteLength === 0) return asPng;
    return { data: Buffer.from(buf).toString("base64"), mediaType: "image/jpeg" };
  } catch {
    return asPng;
  } finally {
    await rm(src, { force: true }).catch(() => {});
    await rm(dst, { force: true }).catch(() => {});
  }
}

/** ASS time "h:mm:ss.cc". */
function assTime(t: number): string {
  const cs = Math.max(0, Math.round(t * 100));
  const h = Math.floor(cs / 360000);
  const m = Math.floor((cs % 360000) / 6000);
  const s = Math.floor((cs % 6000) / 100);
  const c = cs % 100;
  return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.${String(c).padStart(2, "0")}`;
}

/** Brand-template caption styles (OpusClip-style presets). All target a 1080×1920 PlayRes canvas;
 * libass scales to the actual video, so the same file works for "original" aspect too. */
const CAPTION_STYLES: Record<CaptionStyle, { style: string; karaoke: boolean }> = {
  // Word-by-word highlight (yellow active word) — the TikTok/Reels default.
  karaoke: { style: "Style: Cap,Arial,80,&H0000E6FF,&H00FFFFFF,&H00000000,&H96000000,-1,0,0,0,100,100,0,0,1,6,0,2,90,90,260,1", karaoke: true },
  // Plain bold white with a heavy outline — clean, no per-word color.
  clean: { style: "Style: Cap,Arial,80,&H00FFFFFF,&H00FFFFFF,&H00000000,&H96000000,-1,0,0,0,100,100,0,0,1,6,0,2,90,90,260,1", karaoke: false },
  // White on a solid dark box (BorderStyle 3) — maximal readability on busy footage.
  boxed: { style: "Style: Cap,Arial,74,&H00FFFFFF,&H00FFFFFF,&H00000000,&HB4000000,-1,0,0,0,100,100,0,0,3,10,0,2,90,90,260,1", karaoke: false },
  // Smaller, lighter, lower — discreet subtitles rather than social captions.
  minimal: { style: "Style: Cap,Arial,56,&H00FFFFFF,&H00FFFFFF,&H00000000,&H96000000,0,0,0,0,100,100,0,0,1,4,0,2,110,110,140,1", karaoke: false },
};

/** ASS for the words inside [clipStart, clipEnd], times rebased to the clip. Cues of ≤3 words
 * (karaoke styles highlight the active word via \k). Optionally burns the clip TITLE top-center for
 * the first seconds — the signature OpusClip look. */
function captionsAss(
  words: TWord[],
  clipStart: number,
  clipEnd: number,
  styleName: CaptionStyle,
  title?: string,
): string {
  const inRange = words.filter((w) => w.start >= clipStart - 0.05 && w.end <= clipEnd + 0.25);
  const cs = CAPTION_STYLES[styleName] ?? CAPTION_STYLES.karaoke;
  // WrapStyle 0 (smart wrap) — long cues fold to a second centered line instead of overflowing the
  // frame edges; 3 words per cue keeps most cues on one line even in wordy languages.
  const header = `[Script Info]
ScriptType: v4.00+
PlayResX: 1080
PlayResY: 1920
WrapStyle: 0
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
${cs.style}
Style: Title,Arial,66,&H00FFFFFF,&H00FFFFFF,&H00000000,&HA0000000,-1,0,0,0,100,100,0,0,3,12,0,8,70,70,120,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;
  const lines: string[] = [];
  if (title) {
    const tEnd = Math.min(4.5, Math.max(2, clipEnd - clipStart));
    const safe = title.replace(/[{}\\]/g, "");
    lines.push(`Dialogue: 1,${assTime(0)},${assTime(tEnd)},Title,,0,0,0,,${safe}`);
  }
  for (let i = 0; i < inRange.length; ) {
    const cue = inRange.slice(i, i + 3);
    i += cue.length;
    const start = Math.max(0, cue[0]!.start - clipStart);
    const end = Math.max(start + 0.2, cue[cue.length - 1]!.end - clipStart);
    const parts = cue.map((w, j) => {
      const text = w.word.trim().replace(/[{}\\]/g, "");
      if (!cs.karaoke) return text;
      const ws = Math.max(start, w.start - clipStart);
      const we = j + 1 < cue.length ? Math.max(ws, cue[j + 1]!.start - clipStart) : Math.max(ws, w.end - clipStart);
      const k = Math.max(1, Math.round((we - ws) * 100));
      return `{\\k${k}}${text}`;
    });
    lines.push(`Dialogue: 0,${assTime(start)},${assTime(end)},Cap,,0,0,0,,${parts.join(" ")}`);
  }
  return header + lines.join("\n") + "\n";
}

/** Audio filter that censors the given words with a 1 kHz beep (mute speech + tone in each range).
 * Returns null when no occurrences fall inside the clip. */
function beepFilter(words: TWord[], beepWords: string[], clipStart: number, clipEnd: number): string | null {
  const norm = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
  // Targets go through the SAME normalization as transcript words — otherwise any beep word with a
  // non-alphanumeric char ("f*ck", "dell'anima") silently never matches and ships uncensored.
  const targets = beepWords.map(norm).filter(Boolean);
  if (!targets.length) return null;
  const ranges = words
    .filter((w) => w.start >= clipStart - 0.05 && w.end <= clipEnd + 0.25 && targets.includes(norm(w.word)))
    .map((w) => ({ s: Math.max(0, w.start - clipStart - 0.04), e: w.end - clipStart + 0.04 }));
  if (!ranges.length) return null;
  const expr = ranges.map((r) => `between(t,${r.s.toFixed(3)},${r.e.toFixed(3)})`).join("+");
  // Mute the voice inside the ranges and mix in a gated 1 kHz tone.
  return (
    `[SRC]volume=volume='if(gt(${expr},0),0,1)':eval=frame[vmute];` +
    `sine=frequency=1000:sample_rate=48000[bp];` +
    // ffmpeg's sine source generates at ~0.1 amplitude, so gain 2.0 lands the beep around -14 dB —
    // clearly audible without blasting (measured: 0.30 gave an almost-inaudible -31 dB beep).
    `[bp]volume=volume='if(gt(${expr},0),2.0,0)':eval=frame[bpg];` +
    `[vmute][bpg]amix=inputs=2:duration=first:normalize=0[aout]`
  );
}

/** Escape a Windows path for use inside a quoted ffmpeg filter option value. Inside '...' the
 * tokenizer treats backslash literally and ' CLOSES the quote, so an apostrophe (user's watermark
 * path, or a Windows username like O'Neill in exportsDir) must be emitted as '\'' — quote-close,
 * escaped quote, quote-reopen — doubled for the graph-then-option two-level parse (empirically
 * verified: plain \' breaks with "No such file or directory", this form passes). */
function filterPath(p: string): string {
  return p.replace(/\\/g, "/").replace(/:/g, "\\:").replace(/'/g, "'\\\\\\''");
}

/** Social platforms normalize playback to ≈-14 LUFS; pre-normalizing every clip to that target keeps
 * exports from playing quieter/louder than the surrounding feed. Always the LAST audio filter, so it
 * measures the final mix (after channel balance / beep). */
const LOUDNORM = "loudnorm=I=-14:TP=-1.5:LRA=11";

/** True when the source carries 90°/270° rotation metadata (portrait phone footage). ffmpeg
 * autorotates on decode, so any width math from the probe must use the swapped dimensions. */
async function isRotated90(srcPath: string): Promise<boolean> {
  const { stdout, code } = await run(FFPROBE_BIN, [
    "-v", "error", "-select_streams", "v:0", "-show_entries", "stream_side_data=rotation", "-of", "json", srcPath,
  ]);
  if (code !== 0) return false;
  try {
    const streams = (JSON.parse(stdout) as { streams?: { side_data_list?: { rotation?: number }[] }[] }).streams;
    const rotation = streams?.[0]?.side_data_list?.find((sd) => typeof sd.rotation === "number")?.rotation ?? 0;
    return Math.abs(rotation) % 180 === 90;
  } catch {
    return false;
  }
}

function slug(s: string): string {
  return (
    s
      .toLowerCase()
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "clip"
  );
}

/** The whole OpusClip-style pipeline: transcribe → Claude curates (transcript, or scene frames via
 * vision when there's no usable speech) → snap → batch export. */
export async function autoClips(args: AutoClipsArgs): Promise<{ clips: AutoClipResult[]; folder: string; language: string }> {
  const progress = args.onProgress ?? (() => {});
  // Transcribe even when visual curation is forced — burned captions/word beeps still need the words.
  // Skip it only when visual:true and nothing downstream would use a transcript.
  let tr: Transcript | null = null;
  if (args.visual !== true || args.captions || args.beepWords?.length) {
    progress("Transcribing…");
    tr = await transcribe(args.srcPath, args.language);
  }
  // SPOKEN curation needs speech; otherwise fall through to VISUAL (ClipAnything-style) curation.
  const spoken = args.visual !== true && tr !== null && tr.segments.length > 0;
  const words = tr?.words ?? [];

  // A failed probe at import time leaves durationSeconds 0 — snapping would clamp every pick to
  // [0,0] and surface a misleading "no usable clips". Re-probe, then fall back to the transcript.
  if (!(args.durationSeconds > 0)) {
    const probe = await probeMedia(args.srcPath);
    const fromTranscript = tr?.segments.length ? (tr.segments[tr.segments.length - 1]?.end ?? 0) + 1 : 0;
    args = { ...args, durationSeconds: probe.durationSeconds > 0 ? probe.durationSeconds : fromTranscript };
  }

  let curated: ClipPick[];
  if (spoken) {
    progress("Asking Claude to pick the best moments…");
    const user = [
      `Video duration: ${args.durationSeconds.toFixed(1)}s. Transcript language: ${tr!.language}.`,
      `Pick up to ${args.count} clips, each between ${args.minSeconds}s and ${args.maxSeconds}s.`,
      args.guidance ? `USER GUIDANCE (this wins over general virality): ${args.guidance}` : "",
      "",
      "TRANSCRIPT:",
      transcriptForPrompt(tr!),
    ]
      .filter(Boolean)
      .join("\n");
    const raw = await oneShotText(CURATION_SYSTEM, user, { model: args.model });
    curated = parsePicks(raw).map((p) => snapToWords(p, words, args.durationSeconds));
  } else {
    // VISUAL mode: detect the shot structure, sample one frame per scene, let Claude vision judge
    // action/composition, then snap the picked ranges to shot boundaries instead of words.
    if (!(args.durationSeconds > 0)) {
      throw new Error("Cannot determine this video's duration (probe failed) — visual clip curation needs it to sample frames.");
    }
    progress("Detecting scenes…");
    const { sceneChanges } = await analyzeVideo(args.srcPath);
    const times = sceneSampleTimes(sceneChanges, args.durationSeconds);
    progress(`Sampling ${times.length} frames…`);
    const frames: { t: number; data: string; mediaType: string }[] = [];
    for (const t of times) {
      const png = await frameToBase64(args.srcPath, t, 512);
      if (png) frames.push({ t, ...(await frameForVision(png, frames.length)) });
    }
    if (frames.length === 0) throw new Error("Could not extract any frames from this video — the file may be unreadable.");
    progress("Asking Claude to pick the best visual moments…");
    const scListed = sceneChanges.slice(0, 300); // plenty for alignment; caps the prompt on fast-cut marathons
    const userText = [
      `Video duration: ${args.durationSeconds.toFixed(1)}s. No usable speech — judge the frames visually.`,
      `Pick up to ${args.count} clips, each between ${args.minSeconds}s and ${args.maxSeconds}s.`,
      args.guidance ? `USER GUIDANCE (this wins over general virality): ${args.guidance}` : "",
      scListed.length
        ? `Detected scene changes (s)${scListed.length < sceneChanges.length ? ` — first ${scListed.length} of ${sceneChanges.length}` : ""}: ${scListed.map((t) => t.toFixed(1)).join(", ")}`
        : "Detected scene changes: none (one continuous shot).",
      "",
      `FRAMES — the ${frames.length} images that follow are in this exact order:`,
      ...frames.map((f, i) => `Frame ${i + 1} → t=${f.t.toFixed(1)}s`),
    ]
      .filter(Boolean)
      .join("\n");
    const raw = await oneShotVision(
      VISUAL_CURATION_SYSTEM,
      userText,
      frames.map((f) => ({ data: f.data, mediaType: f.mediaType })),
      { model: args.model },
    );
    curated = parsePicks(raw).map((p) => snapToScenes(p, sceneChanges, args.durationSeconds));
  }
  let picks = curated
    .filter((p) => p.endSeconds - p.startSeconds >= Math.max(3, args.minSeconds * 0.6))
    .sort((a, b) => b.score - a.score)
    .slice(0, args.count);
  // Drop overlaps (keep the higher-scored one — list is already score-sorted).
  const kept: ClipPick[] = [];
  for (const p of picks) {
    if (!kept.some((k) => p.startSeconds < k.endSeconds && p.endSeconds > k.startSeconds)) kept.push(p);
  }
  picks = kept.sort((a, b) => a.startSeconds - b.startSeconds);
  if (picks.length === 0) throw new Error("Claude found no usable clips in this video (try different duration bounds or guidance).");

  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
  const folder = join(exportsDir, `clips-${stamp}`);
  await mkdir(folder, { recursive: true });

  const colorFix = await inputColorFix(args.srcPath);
  const balance = await channelBalanceFix(args.srcPath);
  const probe = await probeMedia(args.srcPath);
  // Brand-kit watermark (OpusClip-style): PNG overlaid top-right at 16% of the clip width, 3% margin.
  // The logo is pre-scaled to a FIXED pixel width computed from the probe — sizing it against the main
  // stream inside the graph would need the deprecated/fragile scale2ref.
  let watermark: { path: string; opacity: number; logoWidth: number } | null = null;
  if (args.watermarkPath && (await Bun.file(args.watermarkPath).exists()) && probe.width && probe.height) {
    const swap = await isRotated90(args.srcPath);
    const iw = swap ? probe.height : probe.width;
    const ih = swap ? probe.width : probe.height;
    // Clip width = displayed source width, or the post-crop width for 9:16 (same floor-to-even math
    // as the crop filter below).
    const outWidth = args.aspect === "9:16" ? Math.floor(Math.min(iw, (ih * 9) / 16) / 2) * 2 : iw;
    watermark = {
      path: args.watermarkPath,
      opacity: Math.min(1, Math.max(0, args.watermarkOpacity ?? 0.85)),
      logoWidth: Math.max(2, Math.round((0.16 * outWidth) / 2) * 2),
    };
  }
  // Captions require words — forced off when there is no transcript (visual mode on mute footage).
  const captionsOn = args.captions && words.length > 0;
  const results: AutoClipResult[] = [];
  for (let i = 0; i < picks.length; i++) {
    const p = picks[i]!;
    progress(`Exporting clip ${i + 1}/${picks.length}: ${p.title}`);
    const base = `clip-${String(i + 1).padStart(2, "0")}-${slug(p.title)}`;
    const out = join(folder, `${base}.mp4`);
    const vf: string[] = [];
    if (colorFix) vf.push(colorFix);
    if (args.aspect === "9:16") vf.push("crop=floor(min(iw\\,ih*9/16)/2)*2:ih");
    if (captionsOn || args.titleOverlay !== false) {
      const assPath = join(folder, `${base}.ass`);
      const wordsForCaps = captionsOn ? words : [];
      // The title keeps its emoji in metadata/asset names, but the burned overlay drops them —
      // libass renders emoji as ugly monochrome outlines (see stripEmoji).
      const title = args.titleOverlay !== false ? stripEmoji(p.title) || undefined : undefined;
      await writeFile(assPath, captionsAss(wordsForCaps, p.startSeconds, p.endSeconds, args.captionStyle ?? "karaoke", title), "utf8");
      vf.push(`subtitles=filename='${filterPath(assPath)}'`);
    }
    // -vf/-af and -filter_complex are mutually exclusive, so word censoring (beep) and/or the
    // watermark overlay move everything into one filter_complex; with neither, plain -vf/-af stays.
    const beep = probe.hasAudio && args.beepWords?.length ? beepFilter(words, args.beepWords, p.startSeconds, p.endSeconds) : null;
    const balArg = balance ? balance.replace(/^,/, "") : "";
    let filterArgs: string[];
    if (beep || watermark) {
      const graph: string[] = [];
      const vchain = vf.length ? vf.join(",") : "null";
      if (watermark) {
        graph.push(
          `[0:v]${vchain}[v0]`,
          `movie='${filterPath(watermark.path)}',format=rgba,colorchannelmixer=aa=${watermark.opacity},scale=${watermark.logoWidth}:-2[wm]`,
          "[v0][wm]overlay=x=W-w-W*0.03:y=H*0.03:eval=init[vout]",
        );
      } else {
        graph.push(`[0:v]${vchain}[vout]`);
      }
      if (probe.hasAudio) {
        const aSrc = `[0:a]${balArg ? `${balArg},` : ""}`;
        graph.push(beep ? beep.replace("[SRC]", aSrc).replace("[aout]", `,${LOUDNORM}[aout]`) : `${aSrc}${LOUDNORM}[aout]`);
      }
      filterArgs = ["-filter_complex", graph.join(";"), "-map", "[vout]", ...(probe.hasAudio ? ["-map", "[aout]"] : [])];
    } else {
      filterArgs = [
        ...(vf.length ? ["-vf", vf.join(",")] : []),
        ...(probe.hasAudio ? ["-af", balArg ? `${balArg},${LOUDNORM}` : LOUDNORM] : []),
      ];
    }
    const ffArgs = [
      "-y",
      "-ss",
      String(p.startSeconds),
      "-i",
      args.srcPath,
      "-t",
      String(Math.round((p.endSeconds - p.startSeconds) * 1000) / 1000),
      ...filterArgs,
      "-c:v",
      "libx264",
      "-preset",
      "medium",
      "-crf",
      "17",
      "-pix_fmt",
      "yuv420p",
      "-colorspace",
      "bt709",
      "-color_primaries",
      "bt709",
      "-color_trc",
      "bt709",
      "-color_range",
      "tv",
      // loudnorm resamples to 192 kHz internally — pin the output rate or the AAC comes out 96 kHz.
      ...(probe.hasAudio ? ["-c:a", "aac", "-b:a", "192k", "-ar", "48000"] : ["-an"]),
      "-movflags",
      "+faststart",
      out,
    ];
    const { code, stderr } = await withTranscodeSlot(() => run(FFMPEG_BIN, ffArgs));
    if (code !== 0 || !(await Bun.file(out).exists())) {
      throw new Error(`Export failed for "${p.title}" (${p.startSeconds}-${p.endSeconds}s): ${stderr.slice(-300)}`);
    }
    results.push({
      file: out,
      title: p.title,
      hook: p.hook,
      score: p.score,
      startSeconds: p.startSeconds,
      endSeconds: p.endSeconds,
      reason: p.reason,
    });
  }
  return { clips: results, folder, language: tr?.language ?? "visual" };
}
