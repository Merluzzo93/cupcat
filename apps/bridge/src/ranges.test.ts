// These two functions decide which seconds of somebody's footage get deleted, so they are tested on
// their own rather than only through a detector: a wrong margin here is a clipped word, and a wrong
// intersection is a sentence cut in half.

import { describe, expect, test } from "bun:test";
import { intersectRanges, shapeRanges, type Range } from "./ranges";

const r = (startSeconds: number, endSeconds: number): Range => ({ startSeconds, endSeconds });
const pairs = (rs: Range[]) => rs.map((x) => [Math.round(x.startSeconds * 1000) / 1000, Math.round(x.endSeconds * 1000) / 1000]);

describe("shaping a detector's ranges into cuts", () => {
  const opts = { pad: 0.1, minKeep: 0.15, assetDur: 30 };

  test("a margin is kept on both sides, so the cut does not clip what follows", () => {
    expect(pairs(shapeRanges([r(5, 8)], opts))).toEqual([[5.1, 7.9]]);
  });

  test("a range starting at the very beginning is not padded away from it", () => {
    // Padding the head would strand an unreachable sliver before the first frame anyone can cut.
    expect(pairs(shapeRanges([r(0, 4)], opts))).toEqual([[0, 3.9]]);
  });

  test("a range running to the end is not padded away from it either", () => {
    // The "recording left running" case: the tail should go all the way out.
    expect(pairs(shapeRanges([r(25, 30)], opts))).toEqual([[25.1, 30]]);
  });

  test("a blip too short to keep is swallowed rather than left as a flash-frame", () => {
    // 0.1 s of content between two gaps: a breath, or two moving frames. Keeping it is a flash.
    expect(pairs(shapeRanges([r(2, 5), r(5.1, 9)], opts))).toEqual([[2.1, 8.9]]);
  });

  test("content long enough to keep separates the ranges", () => {
    expect(pairs(shapeRanges([r(2, 5), r(6, 9)], opts))).toEqual([
      [2.1, 4.9],
      [6.1, 8.9],
    ]);
  });

  test("a range too short to survive its own margins is dropped, not inverted", () => {
    // 0.15 s with 0.1 s off each side would end before it starts — a negative range would delete
    // backwards, or worse, be passed on as if it were real.
    expect(shapeRanges([r(5, 5.15)], opts)).toEqual([]);
  });

  test("unsorted input is handled, because a detector's order is not a promise", () => {
    expect(pairs(shapeRanges([r(6, 9), r(2, 5)], opts))).toEqual([
      [2.1, 4.9],
      [6.1, 8.9],
    ]);
  });

  test("overlapping ranges merge instead of producing two overlapping cuts", () => {
    expect(pairs(shapeRanges([r(2, 6), r(4, 9)], opts))).toEqual([[2.1, 8.9]]);
  });

  test("a range wholly inside another does not shorten it", () => {
    expect(pairs(shapeRanges([r(2, 9), r(4, 5)], opts))).toEqual([[2.1, 8.9]]);
  });

  test("zero padding cuts flush, for callers that want the boundary exactly", () => {
    expect(pairs(shapeRanges([r(5, 8)], { ...opts, pad: 0 }))).toEqual([[5, 8]]);
  });

  test("nothing detected stays nothing", () => {
    expect(shapeRanges([], opts)).toEqual([]);
  });
});

describe("still AND quiet", () => {
  test("only the overlap survives", () => {
    // Still 0-10, quiet 4-6: the person was talking for most of the motionless stretch.
    expect(pairs(intersectRanges([r(0, 10)], [r(4, 6)]))).toEqual([[4, 6]]);
  });

  test("a still stretch with speech all the way through it is not cut at all", () => {
    expect(intersectRanges([r(0, 10)], [r(20, 25)])).toEqual([]);
  });

  test("one still stretch spanning several pauses yields one cut per pause", () => {
    expect(pairs(intersectRanges([r(0, 20)], [r(2, 3), r(7, 9), r(15, 16)]))).toEqual([
      [2, 3],
      [7, 9],
      [15, 16],
    ]);
  });

  test("several still stretches inside one long pause each survive", () => {
    expect(pairs(intersectRanges([r(1, 2), r(5, 6)], [r(0, 10)]))).toEqual([
      [1, 2],
      [5, 6],
    ]);
  });

  test("ranges that merely touch produce no cut", () => {
    // Zero-length overlap is not dead air; emitting it would be a cut of nothing.
    expect(intersectRanges([r(0, 5)], [r(5, 9)])).toEqual([]);
  });

  test("either side empty means nothing to cut", () => {
    expect(intersectRanges([], [r(0, 5)])).toEqual([]);
    expect(intersectRanges([r(0, 5)], [])).toEqual([]);
  });

  test("interleaved sets advance without missing an overlap", () => {
    // The pointer has to advance on whichever ends first, or the tail overlaps are lost.
    expect(pairs(intersectRanges([r(0, 3), r(5, 8), r(10, 12)], [r(2, 6), r(7, 11)]))).toEqual([
      [2, 3],
      [5, 6],
      [7, 8],
      [10, 11],
    ]);
  });
});
