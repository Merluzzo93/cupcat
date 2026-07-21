// Colour work driven by measurement rather than guesswork: CupCat samples frames, reads ffmpeg's
// own signalstats, and computes a correction from the numbers. Local, free, and repeatable.
//
// Everything here renders a NEW library asset and leaves the source alone, the same contract as the
// rest of the repair tools.

import { join } from "node:path";
import { mkdir } from "node:fs/promises";
import { exportsDir, FFMPEG_BIN } from "./config";
import { probeMedia, withTranscodeSlot } from "./ffmpeg";
import { run } from "./proc";

export interface GradeResult {
  file: string;
  note: string;
}

/** Averaged frame statistics. Y is luma 0-255; U/V are chroma, 128 = perfectly neutral. */
export interface ColorStats {
  yavg: number;
  ymin: number;
  ymax: number;
  uavg: number;
  vavg: number;
  satavg: number;
  frames: number;
}

const stamp = () => new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
const baseName = (p: string) => p.replace(/\\/g, "/").split("/").pop()?.replace(/\.[^.]+$/, "") ?? "clip";

/** Average the signalstats metadata ffmpeg prints per frame. Pure — unit-tested. */
export function parseSignalStats(stderr: string): ColorStats | null {
  const grab = (key: string): number[] =>
    [...stderr.matchAll(new RegExp(`signalstats\\.${key}=(-?[0-9.]+)`, "g"))]
      .map((m) => Number.parseFloat(m[1]!))
      .filter((n) => Number.isFinite(n));
  const y = grab("YAVG");
  if (y.length === 0) return null;
  const mean = (a: number[]) => (a.length ? a.reduce((s, n) => s + n, 0) / a.length : 0);
  const ymins = grab("YMIN");
  const ymaxs = grab("YMAX");
  return {
    yavg: mean(y),
    // AVERAGE per-frame floor/ceiling, not the union across the whole clip: one flash frame hitting
    // 0 and 255 would otherwise report "full range already" and suppress every contrast fix.
    ymin: ymins.length ? mean(ymins) : 0,
    ymax: ymaxs.length ? mean(ymaxs) : 255,
    uavg: mean(grab("UAVG")) || 128,
    vavg: mean(grab("VAVG")) || 128,
    satavg: mean(grab("SATAVG")),
    frames: y.length,
  };
}

/** Sample `count` frames spread across the clip and average their statistics. */
export async function analyzeColor(src: string, durationSeconds: number, count = 12): Promise<ColorStats | null> {
  // One decode with a select filter beats N seeks: fps is set so roughly `count` frames come out
  // regardless of length, and the whole thing stays a single pass.
  const dur = durationSeconds > 0 ? durationSeconds : 0;
  const rate = dur > 0 ? Math.max(0.02, count / dur) : 1;
  const r = await run(FFMPEG_BIN, [
    "-hide_banner", "-i", src,
    "-vf", `fps=${rate.toFixed(4)},signalstats,metadata=print`,
    "-an", "-f", "null", "-",
  ]);
  return parseSignalStats(r.stderr);
}

export interface ColorCorrection {
  brightness: number; // eq brightness, -1..1
  contrast: number; // eq contrast, 0..3 (1 = unchanged)
  saturation: number; // eq saturation, 0..3
  rGain: number; // colorchannelmixer red gain, 1 = unchanged
  bGain: number; // colorchannelmixer blue gain, 1 = unchanged
}

/** Luma range a well-exposed shot can legitimately sit in. A high-key fashion plate on white is
 * MEANT to average bright, and a moody night scene is meant to average dark — dragging either to
 * mid-grey is a downgrade, so correction only starts outside this band. */
const EXPOSURE_BAND = { lo: 70, hi: 185 };

// White balance is solved as a 2x2 system rather than dialled by a single "temperature", because a
// temperature control moves the blue-yellow and red-cyan axes together: correcting a blue cast
// dragged the red axis off neutral by almost as much as it fixed. These coefficients were measured
// on real footage — how far each chroma mean moves per unit of channel gain, including the smaller
// cross term each gain has on the other axis.
const WB = { uPerB: 76.7, vPerB: -15, uPerR: -26.7, vPerR: 80 };

/** How far from neutral the chroma mean has to sit before it's a cast worth correcting rather than
 * a deliberate look. */
const WB_DEADBAND = 1.5;

/**
 * Turn measured statistics into a correction.
 *
 * Deliberately conservative and clamped: an automatic pass that occasionally wrecks a shot is worse
 * than one that reliably improves it a little. `strength` scales every move.
 *
 * - exposure  — pull YAVG toward mid-grey (128)
 * - contrast  — expand only when the picture doesn't already use the full range
 * - white balance — U above 128 means a blue cast, V above 128 a red one; correct the opposite way
 * - saturation — lift only visibly flat footage, never push already-saturated shots further
 */
export function computeCorrection(s: ColorStats, strength = 1, ref?: ColorStats): ColorCorrection {
  const k = Math.min(1.5, Math.max(0, strength));
  const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

  // ── exposure ──
  // Matching a reference aims at ITS brightness. On its own, the clip is only moved when it falls
  // outside the acceptable band, and then only to the edge of that band — never all the way to
  // mid-grey, which is what flattened a legitimately bright shot in testing.
  let brightness = 0;
  if (ref) {
    brightness = clamp(((ref.yavg - s.yavg) / 255) * k, -0.3, 0.3);
  } else if (s.yavg < EXPOSURE_BAND.lo) {
    brightness = clamp(((EXPOSURE_BAND.lo - s.yavg) / 255) * k, 0, 0.3);
  } else if (s.yavg > EXPOSURE_BAND.hi) {
    brightness = clamp(((EXPOSURE_BAND.hi - s.yavg) / 255) * k, -0.3, 0);
  }

  // ── contrast ──
  // Only ever widened, never narrowed: a punchy shot must not be flattened by an "auto" pass.
  const span = Math.max(1, s.ymax - s.ymin);
  const contrast = ref ? 1 : clamp(span < 200 ? 1 + ((200 - span) / 200) * k * 0.5 : 1, 1, 1.35);

  // ── white balance ──
  // Solve for the colour temperature that lands the chroma means on neutral, using the measured
  // response above. U above 128 is a blue cast (needs a warmer, lower temperature); V above 128 is
  // a red one. Both means are used, since a cast usually shows in both.
  const targetU = ref ? ref.uavg : 128;
  const targetV = ref ? ref.vavg : 128;
  const wantU = (targetU - s.uavg) * k; // how far each chroma mean needs to travel
  const wantV = (targetV - s.vavg) * k;
  let rGain = 1;
  let bGain = 1;
  if (Math.abs(wantU) > WB_DEADBAND || Math.abs(wantV) > WB_DEADBAND) {
    // Cramer's rule on [uPerB uPerR; vPerB vPerR] · [db dr] = [wantU wantV]
    const det = WB.uPerB * WB.vPerR - WB.uPerR * WB.vPerB;
    const db = (wantU * WB.vPerR - WB.uPerR * wantV) / det;
    const dr = (WB.uPerB * wantV - wantU * WB.vPerB) / det;
    // ±12% is a firm correction without turning a cast into a colour effect.
    bGain = clamp(1 + db, 0.88, 1.12);
    rGain = clamp(1 + dr, 0.88, 1.12);
  }

  // ── saturation ──
  // Lifted only for genuinely flat/log-ish footage, and never reduced.
  const saturation = ref ? 1 : clamp(s.satavg > 0 && s.satavg < 10 ? 1 + ((10 - s.satavg) / 10) * k * 0.4 : 1, 1, 1.25);

  return { brightness, contrast, saturation, rGain, bGain };
}

/** Build the ffmpeg chain for a correction, omitting any stage that would be a no-op. */
export function correctionChain(c: ColorCorrection): string {
  const parts: string[] = [];
  const eq: string[] = [];
  if (Math.abs(c.brightness) > 0.002) eq.push(`brightness=${c.brightness.toFixed(4)}`);
  if (Math.abs(c.contrast - 1) > 0.005) eq.push(`contrast=${c.contrast.toFixed(4)}`);
  if (Math.abs(c.saturation - 1) > 0.005) eq.push(`saturation=${c.saturation.toFixed(4)}`);
  if (eq.length) parts.push(`eq=${eq.join(":")}`);
  // colorchannelmixer rather than colorbalance or colortemperature: colorbalance moved the chroma
  // mean by barely one unit at its extreme, and colortemperature couples the two axes together.
  // Per-channel gain is what the solve above is expressed in.
  if (Math.abs(c.rGain - 1) > 0.003 || Math.abs(c.bGain - 1) > 0.003) {
    parts.push(`colorchannelmixer=rr=${c.rGain.toFixed(4)}:bb=${c.bGain.toFixed(4)}`);
  }
  return parts.join(",");
}

const V_ARGS = ["-c:v", "libx264", "-preset", "medium", "-crf", "17", "-pix_fmt", "yuv420p", "-movflags", "+faststart"];

async function outPath(src: string, suffix: string): Promise<string> {
  await mkdir(exportsDir, { recursive: true });
  return join(exportsDir, `${baseName(src)}-${suffix}-${stamp()}.mp4`);
}

/**
 * Auto-correct a clip's exposure, contrast and white balance from its own statistics — or, when a
 * reference clip is given, move it toward that clip's look so two cameras cut together.
 */
export async function autoColor(
  src: string,
  opts: {
    durationSeconds?: number;
    strength?: number;
    referencePath?: string;
    referenceDuration?: number;
    onProgress?: (t: string) => void;
  } = {},
): Promise<GradeResult & { correction: ColorCorrection }> {
  const progress = opts.onProgress ?? (() => {});
  const probe = await probeMedia(src);
  const dur = opts.durationSeconds ?? probe.durationSeconds;

  progress("Measuring the picture…");
  const stats = await analyzeColor(src, dur);
  if (!stats) throw new Error("Couldn't read this clip's picture statistics.");

  let ref: ColorStats | undefined;
  if (opts.referencePath) {
    progress("Measuring the reference clip…");
    const r = await analyzeColor(opts.referencePath, opts.referenceDuration ?? 0);
    if (!r) throw new Error("Couldn't read the reference clip's picture statistics.");
    ref = r;
  }

  const correction = computeCorrection(stats, opts.strength ?? 1, ref);
  const chain = correctionChain(correction);
  if (!chain) {
    throw new Error(
      ref
        ? "These two clips already match — no correction needed."
        : "This clip is already well balanced — no correction needed.",
    );
  }

  progress(ref ? "Matching the look…" : "Applying the correction…");
  const out = await outPath(src, ref ? "colour-matched" : "auto-colour");
  const r = await withTranscodeSlot(() =>
    run(FFMPEG_BIN, ["-y", "-i", src, "-vf", chain, ...V_ARGS, ...(probe.hasAudio ? ["-c:a", "copy"] : ["-an"]), out]),
  );
  if (r.code !== 0 || !(await Bun.file(out).exists())) throw new Error(`Colour pass failed: ${r.stderr.slice(-300)}`);

  const bits: string[] = [];
  if (Math.abs(correction.brightness) > 0.002) bits.push(`exposure ${correction.brightness > 0 ? "+" : ""}${(correction.brightness * 100).toFixed(0)}%`);
  if (Math.abs(correction.contrast - 1) > 0.005) bits.push(`contrast ×${correction.contrast.toFixed(2)}`);
  if (Math.abs(correction.saturation - 1) > 0.005) bits.push(`saturation ×${correction.saturation.toFixed(2)}`);
  if (Math.abs(correction.rGain - 1) > 0.003 || Math.abs(correction.bGain - 1) > 0.003) {
    bits.push(`white balance ${correction.bGain < 1 ? "warmed" : "cooled"}`);
  }
  return { file: out, note: bits.join(", ") || "balanced", correction };
}

/** Apply a .cube / .3dl look-up table — the format every LUT pack ships. */
export async function applyLut(
  src: string,
  lutPath: string,
  opts: { intensity?: number; onProgress?: (t: string) => void } = {},
): Promise<GradeResult> {
  const progress = opts.onProgress ?? (() => {});
  if (!(await Bun.file(lutPath).exists())) throw new Error(`LUT file not found: ${lutPath}`);
  const intensity = Math.min(1, Math.max(0, opts.intensity ?? 1));
  const probe = await probeMedia(src);

  // The LUT path goes through ffmpeg's filter parser, where ':' separates options and '\' is an
  // escape — so a Windows path has to be escaped or the filter silently mis-parses (the same class
  // of bug that made vidstab produce nothing).
  const esc = lutPath.replace(/\\/g, "/").replace(/:/g, "\\:").replace(/'/g, "'\\\\\\''");

  progress("Applying the look…");
  const out = await outPath(src, "lut");
  // Partial intensity = blend the graded picture back over the original.
  const chain =
    intensity >= 0.999
      ? `lut3d=file='${esc}'`
      : `split[a][b];[b]lut3d=file='${esc}'[g];[a][g]blend=all_mode=normal:all_opacity=${intensity.toFixed(3)}`;
  const args =
    intensity >= 0.999
      ? ["-y", "-i", src, "-vf", chain, ...V_ARGS, ...(probe.hasAudio ? ["-c:a", "copy"] : ["-an"]), out]
      : ["-y", "-i", src, "-filter_complex", chain, ...V_ARGS, ...(probe.hasAudio ? ["-c:a", "copy"] : ["-an"]), out];
  const r = await withTranscodeSlot(() => run(FFMPEG_BIN, args));
  if (r.code !== 0 || !(await Bun.file(out).exists())) throw new Error(`Applying the LUT failed: ${r.stderr.slice(-300)}`);
  return { file: out, note: `${baseName(lutPath)} applied${intensity < 0.999 ? ` at ${(intensity * 100).toFixed(0)}%` : ""}` };
}
