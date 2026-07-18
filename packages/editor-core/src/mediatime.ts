// Exact time math for frame ↔ seconds conversions. CupCat's data model stays integer FRAMES at
// timeline.fps; this module gives those frames a drift-free time meaning, OpenCut-MediaTime style:
// an integer tick grid plus exact rationals for the NTSC rates, so no display/export layer ever
// has to divide by a binary-inexact float like 29.97 (frame 30000 at 29.97 fps is EXACTLY 1001 s).

/** Ticks per second of the integer time grid. 120000 divides evenly by every common integer rate
 * (24, 25, 30, 50, 60, 120) AND by the NTSC rationals (120000·1001/30000 = 4004 exactly). */
export const TICKS_PER_SECOND = 120000;

export interface FpsRational {
  num: number;
  den: number;
}

// The conventional NTSC decimals (as they arrive from JSON/UI selects) → exact broadcast
// rationals. Keys are compared with === on purpose: both JSON.parse("29.97") and
// Number("29.97") produce the identical double, so no epsilon is needed.
const NTSC_RATIONALS = new Map<number, FpsRational>([
  [23.976, { num: 24000, den: 1001 }],
  [29.97, { num: 30000, den: 1001 }],
  [59.94, { num: 60000, den: 1001 }],
]);

/** The NTSC frame rates accepted by set_project_format (next to plain integers 1–120). */
export const NTSC_RATES: readonly number[] = [...NTSC_RATIONALS.keys()];

/** Exact rational frame rate: 29.97 → 30000/1001, 23.976 → 24000/1001, 59.94 → 60000/1001,
 * anything else → fps/1. The rational — never the float — is what export/interchange code
 * should hand to ffmpeg (-r 30000/1001) and XML formats (frameDuration 1001/30000s). */
export function fpsRational(fps: number): FpsRational {
  return NTSC_RATIONALS.get(fps) ?? { num: fps, den: 1 };
}

/** Ticks per frame: TICKS_PER_SECOND·den/num — exact integers for the common rates
 * (30 → 4000, 29.97 → 4004, 23.976 → 5005, 59.94 → 2002). */
export function ticksPerFrame(fps: number): number {
  const { num, den } = fpsRational(fps);
  return (TICKS_PER_SECOND * den) / num;
}

export function frameToTicks(frame: number, fps: number): number {
  const { num, den } = fpsRational(fps);
  // Multiply first: integer products stay exact in a double up to 2^53 (a 10-hour timeline at
  // 120 fps is ~5·10^14 — well inside), so common rates round-trip with zero error.
  return Math.round((frame * TICKS_PER_SECOND * den) / num);
}

export function ticksToFrame(ticks: number, fps: number): number {
  const { num, den } = fpsRational(fps);
  return Math.round((ticks * num) / (TICKS_PER_SECOND * den));
}

/** frame → seconds through the EXACT rational (frame·den/num), never a float-fps division:
 * 30000/29.97 = 1001.001001… (drifts a full second over 10 h) while 30000·1001/30000 = 1001. */
export function frameToSeconds(frame: number, fps: number): number {
  const { num, den } = fpsRational(fps);
  return (frame * den) / num;
}

/** frame count → decimal-seconds STRING from the exact rational, up to `maxDecimals` digits
 * (default 7), trailing zeros trimmed — for ffmpeg filtergraph times. 7 decimals put the worst
 * rounding (5·10⁻⁸ s) four orders of magnitude under half a frame even at 120 fps, so
 * enable/trim windows built from these strings can never exclude a boundary frame the way a
 * 3-decimal toFixed did. Integer frame counts go through integer (BigInt) math — bit-exact;
 * fractional ones (speed-scaled durations) fall back to full double precision. */
export function frameSecondsString(frame: number, fps: number, maxDecimals = 7): string {
  const { num, den } = fpsRational(fps);
  const trim = (str: string) => str.replace(/\.?0+$/, "");
  if (!Number.isInteger(frame) || !Number.isInteger(num) || frame < 0) {
    return trim(((frame * den) / num).toFixed(maxDecimals));
  }
  const scale = 10n ** BigInt(maxDecimals);
  const d = BigInt(num);
  // Round-half-up at the last kept decimal: q = round(frame·den·10^k / num).
  const q = (BigInt(frame) * BigInt(den) * scale + d / 2n) / d;
  const frac = (q % scale).toString().padStart(maxDecimals, "0").replace(/0+$/, "");
  return frac ? `${q / scale}.${frac}` : `${q / scale}`;
}
