// Auto-reframe decides where the camera points, so these tests cover the decision itself: given the
// faces found in a shot, where does the crop window centre? The framing is what a viewer notices
// first, and getting it wrong cuts someone's head off.

import { describe, expect, it } from "bun:test";
import { faceCenterX, faceCenterY } from "./reframe-local";

const box = (x: number, y: number, w = 0.1, h = 0.1) => ({ x, y, w, h });

describe("faceCenterX", () => {
  it("centres on the one face in shot", () => {
    expect(faceCenterX([box(0.7, 0.2, 0.1, 0.1)])).toBeCloseTo(0.75, 5);
  });

  it("says nothing when there is nobody, so the caller keeps its own heuristic", () => {
    expect(faceCenterX([])).toBeNull();
  });

  it("favours the nearest person when a group is spread across the frame", () => {
    // A big face is close to camera and is who the shot is about; a small one is a bystander.
    const c = faceCenterX([box(0.05, 0.3, 0.3, 0.3), box(0.85, 0.3, 0.05, 0.05)]);
    expect(c).toBeLessThan(0.35); // pulled to the big face at ~0.20, not the midpoint of the two
  });

  it("sits between two equally sized faces", () => {
    expect(faceCenterX([box(0.1, 0.3), box(0.7, 0.3)])).toBeCloseTo(0.45, 5);
  });

  it("ignores zero-area boxes instead of letting them skew the average", () => {
    expect(faceCenterX([box(0.7, 0.2), box(0.0, 0.0, 0, 0)])).toBeCloseTo(0.75, 5);
  });

  it("never points the camera outside the frame", () => {
    const c = faceCenterX([box(0.95, 0.5, 0.4, 0.4)]);
    expect(c).toBeGreaterThanOrEqual(0);
    expect(c).toBeLessThanOrEqual(1);
  });
});

describe("faceCenterY", () => {
  it("aims below the face so the subject gets body in frame, not a mugshot", () => {
    const c = faceCenterY([box(0.4, 0.1, 0.1, 0.1)])!;
    expect(c).toBeGreaterThan(0.15); // face centre is 0.15; the crop sits lower
  });

  it("stays inside the frame for a face at the bottom edge", () => {
    expect(faceCenterY([box(0.4, 0.9, 0.1, 0.1)])).toBeLessThanOrEqual(1);
  });

  it("says nothing when there is nobody", () => {
    expect(faceCenterY([])).toBeNull();
  });
});
