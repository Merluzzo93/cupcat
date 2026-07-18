// Pure keyframe-row builders for the Inspector. The bridge's set_keyframes command REPLACES a
// property's whole track with rows shaped [frame, ...values, interp?], where the optional last
// element is "smooth" | "linear" | "hold" | "bezier" (default smooth); a "bezier" row appends its
// 4 CSS-style handle numbers ([..., "bezier", outX, outY, inX, inY]). These helpers rebuild rows
// from the clip's CURRENT keyframes so partial edits — adding one keyframe, switching the easing,
// dragging a curve handle — never silently reset the other rows' easing or handles to the
// default. Unit-tested in kfRows.test.ts.

import { BEZIER_DEFAULT_IN, BEZIER_DEFAULT_OUT } from "@cupcat/editor-core";
import type { AnimPair, Interpolation, Keyframe } from "@cupcat/editor-core";

export type ScalarRow =
  | [number, number, Interpolation]
  | [number, number, "bezier", number, number, number, number];
export type PairRow =
  | [number, number, number, Interpolation]
  | [number, number, number, "bezier", number, number, number, number];

/** Easing of a keyframe, treating a missing value as the bridge's default ("smooth"). */
function easingOf(k: { interpolationOut?: Interpolation }): Interpolation {
  return k.interpolationOut ?? "smooth";
}

/** Row tail for a keyframe: just the easing name, or — for bezier — the easing plus explicit
 * handles (missing stored handles materialize as the smoothstep-equivalent defaults, so a
 * write-back is stable and the curve editor always has concrete numbers to drag). */
function easingTail(k: Keyframe<unknown>, override?: Interpolation): (Interpolation | number)[] {
  const interp = override ?? easingOf(k);
  if (interp !== "bezier") return [interp];
  return [interp, ...(k.bezierOut ?? BEZIER_DEFAULT_OUT), ...(k.bezierIn ?? BEZIER_DEFAULT_IN)];
}

/** Rows for a scalar track (opacity/rotation/volume). `override` forces one easing on every row;
 * omitted = each keyframe keeps its own (and, for bezier, its handles). */
export function scalarRows(kfs: Keyframe<number>[], override?: Interpolation): ScalarRow[] {
  return kfs.map((k) => [k.frame, k.value, ...easingTail(k, override)] as ScalarRow);
}

/** Rows for a pair track (position/scale) — [frame, a, b, interp, ...handles?]. */
export function pairRows(kfs: Keyframe<AnimPair>[], override?: Interpolation): PairRow[] {
  return kfs.map((k) => [k.frame, k.value.a, k.value.b, ...easingTail(k, override)] as PairRow);
}

/** Upsert one row into a row list keyed by frame (row[0]), kept sorted — same frame replaces. */
export function mergeKfRows<R extends [number, ...unknown[]]>(existing: R[], row: R): R[] {
  return [...existing.filter((r) => r[0] !== row[0]), row].sort((a, b) => a[0] - b[0]);
}

/** The easing shared by ALL keyframes of a track, or null when the track is empty or mixed —
 * drives which preset chip lights up in the Inspector (mixed lights none). */
export function trackEasing(kfs: { interpolationOut?: Interpolation }[] | undefined): Interpolation | null {
  if (!kfs || kfs.length === 0) return null;
  const first = easingOf(kfs[0]!);
  return kfs.every((k) => easingOf(k) === first) ? first : null;
}
