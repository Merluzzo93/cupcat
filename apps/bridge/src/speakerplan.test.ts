// Mapping speaker turns onto a clip. Every bug here produces a cut that looks fine and is in the
// wrong place, so the edge cases — trimmed clips, sped-up clips, boundaries landing on the same
// frame — are the point.

import { describe, expect, it } from "bun:test";
import { assignPieces, sourceToTimeline, speakerAtSource, speakerOrder, splitFramesForTurns, timelineToSource } from "./speakerplan";

const FPS = 30;
// A clip at timeline frame 300 showing source 0s..10s at normal speed.
const w = { startFrame: 300, durationFrames: 300, trimStartFrame: 0, speed: 1, fps: FPS };
const turn = (speaker: string, startSeconds: number, endSeconds: number) => ({ speaker, startSeconds, endSeconds });

describe("sourceToTimeline / timelineToSource", () => {
  it("round-trips", () => {
    for (const s of [0, 1.5, 7.25, 9.9]) expect(timelineToSource(sourceToTimeline(s, w), w)).toBeCloseTo(s, 6);
  });

  it("accounts for the trim: a trimmed clip starts later in the source", () => {
    const trimmed = { ...w, trimStartFrame: 150 }; // shows source 5s..15s
    expect(sourceToTimeline(5, trimmed)).toBeCloseTo(300, 6); // source 5s is the clip's first frame
    expect(sourceToTimeline(6, trimmed)).toBeCloseTo(330, 6);
  });

  it("accounts for speed: at 2x, two source seconds pass per timeline second", () => {
    const fast = { ...w, speed: 2 };
    expect(sourceToTimeline(2, fast)).toBeCloseTo(330, 6); // 2s of source = 1s of timeline = 30f
    expect(timelineToSource(330, fast)).toBeCloseTo(2, 6);
  });
});

describe("splitFramesForTurns", () => {
  it("cuts at the boundary between two speakers", () => {
    expect(splitFramesForTurns([turn("S1", 0, 4), turn("S2", 4, 10)], w)).toEqual([420]); // 4s in
  });

  it("ignores boundaries on the clip's own edges, which would split nothing", () => {
    expect(splitFramesForTurns([turn("S1", 0, 10)], w)).toEqual([]);
  });

  it("ignores turns that fall outside the clip", () => {
    expect(splitFramesForTurns([turn("S1", 30, 40)], w)).toEqual([]);
  });

  it("deduplicates boundaries that round to the same frame", () => {
    // A gap far under a frame: S1 ends and S2 starts within the same 1/30s.
    const f = splitFramesForTurns([turn("S1", 0, 4.0), turn("S2", 4.01, 10)], w);
    expect(f).toEqual([420]); // one cut, not two — the second would be rejected as a duplicate
  });

  it("returns cuts in ascending order", () => {
    const f = splitFramesForTurns([turn("S1", 0, 2), turn("S2", 2, 5), turn("S1", 5, 10)], w);
    expect(f).toEqual([...f].sort((a, b) => a - b));
    expect(f).toEqual([360, 450]);
  });

  it("maps through the trim", () => {
    const trimmed = { ...w, trimStartFrame: 150 }; // shows 5s..15s
    expect(splitFramesForTurns([turn("S1", 0, 7), turn("S2", 7, 20)], trimmed)).toEqual([360]);
  });
});

describe("speakerAtSource", () => {
  const turns = [turn("S1", 0, 4), turn("S2", 5, 9)];

  it("finds the speaker inside a turn", () => {
    expect(speakerAtSource(turns, 2)).toBe("S1");
    expect(speakerAtSource(turns, 6)).toBe("S2");
  });

  it("returns null in the silence between turns", () => {
    expect(speakerAtSource(turns, 4.5)).toBeNull();
  });

  it("treats a turn's end as exclusive, so a boundary belongs to exactly one speaker", () => {
    expect(speakerAtSource([turn("S1", 0, 4), turn("S2", 4, 8)], 4)).toBe("S2");
  });
});

describe("assignPieces", () => {
  it("labels each piece by who is talking in the middle of it", () => {
    const pieces = [
      { id: "a", startFrame: 300, durationFrames: 120 }, // source 0..4
      { id: "b", startFrame: 420, durationFrames: 180 }, // source 4..10
    ];
    expect(assignPieces(pieces, [turn("S1", 0, 4), turn("S2", 4, 10)], w)).toEqual([
      { id: "a", speaker: "S1" },
      { id: "b", speaker: "S2" },
    ]);
  });

  it("does not mislabel a piece whose start rounded a frame early", () => {
    // The cut landed one frame before S2 actually starts. Reading the label at the START would say
    // S1; the midpoint says S2, which is what the piece is really made of.
    const pieces = [{ id: "b", startFrame: 419, durationFrames: 181 }];
    expect(assignPieces(pieces, [turn("S1", 0, 4), turn("S2", 4, 10)], w)[0]!.speaker).toBe("S2");
  });

  it("leaves a silent piece unassigned rather than guessing", () => {
    const pieces = [{ id: "s", startFrame: 420, durationFrames: 30 }]; // source 4..5, a gap
    expect(assignPieces(pieces, [turn("S1", 0, 4), turn("S2", 5, 10)], w)[0]!.speaker).toBeNull();
  });
});

describe("speakerOrder", () => {
  it("orders speakers by when they first talk, not by label", () => {
    expect(speakerOrder([turn("S2", 5, 6), turn("S1", 0, 4), turn("S2", 8, 9)])).toEqual(["S1", "S2"]);
  });

  it("handles no turns", () => {
    expect(speakerOrder([])).toEqual([]);
  });
});
