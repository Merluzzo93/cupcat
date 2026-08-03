// The judgement calls in reference.ts, pinned.
//
// Every rule here exists because the naive version is wrong in a way you would not notice: scene
// detection double-fires on one cut, a snare is louder than a drop, two recordings do not share a
// loudness scale, and a montage built from three clips shows the same two seconds nine times.

import { describe, expect, test } from "bun:test";
import {
  beatAlignment,
  buildBlueprint,
  findDrop,
  matchFootage,
  median,
  scoreShotEnergy,
  shotsFromScenes,
  type Candidate,
  type Shot,
} from "./reference";

/** An envelope that is `level` everywhere, then `after` from `at` seconds on. */
function stepEnvelope(totalSeconds: number, envRate: number, level: number, at: number, after: number): Float32Array {
  const env = new Float32Array(Math.round(totalSeconds * envRate));
  for (let i = 0; i < env.length; i++) env[i] = i / envRate < at ? level : after;
  return env;
}

describe("shotsFromScenes", () => {
  test("turns cut points into contiguous shots covering the whole video", () => {
    const shots = shotsFromScenes([2, 5], 8);
    expect(shots.map((s) => [s.startSeconds, s.endSeconds])).toEqual([
      [0, 2],
      [2, 5],
      [5, 8],
    ]);
  });

  test("a video with no cuts is one shot, not zero", () => {
    expect(shotsFromScenes([], 10).map((s) => s.durationSeconds)).toEqual([10]);
  });

  test("folds cuts closer together than the minimum — ffmpeg double-fires on one hard cut", () => {
    // 3.00 and 3.08 are the same cut seen twice; 6 is a real one.
    const shots = shotsFromScenes([3, 3.08, 6], 9, { minShotSeconds: 0.25 });
    expect(shots.map((s) => s.startSeconds)).toEqual([0, 3, 6]);
  });

  test("a tail shorter than the minimum belongs to the shot before it, not to itself", () => {
    const shots = shotsFromScenes([4], 4.1, { minShotSeconds: 0.25 });
    expect(shots).toHaveLength(1);
    expect(shots[0]!.endSeconds).toBe(4.1);
  });

  test("ignores cuts at or past the end, and duplicates", () => {
    expect(shotsFromScenes([2, 2, 10, 12], 10).map((s) => s.startSeconds)).toEqual([0, 2]);
  });

  test("a zero-length video has no shots rather than one of length zero", () => {
    expect(shotsFromScenes([1], 0)).toEqual([]);
  });
});

describe("scoreShotEnergy", () => {
  test("scores relative to the loudest shot, so the loudest is always 1", () => {
    const env = new Float32Array(400);
    for (let i = 0; i < 200; i++) env[i] = 0.1; // 0–2 s quiet
    for (let i = 200; i < 400; i++) env[i] = 0.5; // 2–4 s loud
    const scored = scoreShotEnergy(shotsFromScenes([2], 4), env, 100);
    expect(scored[0]!.energy).toBeCloseTo(0.2, 2);
    expect(scored[1]!.energy).toBe(1);
  });

  test("silent footage scores every shot 0 rather than dividing by zero", () => {
    const scored = scoreShotEnergy(shotsFromScenes([2], 4), new Float32Array(400), 100);
    expect(scored.map((s) => s.energy)).toEqual([0, 0]);
  });

  test("no audio at all is 0, not a guess", () => {
    expect(scoreShotEnergy(shotsFromScenes([2], 4), null, 100).map((s) => s.energy)).toEqual([0, 0]);
  });
});

describe("findDrop", () => {
  test("finds the moment the track opens up", () => {
    const env = stepEnvelope(20, 100, 0.1, 10, 0.6);
    expect(findDrop(env, 100)).toBeCloseTo(10, 1);
  });

  test("a single loud transient is NOT a drop — the rule that makes this usable", () => {
    const env = new Float32Array(20 * 100).fill(0.2);
    for (let i = 1000; i < 1020; i++) env[i] = 1; // a 200 ms snare at 10 s
    expect(findDrop(env, 100)).toBeNull();
  });

  test("steady music has no drop", () => {
    expect(findDrop(new Float32Array(20 * 100).fill(0.3), 100)).toBeNull();
  });

  test("a fade-in at the very start is not reported as a drop", () => {
    const env = stepEnvelope(20, 100, 0.05, 0.5, 0.5);
    expect(findDrop(env, 100, { edgeSeconds: 3 })).toBeNull();
  });

  test("too short to judge returns null rather than a number from two samples", () => {
    expect(findDrop(stepEnvelope(3, 100, 0.1, 1.5, 0.9), 100)).toBeNull();
  });

  test("silence has no drop", () => {
    expect(findDrop(new Float32Array(20 * 100), 100)).toBeNull();
  });
});

describe("beatAlignment", () => {
  const shots = shotsFromScenes([2, 4, 6], 8);

  test("reports the fraction of cuts landing on a beat", () => {
    const { cutsOnBeat, shots: marked } = beatAlignment(shots, [0, 2, 4, 6]);
    expect(cutsOnBeat).toBe(1);
    expect(marked.slice(1).every((s) => s.onBeat)).toBe(true);
  });

  test("the opening is not counted — every grid matches time zero", () => {
    const { cutsOnBeat } = beatAlignment(shots, [0]);
    expect(cutsOnBeat).toBe(0);
    expect(beatAlignment(shots, [0]).shots[0]!.onBeat).toBe(false);
  });

  test("a partly-aligned edit scores in between — three cuts, two on the grid", () => {
    // shotsFromScenes([2,4,6], 8) opens four shots, so there are THREE cuts to judge: 2, 4 and 6.
    expect(shots).toHaveLength(4);
    expect(beatAlignment(shots, [2, 6]).cutsOnBeat).toBe(0.67);
  });

  test("no beats means no alignment, not a crash", () => {
    expect(beatAlignment(shots, []).cutsOnBeat).toBe(0);
  });
});

describe("buildBlueprint", () => {
  test("describes a beat-cut montage as one", () => {
    const env = new Float32Array(8 * 100).fill(0.4);
    const bp = buildBlueprint([2, 4, 6], 8, env, 100, { bpm: 120, beats: [0, 2, 4, 6], confidence: 0.9 });
    expect(bp.shots).toHaveLength(4);
    expect(bp.cutsOnBeat).toBe(1);
    expect(bp.medianShotSeconds).toBe(2);
    expect(bp.bpm).toBe(120);
    expect(bp.dropSeconds).toBeNull();
  });

  test("a single-shot interview reads as one shot and no rhythm", () => {
    const bp = buildBlueprint([], 60, null, 100, { bpm: 0, beats: [], confidence: 0 });
    expect(bp.shots).toHaveLength(1);
    expect(bp.cutsOnBeat).toBe(0);
    expect(bp.longestShotSeconds).toBe(60);
  });
});

describe("median", () => {
  test("odd and even counts", () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 2, 3])).toBe(2.5);
  });
  test("empty is 0, not NaN", () => {
    expect(median([])).toBe(0);
  });
});

describe("matchFootage", () => {
  const cand = (name: string, durationSeconds: number, energy: number): Candidate => ({ mediaRef: `m_${name}`, name, durationSeconds, energy });

  const shots: Shot[] = [
    { index: 0, startSeconds: 0, endSeconds: 2, durationSeconds: 2, energy: 0.1, onBeat: false },
    { index: 1, startSeconds: 2, endSeconds: 4, durationSeconds: 2, energy: 0.5, onBeat: true },
    { index: 2, startSeconds: 4, endSeconds: 6, durationSeconds: 2, energy: 1, onBeat: true },
  ];

  test("calm footage lands on calm slots and lively footage on loud ones", () => {
    const got = matchFootage(shots, [cand("calm", 30, 0.1), cand("mid", 30, 0.5), cand("action", 30, 1)]);
    expect(got.map((a) => a.name)).toEqual(["calm", "mid", "action"]);
  });

  test("ranks rather than compares absolute energy — two recordings share no scale", () => {
    // Every candidate is quiet in absolute terms; the ORDER still decides.
    const got = matchFootage(shots, [cand("calm", 30, 0.01), cand("mid", 30, 0.02), cand("action", 30, 0.03)]);
    expect(got.map((a) => a.name)).toEqual(["calm", "mid", "action"]);
  });

  test("reusing one clip advances through it instead of replaying the same seconds", () => {
    const got = matchFootage(shots, [cand("only", 30, 0.5)]);
    expect(got.map((a) => a.sourceStartSeconds)).toEqual([0, 2, 4]);
  });

  test("wraps to the start when the clip runs out rather than reading past the end", () => {
    const got = matchFootage(shots, [cand("short", 5, 0.5)]);
    // 0→2, 2→4, then only 1 s of room left for a 2 s slot: back to the beginning.
    expect(got.map((a) => a.sourceStartSeconds)).toEqual([0, 2, 0]);
  });

  test("a slot too long for its energy-matched clip takes the longest clip available, and says so", () => {
    const longShots: Shot[] = [{ index: 0, startSeconds: 0, endSeconds: 20, durationSeconds: 20, energy: 1, onBeat: false }];
    const got = matchFootage(longShots, [cand("tiny", 1, 1), cand("long", 60, 0.1)]);
    expect(got[0]!.name).toBe("long");
    expect(got[0]!.why).toContain("longest clip");
  });

  test("returns assignments in shot order even though it fills longest-first", () => {
    const uneven: Shot[] = [
      { index: 0, startSeconds: 0, endSeconds: 1, durationSeconds: 1, energy: 0.2, onBeat: false },
      { index: 1, startSeconds: 1, endSeconds: 11, durationSeconds: 10, energy: 0.9, onBeat: false },
    ];
    const got = matchFootage(uneven, [cand("a", 30, 0.2), cand("b", 30, 0.9)]);
    expect(got.map((a) => a.shotIndex)).toEqual([0, 1]);
  });

  test("a shot longer than every clip is filled by consecutive pieces, never by one clip run past its end", () => {
    // The defect this pins: a 21.5 s shot was handed a 17 s clip, i.e. 4.5 s of nothing.
    const long: Shot[] = [{ index: 0, startSeconds: 5, endSeconds: 26.5, durationSeconds: 21.5, energy: 1, onBeat: false }];
    const got = matchFootage(long, [cand("seventeen", 17, 1), cand("ten", 10, 0.2)]);
    expect(got.length).toBeGreaterThan(1);
    for (const a of got) {
      const src = a.name === "seventeen" ? 17 : 10;
      expect(a.sourceStartSeconds + a.durationSeconds).toBeLessThanOrEqual(src + 1e-6);
    }
    // Contiguous, and exactly as long as the shot — no gap, no overrun.
    expect(got[0]!.startSeconds).toBe(5);
    expect(got.reduce((s, a) => s + a.durationSeconds, 0)).toBeCloseTo(21.5, 6);
    for (let i = 1; i < got.length; i++) {
      expect(got[i]!.startSeconds).toBeCloseTo(got[i - 1]!.startSeconds + got[i - 1]!.durationSeconds, 6);
    }
    expect(got.every((a) => a.shotIndex === 0)).toBe(true);
    expect(got[1]!.name).not.toBe(got[0]!.name); // the join reads as a cut between takes
  });

  test("a shot some clip CAN cover is never broken in two — wrapping beats an invented cut", () => {
    const two: Shot[] = [
      { index: 0, startSeconds: 0, endSeconds: 4, durationSeconds: 4, energy: 0.5, onBeat: false },
      { index: 1, startSeconds: 4, endSeconds: 8, durationSeconds: 4, energy: 0.5, onBeat: false },
    ];
    // 6 s clip, two 4 s shots: the second cannot continue from 4 s, so it wraps rather than splitting.
    const got = matchFootage(two, [cand("six", 6, 0.5)]);
    expect(got).toHaveLength(2);
    expect(got.map((a) => a.sourceStartSeconds)).toEqual([0, 0]);
  });

  test("a silent reference cycles the footage instead of giving every shot to the same clip", () => {
    // No audio → scoreShotEnergy returns 0 everywhere, so there is nothing to match on.
    const silent: Shot[] = shots.map((s) => ({ ...s, energy: 0 }));
    const got = matchFootage(silent, [cand("a", 30, 0.1), cand("b", 30, 0.5)]);
    expect(got.map((x) => x.name)).toEqual(["a", "b", "a"]);
    expect(got[0]!.why).toContain("cycling");
  });

  test("a single shot still matches on its own energy — one shot is not 'flat'", () => {
    const one: Shot[] = [{ index: 0, startSeconds: 0, endSeconds: 2, durationSeconds: 2, energy: 1, onBeat: false }];
    expect(matchFootage(one, [cand("calm", 30, 0.1), cand("action", 30, 1)])[0]!.name).toBe("action");
  });

  test("no candidates or no shots gives nothing, not a crash", () => {
    expect(matchFootage(shots, [])).toEqual([]);
    expect(matchFootage([], [cand("a", 10, 1)])).toEqual([]);
  });

  test("a zero-length candidate is not usable", () => {
    expect(matchFootage(shots, [cand("empty", 0, 0.5)])).toEqual([]);
  });
});
