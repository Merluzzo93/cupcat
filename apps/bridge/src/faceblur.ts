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
import { exportsDir, FFMPEG_BIN, FFPROBE_BIN } from "./config";
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

// Several frames go into ONE request: detection was one API call per frame, which on a 36-minute
// video meant thousands of round trips (~12 minutes of pure waiting). Asking for one result array
// per image cuts the calls by BATCH and costs nothing in coverage — the same frames are still seen.
const BATCH = 5;

const SYSTEM = [
  "You locate human faces in video frames.",
  "You are given N images. Reply with ONLY a JSON array of N objects, one per image.",
  'Each object: {"i":0,"faces":[{"x":0.12,"y":0.08,"w":0.15,"h":0.22}]}',
  '"i" is the image\'s index in the order given, starting at 0. ALWAYS include it — results are matched by "i", not by position.',
  "Box coordinates are fractions of THAT image's width/height, origin at the TOP-LEFT.",
  "Box the head: forehead to chin, ear to ear. Exclude neck and shoulders.",
  "Include every human face: background people, faces on screens or posters, partial and profile faces.",
  "Do NOT include animal faces, statues, drawings or logos.",
  'An image with no face gets an empty list. Example for 3 images: [{"i":0,"faces":[{...}]},{"i":1,"faces":[]},{"i":2,"faces":[{...}]}]',
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

/**
 * Parse the batched reply: an array of `expected` arrays, one per image. Degrades rather than
 * fails — a short reply pads with empties, and a model that flattened everything into one array is
 * treated as "all of it belongs to the first frame" only when a single frame was asked for.
 */
export function parseFrameBatch(raw: string, expected: number): { x: number; y: number; w: number; h: number }[][] {
  const out: { x: number; y: number; w: number; h: number }[][] = Array.from({ length: expected }, () => []);
  const start = raw.indexOf("[");
  const end = raw.lastIndexOf("]");
  if (start < 0 || end <= start) return out;
  let arr: unknown;
  try {
    arr = JSON.parse(raw.slice(start, end + 1));
  } catch {
    return out;
  }
  if (!Array.isArray(arr)) return out;

  // Preferred shape: objects carrying their own index. Boxes are placed BY that index, so a reply
  // that comes back reordered still lands on the right frame — getting this wrong stamps one
  // moment's face onto another moment's timestamp, which is exactly how a blurred face ends up
  // pasted where nobody is standing.
  const indexed = arr.filter((e): e is Record<string, unknown> => !!e && typeof e === "object" && !Array.isArray(e) && "i" in e);
  if (indexed.length > 0) {
    for (const o of indexed) {
      const idx = typeof o.i === "number" ? o.i : Number.NaN;
      if (!Number.isInteger(idx) || idx < 0 || idx >= expected) continue; // unusable index — drop it
      const faces = o.faces;
      if (Array.isArray(faces)) out[idx] = parseBoxes(JSON.stringify(faces));
    }
    return out;
  }

  // Fallback for a reply that ignored the format: arrays in order.
  const nested = arr.filter((e) => Array.isArray(e));
  if (nested.length > 0) {
    for (let i = 0; i < Math.min(nested.length, expected); i++) out[i] = parseBoxes(JSON.stringify(nested[i]));
    return out;
  }
  // A flat list of boxes is only unambiguous when a single frame was asked about.
  if (expected === 1) out[0] = parseBoxes(raw);
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
  // The cover is an inscribed ellipse, which touches less than the box it sits in — so the box has
  // to be grown more than a rectangular patch would need or the chin and hairline poke out.
  const pad = opts.padding ?? 0.34;
  const progress = opts.onProgress ?? (() => {});

  const times: number[] = [];
  for (let t = start; t < end; t += every) times.push(Math.round(t * 100) / 100);
  if (times.length === 0) return [];

  // Group the sampled times into batches, then run several batches at once: the work is API-bound,
  // so the wall clock is (frames / BATCH / POOL) round trips rather than one per frame.
  const groups: number[][] = [];
  for (let i = 0; i < times.length; i += BATCH) groups.push(times.slice(i, i + BATCH));

  const frames: { t: number; boxes: { x: number; y: number; w: number; h: number }[] }[] = [];
  const POOL = 6;
  let seen = 0;
  for (let g = 0; g < groups.length; g += POOL) {
    const wave = groups.slice(g, g + POOL);
    const done = await Promise.all(
      wave.map(async (group) => {
        const imgs = await Promise.all(group.map((t) => frameToBase64(srcPath, t, 640)));
        const usable = group.map((t, i) => ({ t, img: imgs[i] })).filter((f): f is { t: number; img: string } => !!f.img);
        if (usable.length === 0) return group.map((t) => ({ t, boxes: [] }));
        try {
          const raw = await oneShotVision(
            SYSTEM,
            `${usable.length} images. Return one object per image with its "i" index (0..${usable.length - 1}).`,
            usable.map((f) => ({ data: f.img, mediaType: "image/jpeg" })),
            { maxTokens: 1600 },
          );
          const per = parseFrameBatch(raw, usable.length);
          return usable.map((f, i) => ({ t: f.t, boxes: (per[i] ?? []).map((b) => padBox(b, pad)) }));
        } catch {
          return group.map((t) => ({ t, boxes: [] })); // one bad batch must not sink the whole pass
        }
      }),
    );
    for (const d of done) frames.push(...d);
    seen += wave.reduce((n, w) => n + w.length, 0);
    progress(`Looking for faces… ${Math.min(seen, times.length)}/${times.length}`);
  }
  frames.sort((a, b) => a.t - b.t);
  return buildTracks(frames);
}

/**
 * Piecewise-linear ffmpeg expression for one component of a track, in SOURCE seconds.
 * Produces nested if()s: before the first sample it holds the first value, after the last it holds
 * the last, and in between it interpolates — matching what the UI draws.
 */
/**
 * Does this ffmpeg accept `-/filter_complex <file>`? True on 7.x and later, false on older builds
 * that only know `-filter_complex_script`. Probed once against the ACTUAL binary in use — the
 * bundled sidecar and whatever happens to be on PATH are frequently different versions.
 */
let filterScriptStyle: boolean | null = null;
export async function supportsFilterScriptFromFile(): Promise<boolean> {
  if (filterScriptStyle !== null) return filterScriptStyle;
  try {
    // -h is enough: an unknown option is rejected during parsing, before any work happens.
    const r = await run(FFMPEG_BIN, ["-hide_banner", "-/filter_complex", "-h"]);
    filterScriptStyle = !/unrecognized option/i.test(r.stderr);
  } catch {
    filterScriptStyle = false;
  }
  return filterScriptStyle;
}

/** True when the source carries 90°/270° rotation metadata (portrait phone footage). ffmpeg
 * autorotates on decode, so any pixel maths from the probe must use the swapped dimensions. */
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
  // Phone footage carries 90°/270° rotation metadata: ffprobe reports the STORED dimensions while
  // ffmpeg autorotates on decode, so the filter graph sees them swapped. Using the stored pair put
  // every patch at the wrong place and the wrong size — the "face pasted somewhere else" bug.
  const rotated = await isRotated90(srcPath);
  const pw = probe.width && probe.width > 0 ? probe.width : 1920;
  const ph = probe.height && probe.height > 0 ? probe.height : 1080;
  const W = rotated ? ph : pw;
  const H = rotated ? pw : ph;

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
        : // boxblur twice, radius tied to the face size: a fixed radius barely touches a large face
          // and obliterates the frame around a small one.
          `boxblur=luma_radius=${Math.max(2, Math.round((w * strength) / 55))}:luma_power=2:chroma_radius=${Math.max(2, Math.round((w * strength) / 70))}:chroma_power=2`;
    // Feathered ELLIPSE, not a bare rectangle: a hard-edged box screams "censored patch" and looks
    // pasted on. The alpha is a function of position within the patch only — no time term — so it
    // costs nothing per frame. d is the normalised elliptical distance (0 centre, 1 at the edge);
    // alpha holds full inside ~0.72 and falls to nothing by the boundary.
    const feather = `format=yuva420p,geq=lum='p(X,Y)':cb='p(X,Y)':cr='p(X,Y)':a='255*clip((1.0-hypot((X-${Math.round(
      w / 2,
    )})/${Math.max(1, Math.round(w / 2))}\\,(Y-${Math.round(h / 2)})/${Math.max(1, Math.round(h / 2))}))/0.28\\,0\\,1)'`;
    parts.push(`[f${i}]crop=${w}:${h}:'${X}':'${Y}',${cover},${feather}[b${i}]`);
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
  //
  // `-/filter_complex <file>` is ffmpeg's current way to read an option's value from a file. The
  // older `-filter_complex_script` was deprecated in 7.x and REMOVED in 8 — which is the build
  // CupCat bundles, so that spelling fails in the shipped app even though it still works against an
  // older ffmpeg on PATH. Probe once and fall back, so either build works.
  const graphFile = join(exportsDir, `_faceblur_${stamp}.txt`);
  await Bun.write(graphFile, parts.join(";\n"));
  const graphArgs = (await supportsFilterScriptFromFile())
    ? ["-/filter_complex", graphFile]
    : ["-filter_complex_script", graphFile];

  const args = [
    "-y",
    "-i",
    srcPath,
    ...graphArgs,
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
