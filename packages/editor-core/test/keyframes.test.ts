import { describe, expect, it } from "bun:test";
import {
  cubicBezierY,
  densifyTrack,
  type Keyframe,
  type KeyframeTrack,
  lerpAnimPair,
  lerpNumber,
  sampleTrack,
  setKeyframes,
  smoothstep,
  EditorDocument,
  addClips,
  type MediaAsset,
} from "../src";

// Reference values computed with an independent pure-bisection cubic-bezier solver (1e-12).
const EASE_IN_OUT: [number, number][] = [
  [0.1, 0.01972245],
  [0.25, 0.12916193],
  [0.5, 0.5],
  [0.75, 0.87083807],
  [0.9, 0.98027755],
];

const kf = (frame: number, value: number, interp: Keyframe<number>["interpolationOut"] = "smooth", bezierOut?: [number, number], bezierIn?: [number, number]): Keyframe<number> => ({
  frame,
  value,
  interpolationOut: interp,
  ...(bezierOut ? { bezierOut } : {}),
  ...(bezierIn ? { bezierIn } : {}),
});

describe("cubicBezierY", () => {
  it("hits the endpoints exactly for any handles", () => {
    for (const [x1, y1, x2, y2] of [[0.42, 0, 0.58, 1], [0.9, 0, 0.1, 1], [0.3, -0.6, 0.7, 1.6]] as const) {
      expect(cubicBezierY(0, x1, y1, x2, y2)).toBe(0);
      expect(cubicBezierY(1, x1, y1, x2, y2)).toBe(1);
    }
  });

  it("matches CSS cubic-bezier(0.42,0,0.58,1) reference values to 1e-4", () => {
    for (const [x, y] of EASE_IN_OUT) {
      expect(Math.abs(cubicBezierY(x, 0.42, 0, 0.58, 1) - y)).toBeLessThan(1e-4);
    }
  });

  it("matches the extreme ease cubic-bezier(0.9,0,0.1,1) reference values to 1e-4", () => {
    expect(Math.abs(cubicBezierY(0.25, 0.9, 0, 0.1, 1) - 0.03729033)).toBeLessThan(1e-4);
    expect(Math.abs(cubicBezierY(0.5, 0.9, 0, 0.1, 1) - 0.5)).toBeLessThan(1e-4);
    expect(Math.abs(cubicBezierY(0.75, 0.9, 0, 0.1, 1) - 0.96270967)).toBeLessThan(1e-4);
  });

  it("y(x) is monotonic in x for monotone y-handles (even where Newton needs the bisection fallback)", () => {
    let prev = -Infinity;
    for (let i = 0; i <= 200; i++) {
      const y = cubicBezierY(i / 200, 0.9, 0, 0.1, 1);
      expect(y).toBeGreaterThanOrEqual(prev - 1e-9);
      prev = y;
    }
  });

  it("supports overshoot: y-handles outside 0..1 push y outside 0..1 mid-curve", () => {
    const dip = cubicBezierY(0.15, 0.3, -0.8, 0.7, 1.8);
    const peak = cubicBezierY(0.85, 0.3, -0.8, 0.7, 1.8);
    expect(dip).toBeLessThan(0);
    expect(peak).toBeGreaterThan(1);
  });
});

describe("sampleTrack bezier interpolation", () => {
  const track = (a: Keyframe<number>, b: Keyframe<number>): KeyframeTrack<number> => ({ keyframes: [a, b] });

  it("evaluates a bezier segment through the CSS curve (extreme ease over 60 frames)", () => {
    const t = track(kf(0, 0, "bezier", [0.9, 0], undefined), { ...kf(60, 1), bezierIn: [0.1, 1] });
    expect(sampleTrack(t, 0, 0, lerpNumber)).toBe(0);
    expect(sampleTrack(t, 60, 0, lerpNumber)).toBe(1);
    expect(Math.abs(sampleTrack(t, 15, 0, lerpNumber) - 0.03729033)).toBeLessThan(1e-4);
    expect(Math.abs(sampleTrack(t, 30, 0, lerpNumber) - 0.5)).toBeLessThan(1e-4);
    expect(Math.abs(sampleTrack(t, 45, 0, lerpNumber) - 0.96270967)).toBeLessThan(1e-4);
  });

  it("falls back to the smoothstep-equivalent curve when a bezier keyframe has no handles", () => {
    const t = track(kf(0, 0, "bezier"), kf(100, 1));
    for (const frame of [10, 25, 50, 80]) {
      expect(Math.abs(sampleTrack(t, frame, 0, lerpNumber) - smoothstep(frame / 100))).toBeLessThan(1e-6);
    }
  });

  it("scales the eased progress into the segment's value range (non 0..1 values)", () => {
    const t = track(kf(0, 200, "bezier", [0.42, 0], undefined), { ...kf(40, 600), bezierIn: [0.58, 1] });
    // midpoint of a symmetric ease = midpoint of the value range
    expect(Math.abs(sampleTrack(t, 20, 0, lerpNumber) - 400)).toBeLessThan(0.05);
    expect(Math.abs(sampleTrack(t, 10, 0, lerpNumber) - (200 + 400 * 0.12916193))).toBeLessThan(0.05);
  });
});

describe("densifyTrack", () => {
  const FPS = 30;

  it("returns the SAME track object when no segment is bezier (export graphs stay byte-identical)", () => {
    const t: KeyframeTrack<number> = { keyframes: [kf(0, 0, "smooth"), kf(30, 1, "linear"), kf(60, 0, "hold"), kf(90, 1)] };
    expect(densifyTrack(t, FPS)).toBe(t);
  });

  it("outputs linear-only keyframes with endpoints preserved", () => {
    const t: KeyframeTrack<number> = {
      keyframes: [kf(0, 0.1, "bezier", [0.9, 0], undefined), { ...kf(60, 0.9), bezierIn: [0.1, 1] }],
    };
    const d = densifyTrack(t, FPS);
    expect(d).not.toBe(t);
    expect(d.keyframes.every((k) => k.interpolationOut === "linear")).toBe(true);
    expect(d.keyframes[0]).toMatchObject({ frame: 0, value: 0.1 });
    expect(d.keyframes[d.keyframes.length - 1]).toMatchObject({ frame: 60, value: 0.9 });
    // frames strictly increasing, spacing within [2, step+1] on the interior grid
    for (let i = 1; i < d.keyframes.length; i++) {
      expect(d.keyframes[i]!.frame).toBeGreaterThan(d.keyframes[i - 1]!.frame);
    }
  });

  it("respects the sampling budget: >=8 samples/second and no denser than every 2 frames", () => {
    const t: KeyframeTrack<number> = {
      keyframes: [kf(0, 0, "bezier", [0.42, 0], undefined), { ...kf(60, 1), bezierIn: [0.58, 1] }],
    };
    const d = densifyTrack(t, FPS);
    const frames = d.keyframes.map((k) => k.frame);
    for (let i = 1; i < frames.length; i++) {
      const gap = frames[i]! - frames[i - 1]!;
      expect(gap).toBeGreaterThanOrEqual(2);
      expect(gap).toBeLessThanOrEqual(Math.floor(FPS / 8) + 1); // grid step, +1 slack at the tail
    }
  });

  it("stays within 0.5% of the true ease-in-out curve at every 30fps frame", () => {
    const t: KeyframeTrack<number> = {
      keyframes: [kf(0, 0, "bezier", [0.42, 0], undefined), { ...kf(60, 1), bezierIn: [0.58, 1] }],
    };
    const d = densifyTrack(t, FPS);
    let maxErr = 0;
    for (let f = 0; f <= 60; f++) {
      const truth = sampleTrack(t, f, 0, lerpNumber);
      const approx = sampleTrack(d, f, 0, lerpNumber);
      maxErr = Math.max(maxErr, Math.abs(truth - approx));
    }
    expect(maxErr).toBeLessThan(0.005); // value range is 1.0
  });

  it("is exact at its own sample frames even for the extreme ease (0.9,0,0.1,1)", () => {
    const t: KeyframeTrack<number> = {
      keyframes: [kf(0, 0, "bezier", [0.9, 0], undefined), { ...kf(60, 1), bezierIn: [0.1, 1] }],
    };
    const d = densifyTrack(t, FPS);
    for (const k of d.keyframes) {
      expect(Math.abs(k.value - sampleTrack(t, k.frame, 0, lerpNumber))).toBeLessThan(1e-9);
    }
    // the e2e measurement frames land on the 30fps grid (step 3)
    for (const f of [15, 30, 45]) expect(d.keyframes.some((k) => k.frame === f)).toBe(true);
  });

  it("converts hold segments in a mixed track to an exact per-frame step", () => {
    const t: KeyframeTrack<number> = {
      keyframes: [kf(0, 0, "hold"), kf(20, 1, "bezier", [0.42, 0], undefined), { ...kf(40, 0), bezierIn: [0.58, 1] }],
    };
    const d = densifyTrack(t, FPS);
    expect(d.keyframes.every((k) => k.interpolationOut === "linear")).toBe(true);
    for (let f = 0; f <= 19; f++) expect(sampleTrack(d, f, -1, lerpNumber)).toBe(0);
    expect(sampleTrack(d, 20, -1, lerpNumber)).toBe(1);
  });

  it("densifies pair tracks (position) through both channels", () => {
    const t: KeyframeTrack<{ a: number; b: number }> = {
      keyframes: [
        { frame: 0, value: { a: 0.1, b: 0.2 }, interpolationOut: "bezier", bezierOut: [0.42, 0] },
        { frame: 60, value: { a: 0.7, b: 0.9 }, interpolationOut: "smooth", bezierIn: [0.58, 1] },
      ],
    };
    const d = densifyTrack(t, FPS);
    for (const k of d.keyframes) {
      const truth = sampleTrack(t, k.frame, { a: 0, b: 0 }, lerpAnimPair);
      expect(Math.abs(k.value.a - truth.a)).toBeLessThan(1e-9);
      expect(Math.abs(k.value.b - truth.b)).toBeLessThan(1e-9);
    }
  });
});

describe("set_keyframes bezier rows", () => {
  const image = (id: string): MediaAsset => ({ id, type: "image", name: id, durationSeconds: 0, hasAudio: false, generationStatus: { kind: "none" } });
  const docWithClip = () => {
    const doc = new EditorDocument();
    doc.addAsset(image("i1"));
    doc.mutate("setup", "user", () => doc.insertTrack(0, "video"));
    addClips(doc, { entries: [{ mediaRef: "i1", trackIndex: 0, startFrame: 0, durationFrames: 90 }] }, "user");
    return { doc, clipId: doc.timeline.tracks[0]!.clips[0]!.id };
  };

  it("parses [frame, ...vals, 'bezier', outX, outY, inX, inY] rows into handle fields", () => {
    const { doc, clipId } = docWithClip();
    setKeyframes(doc, {
      clipId,
      property: "position",
      keyframes: [
        [0, 0.05, 0.05, "bezier", 0.9, 0, 0.1, 1],
        [60, 0.75, 0.65, "smooth"],
      ],
    });
    const ks = doc.getClip(clipId)!.positionTrack!.keyframes;
    expect(ks[0]!.interpolationOut).toBe("bezier");
    expect(ks[0]!.bezierOut).toEqual([0.9, 0]);
    expect(ks[0]!.bezierIn).toEqual([0.1, 1]);
    expect(ks[1]!.interpolationOut).toBe("smooth");
    expect(ks[1]!.bezierOut).toBeUndefined();
  });

  it("accepts a handle-less 'bezier' row (defaults apply at sample time)", () => {
    const { doc, clipId } = docWithClip();
    setKeyframes(doc, { clipId, property: "opacity", keyframes: [[0, 0, "bezier"], [30, 1]] });
    const ks = doc.getClip(clipId)!.opacityTrack!.keyframes;
    expect(ks[0]!.interpolationOut).toBe("bezier");
    expect(ks[0]!.bezierOut).toBeUndefined();
  });

  it("rejects handle X outside 0..1 and handles on non-bezier rows", () => {
    const { doc, clipId } = docWithClip();
    expect(() => setKeyframes(doc, { clipId, property: "opacity", keyframes: [[0, 0, "bezier", 1.2, 0, 0.5, 1], [30, 1]] })).toThrow(/0\.\.1/);
    expect(() => setKeyframes(doc, { clipId, property: "opacity", keyframes: [[0, 0, "smooth", 0.4, 0, 0.6, 1], [30, 1]] })).toThrow(/bezier/);
    // y is deliberately unclamped (overshoot)
    setKeyframes(doc, { clipId, property: "opacity", keyframes: [[0, 0, "bezier", 0.3, -0.8, 0.7, 1.8], [30, 1]] });
    expect(doc.getClip(clipId)!.opacityTrack!.keyframes[0]!.bezierOut).toEqual([0.3, -0.8]);
  });
});
