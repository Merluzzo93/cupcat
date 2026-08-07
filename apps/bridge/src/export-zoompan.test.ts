// The zoompan timestamp trap, pinned — and it is a trap that already shipped.
//
// A push-in built by punch_in renders through ffmpeg's zoompan, and zoompan REGENERATES output
// timestamps from zero, discarding the setpts that had moved the clip to its place on the timeline.
// The overlay compositing that clip is gated on `enable=between(t, start, end)`, so the stream ran
// dry before its own window opened and the black canvas showed through: a finished export where
// every push-in was a black hole with the subtitles still legible on top. The preview looked
// perfect throughout, because the preview composites in the browser and never runs ffmpeg — which
// is exactly why this needs a test rather than an eyeball.

import { describe, expect, test } from "bun:test";
import { makeClip, type Clip } from "@cupcat/editor-core";
import { kenBurnsZoompan } from "./export";

/** A clip at `startFrame` with a push-in from 1× to `to`, the shape punch_in produces. */
function zoomClip(startFrame: number, durationFrames: number, to: number): Clip {
  const c = makeClip({ mediaRef: "m", mediaType: "video", startFrame, durationFrames });
  c.scaleTrack = {
    keyframes: [
      { frame: 0, value: { a: 1, b: 1 }, interpolationOut: "smooth" },
      { frame: durationFrames, value: { a: to, b: to }, interpolationOut: "smooth" },
    ],
  };
  c.positionTrack = {
    keyframes: [
      { frame: 0, value: { a: 0, b: 0 }, interpolationOut: "smooth" },
      { frame: durationFrames, value: { a: -0.1, b: 0 }, interpolationOut: "smooth" },
    ],
  };
  return c;
}

describe("kenBurnsZoompan", () => {
  test("puts the clip back at its own place on the timeline — zoompan resets PTS to zero", () => {
    const chain = kenBurnsZoompan(zoomClip(555, 228, 2), 1280, 720, 30);
    expect(chain).not.toBeNull();
    // 555 / 30 fps = 18.5s. Without this the clip composites at t=0 and its window renders black.
    expect(chain).toMatch(/setpts=PTS-STARTPTS\+18\.500000\/TB$/);
  });

  test("a clip already at the head still gets the offset, so the rule has no exception to forget", () => {
    expect(kenBurnsZoompan(zoomClip(0, 150, 1.6), 1280, 720, 30)).toMatch(/setpts=PTS-STARTPTS\+0\.000000\/TB$/);
  });

  test("the offset is the LAST thing in the chain — anything after zoompan would undo it", () => {
    const chain = kenBurnsZoompan(zoomClip(300, 120, 1.5), 1280, 720, 25)!;
    expect(chain.lastIndexOf("zoompan=")).toBeLessThan(chain.lastIndexOf("setpts="));
    expect(chain.indexOf("setpts=")).toBe(chain.lastIndexOf("setpts=")); // exactly one
  });

  test("no zoom means no zoompan at all — the overlay path renders pans, and it keeps its own PTS", () => {
    const flat = zoomClip(100, 60, 1);
    expect(kenBurnsZoompan(flat, 1280, 720, 30)).toBeNull();
  });

  test("a zoom OUT below 1:1 is left to the overlay path — zoompan cannot go under 1", () => {
    const out = zoomClip(100, 60, 2);
    out.scaleTrack!.keyframes[0]!.value = { a: 0.8, b: 0.8 };
    expect(kenBurnsZoompan(out, 1280, 720, 30)).toBeNull();
  });
});
