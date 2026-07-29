// The rules an editor applies without thinking, written down so they can be argued with.
//
// A camera plan cannot be checked by running it: a montage that cuts in the wrong places still
// exports fine. These are the cases that separate a plan from a list of switches.

import { describe, expect, test } from "bun:test";
import { enforceMinShot, floorTimeline, planCameras, settleFloor, type CamSegment, type Turn } from "./camplan";

const turn = (speaker: string, startSeconds: number, endSeconds: number): Turn => ({ speaker, startSeconds, endSeconds });

/** Two people, one camera each. */
const TWO = { A: 0, B: 1 };

describe("who has the floor", () => {
  test("a plain exchange is one stretch per turn", () => {
    const spans = floorTimeline([turn("A", 0, 5), turn("B", 5, 10)], 0, 10);
    expect(spans.map((s) => [s.startSeconds, s.endSeconds, s.floor.kind])).toEqual([
      [0, 5, "speaker"],
      [5, 10, "speaker"],
    ]);
  });

  test("a gap between turns is a pause, not a speaker", () => {
    const spans = floorTimeline([turn("A", 0, 4), turn("B", 6, 10)], 0, 10);
    expect(spans.map((s) => s.floor.kind)).toEqual(["speaker", "pause", "speaker"]);
  });

  test("simultaneous speech is its own thing", () => {
    const spans = floorTimeline([turn("A", 0, 6), turn("B", 4, 10)], 0, 10);
    expect(spans.map((s) => [s.startSeconds, s.endSeconds, s.floor.kind])).toEqual([
      [0, 4, "speaker"],
      [4, 6, "overlap"],
      [6, 10, "speaker"],
    ]);
  });

  test("boundaries land on the words, not on a sampling grid", () => {
    // Half a sample of drift is a visible mis-cut at 30fps, which is why this is event-driven.
    const spans = floorTimeline([turn("A", 0, 3.267), turn("B", 3.267, 8)], 0, 8);
    expect(spans[0]!.endSeconds).toBe(3.267);
  });

  test("turns outside the window do not create stretches inside it", () => {
    const spans = floorTimeline([turn("A", 0, 100)], 20, 30);
    expect(spans).toEqual([{ startSeconds: 20, endSeconds: 30, floor: { kind: "speaker", speaker: "A" } }]);
  });

  test("one speaker talking twice across an instant is still one speaker", () => {
    const spans = floorTimeline([turn("A", 0, 5), turn("A", 3, 8)], 0, 8);
    expect(spans.every((s) => s.floor.kind === "speaker")).toBe(true);
  });
});

describe("what is too short to react to", () => {
  const o = { minTurnSeconds: 0.6, minOverlapSeconds: 0.8, minPauseSeconds: 2.5 };

  test('"mhm" does not take the camera', () => {
    const settled = settleFloor(floorTimeline([turn("A", 0, 10), turn("B", 4, 4.3)], 0, 10), o);
    // B's interjection creates an overlap of 0.3s inside A's turn; both are below their thresholds,
    // so the whole window stays A's.
    expect(settled).toHaveLength(1);
    expect(settled[0]!.floor).toEqual({ kind: "speaker", speaker: "A" });
  });

  test("a breath between sentences is not a silence", () => {
    const settled = settleFloor(floorTimeline([turn("A", 0, 4), turn("A", 5, 9)], 0, 9), o);
    expect(settled).toHaveLength(1);
  });

  test("a real silence survives", () => {
    const settled = settleFloor(floorTimeline([turn("A", 0, 4), turn("B", 10, 14)], 0, 14), o);
    expect(settled.map((s) => s.floor.kind)).toEqual(["speaker", "pause", "speaker"]);
  });

  test("a real crosstalk survives", () => {
    const settled = settleFloor(floorTimeline([turn("A", 0, 8), turn("B", 5, 12)], 0, 12), o);
    expect(settled.map((s) => s.floor.kind)).toEqual(["speaker", "overlap", "speaker"]);
  });

  test("absorbing one stretch can merge its neighbours, and the loop keeps going", () => {
    // A, tiny pause, A, tiny pause, A → one stretch, not three.
    const settled = settleFloor(floorTimeline([turn("A", 0, 3), turn("A", 3.2, 6), turn("A", 6.2, 9)], 0, 9), o);
    expect(settled).toHaveLength(1);
    expect(settled[0]).toEqual({ startSeconds: 0, endSeconds: 9, floor: { kind: "speaker", speaker: "A" } });
  });

  test("a short stretch at the very start is absorbed forwards", () => {
    const settled = settleFloor(floorTimeline([turn("A", 0, 0.2), turn("B", 0.2, 10)], 0, 10), o);
    expect(settled).toHaveLength(1);
    expect(settled[0]!.startSeconds).toBe(0);
    expect(settled[0]!.floor).toEqual({ kind: "speaker", speaker: "B" });
  });

  test("a window with nothing in it stays one stretch instead of vanishing", () => {
    const settled = settleFloor(floorTimeline([], 0, 1), o);
    expect(settled).toEqual([{ startSeconds: 0, endSeconds: 1, floor: { kind: "pause" } }]);
  });
});

const seg = (startSeconds: number, endSeconds: number, angle: number): CamSegment => ({ startSeconds, endSeconds, angle, why: "speaker" });

describe("the minimum shot", () => {
  test("a flick of a shot is folded into the one before it", () => {
    const out = enforceMinShot([seg(0, 10, 0), seg(10, 10.4, 1), seg(10.4, 20, 0)], 1.5);
    expect(out).toHaveLength(1);
    expect(out[0]!.angle).toBe(0);
    expect(out[0]!.endSeconds).toBe(20);
  });

  test("shots long enough are left exactly as they are", () => {
    const input = [seg(0, 10, 0), seg(10, 20, 1), seg(20, 30, 0)];
    expect(enforceMinShot(input, 1.5)).toHaveLength(3);
  });

  test("a short opening shot is folded into the one after it", () => {
    const out = enforceMinShot([seg(0, 0.5, 0), seg(0.5, 20, 1)], 1.5);
    expect(out).toHaveLength(1);
    expect(out[0]!.angle).toBe(1);
    expect(out[0]!.startSeconds).toBe(0);
  });

  test("no time is lost or invented, whatever gets folded", () => {
    const out = enforceMinShot([seg(0, 3, 0), seg(3, 3.2, 1), seg(3.2, 3.5, 0), seg(3.5, 9, 1)], 1.5);
    expect(out[0]!.startSeconds).toBe(0);
    expect(out[out.length - 1]!.endSeconds).toBe(9);
    for (let i = 1; i < out.length; i++) expect(out[i]!.startSeconds).toBe(out[i - 1]!.endSeconds);
  });

  test("a clip shorter than one minimum shot stays a single shot", () => {
    expect(enforceMinShot([seg(0, 0.8, 0)], 1.5)).toHaveLength(1);
  });
});

describe("the whole plan", () => {
  test("a conversation cuts to whoever is talking", () => {
    const plan = planCameras([turn("A", 0, 10), turn("B", 10, 20), turn("A", 20, 30)], {
      startSeconds: 0,
      endSeconds: 30,
      speakerAngles: TWO,
    });
    expect(plan.segments.map((s) => s.angle)).toEqual([0, 1, 0]);
    expect(plan.switches).toBe(2);
  });

  test("crosstalk goes to the wide when there is one", () => {
    const plan = planCameras([turn("A", 0, 12), turn("B", 8, 20)], {
      startSeconds: 0,
      endSeconds: 20,
      speakerAngles: TWO,
      wideAngle: 2,
    });
    expect(plan.segments.map((s) => [s.angle, s.why])).toEqual([
      [0, "speaker"],
      [2, "crosstalk"],
      [1, "speaker"],
    ]);
  });

  test("with no wide angle, crosstalk holds the shot instead of flapping between the two", () => {
    const plan = planCameras([turn("A", 0, 12), turn("B", 8, 20)], { startSeconds: 0, endSeconds: 20, speakerAngles: TWO });
    expect(plan.segments.map((s) => s.angle)).toEqual([0, 1]);
  });

  test("a long silence goes wide; a breath does not", () => {
    const wide = planCameras([turn("A", 0, 10), turn("A", 20, 30)], {
      startSeconds: 0,
      endSeconds: 30,
      speakerAngles: TWO,
      wideAngle: 2,
    });
    expect(wide.segments.map((s) => s.angle)).toEqual([0, 2, 0]);

    const breath = planCameras([turn("A", 0, 10), turn("A", 11, 30)], {
      startSeconds: 0,
      endSeconds: 30,
      speakerAngles: TWO,
      wideAngle: 2,
    });
    expect(breath.segments).toHaveLength(1);
  });

  test("a rapid exchange is not turned into a strobe", () => {
    // Eight turns in eight seconds. Cutting on each one would be unwatchable.
    const turns = Array.from({ length: 8 }, (_, i) => turn(i % 2 === 0 ? "A" : "B", i, i + 1));
    const plan = planCameras(turns, { startSeconds: 0, endSeconds: 8, speakerAngles: TWO });
    for (const s of plan.segments) expect(s.endSeconds - s.startSeconds).toBeGreaterThanOrEqual(1.5);
  });

  test("the plan covers the window exactly, with no gaps and no overlaps", () => {
    const turns = [turn("A", 0, 7), turn("B", 7.5, 14), turn("A", 14, 15.2), turn("B", 16, 25)];
    const plan = planCameras(turns, { startSeconds: 0, endSeconds: 25, speakerAngles: TWO, wideAngle: 2 });
    expect(plan.segments[0]!.startSeconds).toBe(0);
    expect(plan.segments[plan.segments.length - 1]!.endSeconds).toBe(25);
    for (let i = 1; i < plan.segments.length; i++) {
      expect(plan.segments[i]!.startSeconds).toBe(plan.segments[i - 1]!.endSeconds);
    }
  });

  test("time on each angle adds up to the window", () => {
    const plan = planCameras([turn("A", 0, 10), turn("B", 10, 20)], { startSeconds: 0, endSeconds: 20, speakerAngles: TWO });
    expect(plan.perAngle.reduce((a, b) => a + b, 0)).toBeCloseTo(20, 6);
  });

  test("a speaker no camera shows is named rather than silently dropped", () => {
    const plan = planCameras([turn("A", 0, 10), turn("C", 10, 20)], { startSeconds: 0, endSeconds: 20, speakerAngles: TWO, wideAngle: 2 });
    expect(plan.unmappedSpeakers).toEqual(["C"]);
    expect(plan.segments.map((s) => s.angle)).toEqual([0, 2]); // C goes to the wide, not to A's camera
  });

  test("only the window is planned, however long the recording is", () => {
    const plan = planCameras([turn("A", 0, 600)], { startSeconds: 100, endSeconds: 130, speakerAngles: TWO });
    expect(plan.segments).toEqual([{ startSeconds: 100, endSeconds: 130, angle: 0, why: "speaker", speaker: "A" }]);
  });

  test("an empty window is refused rather than planned as nothing", () => {
    expect(() => planCameras([], { startSeconds: 10, endSeconds: 10, speakerAngles: TWO })).toThrow();
  });

  test("silence throughout still produces a shot to be on", () => {
    const plan = planCameras([], { startSeconds: 0, endSeconds: 30, speakerAngles: TWO, wideAngle: 2 });
    expect(plan.segments).toHaveLength(1);
    expect(plan.segments[0]!.angle).toBe(2);
  });
});

describe("breaking up a long take", () => {
  test("off by default — a monologue is one shot unless asked otherwise", () => {
    const plan = planCameras([turn("A", 0, 300)], { startSeconds: 0, endSeconds: 300, speakerAngles: TWO, wideAngle: 2 });
    expect(plan.segments).toHaveLength(1);
  });

  test("when asked, the camera glances at the wide and comes back", () => {
    const plan = planCameras([turn("A", 0, 100)], {
      startSeconds: 0,
      endSeconds: 100,
      speakerAngles: TWO,
      wideAngle: 2,
      maxShotSeconds: 30,
      cutawaySeconds: 3,
    });
    expect(plan.segments.map((s) => s.angle)).toEqual([0, 2, 0, 2, 0]);
    expect(plan.segments[1]!.endSeconds - plan.segments[1]!.startSeconds).toBeCloseTo(3, 6);
  });

  test("a cutaway is never inserted so late that the return is a flick", () => {
    const plan = planCameras([turn("A", 0, 31)], {
      startSeconds: 0,
      endSeconds: 31,
      speakerAngles: TWO,
      wideAngle: 2,
      maxShotSeconds: 30,
      cutawaySeconds: 3,
    });
    expect(plan.segments).toHaveLength(1);
  });

  test("the wide is not cut away from itself", () => {
    const plan = planCameras([], {
      startSeconds: 0,
      endSeconds: 300,
      speakerAngles: TWO,
      wideAngle: 2,
      maxShotSeconds: 30,
      cutawaySeconds: 3,
    });
    expect(plan.segments).toHaveLength(1);
    expect(plan.segments[0]!.angle).toBe(2);
  });
});
