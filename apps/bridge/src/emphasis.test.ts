// Choosing who to punch in on. The scoring has to survive the two things that would otherwise make
// it useless: a shaky or moving shot (which moves every mouth region at once) and a genuine tie
// (which means the measurement failed and should say so rather than guess).

import { describe, expect, it } from "bun:test";
import { framingFor, isConfident, mouthRegion, rankSpeakers, regionMotion } from "./emphasis";

describe("mouthRegion", () => {
  it("sits in the lower middle of the face, not the whole box", () => {
    const m = mouthRegion({ x: 0, y: 0, w: 1, h: 1 });
    expect(m.x).toBeGreaterThan(0);
    expect(m.y).toBeGreaterThan(0.5); // below the eyes
    expect(m.w).toBeLessThan(1);
    expect(m.y + m.h).toBeLessThanOrEqual(1.0001); // still inside the face
  });

  it("scales and moves with the face", () => {
    const m = mouthRegion({ x: 0.5, y: 0.2, w: 0.2, h: 0.2 });
    expect(m.x).toBeGreaterThan(0.5);
    expect(m.x + m.w).toBeLessThan(0.7);
  });
});

describe("regionMotion", () => {
  const W = 10;
  const H = 10;
  const flat = (v: number) => new Uint8Array(W * H).fill(v);

  it("is zero between identical frames", () => {
    expect(regionMotion(flat(80), flat(80), W, H, { x: 0, y: 0, w: 1, h: 1 })).toBe(0);
  });

  it("measures the average change inside the region", () => {
    expect(regionMotion(flat(80), flat(90), W, H, { x: 0, y: 0, w: 1, h: 1 })).toBeCloseTo(10, 5);
  });

  it("only looks inside the region it was given", () => {
    const a = flat(0);
    const b = flat(0);
    b[0] = 255; // change one pixel in the top-left corner only
    const bottomRight = regionMotion(a, b, W, H, { x: 0.5, y: 0.5, w: 0.5, h: 0.5 });
    expect(bottomRight).toBe(0);
    expect(regionMotion(a, b, W, H, { x: 0, y: 0, w: 0.5, h: 0.5 })).toBeGreaterThan(0);
  });

  it("survives a region that runs off the edge instead of reading past the buffer", () => {
    expect(() => regionMotion(flat(0), flat(1), W, H, { x: 0.9, y: 0.9, w: 0.5, h: 0.5 })).not.toThrow();
  });

  it("never returns NaN for a zero-sized region", () => {
    expect(regionMotion(flat(0), flat(1), W, H, { x: 0.5, y: 0.5, w: 0, h: 0 })).toBeGreaterThanOrEqual(0);
  });
});

describe("rankSpeakers", () => {
  it("puts the moving mouth first", () => {
    const ranked = rankSpeakers([[1, 1, 1], [9, 8, 9]], [1, 1, 1]);
    expect(ranked[0]!.index).toBe(1);
  });

  it("cancels out whole-frame movement, so a moving camera does not crown everybody", () => {
    // Both mouths move a lot, but so does the entire picture — nobody stands out.
    const ranked = rankSpeakers([[20, 20, 20], [21, 20, 19]], [20, 20, 20]);
    expect(ranked[0]!.score).toBeCloseTo(ranked[1]!.score, 1);
  });

  it("finds the talker even while the camera moves", () => {
    const ranked = rankSpeakers([[20, 20, 20], [60, 62, 58]], [20, 20, 20]);
    expect(ranked[0]!.index).toBe(1);
    expect(ranked[0]!.score / ranked[1]!.score).toBeGreaterThan(2);
  });

  it("handles a face with no samples rather than producing NaN", () => {
    const ranked = rankSpeakers([[], [3, 3]], [1, 1]);
    expect(ranked.every((r) => Number.isFinite(r.score))).toBe(true);
  });

  it("returns nothing for no candidates", () => {
    expect(rankSpeakers([], [])).toEqual([]);
  });
});

describe("isConfident", () => {
  it("accepts a clear winner", () => {
    expect(isConfident([{ index: 1, score: 10 }, { index: 0, score: 2 }])).toBe(true);
  });

  it("refuses a near-tie, because a tie means the measurement did not decide", () => {
    expect(isConfident([{ index: 0, score: 10 }, { index: 1, score: 9.5 }])).toBe(false);
  });

  it("accepts a lone face that actually moved", () => {
    expect(isConfident([{ index: 0, score: 4 }])).toBe(true);
  });

  it("refuses a lone face that never moved", () => {
    expect(isConfident([{ index: 0, score: 0 }])).toBe(false);
  });

  it("refuses when there is nobody", () => {
    expect(isConfident([])).toBe(false);
  });
});

describe("framingFor", () => {
  it("magnifies a small face more than a large one", () => {
    const small = framingFor({ x: 0.4, y: 0.4, w: 0.05, h: 0.08 }, 0.4);
    const large = framingFor({ x: 0.3, y: 0.2, w: 0.3, h: 0.4 }, 0.4);
    expect(small.scale).toBeGreaterThan(large.scale);
  });

  it("never shrinks the picture below full frame", () => {
    expect(framingFor({ x: 0, y: 0, w: 1, h: 1 }, 0.4).scale).toBe(1);
  });

  it("caps the magnification so a tiny face does not become a pixel soup", () => {
    expect(framingFor({ x: 0.5, y: 0.5, w: 0.002, h: 0.002 }, 0.5).scale).toBeLessThanOrEqual(6);
  });

  it("keeps the window inside the picture for a face at the very edge", () => {
    // A face in the corner must not produce a window hanging off the frame — that shows black.
    const f = framingFor({ x: 0.94, y: 0.9, w: 0.06, h: 0.1 }, 0.4);
    const half = 0.5 / f.scale;
    // The centre the framing settled on, recovered from the offset, must be at least half a window
    // away from each edge.
    const cx = (0.5 - f.x) / f.scale;
    const cy = (0.5 - f.y) / f.scale;
    expect(cx).toBeGreaterThanOrEqual(half - 1e-9);
    expect(cx).toBeLessThanOrEqual(1 - half + 1e-9);
    expect(cy).toBeGreaterThanOrEqual(half - 1e-9);
    expect(cy).toBeLessThanOrEqual(1 - half + 1e-9);
  });

  it("clamps by moving the window, not by shrinking it — the asked-for zoom is what you get", () => {
    const centre = framingFor({ x: 0.45, y: 0.45, w: 0.1, h: 0.1 }, 0.4);
    const edge = framingFor({ x: 0.0, y: 0.0, w: 0.1, h: 0.1 }, 0.4);
    expect(edge.scale).toBeCloseTo(centre.scale, 6);
  });

  it("leaves head-room rather than centring the face like a passport photo", () => {
    const f = framingFor({ x: 0.4, y: 0.4, w: 0.2, h: 0.2 }, 0.45);
    const cy = (0.5 - f.y) / f.scale;
    expect(cy).toBeLessThan(0.5); // aims above the face centre
  });
});
