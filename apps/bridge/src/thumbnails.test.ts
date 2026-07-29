// What makes one frame a better cover than another.
//
// The measuring is separated from the deciding so the deciding can be tested on numbers instead of
// video. The frames here are built by hand — a flat wall, a checkerboard, a smeared edge — because
// those are exactly the cases that a cover picker gets wrong.

import { describe, expect, test } from "bun:test";
import { frameStats, percentile, pickSpread, scoreFrames, sharpnessScale, type FaceInfo, type FrameStats, type ScoredFrame } from "./thumbnails";

const W = 32;
const H = 24;

function flat(value: number): Uint8Array {
  return new Uint8Array(W * H).fill(value);
}

function checkerboard(size: number, lo = 16, hi = 240): Uint8Array {
  const g = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      g[y * W + x] = (Math.floor(x / size) + Math.floor(y / size)) % 2 === 0 ? hi : lo;
    }
  }
  return g;
}

/** A vertical edge with `ramp` columns of transition — 0 columns is in focus, 8 is smeared. */
function edge(ramp: number): Uint8Array {
  const g = new Uint8Array(W * H);
  const mid = W / 2;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const d = x - mid;
      const v = ramp === 0 ? (d < 0 ? 30 : 220) : Math.max(0, Math.min(1, (d + ramp / 2) / ramp)) * 190 + 30;
      g[y * W + x] = Math.round(v);
    }
  }
  return g;
}

describe("frame measurement", () => {
  test("a flat wall has no detail and no contrast", () => {
    const s = frameStats(flat(120), W, H, 0);
    expect(s.brightness).toBe(120);
    expect(s.contrast).toBeCloseTo(0, 6);
    expect(s.sharpness).toBeCloseTo(0, 6);
  });

  test("brightness is the mean, so a dark frame reads dark", () => {
    expect(frameStats(flat(8), W, H, 0).brightness).toBe(8);
    expect(frameStats(flat(250), W, H, 0).brightness).toBe(250);
  });

  test("a detailed frame measures far sharper than a flat one", () => {
    expect(frameStats(checkerboard(2), W, H, 0).sharpness).toBeGreaterThan(frameStats(flat(128), W, H, 0).sharpness + 1000);
  });

  test("blur lowers sharpness — the whole point of the measure", () => {
    // Same edge, same average brightness, same subject: only the focus differs.
    const sharp = frameStats(edge(0), W, H, 0);
    const soft = frameStats(edge(4), W, H, 0);
    const smeared = frameStats(edge(10), W, H, 0);
    expect(sharp.sharpness).toBeGreaterThan(soft.sharpness);
    expect(soft.sharpness).toBeGreaterThan(smeared.sharpness);
  });

  test("blur does not lower CONTRAST much — which is why sharpness is measured separately", () => {
    // A defocused shot keeps its tonal range; only its edges go. A picker that judged on contrast
    // alone would happily choose the blurred frame.
    const sharp = frameStats(edge(0), W, H, 0);
    const smeared = frameStats(edge(10), W, H, 0);
    expect(smeared.contrast).toBeGreaterThan(sharp.contrast * 0.7);
  });

  test("the time is carried through untouched", () => {
    expect(frameStats(flat(100), W, H, 12.5).t).toBe(12.5);
  });
});

describe("percentile", () => {
  test("returns a value from the set, not an interpolation", () => {
    expect(percentile([5, 1, 3, 2, 4], 0.5)).toBe(3);
    expect(percentile([5, 1, 3, 2, 4], 1)).toBe(5);
    expect(percentile([5, 1, 3, 2, 4], 0)).toBe(1);
  });

  test("an empty set is zero rather than NaN", () => {
    expect(percentile([], 0.9)).toBe(0);
  });

  test("one freak value does not become the reference", () => {
    // The ninth decile of nine ordinary frames and one flash is an ordinary frame.
    const vals = [10, 11, 12, 10, 11, 12, 10, 11, 12, 9000];
    expect(percentile(vals, 0.9)).toBeLessThan(100);
  });
});

describe("the sharpness scale", () => {
  // The numbers below are real: they are the deciles measured on the user's own footage, which is
  // what forced this scale to exist. Dividing by the best frame put everything usable above 0.4.
  const handheld = [1197, 1519, 1647, 1912, 2143, 2445, 2851]; // a two-minute handheld clip
  const lockedOff = [934, 1613, 1634, 1685, 1727, 1778, 1902]; // a tripod interview

  test("footage with real focus differences uses the whole range", () => {
    const s = sharpnessScale(handheld);
    expect(s(1519)).toBeLessThan(0.1);
    expect(s(1912)).toBeGreaterThan(0.3);
    expect(s(1912)).toBeLessThan(0.7);
    expect(s(2445)).toBeGreaterThan(0.9);
  });

  test("uniformly sharp footage does not get a ranking invented from its noise", () => {
    // Everything within a few percent of everything else: the term must stay small so that faces
    // and exposure decide, instead of a rounding difference in focus deciding.
    const s = sharpnessScale(lockedOff);
    expect(s(1778)).toBeLessThan(0.5);
    expect(s(1727) - s(1634)).toBeLessThan(0.3);
  });

  test("a genuinely blurred frame still falls to the bottom of uniform footage", () => {
    expect(sharpnessScale(lockedOff)(934)).toBe(0);
  });

  test("scale is irrelevant — grainy and clean footage rank the same", () => {
    const grainy = sharpnessScale(handheld);
    const clean = sharpnessScale(handheld.map((v) => v * 1000));
    expect(grainy(1912)).toBeCloseTo(clean(1912000), 6);
  });

  test("a single frame, or identical frames, score neutral rather than zero", () => {
    expect(sharpnessScale([500])(500)).toBe(0.5);
    expect(sharpnessScale([500, 500, 500])(500)).toBe(0.5);
  });

  test("one freak frame does not become the reference", () => {
    // A strobe or a burst of on-screen text can measure hundreds of times sharper than anything
    // else. Scaling against the maximum would push every real frame to near zero; the ninth decile
    // ignores it, and the footage's genuine best frame still tops the scale.
    const withFlash = sharpnessScale([...handheld, 900000]);
    expect(withFlash(2851)).toBe(1);
    expect(withFlash(2445)).toBeGreaterThan(0.5);
  });
});

const f = (t: number, sharpness: number, brightness = 128, contrast = 55): FrameStats => ({ t, sharpness, brightness, contrast });

describe("scoring", () => {
  test("the sharper frame wins when everything else is equal", () => {
    const [a, b] = scoreFrames([f(0, 1000), f(1, 100)]);
    expect(a!.score).toBeGreaterThan(b!.score);
  });

  test("a crushed or blown frame is disqualified on exposure", () => {
    const scored = scoreFrames([f(0, 1000, 128), f(1, 1000, 6), f(2, 1000, 252)]);
    expect(scored[0]!.score).toBeGreaterThan(scored[1]!.score);
    expect(scored[0]!.score).toBeGreaterThan(scored[2]!.score);
  });

  test("scores stay inside 0–1 whether or not faces were checked", () => {
    const set = [f(0, 100), f(1, 2000), f(2, 4000, 128, 300)];
    const withFace = scoreFrames(set, [null, null, { count: 2, largest: 0.5, clipped: false }]);
    const without = scoreFrames(set);
    for (const s of [...withFace, ...without]) {
      expect(s.score).toBeGreaterThanOrEqual(0);
      expect(s.score).toBeLessThanOrEqual(1);
    }
    // With no face information the face weight is redistributed, not thrown away: the best frame
    // still scores near the top of the scale rather than losing 30% of it.
    expect(Math.max(...without.map((s) => s.score))).toBeGreaterThan(0.9);
  });

  test("a face is worth more than a slightly sharper empty frame", () => {
    const faces: (FaceInfo | null)[] = [
      { count: 0, largest: 0, clipped: false },
      { count: 1, largest: 0.09, clipped: false },
    ];
    const scored = scoreFrames([f(0, 1000), f(1, 850)], faces);
    expect(scored[1]!.score).toBeGreaterThan(scored[0]!.score);
  });

  test("a head cut off by the frame edge is worth less than the same head inside it", () => {
    const scored = scoreFrames(
      [f(0, 1000), f(1, 1000)],
      [
        { count: 1, largest: 0.09, clipped: false },
        { count: 1, largest: 0.09, clipped: true },
      ],
    );
    expect(scored[0]!.score).toBeGreaterThan(scored[1]!.score);
  });

  test("a face too small to read gets little credit", () => {
    const scored = scoreFrames(
      [f(0, 1000), f(1, 1000)],
      [
        { count: 1, largest: 0.002, clipped: false },
        { count: 1, largest: 0.08, clipped: false },
      ],
    );
    expect(scored[1]!.score).toBeGreaterThan(scored[0]!.score + 0.2);
  });

  test("the explanation names what was measured", () => {
    const [only] = scoreFrames([f(0, 1000)], [{ count: 1, largest: 0.1, clipped: false }]);
    expect(only!.why).toContain("sharpness");
    expect(only!.why).toContain("exposure");
    expect(only!.why).toContain("face");
  });

  test("sharpness is judged against the other frames, not an absolute", () => {
    // Grainy footage and clean footage produce Laplacian variances orders of magnitude apart. The
    // best frame of either should come out near the top of its own set.
    const grainy = scoreFrames([f(0, 20), f(1, 8), f(2, 5)]);
    const clean = scoreFrames([f(0, 20000), f(1, 8000), f(2, 5000)]);
    expect(grainy[0]!.score).toBeCloseTo(clean[0]!.score, 5);
  });

  test("a shortlist is still judged against the whole video, not against itself", () => {
    // Without the reference, rescaling the ten best frames spreads them back over 0–1 and a
    // hair's-breadth focus difference between two excellent frames becomes decisive.
    const all = [f(0, 100), f(1, 3000), f(2, 3100), f(3, 3200)].map((x) => x.sharpness);
    const shortlist = [f(1, 3000), f(2, 3100), f(3, 3200)];
    const anchored = scoreFrames(shortlist, [], all);
    const unanchored = scoreFrames(shortlist);
    expect(anchored[2]!.score - anchored[0]!.score).toBeLessThan(unanchored[2]!.score - unanchored[0]!.score);
  });
});

const s = (t: number, score: number): ScoredFrame => ({ t, score, sharpness: 0, brightness: 128, contrast: 55, faces: null, why: "" });

describe("spreading the picks out", () => {
  test("the best frames win", () => {
    const picked = pickSpread([s(0, 0.1), s(10, 0.9), s(20, 0.5)], 2, 5);
    expect(picked.map((p) => p.t)).toEqual([10, 20]);
  });

  test("two frames of the same moment are not two suggestions", () => {
    const picked = pickSpread([s(10, 0.95), s(10.5, 0.94), s(11, 0.93), s(40, 0.5)], 2, 5);
    expect(picked.map((p) => p.t)).toEqual([10, 40]);
  });

  test("results come back in time order, not score order", () => {
    const picked = pickSpread([s(30, 0.9), s(10, 0.8), s(20, 0.7)], 3, 5);
    expect(picked.map((p) => p.t)).toEqual([10, 20, 30]);
  });

  test("frames sitting on a shot change are skipped", () => {
    const picked = pickSpread([s(10, 0.99), s(30, 0.5)], 1, 5, [10.2]);
    expect(picked.map((p) => p.t)).toEqual([30]);
  });

  test("a clip too short to space the picks still returns the number asked for", () => {
    // Refusing to answer because a 3-second clip has no two moments 5 seconds apart would be
    // pedantry: the caller wants choices, and near-identical choices beat one.
    const picked = pickSpread([s(0, 0.9), s(1, 0.8), s(2, 0.7)], 3, 5);
    expect(picked).toHaveLength(3);
  });

  test("asking for more than exist returns what exists", () => {
    expect(pickSpread([s(0, 0.9)], 5, 1)).toHaveLength(1);
  });

  test("no frame is suggested twice when the gap cannot be honoured", () => {
    const picked = pickSpread([s(0, 0.9), s(1, 0.8)], 4, 60);
    expect(new Set(picked.map((p) => p.t)).size).toBe(picked.length);
  });
});
