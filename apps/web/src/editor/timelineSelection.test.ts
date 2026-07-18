// Pure-logic tests for the Timeline selection helpers: marquee hit-testing in frame/px
// coordinates, shift-click range ordering, and pointer-down selection semantics.
import { describe, expect, test } from "vitest";
import { marqueeHitIds, nextClipSelection, rangeOnTrack } from "./timelineSelection";
import type { ClipSpan } from "./timelineSelection";

const TRACK_H = 46;

function clip(id: string, startFrame: number, durationFrames = 30): ClipSpan {
  return { id, startFrame, durationFrames };
}

describe("marqueeHitIds", () => {
  // Track 0: a[0..30) b[60..90); Track 1: c[10..40)
  const tracks = [{ clips: [clip("a", 0), clip("b", 60)] }, { clips: [clip("c", 10)] }];

  test("rect over the middle of one track hits only the overlapping clip", () => {
    expect(marqueeHitIds(tracks, { x1: 50, x2: 100, y1: 5, y2: 20 }, TRACK_H)).toEqual(["b"]);
  });

  test("rect spanning both tracks hits clips on both", () => {
    expect(marqueeHitIds(tracks, { x1: 5, x2: 20, y1: 10, y2: 60 }, TRACK_H)).toEqual(["a", "c"]);
  });

  test("horizontal overlap is strict — a rect ending exactly at a clip start misses it", () => {
    // x2 === b.startFrame (60): no strict overlap with b, still overlaps a.
    expect(marqueeHitIds(tracks, { x1: 20, x2: 60, y1: 0, y2: 10 }, TRACK_H)).toEqual(["a"]);
  });

  test("zero-area rect (a plain click on an empty lane) hits nothing", () => {
    expect(marqueeHitIds(tracks, { x1: 45, x2: 45, y1: 10, y2: 10 }, TRACK_H)).toEqual([]);
  });

  test("rect entirely below every track hits nothing", () => {
    expect(marqueeHitIds(tracks, { x1: 0, x2: 500, y1: 200, y2: 300 }, TRACK_H)).toEqual([]);
  });
});

describe("rangeOnTrack", () => {
  // Deliberately unsorted input: order must come from startFrame, not array order.
  const clips = [clip("late", 120), clip("early", 0), clip("mid", 60)];

  test("anchor before target selects everything between in time order", () => {
    expect(rangeOnTrack(clips, "early", "late")).toEqual(["early", "mid", "late"]);
  });

  test("anchor after target (clicking backwards) yields the same range", () => {
    expect(rangeOnTrack(clips, "late", "early")).toEqual(["early", "mid", "late"]);
  });

  test("missing anchor falls back to just the target", () => {
    expect(rangeOnTrack(clips, "ghost", "mid")).toEqual(["mid"]);
  });

  test("missing target selects nothing (stale id must not wipe the selection)", () => {
    expect(rangeOnTrack(clips, "early", "ghost")).toEqual([]);
  });
});

describe("nextClipSelection", () => {
  const trackClips = [clip("a", 0), clip("b", 60), clip("c", 120)];
  const base = { additive: false, range: false, trackClips };

  test("plain click on an unselected clip single-selects it", () => {
    expect(nextClipSelection({ ...base, current: ["a", "b"], clickedId: "c" })).toEqual(["c"]);
  });

  test("plain click inside a multi-selection keeps it (group drag can start)", () => {
    expect(nextClipSelection({ ...base, current: ["a", "b"], clickedId: "a" })).toEqual(["a", "b"]);
  });

  test("ctrl-click adds an unselected clip", () => {
    expect(nextClipSelection({ ...base, current: ["a"], clickedId: "b", additive: true })).toEqual(["a", "b"]);
  });

  test("ctrl-click removes an already-selected clip", () => {
    expect(nextClipSelection({ ...base, current: ["a", "b"], clickedId: "b", additive: true })).toEqual(["a"]);
  });

  test("shift-click ranges from the last selected clip on the track, in time order", () => {
    expect(nextClipSelection({ ...base, current: ["a"], clickedId: "c", range: true })).toEqual(["a", "b", "c"]);
  });

  test("shift-click unions with picks on other tracks instead of dropping them", () => {
    // "x" lives on another track: it is not part of the range but must survive.
    expect(nextClipSelection({ ...base, current: ["x", "a"], clickedId: "b", range: true })).toEqual(["x", "a", "b"]);
  });

  test("shift-click with no anchor on the track selects only the clicked clip", () => {
    expect(nextClipSelection({ ...base, current: ["x"], clickedId: "b", range: true })).toEqual(["x", "b"]);
  });
});
