// Picking the frame that becomes the cover.
//
// Scrubbing a thirty-minute video for a thumbnail is a genuinely tedious job, and the frames people
// land on by hand are usually the ones they happened to stop near. This does the sweep instead: it
// measures every sampled frame for the three things that actually disqualify a cover — motion blur,
// a washed-out or crushed exposure, and a flat picture with nothing in it — then asks the bundled
// face detector about the survivors, because a face is the single strongest thing a cover can have.
//
// Everything below the ffmpeg call is arithmetic on plain arrays, so the judgement can be tested
// without a video: the measuring is separated from the deciding on purpose.

import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { exportsDir, FFMPEG_BIN } from "./config";
import { detectFacesAt } from "./faceblur";
import { analyzeVideo, probeMedia, scrubProxyPath } from "./ffmpeg";
import { run } from "./proc";

/** The sample grid. Small enough that a whole film's worth of frames is a couple of megabytes,
 *  large enough that a blurred frame still looks blurred after the downscale. */
export const SAMPLE_W = 160;
export const SAMPLE_H = 90;

export interface FrameStats {
  /** Seconds into the source. */
  t: number;
  /** Variance of the Laplacian — the standard focus measure. Low means blurred or smeared. */
  sharpness: number;
  /** Mean luma, 0–255. */
  brightness: number;
  /** Standard deviation of luma — a frame with nothing in it has almost none. */
  contrast: number;
}

export interface FaceInfo {
  /** How many faces the detector found. */
  count: number;
  /** Fraction of the frame the largest face covers. */
  largest: number;
  /** True when that face touches the frame edge — half a head makes a poor cover. */
  clipped: boolean;
}

export interface ScoredFrame extends FrameStats {
  faces: FaceInfo | null;
  score: number;
  /** Why this frame scored as it did, in the order the weights are applied. */
  why: string;
}

/** Luma statistics and focus measure for one sampled grayscale frame. */
export function frameStats(gray: Uint8Array, w: number, h: number, t: number): FrameStats {
  let sum = 0;
  for (let i = 0; i < w * h; i++) sum += gray[i]!;
  const mean = sum / (w * h);
  let varSum = 0;
  for (let i = 0; i < w * h; i++) {
    const d = gray[i]! - mean;
    varSum += d * d;
  }
  // Variance of the 4-neighbour Laplacian over the interior. Its variance rather than its mean:
  // the mean rises with overall texture, while the variance rises with EDGES, which is what focus
  // is. A gently defocused frame keeps its texture and loses its edges.
  let lSum = 0;
  let lSqSum = 0;
  let n = 0;
  for (let y = 1; y < h - 1; y++) {
    const row = y * w;
    for (let x = 1; x < w - 1; x++) {
      const l = 4 * gray[row + x]! - gray[row + x - 1]! - gray[row + x + 1]! - gray[row - w + x]! - gray[row + w + x]!;
      lSum += l;
      lSqSum += l * l;
      n++;
    }
  }
  const lMean = n > 0 ? lSum / n : 0;
  return {
    t,
    sharpness: n > 0 ? lSqSum / n - lMean * lMean : 0,
    brightness: mean,
    contrast: Math.sqrt(varSum / (w * h)),
  };
}

/** 0 outside [lo, hi], 1 inside [loGood, hiGood], ramped between. */
function band(v: number, lo: number, loGood: number, hiGood: number, hi: number): number {
  if (v <= lo || v >= hi) return 0;
  if (v < loGood) return (v - lo) / (loGood - lo);
  if (v > hiGood) return (hi - v) / (hi - hiGood);
  return 1;
}

/** The value below which `p` of the sorted numbers fall. Used instead of the maximum so that one
 *  freak frame — a strobe, a flash of text — cannot flatten every other frame's score to nothing. */
export function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const s = [...values].sort((a, b) => a - b);
  const i = Math.min(s.length - 1, Math.max(0, Math.round((s.length - 1) * p)));
  return s[i]!;
}

export interface ScoreWeights {
  sharpness: number;
  contrast: number;
  exposure: number;
  faces: number;
}

const WITH_FACES: ScoreWeights = { sharpness: 0.34, contrast: 0.18, exposure: 0.18, faces: 0.3 };
// Nothing asked the detector, or it is not installed. Spreading the face weight over the rest keeps
// scores on the same 0–1 scale, so a caller comparing two runs is not comparing two scales.
const NO_FACES: ScoreWeights = { sharpness: 0.49, contrast: 0.26, exposure: 0.25, faces: 0 };

/**
 * Where one frame's sharpness sits in the range this footage actually spans.
 *
 * Measured on real video, the interesting spread is narrow and high: a two-minute handheld clip ran
 * 1197–2851, so dividing by the best frame put every usable frame between 0.42 and 1 and the ranking
 * collapsed. Scaling between the first and ninth decile instead uses the whole 0–1 range for the
 * differences that exist, and ignores the one freak frame at either end.
 *
 * The floor on the denominator is the important part. Locked-off footage — an interview, a screen
 * recording — is uniformly sharp, and stretching its noise across 0–1 would invent a ranking out of
 * nothing and let a meaningless sharpness edge outvote an actual face. When the spread is small
 * relative to the level, the term stays small and the other measurements decide.
 */
export function sharpnessScale(values: number[]): (v: number) => number {
  const lo = percentile(values, 0.1);
  const hi = percentile(values, 0.9);
  const spread = hi - lo;
  if (!(spread > 0)) return () => 0.5; // one frame, or every frame identical: nothing to say
  const denom = Math.max(spread, hi * 0.25);
  return (v) => Math.min(1, Math.max(0, (v - lo) / denom));
}

/**
 * Score every frame against the others in the same video.
 *
 * Sharpness is relative on purpose: its absolute value depends on the lens, the grain and the
 * subject, so "sharp" only means anything next to the other frames of the same footage. Exposure
 * and contrast are absolute, and they are disqualifiers rather than rankers — on well-shot footage
 * both sit at full marks and the choice comes down to focus and faces, which is correct. What they
 * exist for is the blown white flash and the empty black frame, and on real footage they catch them.
 *
 * `reference` lets a second pass over a shortlist keep judging against the WHOLE video: rescaling
 * inside the shortlist would spread ten already-excellent frames back across 0–1 and turn a rounding
 * difference in focus into a decisive one.
 */
export function scoreFrames(frames: FrameStats[], faces: (FaceInfo | null)[] = [], reference?: number[]): ScoredFrame[] {
  const known = faces.some((f) => f !== null);
  const w = known ? WITH_FACES : NO_FACES;
  const scale = sharpnessScale(reference ?? frames.map((f) => f.sharpness));
  return frames.map((f, i) => {
    const face = faces[i] ?? null;
    const sharp = scale(f.sharpness);
    const contrast = Math.min(1, f.contrast / 55);
    const exposure = band(f.brightness, 18, 55, 195, 240);
    // A face has to be big enough to read as a face at thumbnail size. 6% of the frame is roughly a
    // head filling a quarter of the height of a vertical video — below that it is a person in a
    // scene, which is fine but not what makes someone click.
    const faceScore = face && face.count > 0 ? Math.min(1, face.largest / 0.06) * (face.clipped ? 0.6 : 1) : 0;
    const score = w.sharpness * sharp + w.contrast * contrast + w.exposure * exposure + w.faces * faceScore;
    const parts = [`sharpness ${(sharp * 100).toFixed(0)}%`, `contrast ${(contrast * 100).toFixed(0)}%`, `exposure ${(exposure * 100).toFixed(0)}%`];
    if (known) {
      parts.push(
        face && face.count > 0
          ? `${face.count} face(s), largest ${(face.largest * 100).toFixed(1)}% of the frame${face.clipped ? " (cut by the edge)" : ""}`
          : "no faces",
      );
    }
    return { ...f, faces: face, score: Math.round(score * 1000) / 1000, why: parts.join(", ") };
  });
}

/**
 * The best frames, forced apart in time.
 *
 * Without the spacing rule the top five are five frames of the same second: the sharpest moment of a
 * video is sharp for a while. A set of candidates is only useful if they are actually different
 * shots, so each pick blocks a window around itself.
 */
export function pickSpread(scored: ScoredFrame[], count: number, minGapSeconds: number, avoid: number[] = []): ScoredFrame[] {
  const near = (t: number) => avoid.some((a) => Math.abs(a - t) < 0.5);
  const ranked = scored.filter((f) => !near(f.t)).sort((a, b) => b.score - a.score || a.t - b.t);
  const out: ScoredFrame[] = [];
  for (const f of ranked) {
    if (out.length >= count) break;
    if (out.every((k) => Math.abs(k.t - f.t) >= minGapSeconds)) out.push(f);
  }
  // A short clip can have no two frames far enough apart. Returning three identical-looking frames
  // is better than returning one: the caller asked for choices.
  if (out.length < count) {
    for (const f of ranked) {
      if (out.length >= count) break;
      if (!out.includes(f)) out.push(f);
    }
  }
  return out.sort((a, b) => a.t - b.t);
}

/** Decode the whole video once at a low resolution and measure every sampled frame. */
export async function sampleFrames(src: string, everySeconds: number): Promise<FrameStats[]> {
  const proc = Bun.spawn(
    [
      FFMPEG_BIN, "-v", "error", "-i", src,
      "-vf", `fps=1/${everySeconds},scale=${SAMPLE_W}:${SAMPLE_H},format=gray`,
      "-f", "rawvideo", "-pix_fmt", "gray", "pipe:1",
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  const buf = new Uint8Array(await new Response(proc.stdout).arrayBuffer());
  await proc.exited;
  const frameBytes = SAMPLE_W * SAMPLE_H;
  const out: FrameStats[] = [];
  for (let i = 0; i + frameBytes <= buf.length; i += frameBytes) {
    // fps=1/N emits the frame at the START of each interval, so sample k sits at k*N seconds.
    out.push(frameStats(buf.subarray(i, i + frameBytes), SAMPLE_W, SAMPLE_H, (out.length * everySeconds)));
  }
  return out;
}

export interface ThumbnailSuggestion {
  path: string;
  atSeconds: number;
  score: number;
  why: string;
}

export interface SuggestOptions {
  count?: number;
  /** Restrict to a window of the source. */
  startSeconds?: number;
  endSeconds?: number;
  /** Skip the face pass (it costs a second per shortlisted frame). */
  faces?: boolean;
  onProgress?: (text: string) => void;
}

export interface SuggestResult {
  suggestions: ThumbnailSuggestion[];
  sampled: number;
  everySeconds: number;
  measuredOn: "proxy" | "source";
  facesChecked: number;
  faceDetector: boolean;
}

/**
 * Cover candidates for a video, written out as full-resolution stills.
 *
 * The measuring runs on the scrub proxy when there is one — it is the same picture at a lower
 * resolution, and at a 160×90 sample grid the two are indistinguishable, while the proxy decodes
 * several times faster. The stills themselves always come out of the ORIGINAL, because a cover
 * pulled from a proxy is a cover at proxy quality.
 */
export async function suggestThumbnails(src: string, opts: SuggestOptions = {}): Promise<SuggestResult> {
  const count = Math.max(1, Math.min(12, Math.round(opts.count ?? 5)));
  const probe = await probeMedia(src);
  const dur = probe.durationSeconds || 0;
  if (dur <= 0) throw new Error("Could not read the video's duration.");
  const from = Math.max(0, opts.startSeconds ?? 0);
  const to = Math.min(dur, opts.endSeconds ?? dur);
  if (to - from < 0.2) throw new Error("The requested window is shorter than a single frame.");

  // Aim for a few hundred samples whatever the length: dense enough on a short clip to catch the one
  // good moment, sparse enough on a feature that the decode stays a decode and not an ordeal.
  const span = to - from;
  const everySeconds = Math.max(0.5, Math.round((span / 400) * 2) / 2);

  const proxy = scrubProxyPath(src);
  const measureOn = (await Bun.file(proxy).exists()) ? proxy : src;
  opts.onProgress?.(`Measuring one frame every ${everySeconds}s…`);
  const all = await sampleFrames(measureOn, everySeconds);
  const frames = all.filter((f) => f.t >= from && f.t <= to);
  if (frames.length === 0) throw new Error("ffmpeg returned no frames to measure.");

  // Frames sitting on a shot change are half of one shot and half of the next.
  const cuts = await analyzeVideo(measureOn, { scenesOnly: true })
    .then((a) => a.sceneChanges)
    .catch(() => [] as number[]);

  // Shortlist on the cheap measurements, then spend the face detector only on those. Three times the
  // asked-for count leaves room for the faces to reorder things without a second decode.
  const population = frames.map((f) => f.sharpness);
  const first = pickSpread(scoreFrames(frames, [], population), count * 3, Math.max(1, span / (count * 4)), cuts);
  let faces: (FaceInfo | null)[] = [];
  let facesChecked = 0;
  if (opts.faces !== false) {
    opts.onProgress?.(`Looking for faces in ${first.length} frames…`);
    const hits = await detectFacesAt(src, first.map((f) => f.t)).catch(() => null);
    if (hits) {
      facesChecked = first.length;
      faces = hits.map((boxes) => {
        if (boxes.length === 0) return { count: 0, largest: 0, clipped: false } satisfies FaceInfo;
        const big = boxes.reduce((a, b) => (a.w * a.h >= b.w * b.h ? a : b));
        return {
          count: boxes.length,
          largest: big.w * big.h,
          clipped: big.x <= 0.01 || big.y <= 0.01 || big.x + big.w >= 0.99 || big.y + big.h >= 0.99,
        } satisfies FaceInfo;
      });
    }
  }

  const finalists = pickSpread(scoreFrames(first, faces, population), count, Math.max(1, span / (count * 2)), cuts);

  const dir = join(exportsDir, "thumbnails");
  await mkdir(dir, { recursive: true });
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
  const suggestions: ThumbnailSuggestion[] = [];
  for (let i = 0; i < finalists.length; i++) {
    const f = finalists[i]!;
    const out = join(dir, `cover_${stamp}_${String(i + 1).padStart(2, "0")}.jpg`);
    const args = ["-y", "-v", "error"];
    if (f.t > 0.001) args.push("-ss", f.t.toFixed(3));
    args.push("-i", src, "-frames:v", "1", "-q:v", "2", out);
    const r = await run(FFMPEG_BIN, args);
    if (r.code !== 0 || !(await Bun.file(out).exists())) continue;
    suggestions.push({ path: out, atSeconds: Math.round(f.t * 100) / 100, score: f.score, why: f.why });
  }
  if (suggestions.length === 0) throw new Error("ffmpeg could not write any still from the chosen moments.");

  return {
    suggestions,
    sampled: frames.length,
    everySeconds,
    measuredOn: measureOn === src ? "source" : "proxy",
    facesChecked,
    faceDetector: facesChecked > 0,
  };
}
