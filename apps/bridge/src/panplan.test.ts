// Placing voices where their owners are standing.
//
// The expression these produce is handed to ffmpeg, where a mistake is silent: the render succeeds
// and the mix is wrong. So the curve is checked here by evaluating it the way ffmpeg would.

import { describe, expect, test } from "bun:test";
import { gainExpression, gainPoints, panForX, panGains, planPan, positionsFrom, reliablePositions, type PanSegment } from "./panplan";

/** Evaluate the subset of ffmpeg expression syntax gainExpression emits. */
function evalExpr(expr: string, t: number): number {
  const fn = new Function("t", "clip", `return ${expr};`) as (t: number, clip: (x: number, lo: number, hi: number) => number) => number;
  return fn(t, (x, lo, hi) => Math.max(lo, Math.min(hi, x)));
}

describe("screen position to pan", () => {
  test("the middle of the frame is the middle of the mix", () => {
    expect(panForX(0.5)).toBe(0);
  });

  test("left of frame pans left, right pans right", () => {
    expect(panForX(0.1)).toBeLessThan(0);
    expect(panForX(0.9)).toBeGreaterThan(0);
  });

  test("nothing is ever panned harder than asked", () => {
    for (const x of [0, 0.25, 0.5, 0.75, 1]) {
      expect(Math.abs(panForX(x, 0.5))).toBeLessThanOrEqual(0.5);
      expect(Math.abs(panForX(x, 1))).toBeLessThanOrEqual(1);
    }
  });

  test("the default stops well short of hard panning", () => {
    // Hard-panned dialogue is unpleasant on headphones and vanishes on a phone held sideways.
    expect(Math.abs(panForX(0, 0.5))).toBeLessThanOrEqual(0.5);
  });

  test("people standing near the centre all stay centred", () => {
    expect(panForX(0.48)).toBe(0);
    expect(panForX(0.52)).toBe(0);
  });

  test("the mapping is symmetric about the centre", () => {
    expect(panForX(0.2)).toBeCloseTo(-panForX(0.8), 9);
  });

  test("a position outside the frame is clamped, not extrapolated", () => {
    expect(panForX(-3, 0.5)).toBe(panForX(0, 0.5));
    expect(panForX(4, 0.5)).toBe(panForX(1, 0.5));
  });
});

describe("where each person is", () => {
  test("the median, so one wild measurement does not move somebody", () => {
    const pos = positionsFrom([
      { speaker: "A", x: 0.2 },
      { speaker: "A", x: 0.22 },
      { speaker: "A", x: 0.95 }, // the detector picked the wrong face once
      { speaker: "A", x: 0.21 },
      { speaker: "A", x: 0.2 },
    ]);
    expect(pos[0]!.x).toBeCloseTo(0.21, 6);
  });

  test("how many measurements each position rests on is reported", () => {
    const pos = positionsFrom([
      { speaker: "A", x: 0.2 },
      { speaker: "B", x: 0.8 },
      { speaker: "B", x: 0.82 },
    ]);
    expect(pos.map((p) => [p.speaker, p.samples])).toEqual([
      ["A", 1],
      ["B", 2],
    ]);
  });

  test("people come back in left-to-right order", () => {
    const pos = positionsFrom([
      { speaker: "right", x: 0.9 },
      { speaker: "left", x: 0.1 },
      { speaker: "middle", x: 0.5 },
    ]);
    expect(pos.map((p) => p.speaker)).toEqual(["left", "middle", "right"]);
  });

  test("how much the looks agreed is recorded, not just their middle", () => {
    const agree = positionsFrom([
      { speaker: "A", x: 0.2 },
      { speaker: "A", x: 0.21 },
      { speaker: "A", x: 0.19 },
    ]);
    const disagree = positionsFrom([
      { speaker: "A", x: 0.2 },
      { speaker: "A", x: 0.8 },
      { speaker: "A", x: 0.5 },
    ]);
    expect(agree[0]!.spread).toBeLessThan(0.02);
    expect(disagree[0]!.spread).toBeGreaterThan(0.2);
    expect(agree[0]!.x).toBeCloseTo(disagree[0]!.x - 0.3, 6); // same median, very different worth
  });
});

describe("which positions are worth acting on", () => {
  // This whole section came from running auto_pan on a real event recording: a crowded room gave the
  // detector nine faces, the mouth-motion pass refused most of the time, and what survived was two
  // looks that agreed on a bystander. It rendered a confident, wrong mix.
  const pos = (speaker: string, x: number, samples: number, spread: number) => ({ speaker, x, samples, spread });

  test("a position resting on one look is a guess, not a placement", () => {
    const { kept, rejected } = reliablePositions([pos("A", 0.2, 1, 0)]);
    expect(kept).toEqual([]);
    expect(rejected[0]!.why).toContain("1 usable look");
  });

  test("two agreeing looks are still not enough", () => {
    // The exact case that shipped a wrong mix: two looks ninety seconds apart, agreeing with each
    // other and describing two different framings of a camera that had moved between them.
    expect(reliablePositions([pos("A", 0.86, 2, 0.01)]).kept).toEqual([]);
  });

  test("looks that disagree do not average into a position", () => {
    const { kept, rejected } = reliablePositions([pos("A", 0.5, 4, 0.3)]);
    expect(kept).toEqual([]);
    expect(rejected[0]!.why).toContain("disagreed");
  });

  test("several looks that agree are acted on", () => {
    const { kept, rejected } = reliablePositions([pos("A", 0.2, 4, 0.02)]);
    expect(kept.map((k) => k.speaker)).toEqual(["A"]);
    expect(rejected).toEqual([]);
  });

  test("one unreliable person does not disqualify the others", () => {
    const { kept, rejected } = reliablePositions([pos("A", 0.2, 4, 0.01), pos("B", 0.9, 1, 0)]);
    expect(kept.map((k) => k.speaker)).toEqual(["A"]);
    expect(rejected.map((r) => r.speaker)).toEqual(["B"]);
  });

  test("the thresholds can be loosened deliberately", () => {
    expect(reliablePositions([pos("A", 0.2, 1, 0)], { minLooks: 1 }).kept).toHaveLength(1);
    expect(reliablePositions([pos("A", 0.5, 4, 0.3)], { maxSpread: 0.5 }).kept).toHaveLength(1);
  });
});

const POS = [
  { speaker: "A", x: 0.2, samples: 4, spread: 0.01 },
  { speaker: "B", x: 0.8, samples: 4, spread: 0.01 },
];
const turn = (speaker: string, startSeconds: number, endSeconds: number) => ({ speaker, startSeconds, endSeconds });

describe("the pan over time", () => {
  test("each person's lines are panned their way", () => {
    const segs = planPan([turn("A", 0, 10), turn("B", 10, 20)], POS, { startSeconds: 0, endSeconds: 20 });
    expect(segs.map((s) => Math.sign(s.pan))).toEqual([-1, 1]);
  });

  test("silence returns to the centre instead of dragging the room to one side", () => {
    const segs = planPan([turn("A", 0, 5), turn("B", 15, 20)], POS, { startSeconds: 0, endSeconds: 20 });
    expect(segs.map((s) => Math.sign(s.pan))).toEqual([-1, 0, 1]);
  });

  test("the plan covers the whole window with no gaps", () => {
    const segs = planPan([turn("A", 2, 5), turn("B", 8, 12)], POS, { startSeconds: 0, endSeconds: 20 });
    expect(segs[0]!.startSeconds).toBe(0);
    expect(segs[segs.length - 1]!.endSeconds).toBe(20);
    for (let i = 1; i < segs.length; i++) expect(segs[i]!.startSeconds).toBe(segs[i - 1]!.endSeconds);
  });

  test("a two-word interjection does not wobble the mix", () => {
    const segs = planPan([turn("A", 0, 20), turn("B", 9, 9.2)], POS, { startSeconds: 0, endSeconds: 20 });
    expect(segs).toHaveLength(1);
    expect(Math.sign(segs[0]!.pan)).toBe(-1);
  });

  test("overlapping speech does not try to pan two ways at once", () => {
    const segs = planPan([turn("A", 0, 12), turn("B", 8, 20)], POS, { startSeconds: 0, endSeconds: 20 });
    for (let i = 1; i < segs.length; i++) expect(segs[i]!.startSeconds).toBeGreaterThanOrEqual(segs[i - 1]!.endSeconds);
    expect(segs.every((s) => s.endSeconds > s.startSeconds)).toBe(true);
  });

  test("two turns by the same person are one placement", () => {
    const segs = planPan([turn("A", 0, 9.9), turn("A", 10, 20)], POS, { startSeconds: 0, endSeconds: 20, minTurnSeconds: 0 });
    expect(segs).toHaveLength(1);
  });

  test("the breath between two sentences does not swing the mix to the middle and back", () => {
    const segs = planPan([turn("A", 0, 5), turn("B", 5.4, 12)], POS, { startSeconds: 0, endSeconds: 12 });
    expect(segs.map((s) => Math.sign(s.pan))).toEqual([-1, 1]);
  });

  test("a real silence still returns to the centre", () => {
    const segs = planPan([turn("A", 0, 5), turn("B", 9, 12)], POS, { startSeconds: 0, endSeconds: 12 });
    expect(segs.map((s) => Math.sign(s.pan))).toEqual([-1, 0, 1]);
  });

  test("a speaker whose position was never measured is left centred", () => {
    const segs = planPan([turn("A", 0, 10), turn("C", 10, 20)], POS, { startSeconds: 0, endSeconds: 20 });
    expect(segs.map((s) => Math.sign(s.pan))).toEqual([-1, 0]);
  });

  test("nobody talking at all is a centred window, not an error", () => {
    const segs = planPan([], POS, { startSeconds: 0, endSeconds: 20 });
    expect(segs).toEqual([{ startSeconds: 0, endSeconds: 20, pan: 0 }]);
  });

  test("an empty window is refused", () => {
    expect(() => planPan([], POS, { startSeconds: 5, endSeconds: 5 })).toThrow();
  });
});

describe("constant power", () => {
  test("centre is equal on both sides", () => {
    const g = panGains(0);
    expect(g.left).toBeCloseTo(g.right, 9);
  });

  test("loudness does not change with position", () => {
    // The whole point of constant power: a voice must not get louder as it moves to a side.
    for (const p of [-1, -0.5, 0, 0.5, 1]) {
      const g = panGains(p);
      expect(Math.sqrt(g.left ** 2 + g.right ** 2)).toBeCloseTo(1, 9);
    }
  });

  test("hard left is silent on the right, and the other way round", () => {
    expect(panGains(-1).right).toBeCloseTo(0, 9);
    expect(panGains(1).left).toBeCloseTo(0, 9);
  });
});

const seg = (startSeconds: number, endSeconds: number, pan: number): PanSegment => ({ startSeconds, endSeconds, pan });

describe("the gain curve handed to ffmpeg", () => {
  test("a single pan is a constant", () => {
    const expr = gainExpression(gainPoints([seg(0, 10, 0)], "left"));
    expect(evalExpr(expr, 0)).toBeCloseTo(Math.SQRT1_2, 4);
    expect(evalExpr(expr, 9)).toBeCloseTo(Math.SQRT1_2, 4);
  });

  test("the curve actually holds each stretch's value", () => {
    const segments = [seg(0, 10, -0.5), seg(10, 20, 0.5)];
    for (const ch of ["left", "right"] as const) {
      const expr = gainExpression(gainPoints(segments, ch));
      expect(evalExpr(expr, 5)).toBeCloseTo(panGains(-0.5)[ch], 3);
      expect(evalExpr(expr, 15)).toBeCloseTo(panGains(0.5)[ch], 3);
    }
  });

  test("the change is a ramp, not a step", () => {
    const expr = gainExpression(gainPoints([seg(0, 10, -0.5), seg(10, 20, 0.5)], "left", 0.2));
    const before = evalExpr(expr, 9.95);
    const at = evalExpr(expr, 10);
    const after = evalExpr(expr, 10.05);
    expect(at).toBeGreaterThan(Math.min(before, after) - 1e-9);
    expect(at).toBeLessThan(Math.max(before, after) + 1e-9);
    expect(Math.abs(after - before)).toBeGreaterThan(0);
  });

  test("the voice is in place the moment the person starts, not shortly after", () => {
    // The ramp is centred on the boundary, so half of it is already done when the turn begins.
    const expr = gainExpression(gainPoints([seg(0, 10, -0.5), seg(10, 20, 0.5)], "left", 0.2));
    const mid = evalExpr(expr, 10);
    expect(mid).toBeCloseTo((panGains(-0.5).left + panGains(0.5).left) / 2, 3);
  });

  test("a ramp never runs past the stretch it belongs to", () => {
    // Two very short turns in a row: without the clamp their ramps would overlap and neither pan
    // would ever be reached.
    const segments = [seg(0, 0.3, -0.5), seg(0.3, 0.6, 0.5), seg(0.6, 5, -0.5)];
    const pts = gainPoints(segments, "left", 1.0);
    for (let i = 1; i < pts.length; i++) expect(pts[i]!.t).toBeGreaterThan(pts[i - 1]!.t);
  });

  test("the curve stays inside the gains it was built from", () => {
    // The slopes and times are rounded to keep the expression short, so the curve can miss its
    // endpoints by a fraction of a thousandth of a dB. It must never overshoot audibly, which is
    // what the tolerance is: 1e-3 in linear gain is under a hundredth of a decibel.
    const segments = [seg(0, 4, -0.5), seg(4, 8, 0), seg(8, 12, 0.5)];
    const expr = gainExpression(gainPoints(segments, "right"));
    const lo = Math.min(...segments.map((s) => panGains(s.pan).right));
    const hi = Math.max(...segments.map((s) => panGains(s.pan).right));
    for (let t = 0; t <= 12; t += 0.1) {
      const v = evalExpr(expr, t);
      expect(v).toBeGreaterThanOrEqual(lo - 1e-3);
      expect(v).toBeLessThanOrEqual(hi + 1e-3);
    }
  });

  test("a long conversation produces an expression, not a novel", () => {
    // Forty placements is an ordinary interview. Nested conditionals would be unreadable here; this
    // is one term per change.
    const segments = Array.from({ length: 40 }, (_, i) => seg(i * 10, i * 10 + 10, i % 2 === 0 ? -0.5 : 0.5));
    const expr = gainExpression(gainPoints(segments, "left"));
    expect(expr.length).toBeLessThan(4000);
    expect(evalExpr(expr, 5)).toBeCloseTo(panGains(-0.5).left, 3);
    expect(evalExpr(expr, 395)).toBeCloseTo(panGains(0.5).left, 3);
  });

  test("no segments is a silent no-op rather than a broken expression", () => {
    expect(evalExpr(gainExpression(gainPoints([], "left")), 3)).toBe(1);
  });
});
