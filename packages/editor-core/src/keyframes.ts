// Keyframe sampling + interpolation. Mirrors Palmier's KeyframeTrack.sample:
// hold / linear / smooth, with clip-relative frames.

import type { AnimPair, Crop, Keyframe, KeyframeTrack } from "./types";

export function smoothstep(t: number): number {
  return t * t * (3 - 2 * t);
}

// Default control handles for a "bezier" segment missing one. Chosen so a handle-less bezier
// segment is EXACTLY smoothstep: with x1=1/3, x2=2/3 the bezier's x(t) collapses to t, and
// y1=0, y2=1 make y(t) = 3t² − 2t³ — the same ease the "smooth" interpolation uses.
export const BEZIER_DEFAULT_OUT: readonly [number, number] = [1 / 3, 0];
export const BEZIER_DEFAULT_IN: readonly [number, number] = [2 / 3, 1];

/** Evaluate y(x) of a CSS-style cubic timing curve through (0,0), P1=(x1,y1), P2=(x2,y2), (1,1).
 * x1/x2 must be in [0,1] (guarantees x(t) is monotonic, so the solve is well-posed); y1/y2 are
 * unclamped so eases can overshoot. Solves x(t) = x with Newton–Raphson and falls back to
 * bisection when Newton stalls — the same strategy browsers use — to a 1e-5 tolerance. */
export function cubicBezierY(x: number, x1: number, y1: number, x2: number, y2: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  // Polynomial coefficients: B(t) = ((a·t + b)·t + c)·t for a curve anchored at 0 and 1.
  const coef = (p1: number, p2: number) => {
    const c = 3 * p1;
    const b = 3 * (p2 - p1) - c;
    const a = 1 - c - b;
    return { a, b, c };
  };
  const cx = coef(x1, x2);
  const cy = coef(y1, y2);
  const sampleX = (t: number) => ((cx.a * t + cx.b) * t + cx.c) * t;
  const sampleDX = (t: number) => (3 * cx.a * t + 2 * cx.b) * t + cx.c;
  const EPS = 1e-5;

  // Newton–Raphson: fast for well-behaved slopes.
  let t = x;
  for (let i = 0; i < 8; i++) {
    const err = sampleX(t) - x;
    if (Math.abs(err) < EPS) return ((cy.a * t + cy.b) * t + cy.c) * t;
    const d = sampleDX(t);
    if (Math.abs(d) < 1e-6) break; // flat spot — Newton would blow up
    t -= err / d;
  }
  // Bisection fallback: x(t) is monotonic for x1/x2 ∈ [0,1], so this always converges.
  let lo = 0;
  let hi = 1;
  t = x;
  while (hi - lo > EPS) {
    if (sampleX(t) < x) lo = t;
    else hi = t;
    t = (lo + hi) / 2;
  }
  return ((cy.a * t + cy.b) * t + cy.c) * t;
}

/** Eased progress 0..1 (y can overshoot for bezier) through the segment leaving keyframe `a`
 * toward keyframe `b`, at raw linear progress `raw` ∈ [0,1]. Single source of truth for what
 * every consumer (preview sampling, export densification) does per interpolation mode. */
export function segmentProgress<V>(a: Keyframe<V>, b: Keyframe<V>, raw: number): number {
  switch (a.interpolationOut) {
    case "hold":
      return 0;
    case "linear":
      return raw;
    case "bezier": {
      const p1 = a.bezierOut ?? BEZIER_DEFAULT_OUT;
      const p2 = b.bezierIn ?? BEZIER_DEFAULT_IN;
      return cubicBezierY(raw, p1[0], p1[1], p2[0], p2[1]);
    }
    case "smooth":
      return smoothstep(raw);
  }
}

export type Lerp<V> = (a: V, b: V, t: number) => V;

export const lerpNumber: Lerp<number> = (a, b, t) => a + (b - a) * t;

export const lerpAnimPair: Lerp<AnimPair> = (a, b, t) => ({
  a: lerpNumber(a.a, b.a, t),
  b: lerpNumber(a.b, b.b, t),
});

export const lerpCrop: Lerp<Crop> = (a, b, t) => ({
  left: lerpNumber(a.left, b.left, t),
  top: lerpNumber(a.top, b.top, t),
  right: lerpNumber(a.right, b.right, t),
  bottom: lerpNumber(a.bottom, b.bottom, t),
});

export function trackIsActive<V>(t: KeyframeTrack<V> | undefined): boolean {
  return !!t && t.keyframes.length > 0;
}

/** Sample a keyframe track at a clip-relative `frame`, falling back when empty. */
export function sampleTrack<V>(
  track: KeyframeTrack<V> | undefined,
  frame: number,
  fallback: V,
  lerp: Lerp<V>,
): V {
  if (!track || track.keyframes.length === 0) return fallback;
  const ks = track.keyframes;
  const first = ks[0]!;
  const last = ks[ks.length - 1]!;
  if (ks.length === 1) return first.value;
  if (frame <= first.frame) return first.value;
  if (frame >= last.frame) return last.value;

  let bIdx = ks.findIndex((k) => k.frame > frame);
  if (bIdx <= 0) return last.value;
  const a = ks[bIdx - 1]!;
  const b = ks[bIdx]!;
  const raw = (frame - a.frame) / (b.frame - a.frame);
  return lerp(a.value, b.value, segmentProgress(a, b, raw));
}

// ── densification (export parity for bezier segments) ────────────────────────

/** Interpolate any supported keyframe value shape (number, AnimPair, Crop) — densifyTrack works
 * on whole clips, so it can't take a per-property lerp without burdening every caller. */
function lerpValue<V>(a: V, b: V, t: number): V {
  if (typeof a === "number") return lerpNumber(a, b as number, t) as V;
  const ap = a as Record<string, number>;
  if ("a" in ap) return lerpAnimPair(a as AnimPair, b as unknown as AnimPair, t) as V;
  return lerpCrop(a as unknown as Crop, b as unknown as Crop, t) as V;
}

/** Rewrite a track that contains "bezier" segments into an equivalent piecewise-LINEAR track by
 * sampling the true curve, so consumers that can only interpolate linearly between keyframes
 * (the ffmpeg export expressions) render bezier motion identically to the preview. Tracks with
 * no bezier segment are returned UNCHANGED (same reference) — the export graph of a non-bezier
 * timeline is byte-identical before/after densification.
 *
 * Sample spacing: 8 samples/second minimum, capped at one sample every 2 frames — whichever
 * yields fewer points (step = max(2, floor(fps/8)) frames). Original keyframes are kept as exact
 * points; "hold" segments become an exact step via a pre-jump sample one frame before the next
 * keyframe; "smooth"/"bezier" segments get true-curve samples on the grid. Pure function. */
export function densifyTrack<V>(track: KeyframeTrack<V>, fps: number): KeyframeTrack<V> {
  const ks = track.keyframes;
  const hasBezier = ks.some((k, i) => i < ks.length - 1 && k.interpolationOut === "bezier");
  if (!hasBezier) return track;

  const step = Math.max(2, Math.floor(fps / 8));
  const out: Keyframe<V>[] = [];
  const push = (frame: number, value: V) => {
    // Grid samples are spaced ≥2 frames from segment endpoints by construction; the only possible
    // collision is a hold's pre-jump sample landing on the previous sample — last write wins.
    if (out.length && out[out.length - 1]!.frame === frame) out[out.length - 1] = { frame, value, interpolationOut: "linear" };
    else out.push({ frame, value, interpolationOut: "linear" });
  };
  for (let i = 0; i < ks.length - 1; i++) {
    const a = ks[i]!;
    const b = ks[i + 1]!;
    push(a.frame, a.value);
    const span = b.frame - a.frame;
    if (a.interpolationOut === "hold") {
      // Exact step: hold a.value up to the frame before b, then a 1-frame linear jump lands
      // b.value exactly AT b.frame — identical to hold at every integer frame.
      if (span > 1) push(b.frame - 1, a.value);
    } else if (a.interpolationOut !== "linear") {
      for (let f = a.frame + step; f <= b.frame - 2; f += step) {
        push(f, lerpValue(a.value, b.value, segmentProgress(a, b, (f - a.frame) / span)));
      }
    }
  }
  const last = ks[ks.length - 1]!;
  push(last.frame, last.value);
  return { keyframes: out };
}

/** Insert or replace a keyframe at its frame, keeping the array sorted; last write wins. */
export function upsertKeyframe<V>(track: KeyframeTrack<V>, kf: Keyframe<V>): void {
  const i = track.keyframes.findIndex((k) => k.frame === kf.frame);
  if (i >= 0) {
    track.keyframes[i] = kf;
    return;
  }
  const at = track.keyframes.findIndex((k) => k.frame > kf.frame);
  if (at < 0) track.keyframes.push(kf);
  else track.keyframes.splice(at, 0, kf);
}
