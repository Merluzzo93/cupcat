// Footage repair, all of it local and free: stabilization, audio/video denoise, deflicker and
// music ducking. Every one of these is an ffmpeg filter that CupCat's bundled build already ships —
// no model to download, no service to call, nothing added to the installer.
//
// Each entry point renders a NEW file and leaves the source untouched, the same contract as
// auto_clips and blur_faces: results are ordinary library assets you can cut, stack and export.

import { join } from "node:path";
import { mkdir } from "node:fs/promises";
import { exportsDir, FFMPEG_BIN } from "./config";
import { probeMedia, withTranscodeSlot } from "./ffmpeg";
import { run } from "./proc";

export interface EnhanceResult {
  file: string;
  note: string;
}

const stamp = () => new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");

const baseName = (p: string) => p.replace(/\\/g, "/").split("/").pop()?.replace(/\.[^.]+$/, "") ?? "clip";

/** Encoder settings shared by every repair render: visually lossless, widely playable. */
const V_ARGS = ["-c:v", "libx264", "-preset", "medium", "-crf", "17", "-pix_fmt", "yuv420p", "-movflags", "+faststart"];

async function outPath(src: string, suffix: string): Promise<string> {
  await mkdir(exportsDir, { recursive: true });
  return join(exportsDir, `${baseName(src)}-${suffix}-${stamp()}.mp4`);
}

/**
 * Two-pass stabilization (vidstabdetect → vidstabtransform).
 *
 * The motion file is written into exportsDir and referenced by BARE NAME with cwd set there: a
 * Windows absolute path carries a drive colon, and a colon inside an ffmpeg filter argument is an
 * option separator — passing the full path silently produces no output.
 */
export async function stabilizeVideo(
  src: string,
  opts: { strength?: number; onProgress?: (t: string) => void } = {},
): Promise<EnhanceResult> {
  const progress = opts.onProgress ?? (() => {});
  const strength = Math.min(10, Math.max(1, opts.strength ?? 5));
  const shakiness = Math.min(10, Math.max(1, Math.round(strength)));
  const smoothing = Math.round(10 + strength * 4); // frames of look-ahead/behind
  await mkdir(exportsDir, { recursive: true });
  const trf = `_vidstab_${stamp()}.trf`;

  progress("Analysing camera shake…");
  const det = await withTranscodeSlot(() =>
    run(FFMPEG_BIN, ["-y", "-i", src, "-vf", `vidstabdetect=shakiness=${shakiness}:accuracy=15:result=${trf}`, "-an", "-f", "null", "-"], {
      cwd: exportsDir,
    }),
  );
  if (det.code !== 0) throw new Error(`Shake analysis failed: ${det.stderr.slice(-300)}`);

  progress("Smoothing the shot…");
  const out = await outPath(src, "stabilized");
  // crop=black keeps the original framing and fills the edges rather than zooming in; unsharp puts
  // back the small amount of detail the warp costs.
  const chain = `vidstabtransform=input=${trf}:smoothing=${smoothing}:crop=black,unsharp=5:5:0.8:3:3:0.4`;
  const probe = await probeMedia(src);
  const tr = await withTranscodeSlot(() =>
    run(FFMPEG_BIN, ["-y", "-i", src, "-vf", chain, ...V_ARGS, ...(probe.hasAudio ? ["-c:a", "copy"] : ["-an"]), out], { cwd: exportsDir }),
  );
  if (tr.code !== 0 || !(await Bun.file(out).exists())) throw new Error(`Stabilization failed: ${tr.stderr.slice(-300)}`);
  return { file: out, note: `stabilized (strength ${strength}/10)` };
}

/**
 * Clean up a voice recording: spectral denoise, optional hum removal, and EBU R128 loudness so the
 * result sits at a broadcast-normal level instead of wherever it was recorded.
 *
 * afftdn rather than arnndn: arnndn needs an .rnnn model file that isn't part of the bundle, while
 * afftdn is self-contained and handles the usual room tone / air-conditioning / hiss.
 */
export async function enhanceAudio(
  src: string,
  opts: { strength?: number; removeHum?: boolean; normalize?: boolean; onProgress?: (t: string) => void } = {},
): Promise<EnhanceResult> {
  const progress = opts.onProgress ?? (() => {});
  const probe = await probeMedia(src);
  if (!probe.hasAudio) throw new Error("This media has no audio track to clean up.");
  const strength = Math.min(10, Math.max(1, opts.strength ?? 5));
  const nf = -(10 + strength * 3); // noise floor: stronger = more aggressive gate

  const af: string[] = [`afftdn=nf=${nf}:tn=1`];
  // Mains hum sits at 50Hz (EU) / 60Hz (US) plus harmonics; a high-pass below speech clears both
  // that and rumble without touching the voice.
  if (opts.removeHum !== false) af.push("highpass=f=80");
  if (opts.normalize !== false) af.push("loudnorm=I=-16:TP=-1.5:LRA=11");

  progress("Cleaning the audio…");
  const out = await outPath(src, "clean-audio");
  const isVideo = (probe.width ?? 0) > 0;
  const r = await withTranscodeSlot(() =>
    run(FFMPEG_BIN, [
      "-y",
      "-i",
      src,
      "-af",
      af.join(","),
      ...(isVideo ? ["-c:v", "copy"] : []), // picture untouched: only the audio is re-encoded
      "-c:a",
      "aac",
      "-b:a",
      "192k",
      "-ar",
      "48000",
      out,
    ]),
  );
  if (r.code !== 0 || !(await Bun.file(out).exists())) throw new Error(`Audio cleanup failed: ${r.stderr.slice(-300)}`);
  const bits = ["denoised", opts.removeHum !== false ? "hum removed" : "", opts.normalize !== false ? "levelled" : ""].filter(Boolean);
  return { file: out, note: bits.join(", ") };
}

/** Grain / sensor-noise reduction for low-light footage. */
export async function denoiseVideo(
  src: string,
  opts: { strength?: number; onProgress?: (t: string) => void } = {},
): Promise<EnhanceResult> {
  const progress = opts.onProgress ?? (() => {});
  const strength = Math.min(10, Math.max(1, opts.strength ?? 4));
  // hqdn3d is the temporal+spatial workhorse and is fast; nlmeans is far better but costs minutes
  // per second of footage, so it stays off the default path.
  const luma = (strength * 0.8).toFixed(1);
  const chroma = (strength * 0.6).toFixed(1);
  const chain = `hqdn3d=${luma}:${chroma}:${(strength * 1.2).toFixed(1)}:${(strength * 0.9).toFixed(1)}`;
  progress("Removing grain…");
  const out = await outPath(src, "denoised");
  const probe = await probeMedia(src);
  const r = await withTranscodeSlot(() =>
    run(FFMPEG_BIN, ["-y", "-i", src, "-vf", chain, ...V_ARGS, ...(probe.hasAudio ? ["-c:a", "copy"] : ["-an"]), out]),
  );
  if (r.code !== 0 || !(await Bun.file(out).exists())) throw new Error(`Denoise failed: ${r.stderr.slice(-300)}`);
  return { file: out, note: `grain reduced (strength ${strength}/10)` };
}

/** Even out pulsing exposure — artificial lighting beating against the shutter, or a time-lapse. */
export async function deflickerVideo(src: string, opts: { onProgress?: (t: string) => void } = {}): Promise<EnhanceResult> {
  const progress = opts.onProgress ?? (() => {});
  progress("Evening out the flicker…");
  const out = await outPath(src, "deflickered");
  const probe = await probeMedia(src);
  const r = await withTranscodeSlot(() =>
    run(FFMPEG_BIN, ["-y", "-i", src, "-vf", "deflicker=mode=pm:size=10", ...V_ARGS, ...(probe.hasAudio ? ["-c:a", "copy"] : ["-an"]), out]),
  );
  if (r.code !== 0 || !(await Bun.file(out).exists())) throw new Error(`Deflicker failed: ${r.stderr.slice(-300)}`);
  return { file: out, note: "flicker evened out" };
}

/**
 * Duck a music bed under a voice track: sidechaincompress listens to the voice and pulls the music
 * down whenever someone speaks, then lets it back up. Renders a ducked copy of the MUSIC, so the
 * timeline just uses it in place of the original.
 */
export async function duckMusic(
  musicSrc: string,
  voiceSrc: string,
  opts: { amount?: number; onProgress?: (t: string) => void } = {},
): Promise<EnhanceResult> {
  const progress = opts.onProgress ?? (() => {});
  const amount = Math.min(10, Math.max(1, opts.amount ?? 6));
  const ratio = (2 + amount * 1.6).toFixed(1); // how hard the music is pushed down
  const threshold = (0.02 + (10 - amount) * 0.01).toFixed(3);

  const mProbe = await probeMedia(musicSrc);
  const vProbe = await probeMedia(voiceSrc);
  if (!mProbe.hasAudio) throw new Error("The music file has no audio track.");
  if (!vProbe.hasAudio) throw new Error("The voice file has no audio track.");

  progress("Ducking the music under the voice…");
  await mkdir(exportsDir, { recursive: true });
  const out = join(exportsDir, `${baseName(musicSrc)}-ducked-${stamp()}.m4a`);
  // attack fast enough not to clip the first syllable, release slow enough not to pump between words.
  // apad on the VOICE matters: sidechaincompress stops at its shortest input, so a music bed longer
  // than the speech would come back truncated — padding the sidechain with silence lets the music
  // run to its own full length (and it plays back un-ducked once the talking stops, which is right).
  const graph = `[1:a]aformat=channel_layouts=stereo,apad[voice];[0:a]aformat=channel_layouts=stereo[music];[music][voice]sidechaincompress=threshold=${threshold}:ratio=${ratio}:attack=20:release=400:makeup=1[out]`;
  const r = await withTranscodeSlot(() =>
    run(FFMPEG_BIN, ["-y", "-i", musicSrc, "-i", voiceSrc, "-filter_complex", graph, "-map", "[out]", "-c:a", "aac", "-b:a", "192k", "-ar", "48000", out]),
  );
  if (r.code !== 0 || !(await Bun.file(out).exists())) throw new Error(`Ducking failed: ${r.stderr.slice(-300)}`);
  return { file: out, note: `music ducked under the voice (amount ${amount}/10)` };
}

// ── loudness ────────────────────────────────────────────────────────────────

/** Where the audio is going. Each platform normalises to its own target and turns anything louder
 * DOWN, so mastering above the target only costs dynamic range — it never plays louder. */
export const LOUDNESS_TARGETS = {
  youtube: { i: -14, tp: -1, lra: 11, label: "YouTube / Spotify / Apple Music" },
  tiktok: { i: -14, tp: -1, lra: 9, label: "TikTok / Reels / Shorts" },
  podcast: { i: -16, tp: -1, lra: 11, label: "Podcast (Apple/Spotify spoken word)" },
  broadcast: { i: -23, tp: -2, lra: 7, label: "Broadcast EBU R128" },
  cinema: { i: -27, tp: -2, lra: 20, label: "Cinema / wide dynamics" },
} as const;

export type LoudnessTarget = keyof typeof LOUDNESS_TARGETS;

export interface LoudnessMeasurement {
  i: number; // integrated loudness, LUFS
  tp: number; // true peak, dBTP
  lra: number; // loudness range
  thresh: number;
  offset: number;
}

/** Parse loudnorm's print_format=json block out of ffmpeg's stderr. Pure — unit-tested. */
export function parseLoudnorm(stderr: string): LoudnessMeasurement | null {
  const start = stderr.lastIndexOf("{");
  const end = stderr.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    const j = JSON.parse(stderr.slice(start, end + 1)) as Record<string, string>;
    const num = (k: string) => {
      const v = Number.parseFloat(j[k] ?? "");
      return Number.isFinite(v) ? v : null;
    };
    const i = num("input_i");
    const tp = num("input_tp");
    const lra = num("input_lra");
    const thresh = num("input_thresh");
    const offset = num("target_offset");
    if (i === null || tp === null || lra === null || thresh === null) return null;
    return { i, tp, lra, thresh, offset: offset ?? 0 };
  } catch {
    return null;
  }
}

/** Measure a file's loudness without rendering anything. */
export async function measureLoudness(src: string, target: LoudnessTarget = "youtube"): Promise<LoudnessMeasurement | null> {
  const t = LOUDNESS_TARGETS[target];
  const r = await run(FFMPEG_BIN, [
    "-hide_banner", "-i", src, "-af", `loudnorm=I=${t.i}:TP=${t.tp}:LRA=${t.lra}:print_format=json`, "-f", "null", "-",
  ]);
  return parseLoudnorm(r.stderr);
}

/**
 * Normalise to a platform's loudness target using loudnorm's TWO-PASS mode: the first pass measures,
 * the second applies with those measurements fed back in. Single-pass loudnorm is a live estimator
 * and drifts on material whose level changes; two-pass lands on the target.
 */
export async function matchLoudness(
  src: string,
  opts: { target?: LoudnessTarget; onProgress?: (t: string) => void } = {},
): Promise<EnhanceResult & { before: number; after: number }> {
  const progress = opts.onProgress ?? (() => {});
  const key = (opts.target ?? "youtube") as LoudnessTarget;
  const t = LOUDNESS_TARGETS[key] ?? LOUDNESS_TARGETS.youtube;
  const probe = await probeMedia(src);
  if (!probe.hasAudio) throw new Error("This media has no audio track to normalise.");

  progress("Measuring loudness…");
  const m = await measureLoudness(src, key);
  if (!m) throw new Error("Couldn't measure this file's loudness.");

  progress(`Normalising to ${t.i} LUFS (${t.label})…`);
  const out = await outPath(src, `loudness-${key}`);
  const isVideo = (probe.width ?? 0) > 0;
  const af =
    `loudnorm=I=${t.i}:TP=${t.tp}:LRA=${t.lra}` +
    `:measured_I=${m.i}:measured_TP=${m.tp}:measured_LRA=${m.lra}:measured_thresh=${m.thresh}` +
    `:offset=${m.offset}:linear=true:print_format=summary`;
  const r = await withTranscodeSlot(() =>
    run(FFMPEG_BIN, [
      "-y", "-i", src, "-af", af,
      ...(isVideo ? ["-c:v", "copy"] : []), // picture untouched
      "-c:a", "aac", "-b:a", "192k", "-ar", "48000", out,
    ]),
  );
  if (r.code !== 0 || !(await Bun.file(out).exists())) throw new Error(`Loudness match failed: ${r.stderr.slice(-300)}`);
  const after = await measureLoudness(out, key);
  return {
    file: out,
    note: `${m.i.toFixed(1)} → ${(after?.i ?? t.i).toFixed(1)} LUFS for ${t.label}`,
    before: m.i,
    after: after?.i ?? t.i,
  };
}

// ── repair ──────────────────────────────────────────────────────────────────

/**
 * Repair a damaged recording, as opposed to merely cleaning a good one:
 *  - declick  — impulsive clicks/crackle from bad cables, edits or dropouts
 *  - declip   — rebuilds samples that were recorded past 0 dBFS and got flattened
 *  - deesser  — tames harsh sibilance from a close mic
 * Each stage is optional because applying one that isn't needed only costs quality.
 */
export async function repairAudio(
  src: string,
  opts: { declick?: boolean; declip?: boolean; deesser?: boolean; onProgress?: (t: string) => void } = {},
): Promise<EnhanceResult> {
  const progress = opts.onProgress ?? (() => {});
  const probe = await probeMedia(src);
  if (!probe.hasAudio) throw new Error("This media has no audio track to repair.");

  const stages: string[] = [];
  const done: string[] = [];
  if (opts.declip !== false) {
    stages.push("adeclip=window=55:overlap=75");
    done.push("clipping rebuilt");
  }
  if (opts.declick !== false) {
    stages.push("adeclick=window=55:overlap=75");
    done.push("clicks removed");
  }
  if (opts.deesser !== false) {
    stages.push("deesser=i=0.4:m=0.5:f=0.5");
    done.push("sibilance tamed");
  }
  if (stages.length === 0) throw new Error("Nothing to repair — every stage was disabled.");

  progress("Repairing the recording…");
  const out = await outPath(src, "repaired-audio");
  const isVideo = (probe.width ?? 0) > 0;
  const r = await withTranscodeSlot(() =>
    run(FFMPEG_BIN, [
      "-y", "-i", src, "-af", stages.join(","),
      ...(isVideo ? ["-c:v", "copy"] : []),
      "-c:a", "aac", "-b:a", "192k", "-ar", "48000", out,
    ]),
  );
  if (r.code !== 0 || !(await Bun.file(out).exists())) throw new Error(`Audio repair failed: ${r.stderr.slice(-300)}`);
  return { file: out, note: done.join(", ") };
}
