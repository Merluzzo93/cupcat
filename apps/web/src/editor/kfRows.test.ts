// Pure-logic tests for the Inspector's keyframe-row builders: set_keyframes rows are
// [frame, ...values, interp?] and a rebuild must never silently reset per-keyframe easing.
import { describe, expect, test } from "vitest";
import type { AnimPair, Keyframe } from "@cupcat/editor-core";
import { mergeKfRows, pairRows, scalarRows, trackEasing } from "./kfRows";
import type { ScalarRow } from "./kfRows";

function kf1(frame: number, value: number, interp?: Keyframe<number>["interpolationOut"]): Keyframe<number> {
  // Cast: interpolationOut is required by the type but old project JSON may omit it.
  return { frame, value, interpolationOut: interp } as Keyframe<number>;
}

function kf2(frame: number, a: number, b: number, interp?: Keyframe<AnimPair>["interpolationOut"]): Keyframe<AnimPair> {
  return { frame, value: { a, b }, interpolationOut: interp } as Keyframe<AnimPair>;
}

describe("scalarRows", () => {
  test("preserves each keyframe's own easing when no override is given", () => {
    expect(scalarRows([kf1(0, 1, "linear"), kf1(30, 0, "hold")])).toEqual([
      [0, 1, "linear"],
      [30, 0, "hold"],
    ]);
  });

  test("missing interpolationOut defaults to smooth (the bridge default)", () => {
    expect(scalarRows([kf1(10, 0.5)])).toEqual([[10, 0.5, "smooth"]]);
  });

  test("override forces one easing on every row", () => {
    expect(scalarRows([kf1(0, 1, "linear"), kf1(30, 0, "hold")], "smooth")).toEqual([
      [0, 1, "smooth"],
      [30, 0, "smooth"],
    ]);
  });
});

describe("pairRows", () => {
  test("flattens {a,b} values into [frame, a, b, interp] rows", () => {
    expect(pairRows([kf2(0, 0.1, 0.2, "linear")])).toEqual([[0, 0.1, 0.2, "linear"]]);
  });

  test("override rewrites the easing while keeping the values", () => {
    expect(pairRows([kf2(0, 1, 1, "smooth"), kf2(20, 2, 2, "linear")], "hold")).toEqual([
      [0, 1, 1, "hold"],
      [20, 2, 2, "hold"],
    ]);
  });
});

describe("bezier handle columns", () => {
  test("bezier keyframes emit explicit handle columns (stored handles win)", () => {
    const k = { ...kf1(0, 0, "bezier"), bezierOut: [0.9, 0] as [number, number], bezierIn: [0.2, 0.7] as [number, number] };
    expect(scalarRows([k, kf1(60, 1, "smooth")])).toEqual([
      [0, 0, "bezier", 0.9, 0, 0.2, 0.7],
      [60, 1, "smooth"],
    ]);
  });

  test("a handle-less bezier keyframe materializes the smoothstep-equivalent defaults", () => {
    expect(scalarRows([kf1(0, 0, "bezier"), kf1(30, 1)])).toEqual([
      [0, 0, "bezier", 1 / 3, 0, 2 / 3, 1],
      [30, 1, "smooth"],
    ]);
  });

  test("pair rows append handles after the interp column", () => {
    const k = { ...kf2(0, 0.05, 0.05, "bezier"), bezierOut: [0.9, 0] as [number, number] };
    expect(pairRows([k])).toEqual([[0, 0.05, 0.05, "bezier", 0.9, 0, 2 / 3, 1]]);
  });

  test("a non-bezier override drops the handles; a bezier override keeps stored ones", () => {
    const k = { ...kf1(0, 0, "bezier"), bezierOut: [0.9, 0] as [number, number], bezierIn: [0.1, 1] as [number, number] };
    expect(scalarRows([k], "linear")).toEqual([[0, 0, "linear"]]);
    expect(scalarRows([kf1(0, 0, "smooth")], "bezier")).toEqual([[0, 0, "bezier", 1 / 3, 0, 2 / 3, 1]]);
  });

  test("trackEasing reports a uniform bezier track (lights the Custom chip)", () => {
    expect(trackEasing([kf1(0, 1, "bezier"), kf1(10, 0, "bezier")])).toBe("bezier");
    expect(trackEasing([kf1(0, 1, "bezier"), kf1(10, 0)])).toBeNull();
  });
});

describe("mergeKfRows", () => {
  const existing: ScalarRow[] = [
    [0, 1, "linear"],
    [30, 0, "hold"],
  ];

  test("inserts a new frame keeping rows sorted", () => {
    expect(mergeKfRows(existing, [15, 0.5, "smooth"])).toEqual([
      [0, 1, "linear"],
      [15, 0.5, "smooth"],
      [30, 0, "hold"],
    ]);
  });

  test("replaces the row at the same frame instead of duplicating it", () => {
    expect(mergeKfRows(existing, [30, 0.75, "smooth"])).toEqual([
      [0, 1, "linear"],
      [30, 0.75, "smooth"],
    ]);
  });
});

describe("trackEasing", () => {
  test("uniform easing is reported (missing counts as smooth)", () => {
    expect(trackEasing([kf1(0, 1, "smooth"), kf1(10, 0)])).toBe("smooth");
    expect(trackEasing([kf1(0, 1, "hold"), kf1(10, 0, "hold")])).toBe("hold");
  });

  test("mixed easings report null (no chip lights up)", () => {
    expect(trackEasing([kf1(0, 1, "linear"), kf1(10, 0, "hold")])).toBeNull();
  });

  test("empty or missing track reports null", () => {
    expect(trackEasing([])).toBeNull();
    expect(trackEasing(undefined)).toBeNull();
  });
});
