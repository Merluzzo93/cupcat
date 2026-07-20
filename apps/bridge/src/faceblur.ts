// Face blur: find the faces in a video, follow them over time, and hand back normalized tracks the
// export graph turns into a moving blurred patch.
//
// Detection is Claude vision on sampled frames — CupCat already ships that path (auto_clips uses it
// for visual curation), so this needs no extra model, binary or download, and it reads a scene the
// way a person would: it finds faces in reflections, on screens, at odd angles, where a classic
// cascade detector gives up.
//
// Between samples the boxes are interpolated linearly, which is what the ffmpeg expression does too
// — so what you preview is what renders. A face that disappears (cut, turns away, walks out) simply
// ends its track: blurring an empty region would smear the frame.

import { join } from "node:path";
import { mkdir } from "node:fs/promises";
import { exportsDir, FFMPEG_BIN } from "./config";
import { frameToBase64, probeMedia, withTranscodeSlot } from "./ffmpeg";
import { oneShotVision } from "./agent-chat";
import { run } from "./proc";

/** One face at one sampled instant. All values are 0..1 fractions of the frame. */
export interface FaceBox {
  t: number; // seconds into the SOURCE
  x: number; // left
  y: number; // top
  w: number;
  h: number;
}

/** One face followed across time. */
export interface FaceTrack {
  pts: FaceBox[];
}

export interface DetectOptions {
  /** Seconds between sampled frames. Denser = better on fast movement, slower + more API calls. */
  everySeconds?: number;
  /** Don't sample past this point (defaults to the whole video). */
  durationSeconds: number;
  startSeconds?: number;
  /** Grow every box by this fraction — hair, chin and jitter need headroom or edges peek out. */
  padding?: number;
  onProgress?: (text: string) => void;
}

const SYSTEM = [
  "You locate human faces in a video frame.",
  "Reply with ONLY a JSON array, no prose, no code fence.",
  'Each element: {"x":0.12,"y":0.08,"w":0.15,"h":0.22} — the face\'s bounding box as fractions of the frame width/height, origin at the TOP-LEFT.',
  "Box the head: forehead to chin, ear to ear. Exclude neck and shoulders.",
  "Include every human face: background people, faces on screens or posters, partial and profile faces.",
  "Do NOT include animal faces, statues, drawings or logos.",
  "If there is no face at all, reply exactly: []",
].join("\n");

/** Parse the model's reply into boxes, tolerating stray prose or a code fence. */
export function parseBoxes(raw: string): { x: number; y: number; w: number; h: number }[] {
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
  const out: { x: number; y: number; w: number; h: number }[] = [];
  for (const it of arr) {
    if (!it || typeof it !== "object") continue;
    const o = it as Record<string, unknown>;
    const n = (k: string): number | null => (typeof o[k] === "number" && Number.isFinite(o[k]) ? (o[k] as number) : null);
    const x = n("x");
    const y = n("y");
    const w = n("w");
    const h = n("h");
    if (x === null || y === null || w === null || h === null) continue;
    // Drop degenerate and absurd boxes — a "face" covering the whole frame is a hallucination.
    if (w <= 0.005 || h <= 0.005 || w > 0.95 || h > 0.95) continue;
    out.push({ x, y, w, h });
  }
  return out;
}

/** Grow a box by `pad` on every side, clamped to the frame. */
export function padBox(b: { x: number; y: number; w: number; h: number }, pad: number) {
  const dx = b.w * pad;
  const dy = b.h * pad;
  const x = Math.max(0, b.x - dx);
  const y = Math.max(0, b.y - dy);
  return {
    x,
    y,
    w: Math.min(1 - x, b.w + dx * 2),
    h: Math.min(1 - y, b.h + dy * 2),
  };
}

/** Intersection-over-union — how much two boxes overlap (0..1). */
export function iou(a: { x: number; y: number; w: number; h: number }, b: { x: number; y: number; w: number; h: number }): number {
  const x1 = Math.max(a.x, b.x);
  const y1 = Math.max(a.y, b.y);
  const x2 = Math.min(a.x + a.w, b.x + b.w);
  const y2 = Math.min(a.y + a.h, b.y + b.h);
  const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  if (inter <= 0) return 0;
  return inter / (a.w * a.h + b.w * b.h - inter);
}

/**
 * Group per-frame boxes into per-face tracks by greedy overlap matching against each track's most
 * recent box. A track that goes unmatched for one sample is closed — that's the face leaving the
 * shot, and continuing to blur where it used to be would smear clean frames.
 */
export function buildTracks(frames: { t: number; boxes: { x: number; y: number; w: number; h: number }[] }[], minIou = 0.15): FaceTrack[] {
  const closed: FaceTrack[] = [];
  let open: { track: FaceTrack; last: FaceBox }[] = [];

  for (const f of frames) {
    const unused = [...f.boxes];
    const stillOpen: { track: FaceTrack; last: FaceBox }[] = [];
    for (const o of open) {
      let bestIdx = -1;
      let best = minIou;
      for (let i = 0; i < unused.length; i++) {
        const s = iou(o.last, unused[i]!);
        if (s > best) {
          best = s;
          bestIdx = i;
        }
      }
      if (bestIdx >= 0) {
        const b = unused.splice(bestIdx, 1)[0]!;
        const pt: FaceBox = { t: f.t, ...b };
        o.track.pts.push(pt);
        stillOpen.push({ track: o.track, last: pt });
      } else {
        closed.push(o.track); // face left the shot
      }
    }
    for (const b of unused) {
      const pt: FaceBox = { t: f.t, ...b };
      const track: FaceTrack = { pts: [pt] };
      stillOpen.push({ track, last: pt });
    }
    open = stillOpen;
  }
  for (const o of open) closed.push(o.track);
  // A single isolated hit is usually a false positive; keep tracks seen at least twice.
  return closed.filter((tr) => tr.pts.length >= 2);
}

/** Sample the video and return the faces found, already padded and grouped into tracks. */
export async function detectFaces(srcPath: string, opts: DetectOptions): Promise<FaceTrack[]> {
  const every = Math.max(0.2, opts.everySeconds ?? 1);
  const start = Math.max(0, opts.startSeconds ?? 0);
  const end = Math.max(start, opts.durationSeconds);
  const pad = opts.padding ?? 0.18;
  const progress = opts.onProgress ?? (() => {});

  const times: number[] = [];
  for (let t = start; t < end; t += every) times.push(Math.round(t * 100) / 100);
  if (times.length === 0) return [];

  const frames: { t: number; boxes: { x: number; y: number; w: number; h: number }[] }[] = [];
  const POOL = 3; // a few frames in flight: detection is API-bound, not CPU-bound
  for (let i = 0; i < times.length; i += POOL) {
    const batch = times.slice(i, i + POOL);
    progress(`Looking for faces… ${Math.min(i + batch.length, times.length)}/${times.length}`);
    const done = await Promise.all(
      batch.map(async (t) => {
        const img = await frameToBase64(srcPath, t, 640);
        if (!img) return { t, boxes: [] };
        try {
          const raw = await oneShotVision(SYSTEM, `Frame at t=${t.toFixed(2)}s.`, [{ data: img, mediaType: "image/jpeg" }], { maxTokens: 700 });
          return { t, boxes: parseBoxes(raw).map((b) => padBox(b, pad)) };
        } catch {
          return { t, boxes: [] }; // one unreadable frame must not sink the whole pass
        }
      }),
    );
    frames.push(...done);
  }
  frames.sort((a, b) => a.t - b.t);
  return buildTracks(frames);
}

/**
 * Piecewise-linear ffmpeg expression for one component of a track, in SOURCE seconds.
 * Produces nested if()s: before the first sample it holds the first value, after the last it holds
 * the last, and in between it interpolates — matching what the UI draws.
 */
export interface BlurResult {
  file: string;
  faces: number;
  /** Seconds of footage that ended up covered, for the summary line. */
  coveredSeconds: number;
}

export interface BlurOptions extends Omit<DetectOptions, "durationSeconds"> {
  /** "blur" softens; "pixelate" mosaics — the look people expect for anonymised footage. */
  mode?: "blur" | "pixelate";
  /** 1..10; how unrecognisable. Scaled to the face size so it holds up at any resolution. */
  strength?: number;
  durationSeconds?: number;
}

/**
 * Detect the faces in `srcPath` and render a copy with each one covered, following its movement.
 *
 * Renders a NEW file rather than adding a live effect: it's the same pattern auto_clips uses, it
 * keeps the export graph untouched (exports are the app's most critical path), and the result is a
 * normal library asset the user can cut, trim and export like any other clip.
 */
export async function renderFaceBlur(srcPath: string, opts: BlurOptions = {}): Promise<BlurResult> {
  const progress = opts.onProgress ?? (() => {});
  const probe = await probeMedia(srcPath);
  const duration = opts.durationSeconds ?? probe.durationSeconds;
  if (!(duration > 0)) throw new Error("Can't read this video's duration — the file may be unreadable.");
  const W = probe.width && probe.width > 0 ? probe.width : 1920;
  const H = probe.height && probe.height > 0 ? probe.height : 1080;

  const tracks = await detectFaces(srcPath, { ...opts, durationSeconds: duration, onProgress: progress });
  if (tracks.length === 0) throw new Error("No faces found in this video — nothing to blur.");

  const mode = opts.mode ?? "blur";
  const strength = Math.min(10, Math.max(1, opts.strength ?? 6));

  progress(`Covering ${tracks.length} face(s)…`);
  const parts: string[] = [];
  let label = "base";
  parts.push(`[0:v]split=${tracks.length + 1}[${label}]${tracks.map((_, i) => `[f${i}]`).join("")}`);
  let covered = 0;
  tracks.forEach((tr, i) => {
    const X = trackExpr(tr.pts, (b) => b.x, W);
    const Y = trackExpr(tr.pts, (b) => b.y, H);
    // One patch size per track (the widest the face ever gets) — a size that changed per frame would
    // need a re-scaling crop and buys nothing: the padding already absorbs the variation.
    const even = (n: number) => Math.max(16, Math.round(n / 2) * 2);
    const w = even(Math.max(...tr.pts.map((p) => p.w)) * W);
    const h = even(Math.max(...tr.pts.map((p) => p.h)) * H);
    const t0 = tr.pts[0]!.t;
    const t1 = tr.pts[tr.pts.length - 1]!.t;
    covered += t1 - t0;
    const cover =
      mode === "pixelate"
        ? // Shrink then blow back up with no interpolation = classic mosaic. Cell size follows the
          // face so a small face doesn't turn into one flat square.
          `scale=${Math.max(2, Math.round(w / (strength * 2.2)))}:${Math.max(2, Math.round(h / (strength * 2.2)))}:flags=neighbor,scale=${w}:${h}:flags=neighbor`
        : `avgblur=sizeX=${Math.round(strength * 3)}:sizeY=${Math.round(strength * 3)}`;
    parts.push(`[f${i}]crop=${w}:${h}:'${X}':'${Y}',${cover}[b${i}]`);
    // enable=between: outside the track's life the patch is not drawn at all, so a face that leaves
    // the shot doesn't leave a smear parked where it used to be.
    parts.push(`[${label}][b${i}]overlay=x='${X}':y='${Y}':enable='between(t,${t0},${t1})'[ov${i}]`);
    label = `ov${i}`;
  });

  await mkdir(exportsDir, { recursive: true });
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
  const base = srcPath.replace(/\\/g, "/").split("/").pop()?.replace(/\.[^.]+$/, "") ?? "video";
  const out = join(exportsDir, `${base}-faces-blurred-${stamp}.mp4`);
  // The graph goes in a file: these expressions are long, and a command line long enough to hold
  // them is rejected ("Result too large").
  const graphFile = join(exportsDir, `_faceblur_${stamp}.txt`);
  await Bun.write(graphFile, parts.join(";\n"));

  const args = [
    "-y",
    "-i",
    srcPath,
    "-filter_complex_script",
    graphFile,
    "-map",
    `[${label}]`,
    ...(probe.hasAudio ? ["-map", "0:a?", "-c:a", "copy"] : ["-an"]),
    "-c:v",
    "libx264",
    "-preset",
    "medium",
    "-crf",
    "17",
    "-pix_fmt",
    "yuv420p",
    "-movflags",
    "+faststart",
    out,
  ];
  const { code, stderr } = await withTranscodeSlot(() => run(FFMPEG_BIN, args));
  if (code !== 0 || !(await Bun.file(out).exists())) {
    throw new Error(`Rendering the blurred copy failed: ${stderr.slice(-300)}`);
  }
  return { file: out, faces: tracks.length, coveredSeconds: Math.round(covered * 10) / 10 };
}

export function trackExpr(pts: FaceBox[], pick: (b: FaceBox) => number, scale: number): string {
  const v = (b: FaceBox) => Math.round(pick(b) * scale);
  if (pts.length === 1) return String(v(pts[0]!));
  let expr = String(v(pts[pts.length - 1]!)); // tail: hold the last value
  for (let i = pts.length - 2; i >= 0; i--) {
    const a = pts[i]!;
    const b = pts[i + 1]!;
    const va = v(a);
    const vb = v(b);
    const dt = Math.max(0.001, b.t - a.t);
    const seg = va === vb ? String(va) : `(${va}+(${vb - va})*(t-${a.t.toFixed(3)})/${dt.toFixed(3)})`;
    expr = `if(lt(t,${b.t.toFixed(3)}),${seg},${expr})`;
  }
  return expr;
}
