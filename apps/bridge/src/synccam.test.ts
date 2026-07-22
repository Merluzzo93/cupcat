// Multi-camera placement. The case worth pinning is the one the old path got wrong: a camera that
// started rolling BEFORE the reference needs a negative start, and clamping it to zero leaves that
// angle silently out of sync — which is exactly the defect a multicam edit cannot tolerate, because
// every later cut inherits it.

import { describe, expect, it } from "bun:test";
import { offsetLabel, pickReference, planAnglePlacements } from "./synccam";

const FPS = 30;
const ENV = 100; // envelope samples per second
const angle = (id: string, lagSamples: number | null, seconds = 60) => ({
  id,
  lagSamples,
  durationFrames: Math.round(seconds * FPS),
});

describe("planAnglePlacements", () => {
  it("leaves everything at zero when the cameras already agree", () => {
    const p = planAnglePlacements([angle("a", 0), angle("b", 0)], FPS, ENV);
    expect(p.map((x) => x.startFrame)).toEqual([0, 0]);
  });

  it("pushes back a camera that started rolling later", () => {
    // b's sound arrives 2s EARLIER in its own recording (lag -200) → it started 2s after the ref.
    const p = planAnglePlacements([angle("ref", 0), angle("b", -200)], FPS, ENV);
    expect(p[0]!.startFrame).toBe(0);
    expect(p[1]!.startFrame).toBe(60); // 2s at 30fps
  });

  it("slides the whole rig right rather than clamping a camera that started first", () => {
    // b started 2s BEFORE the reference, so it wants frame -60. Clamping b to 0 would put it 2s
    // out; instead the reference moves to +60 and the relative gap survives.
    const p = planAnglePlacements([angle("ref", 0), angle("b", 200)], FPS, ENV);
    expect(p[0]!.startFrame).toBe(60);
    expect(p[1]!.startFrame).toBe(0);
    expect(p[0]!.startFrame - p[1]!.startFrame).toBe(60); // the 2s gap is what matters
  });

  it("keeps every relative gap intact across three cameras straddling the reference", () => {
    const p = planAnglePlacements([angle("ref", 0), angle("early", 150), angle("late", -90)], FPS, ENV);
    const by = Object.fromEntries(p.map((x) => [x.id, x.startFrame]));
    expect(by.ref! - by.early!).toBe(45); // 1.5s
    expect(by.late! - by.ref!).toBe(27); // 0.9s
    expect(Math.min(...p.map((x) => x.startFrame))).toBe(0); // nothing wasted before the first frame
  });

  it("never places a clip at a negative frame", () => {
    const p = planAnglePlacements([angle("ref", 0), angle("veryEarly", 9999)], FPS, ENV);
    for (const x of p) expect(x.startFrame).toBeGreaterThanOrEqual(0);
  });

  it("still places an angle whose audio could not be matched, and says it is not aligned", () => {
    const p = planAnglePlacements([angle("ref", 0), angle("mute", null)], FPS, ENV);
    expect(p[1]!.aligned).toBe(false);
    expect(p[1]!.startFrame).toBe(0);
    expect(p[0]!.aligned).toBe(true);
  });

  it("reports the offset it applied, so a wrong match is visible in the result", () => {
    const p = planAnglePlacements([angle("ref", 0), angle("b", -200)], FPS, ENV);
    expect(p[1]!.offsetFrames).toBe(60);
  });

  it("carries confidence through untouched", () => {
    const p = planAnglePlacements([{ ...angle("ref", 0), confidence: 1 }, { ...angle("b", -60), confidence: 0.82 }], FPS, ENV);
    expect(p[1]!.confidence).toBe(0.82);
  });

  it("handles an empty list rather than throwing", () => {
    expect(planAnglePlacements([], FPS, ENV)).toEqual([]);
  });
});

describe("pickReference", () => {
  it("picks the longest angle, which is the one most likely to overlap the rest", () => {
    expect(pickReference([{ id: "a", durationFrames: 100 }, { id: "b", durationFrames: 900 }])).toBe("b");
  });

  it("keeps the user's order on a tie", () => {
    expect(pickReference([{ id: "a", durationFrames: 300 }, { id: "b", durationFrames: 300 }])).toBe("a");
  });

  it("returns null for no angles", () => {
    expect(pickReference([])).toBeNull();
  });
});

describe("offsetLabel", () => {
  it("signs the offset so the direction is readable", () => {
    expect(offsetLabel(60, 30)).toBe("+2.000s");
    expect(offsetLabel(-45, 30)).toBe("-1.500s");
    expect(offsetLabel(0, 30)).toBe("0s");
  });
});
