// Where a text clip lands.
//
// Position lives under `transform`, but centerY beside fontSize is the obvious guess and used to be
// dropped in silence — which stacks a title and its subtitle in the dead centre of the frame,
// printed through each other. That looks like a broken renderer, not an ignored argument, so both
// shapes are accepted and this pins it.

import { describe, expect, it } from "bun:test";
import { addTexts, EditorDocument } from "../src";

function place(entry: Record<string, unknown>): { centerX: number; centerY: number; width: number; height: number } {
  const doc = new EditorDocument();
  addTexts(doc, { entries: [{ content: "X", startFrame: 0, durationFrames: 30, ...entry }] }, "agent");
  const clip = doc.timeline.tracks.flatMap((t) => t.clips).find((c) => c.mediaType === "text")!;
  return clip.transform;
}

describe("addTexts placement", () => {
  it("reads position from transform", () => {
    expect(place({ transform: { centerY: 0.42 } }).centerY).toBe(0.42);
  });

  it("reads position given flat on the entry, instead of dropping it", () => {
    expect(place({ centerY: 0.88 }).centerY).toBe(0.88);
    expect(place({ centerX: 0.25 }).centerX).toBe(0.25);
  });

  it("a heading and a subtitle given flat coordinates do NOT land on the same spot", () => {
    expect(place({ centerY: 0.42 }).centerY).not.toBe(place({ centerY: 0.58 }).centerY);
  });

  it("transform wins when both are given, so the documented shape is never overridden", () => {
    expect(place({ centerY: 0.9, transform: { centerY: 0.1 } }).centerY).toBe(0.1);
  });

  it("size can be set either way too", () => {
    expect(place({ width: 0.5 }).width).toBe(0.5);
    expect(place({ transform: { height: 0.35 } }).height).toBe(0.35);
  });

  it("nothing given still centres, with the usual text box", () => {
    const t = place({});
    expect(t.centerX).toBe(0.5);
    expect(t.centerY).toBe(0.5);
    expect(t.width).toBe(0.8);
  });
});
