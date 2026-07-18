// autoReframe.ts — CapCut/OpusClip-style AUTO-REFRAME with face tracking, 100% local and free.
//
// WHAT IT DOES
// Samples a clip's source video every ~0.5 s, detects the largest face per sample with MediaPipe's
// BlazeFace short-range model, smooths + speed-limits the motion, and converts it into "position"
// keyframes that pan a FULL-HEIGHT clip horizontally across a portrait canvas so the face stays
// centered. No cloud calls, no credits — everything runs in this window on WASM.
//
// OFFLINE ASSET STRATEGY (deliberate choice, do not "simplify" to a CDN)
// • Model: `public/models/blaze_face_short_range.tflite` (~230 KB) is committed with the app and
//   served from our own origin (`/models/...` works in vite dev, from the bridge's static dist in
//   production, and inside the Tauri shell). It was downloaded ONCE at authoring time from
//   storage.googleapis.com/mediapipe-models — never at runtime.
// • WASM runtime: imported from the installed `@mediapipe/tasks-vision` package with vite `?url`
//   (see getDetector), so vite fingerprints the loader JS + .wasm into `dist/assets/` and serves
//   them same-origin. This beats copying node_modules files into `public/wasm/` because the served
//   runtime can never drift from the installed package version. We pin the SIMD build instead of
//   using FilesetResolver.forVisionTasks' runtime probe (which needs the simd AND nosimd pairs
//   served): WASM SIMD ships in every Chromium ≥ 91, and CupCat's WebView2/Chromium targets always
//   have it. All mediapipe imports are DYNAMIC so this module stays importable under plain
//   bun/vitest (unit tests of the math below) without vite's `?url` resolver.
//
// GEOMETRY (canvas-normalized units: canvas width = 1, canvas height = 1)
// A clip rendered "fit-height" keeps height = 1 and gets width
//     w = sourceAspect / canvasAspect = (sourceW / sourceH) / (canvasW / canvasH)
// e.g. a 1920×1080 source on a 1080×1920 (9:16) canvas: (16/9) / (9/16) = 256/81 ≈ 3.1605.
// Both renderers fit media into the transform box with COVER semantics — the preview via CSS
// `object-cover` (Preview.tsx boxStyle) and the export via ffmpeg
// `scale=w:h:force_original_aspect_ratio=increase,crop=w:h` (export.ts buildVisualGraph) — so a box
// of EXACTLY the source aspect is covered with zero internal cropping: panning the box pans the
// full-height source. (With a manual clip crop the export pre-crops then plain-scales into the box,
// hence fitHeightWidth/cropRelativeX account for crop insets so the box aspect still matches the
// visible content.)
//
// A face at fx (0..1 across the visible source width) sits on the canvas at topLeftX + fx·w, and
// topLeftX = centerX − w/2 (Transform is center-based; see editor-core transformTopLeft). Putting
// the face at the canvas center 0.5 gives
//     centerX = 0.5 + w · (0.5 − fx)
// clamped so the canvas stays fully covered (no black bars): topLeftX ≤ 0 and topLeftX + w ≥ 1,
// i.e. centerX ∈ [1 − w/2, w/2]. For w ≤ 1 the interval collapses/inverts → pinned to 0.5 (a
// portrait-or-narrower source has nothing to pan). NOTE: the returned cx is therefore the clip's
// transform centerX and intentionally exceeds 0..1 for wide sources (range [1 − w/2, w/2]).
//
// The `set_keyframes` MCP tool wants TOP-LEFT position rows `[frame, topLeftX, topLeftY]`
// (bridge mcp-tools.ts / editor-core commands.ts parseRows) — use positionRows() for the mapping
// a = cx − w/2, b = 0 (full-height clip: centerY 0.5, height 1 → top edge at 0).

import type { FaceDetector } from "@mediapipe/tasks-vision";
import type { Crop } from "@cupcat/editor-core";

export interface ReframeKeyframe {
  /** CLIP-RELATIVE frame (0 = first frame of the clip), matching set_keyframes semantics. */
  frame: number;
  /** Clip transform centerX in canvas units (see header note: range [1 − w/2, w/2], not 0..1). */
  cx: number;
}

export interface ReframeOptions {
  /** Timeline position of the clip. Not used in the math (keyframes are clip-relative); accepted
   * so callers can pass the clip verbatim. */
  clipStartFrame: number;
  clipDurationFrames: number;
  /** Source offset in PROJECT frames (Clip.trimStartFrame). */
  trimStartFrame: number;
  /** Clip playback speed (Clip.speed); source seconds advance at speed× the timeline. */
  speed: number;
  fps: number;
  /** canvasW / canvasH of the project (e.g. 1080/1920 = 0.5625 for 9:16). */
  targetAspect: number;
  sourceW: number;
  sourceH: number;
  /** Seconds of TIMELINE time between samples. Default 0.5. */
  sample?: number;
  /** Manual crop insets on the clip (Clip.crop), if any — identity crop may be passed as-is. */
  crop?: Crop;
  /** Max pan speed in canvas-widths per second. Default 0.15 (slow, steady, CapCut-like). */
  maxPanSpeed?: number;
  /** Progress callback: (samples analyzed, total samples). */
  onProgress?: (done: number, total: number) => void;
}

// ─── pure math (unit-tested in autoReframe.test.ts) ──────────────────────────

const r4 = (n: number) => Math.round(n * 10000) / 10000;

function cropSpanX(crop?: Crop): { left: number; span: number } {
  const left = crop?.left ?? 0;
  const right = crop?.right ?? 0;
  const span = 1 - left - right;
  return span > 0.01 ? { left, span } : { left: 0, span: 1 };
}

function cropSpanY(crop?: Crop): number {
  const span = 1 - (crop?.top ?? 0) - (crop?.bottom ?? 0);
  return span > 0.01 ? span : 1;
}

/** Normalized width of a fit-height clip box: visible source aspect / canvas aspect.
 * 1920×1080 on a 1080×1920 canvas → (16/9)/(9/16) ≈ 3.1605 (see header for the derivation). */
export function fitHeightWidth(sourceW: number, sourceH: number, targetAspect: number, crop?: Crop): number {
  if (!(sourceW > 0) || !(sourceH > 0) || !(targetAspect > 0)) return 1;
  const visibleAspect = (sourceW * cropSpanX(crop).span) / (sourceH * cropSpanY(crop));
  return visibleAspect / targetAspect;
}

/** Map a face x from FULL-frame coords (what the detector sees — proxies aren't cropped) to the
 * visible (cropped) region's 0..1 coords. Identity crop → identity. */
export function cropRelativeX(fx: number, crop?: Crop): number {
  const { left, span } = cropSpanX(crop);
  return Math.min(1, Math.max(0, (fx - left) / span));
}

/** Fill detection gaps: hold the previous face position (short losses shouldn't snap the camera),
 * backfill a leading gap from the first hit, and default to source center when NO face ever shows. */
export function fillGaps(samples: (number | null)[]): number[] {
  const out = new Array<number>(samples.length);
  let prev: number | null = null;
  for (let i = 0; i < samples.length; i++) {
    const v = samples[i];
    if (v != null) prev = v;
    out[i] = prev ?? Number.NaN;
  }
  let next: number | null = null;
  for (let i = samples.length - 1; i >= 0; i--) {
    const v = samples[i];
    if (v != null) next = v;
    if (Number.isNaN(out[i]!)) out[i] = next ?? 0.5;
  }
  return out;
}

/** Centered 3-sample moving average (edges average what exists) — kills per-sample jitter. */
export function smooth3(xs: number[]): number[] {
  if (xs.length < 3) return xs.slice();
  return xs.map((v, i) => {
    const a = xs[i - 1] ?? v;
    const b = xs[i + 1] ?? v;
    return (a + v + b) / 3;
  });
}

/** Forward-pass speed limit: between consecutive samples the value may move at most
 * maxPerSec · Δt. A fast subject is followed with a steady (slightly lagging) pan instead of a
 * whip — the smoothstep easing between keyframes then stays gentle. */
export function clampVelocity(xs: number[], frames: number[], fps: number, maxPerSec: number): number[] {
  const out = xs.slice();
  for (let i = 1; i < out.length; i++) {
    const dt = Math.max(1 / fps, (frames[i]! - frames[i - 1]!) / fps);
    const lim = maxPerSec * dt;
    const d = out[i]! - out[i - 1]!;
    if (d > lim) out[i] = out[i - 1]! + lim;
    else if (d < -lim) out[i] = out[i - 1]! - lim;
  }
  return out;
}

/** Face x (0..1 of visible source width) → clip transform centerX, coverage-clamped
 * (centerX ∈ [1 − w/2, w/2]; header explains why). w ≤ 1 → nothing to pan → 0.5. */
export function faceToCenterX(fx: number, w: number): number {
  if (!(w > 1)) return 0.5;
  const centered = 0.5 + w * (0.5 - fx);
  return Math.min(w / 2, Math.max(1 - w / 2, centered));
}

/** Clip-relative sample frames: every `sampleSec` of timeline time, always including the last
 * visible frame so the pan holds to the very end of the clip. */
export function sampleFrames(durationFrames: number, fps: number, sampleSec = 0.5): number[] {
  const last = Math.max(0, Math.floor(durationFrames) - 1);
  const step = Math.max(1, Math.round(sampleSec * fps));
  const out: number[] = [];
  for (let f = 0; f <= last; f += step) out.push(f);
  if (out[out.length - 1] !== last) out.push(last);
  return out;
}

/** Drop keyframes interior to a constant run (|Δcx| ≤ eps on both sides): a static talking head
 * becomes 2 keyframes instead of 120. First/last are always kept so the track covers the clip. */
export function simplifyKeyframes(kfs: ReframeKeyframe[], eps = 0.002): ReframeKeyframe[] {
  if (kfs.length <= 2) return kfs.slice();
  return kfs.filter((k, i) => {
    if (i === 0 || i === kfs.length - 1) return true;
    return Math.abs(k.cx - kfs[i - 1]!.cx) > eps || Math.abs(kfs[i + 1]!.cx - k.cx) > eps;
  });
}

/** Full pure pipeline: raw per-sample face x (null = no face) → smoothed, speed-limited,
 * coverage-clamped centerX keyframes. Extracted from computeReframeKeyframes so it is testable
 * without a real detector/video. */
export function composeKeyframes(
  raw: (number | null)[],
  frames: number[],
  fps: number,
  w: number,
  opts?: { crop?: Crop; maxPanSpeed?: number },
): ReframeKeyframe[] {
  let fx = fillGaps(raw);
  if (opts?.crop) fx = fx.map((v) => cropRelativeX(v, opts.crop));
  fx = smooth3(fx);
  // maxPanSpeed is in canvas-widths/s; in face space (source-widths) that is maxPanSpeed / w,
  // because the canvas pan Δa = w · Δfx (a = 0.5 − fx·w + const).
  fx = clampVelocity(fx, frames, fps, (opts?.maxPanSpeed ?? 0.15) / Math.max(w, 1));
  const kfs = frames.map((f, i) => ({ frame: f, cx: r4(faceToCenterX(fx[i]!, w)) }));
  return simplifyKeyframes(kfs);
}

/** set_keyframes rows for property "position": [frame, topLeftX, topLeftY] with the clip pinned
 * full-height (topLeftY = 0). centerX→topLeft mapping: a = cx − w/2 (Transform is center-based). */
export function positionRows(kfs: ReframeKeyframe[], w: number): [number, number, number][] {
  return kfs.map((k) => [k.frame, r4(k.cx - w / 2), 0]);
}

// ─── face detection (browser-only; everything below needs a real DOM + WASM) ─

const MODEL_PATH = "models/blaze_face_short_range.tflite";

let detectorPromise: Promise<FaceDetector> | null = null;
/** detectForVideo timestamps must increase monotonically for the (cached) detector's lifetime. */
let lastVideoTs = 0;

function getDetector(): Promise<FaceDetector> {
  detectorPromise ??= (async () => {
    // Dynamic imports: the ~1.5 MB vision bundle + wasm URLs load on first use only (vite code-
    // splits them), and importing THIS module stays side-effect free for unit tests / initial load.
    const [vision, loader, binary] = await Promise.all([
      import("@mediapipe/tasks-vision"),
      import("@mediapipe/tasks-vision/vision_wasm_internal.js?url"),
      import("@mediapipe/tasks-vision/vision_wasm_internal.wasm?url"),
    ]);
    // WasmFileset built by hand (the SIMD pair we serve ourselves) instead of
    // FilesetResolver.forVisionTasks — see the header's offline-asset note.
    const fileset: Parameters<typeof vision.FaceDetector.createFromOptions>[0] = {
      wasmLoaderPath: loader.default,
      wasmBinaryPath: binary.default,
    };
    return vision.FaceDetector.createFromOptions(fileset, {
      baseOptions: {
        modelAssetPath: `${import.meta.env.BASE_URL}${MODEL_PATH}`,
        // CPU delegate: BlazeFace short-range is tiny (~5–15 ms/frame on WASM SIMD) and we sample
        // twice a second — not worth WebView2 GPU/WebGL variability.
        delegate: "CPU",
      },
      runningMode: "VIDEO",
      minDetectionConfidence: 0.5,
    });
  })();
  detectorPromise.catch(() => {
    detectorPromise = null; // failed init (asset missing/offline quirk) → allow a retry next click
  });
  return detectorPromise;
}

/** Resolve when the element knows its dimensions/duration. The bridge may still be transcoding the
 * scrub proxy for heavy sources (it blocks the /media response meanwhile), hence the long timeout. */
export function waitForVideoMetadata(v: HTMLVideoElement, timeoutMs = 60_000): Promise<void> {
  if (v.readyState >= 1 && v.videoWidth > 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const done = () => {
      cleanup();
      resolve();
    };
    const fail = () => {
      cleanup();
      reject(new Error("could not load the preview video"));
    };
    const timer = window.setTimeout(() => {
      cleanup();
      reject(new Error("timed out preparing the preview video"));
    }, timeoutMs);
    const cleanup = () => {
      window.clearTimeout(timer);
      v.removeEventListener("loadedmetadata", done);
      v.removeEventListener("error", fail);
    };
    v.addEventListener("loadedmetadata", done);
    v.addEventListener("error", fail);
  });
}

/** Seek and wait for the frame to be decoded. A stalled seek resolves after the timeout — detecting
 * on the last decoded frame beats aborting the whole pass. */
function seekVideo(v: HTMLVideoElement, seconds: number, timeoutMs = 5_000): Promise<void> {
  const dur = Number.isFinite(v.duration) && v.duration > 0 ? v.duration : Number.POSITIVE_INFINITY;
  const target = Math.max(0, Math.min(seconds, dur - 0.001));
  if (Math.abs(v.currentTime - target) < 0.001 && v.readyState >= 2) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const done = () => {
      cleanup();
      resolve();
    };
    const fail = () => {
      cleanup();
      reject(new Error("the preview video failed while seeking"));
    };
    const timer = window.setTimeout(done, timeoutMs);
    const cleanup = () => {
      window.clearTimeout(timer);
      v.removeEventListener("seeked", done);
      v.removeEventListener("error", fail);
    };
    v.addEventListener("seeked", done);
    v.addEventListener("error", fail);
    v.currentTime = target;
  });
}

/** Largest-face center x in FULL-frame 0..1 coords, or null when no face is found. */
function detectFaceCx(detector: FaceDetector, video: HTMLVideoElement): number | null {
  const vw = video.videoWidth;
  if (!vw) return null;
  lastVideoTs = Math.max(lastVideoTs + 33, Math.round(performance.now()));
  const result = detector.detectForVideo(video, lastVideoTs);
  let best: { area: number; cx: number } | null = null;
  for (const d of result.detections) {
    const b = d.boundingBox;
    if (!b || b.width <= 0 || b.height <= 0) continue;
    const area = b.width * b.height;
    if (!best || area > best.area) best = { area, cx: (b.originX + b.width / 2) / vw };
  }
  return best ? Math.min(1, Math.max(0, best.cx)) : null;
}

/**
 * Analyze `videoEl` (an offscreen element playing the clip's media/proxy) over the clip's source
 * range and return face-following pan keyframes: `{frame, cx}` with clip-relative frames and
 * clip-transform centerX values (see header for the exact geometry + range).
 *
 * The caller applies them by (1) setting the clip's fit-height transform
 * `{centerX: kfs[0].cx, centerY: 0.5, width: fitHeightWidth(...), height: 1}` and (2) replacing the
 * position track with positionRows(kfs, w).
 *
 * Note: detection reads video pixels; the media must be same-origin (or CORS-cleared) or Chromium
 * taints the frame and this rejects with a SecurityError. Served-by-the-bridge setups (production,
 * desktop, `bun run bridge` dev) are same-origin and always fine.
 */
export async function computeReframeKeyframes(
  videoEl: HTMLVideoElement,
  opts: ReframeOptions,
): Promise<ReframeKeyframe[]> {
  const { clipDurationFrames, trimStartFrame, fps, targetAspect, sourceW, sourceH } = opts;
  if (!(fps > 0) || !(clipDurationFrames > 0)) throw new Error("invalid clip timing");
  if (!(sourceW > 0) || !(sourceH > 0) || !(targetAspect > 0)) throw new Error("missing video dimensions");
  const speed = opts.speed > 0 ? opts.speed : 1;
  const w = fitHeightWidth(sourceW, sourceH, targetAspect, opts.crop);

  const frames = sampleFrames(clipDurationFrames, fps, opts.sample ?? 0.5);
  const detector = await getDetector();
  await waitForVideoMetadata(videoEl);

  const raw: (number | null)[] = [];
  for (let i = 0; i < frames.length; i++) {
    // Same source-time mapping as the preview (Preview.tsx): source advances at speed× from trim.
    await seekVideo(videoEl, (trimStartFrame + frames[i]! * speed) / fps);
    raw.push(detectFaceCx(detector, videoEl));
    opts.onProgress?.(i + 1, frames.length);
  }

  return composeKeyframes(raw, frames, fps, w, { crop: opts.crop, maxPanSpeed: opts.maxPanSpeed });
}
