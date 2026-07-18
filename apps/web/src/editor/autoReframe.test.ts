// Pure-math tests for the auto-reframe pipeline: fit-height geometry, gap filling, smoothing,
// pan-speed clamping, centerX→topLeft mapping and the set_keyframes row payloads. No DOM, no WASM —
// the detector itself is exercised in a real browser (see the coordinator verification note).
// Run with `bun test` (bun re-maps the vitest import to bun:test) or `bunx vitest run`.
import { describe, expect, test } from "vitest";
import {
  clampVelocity,
  composeKeyframes,
  cropRelativeX,
  faceToCenterX,
  fillGaps,
  fitHeightWidth,
  positionRows,
  sampleFrames,
  simplifyKeyframes,
  smooth3,
} from "./autoReframe";

// 16:9 source on a 9:16 canvas — the flagship case: (1920/1080)/(1080/1920) = 256/81.
const W916 = 256 / 81; // ≈ 3.16049

describe("fitHeightWidth (fit-height box width in canvas units)", () => {
  test("1920×1080 source on a 1080×1920 canvas ≈ 3.1605", () => {
    expect(fitHeightWidth(1920, 1080, 1080 / 1920)).toBeCloseTo(W916, 4);
  });
  test("source matching the canvas aspect fills exactly (w = 1)", () => {
    expect(fitHeightWidth(1080, 1920, 1080 / 1920)).toBeCloseTo(1, 6);
  });
  test("4K 16:9 gives the same w as 1080p (aspect-only)", () => {
    expect(fitHeightWidth(3840, 2160, 1080 / 1920)).toBeCloseTo(W916, 4);
  });
  test("crop insets change the visible aspect (25% off each side of 16:9 → half the width)", () => {
    const crop = { left: 0.25, top: 0, right: 0.25, bottom: 0 };
    expect(fitHeightWidth(1920, 1080, 1080 / 1920, crop)).toBeCloseTo(W916 / 2, 4);
  });
  test("degenerate inputs fall back to 1", () => {
    expect(fitHeightWidth(0, 1080, 0.5625)).toBe(1);
    expect(fitHeightWidth(1920, 1080, 0)).toBe(1);
  });
});

describe("faceToCenterX (centering + coverage clamp)", () => {
  test("centered face → canvas-centered clip", () => {
    expect(faceToCenterX(0.5, W916)).toBeCloseTo(0.5, 6);
  });
  test("face at the far left clamps to centerX = w/2 (left edge of source at canvas left)", () => {
    // Unclamped would be 0.5 + w·0.5 ≈ 2.08 — that would pull the source off past the right edge.
    expect(faceToCenterX(0, W916)).toBeCloseTo(W916 / 2, 6);
  });
  test("face at the far right clamps to centerX = 1 − w/2", () => {
    expect(faceToCenterX(1, W916)).toBeCloseTo(1 - W916 / 2, 6);
  });
  test("interior face maps linearly: fx=0.75, w=2 → centerX 0 (exactly the coverage bound)", () => {
    expect(faceToCenterX(0.75, 2)).toBeCloseTo(0, 6);
  });
  test("w ≤ 1 (source not wider than canvas) always pins to 0.5", () => {
    expect(faceToCenterX(0.1, 1)).toBe(0.5);
    expect(faceToCenterX(0.9, 0.8)).toBe(0.5);
  });
});

describe("positionRows (centerX→topLeft mapping for set_keyframes)", () => {
  test("a = cx − w/2, b pinned to 0 (full-height clip)", () => {
    const rows = positionRows(
      [
        { frame: 0, cx: 0.5 },
        { frame: 30, cx: 1.2 },
      ],
      W916,
    );
    expect(rows).toEqual([
      [0, Math.round((0.5 - W916 / 2) * 10000) / 10000, 0],
      [30, Math.round((1.2 - W916 / 2) * 10000) / 10000, 0],
    ]);
    // sanity: centered clip on 9:16 → topLeftX ≈ −1.0802 (the box hangs w−1 ≈ 2.16 outside, split evenly)
    expect(rows[0]![1]).toBeCloseTo(-1.0802, 3);
  });
});

describe("fillGaps (detection dropouts)", () => {
  test("holds the previous face through gaps and backfills the leading gap", () => {
    expect(fillGaps([null, 0.3, null, null, 0.7])).toEqual([0.3, 0.3, 0.3, 0.3, 0.7]);
  });
  test("no face in the whole clip → source center everywhere", () => {
    expect(fillGaps([null, null, null])).toEqual([0.5, 0.5, 0.5]);
  });
});

describe("smooth3 (moving average)", () => {
  test("averages a 3-wide window, edges use what exists", () => {
    const out = smooth3([0, 1, 0]);
    expect(out[0]).toBeCloseTo(1 / 3, 6);
    expect(out[1]).toBeCloseTo(1 / 3, 6);
    expect(out[2]).toBeCloseTo(1 / 3, 6);
  });
  test("short inputs pass through", () => {
    expect(smooth3([0.2, 0.8])).toEqual([0.2, 0.8]);
  });
  test("constant input is unchanged", () => {
    expect(smooth3([0.5, 0.5, 0.5, 0.5])).toEqual([0.5, 0.5, 0.5, 0.5]);
  });
});

describe("clampVelocity (max pan speed)", () => {
  test("a jump is ramped at maxPerSec · Δt per step", () => {
    // samples 0.5 s apart (fps 30, 15 frames), limit 0.2/s → max 0.1 per step
    expect(clampVelocity([0, 0.5, 0.5], [0, 15, 30], 30, 0.2)).toEqual([0, 0.1, 0.2]);
  });
  test("slow motion is untouched", () => {
    expect(clampVelocity([0.5, 0.52, 0.55], [0, 15, 30], 30, 0.2)).toEqual([0.5, 0.52, 0.55]);
  });
  test("clamps symmetrically for leftward motion", () => {
    expect(clampVelocity([0.5, 0], [0, 15], 30, 0.2)).toEqual([0.5, 0.4]);
  });
});

describe("sampleFrames", () => {
  test("every 0.5 s at 30 fps, last frame always included", () => {
    expect(sampleFrames(90, 30, 0.5)).toEqual([0, 15, 30, 45, 60, 75, 89]);
  });
  test("clip shorter than one step → first and last", () => {
    expect(sampleFrames(10, 30, 0.5)).toEqual([0, 9]);
  });
  test("single-frame clip", () => {
    expect(sampleFrames(1, 30, 0.5)).toEqual([0]);
  });
});

describe("cropRelativeX", () => {
  test("identity crop is identity", () => {
    expect(cropRelativeX(0.37)).toBeCloseTo(0.37, 6);
    expect(cropRelativeX(0.37, { left: 0, top: 0, right: 0, bottom: 0 })).toBeCloseTo(0.37, 6);
  });
  test("maps full-frame x into the visible span and clamps outside it", () => {
    const crop = { left: 0.25, top: 0, right: 0.25, bottom: 0 };
    expect(cropRelativeX(0.5, crop)).toBeCloseTo(0.5, 6);
    expect(cropRelativeX(0.25, crop)).toBeCloseTo(0, 6);
    expect(cropRelativeX(0.1, crop)).toBe(0); // face outside the crop → clamp to edge
  });
});

describe("simplifyKeyframes", () => {
  test("collapses a constant run to its endpoints", () => {
    const kfs = [0, 15, 30, 45].map((frame) => ({ frame, cx: 0.5 }));
    expect(simplifyKeyframes(kfs).map((k) => k.frame)).toEqual([0, 45]);
  });
  test("keeps both boundary keyframes of a ramp between plateaus", () => {
    const kfs = [
      { frame: 0, cx: 0.5 },
      { frame: 15, cx: 0.5 },
      { frame: 30, cx: 0.9 },
      { frame: 45, cx: 0.9 },
    ];
    expect(simplifyKeyframes(kfs).map((k) => k.frame)).toEqual([0, 15, 30, 45]);
  });
});

describe("composeKeyframes (full pure pipeline)", () => {
  test("static centered face → 2 keyframes at centerX 0.5", () => {
    const frames = [0, 15, 30, 45, 60];
    const raw = [0.5, 0.5, null, 0.5, 0.5]; // one dropout in the middle
    const kfs = composeKeyframes(raw, frames, 30, W916);
    expect(kfs).toEqual([
      { frame: 0, cx: 0.5 },
      { frame: 60, cx: 0.5 },
    ]);
  });
  test("face drifting right pans the clip left (centerX decreases), never past coverage bounds", () => {
    const frames = [0, 15, 30, 45, 60, 75, 90];
    const raw = [0.5, 0.55, 0.6, 0.65, 0.7, 0.75, 0.8];
    const kfs = composeKeyframes(raw, frames, 30, W916, { maxPanSpeed: 10 }); // no speed limit
    expect(kfs[0]!.cx).toBeLessThanOrEqual(0.5);
    for (let i = 1; i < kfs.length; i++) expect(kfs[i]!.cx).toBeLessThan(kfs[i - 1]!.cx);
    for (const k of kfs) {
      expect(k.cx).toBeGreaterThanOrEqual(1 - W916 / 2);
      expect(k.cx).toBeLessThanOrEqual(W916 / 2);
    }
  });
  test("default pan-speed limit keeps steps ≤ 0.15 canvas-width/s", () => {
    const frames = [0, 15, 30];
    const raw = [0.1, 0.9, 0.9]; // violent jump
    const kfs = composeKeyframes(raw, frames, 30, W916);
    for (let i = 1; i < kfs.length; i++) {
      const dt = (kfs[i]!.frame - kfs[i - 1]!.frame) / 30;
      // cx moves w·Δfx, Δfx ≤ (0.15/w)·dt → |Δcx| ≤ 0.15·dt (+ rounding slack)
      expect(Math.abs(kfs[i]!.cx - kfs[i - 1]!.cx)).toBeLessThanOrEqual(0.15 * dt + 0.001);
    }
  });
  test("narrow source (w ≤ 1) yields a flat centered track", () => {
    const kfs = composeKeyframes([0.1, 0.9], [0, 15], 30, 1);
    expect(kfs.every((k) => k.cx === 0.5)).toBe(true);
  });
});
