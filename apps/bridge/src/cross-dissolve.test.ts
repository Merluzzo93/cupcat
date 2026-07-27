// A cross transition has to actually dissolve.
//
// The bug: two clips that merely touch each fade their ALPHA - the outgoing one down, the incoming
// one up - so for that moment neither is opaque and the black background shows through. Measured on
// a real export, luminance at the join was 0 of 255: a black blink at every cut, which is worse
// than the hard cut it was meant to soften. The fix is to let the outgoing clip linger past its own
// end, borrowing frames from beyond its out-point, so the two genuinely overlap.

import { describe, expect, it } from "bun:test";
import type { Clip, Track } from "@cupcat/editor-core";
import { crossLinger } from "./export";

const FPS = 30;
function clip(over: Partial<Clip> & { id: string; startFrame: number; durationFrames: number }): Clip {
  return {
    mediaRef: "a1", mediaType: "video", sourceClipType: "video",
    trimStartFrame: 0, trimEndFrame: 0, speed: 1, volume: 1,
    fadeInFrames: 0, fadeOutFrames: 0, fadeInInterpolation: "linear", fadeOutInterpolation: "linear",
    opacity: 1, transform: { x: 0, y: 0, scale: 1, rotation: 0, centerX: 0.5, centerY: 0.5 },
    crop: { left: 0, right: 0, top: 0, bottom: 0 }, ...over,
  } as Clip;
}
const track = (clips: Clip[]): Track => ({ id: "t0", type: "video", muted: false, hidden: false, locked: false, syncLocked: true, clips }) as Track;

describe("how long a clip lingers so the next can dissolve over it", () => {
  it("lingers for the length of the join when both sides fade", () => {
    const a = clip({ id: "a", startFrame: 0, durationFrames: 90, fadeOutFrames: 12 });
    const b = clip({ id: "b", startFrame: 90, durationFrames: 90, fadeInFrames: 12 });
    expect(crossLinger(a, track([a, b]), FPS, 600)).toBe(12);
  });

  it("does not linger when nothing follows — the last shot fades to black, as it should", () => {
    const a = clip({ id: "a", startFrame: 0, durationFrames: 90, fadeOutFrames: 12 });
    expect(crossLinger(a, track([a]), FPS, 600)).toBe(0);
  });

  it("does not linger when the next clip does not start exactly here", () => {
    // A gap means the timeline shows black between them on purpose; do not paper over it.
    const a = clip({ id: "a", startFrame: 0, durationFrames: 90, fadeOutFrames: 12 });
    const b = clip({ id: "b", startFrame: 120, durationFrames: 90, fadeInFrames: 12 });
    expect(crossLinger(a, track([a, b]), FPS, 600)).toBe(0);
  });

  it("does not linger when the next clip has no fade in — that join is a straight cut", () => {
    const a = clip({ id: "a", startFrame: 0, durationFrames: 90, fadeOutFrames: 12 });
    const b = clip({ id: "b", startFrame: 90, durationFrames: 90 });
    expect(crossLinger(a, track([a, b]), FPS, 600)).toBe(0);
  });

  it("takes the shorter of the two fades, so neither side is asked for frames it has not got", () => {
    const a = clip({ id: "a", startFrame: 0, durationFrames: 90, fadeOutFrames: 20 });
    const b = clip({ id: "b", startFrame: 90, durationFrames: 90, fadeInFrames: 8 });
    expect(crossLinger(a, track([a, b]), FPS, 600)).toBe(8);
  });

  it("borrows only the frames the source actually has left", () => {
    // Out-point at 3s of a 3.2s source: 6 frames of handle, not the 12 the transition wants.
    const a = clip({ id: "a", startFrame: 0, durationFrames: 90, fadeOutFrames: 12 });
    const b = clip({ id: "b", startFrame: 90, durationFrames: 90, fadeInFrames: 12 });
    expect(crossLinger(a, track([a, b]), FPS, 3.2)).toBe(6);
  });

  it("cannot borrow at all at the very end of a source", () => {
    const a = clip({ id: "a", startFrame: 0, durationFrames: 90, fadeOutFrames: 12 });
    const b = clip({ id: "b", startFrame: 90, durationFrames: 90, fadeInFrames: 12 });
    expect(crossLinger(a, track([a, b]), FPS, 3.0)).toBe(0);
  });

  it("counts handles in source frames when the clip is slowed down", () => {
    // At half speed a clip 90 timeline frames long consumes 45 source frames, so 1.6s of source
    // leaves plenty - but the borrowed span is measured on the timeline, at that same speed.
    const a = clip({ id: "a", startFrame: 0, durationFrames: 90, fadeOutFrames: 12, speed: 0.5 });
    const b = clip({ id: "b", startFrame: 90, durationFrames: 90, fadeInFrames: 12 });
    expect(crossLinger(a, track([a, b]), FPS, 2.0)).toBe(12);
  });
});
