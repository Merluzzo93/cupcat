// Pure geometry-mapping tests for the Inspector's SVG keyframe curve editor. The interactive
// component funnels every drag through these helpers, so pinning them pins the editor's math:
// frame↔x and value↔y must round-trip, keyframe drags must stay between neighbors, and bezier
// handle points must convert to/from the normalized (t, v) space the model stores.
import { describe, expect, test } from "vitest";
import {
  frameToX,
  handlePoint,
  neighborClamp,
  pointToHandle,
  valueBounds,
  valueToY,
  xToFrame,
  yToValue,
} from "./KeyframeCurveEditor";

const W = 300;
const H = 120;
const PX = 10;
const PY = 12;

describe("frame↔x mapping", () => {
  test("domain endpoints land on the padded panel edges", () => {
    expect(frameToX(0, 60, W, PX)).toBe(PX);
    expect(frameToX(60, 60, W, PX)).toBe(W - PX);
    expect(frameToX(30, 60, W, PX)).toBeCloseTo(W / 2, 6);
  });

  test("xToFrame inverts frameToX to the nearest whole frame and clamps to the domain", () => {
    for (const f of [0, 7, 30, 59, 60]) {
      expect(xToFrame(frameToX(f, 60, W, PX), 60, W, PX)).toBe(f);
    }
    expect(xToFrame(-50, 60, W, PX)).toBe(0);
    expect(xToFrame(W + 50, 60, W, PX)).toBe(60);
  });
});

describe("value↔y mapping", () => {
  test("y axis is inverted: max value at the top gutter, min at the bottom", () => {
    expect(valueToY(1, 0, 1, H, PY)).toBe(PY);
    expect(valueToY(0, 0, 1, H, PY)).toBe(H - PY);
  });

  test("yToValue inverts valueToY across an arbitrary range", () => {
    for (const v of [-180, -42.5, 0, 99.9, 180]) {
      expect(yToValue(valueToY(v, -180, 180, H, PY), -180, 180, H, PY)).toBeCloseTo(v, 6);
    }
  });

  test("valueBounds pads the range and gives flat data a visible band", () => {
    const b = valueBounds([0, 1]);
    expect(b.min).toBeCloseTo(-0.1, 9);
    expect(b.max).toBeCloseTo(1.1, 9);
    const flat = valueBounds([0.5, 0.5, 0.5]);
    expect(flat.max - flat.min).toBeGreaterThan(0.5); // not collapsed
    expect(flat.min).toBeLessThan(0.5);
    expect(flat.max).toBeGreaterThan(0.5);
  });
});

describe("neighborClamp", () => {
  test("interior keyframes stay strictly between their neighbors", () => {
    expect(neighborClamp([0, 30, 60], 1, 90)).toEqual([1, 59]);
  });

  test("first and last keyframes clamp to the clip's frame domain", () => {
    expect(neighborClamp([0, 30, 60], 0, 90)).toEqual([0, 29]);
    expect(neighborClamp([0, 30, 60], 2, 90)).toEqual([31, 90]);
  });
});

describe("bezier handle ↔ point mapping", () => {
  const k1 = { frame: 0, value: 0.1 };
  const k2 = { frame: 60, value: 0.9 };

  test("handlePoint maps normalized handles into segment space", () => {
    expect(handlePoint(k1, k2, [0.9, 0])).toEqual({ frame: 54, value: 0.1 });
    expect(handlePoint(k1, k2, [0.5, 0.5])).toEqual({ frame: 30, value: 0.5 });
  });

  test("pointToHandle round-trips handlePoint", () => {
    for (const h of [[0.9, 0], [0.1, 1], [0.25, -0.5], [0.75, 1.5]] as const) {
      const p = handlePoint(k1, k2, h);
      const back = pointToHandle(k1, k2, p.frame, p.value);
      expect(back[0]).toBeCloseTo(h[0], 9);
      expect(back[1]).toBeCloseTo(h[1], 9);
    }
  });

  test("handle x clamps to the segment (time must not leave it); y overshoots freely", () => {
    expect(pointToHandle(k1, k2, -30, 0.5)[0]).toBe(0);
    expect(pointToHandle(k1, k2, 90, 0.5)[0]).toBe(1);
    expect(pointToHandle(k1, k2, 30, 2.5)[1]).toBeCloseTo(3, 9); // (2.5-0.1)/0.8
  });

  test("a flat segment (zero value delta) yields the neutral y instead of dividing by zero", () => {
    const flatK2 = { frame: 60, value: 0.1 };
    expect(pointToHandle(k1, flatK2, 30, 0.7)[1]).toBe(0);
    expect(handlePoint(k1, flatK2, [0.5, 0.8]).value).toBeCloseTo(0.1, 9);
  });
});
