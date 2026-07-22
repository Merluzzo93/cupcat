// The speaker lane maps SOURCE-time turns onto a clip that may be trimmed, moved and sped up. Get
// that mapping wrong and the bars still look plausible — they just point at the wrong words, which
// is worse than not drawing them at all. These pin the mapping.

import { describe, expect, it } from "vitest";
import { speakerColour, turnsToBars } from "./Timeline";

const FPS = 30;
const turn = (speaker: string, startSeconds: number, endSeconds: number) => ({ speaker, startSeconds, endSeconds });
// A 10s clip showing the source from the very beginning, at normal speed.
const whole = { trimStartFrames: 0, durationFrames: 300, speed: 1, fps: FPS };

describe("turnsToBars", () => {
  it("places a turn at the right fraction of an untrimmed clip", () => {
    const [b] = turnsToBars([turn("S1", 2, 4)], whole);
    expect(b!.left).toBeCloseTo(0.2, 5);
    expect(b!.width).toBeCloseTo(0.2, 5);
  });

  it("shifts with the trim, because the clip now starts later in the source", () => {
    // Showing source 5s..15s. A turn at source 7s sits 2s in → 20% across.
    const [b] = turnsToBars([turn("S1", 7, 8)], { ...whole, trimStartFrames: 150 });
    expect(b!.left).toBeCloseTo(0.2, 5);
    expect(b!.width).toBeCloseTo(0.1, 5);
  });

  it("drops turns that were trimmed out of the clip entirely", () => {
    // Showing source 5s..15s; a turn at 1s..2s is not in this clip at all.
    expect(turnsToBars([turn("S1", 1, 2)], { ...whole, trimStartFrames: 150 })).toEqual([]);
  });

  it("clips a turn that straddles the start of the visible window", () => {
    // Showing source 5s..15s; the turn runs 3s..7s, so only 5s..7s is visible.
    const [b] = turnsToBars([turn("S1", 3, 7)], { ...whole, trimStartFrames: 150 });
    expect(b!.left).toBeCloseTo(0, 5);
    expect(b!.width).toBeCloseTo(0.2, 5);
  });

  it("clips a turn that runs past the end of the clip", () => {
    const [b] = turnsToBars([turn("S1", 8, 999)], whole);
    expect(b!.left).toBeCloseTo(0.8, 5);
    expect(b!.left + b!.width).toBeCloseTo(1, 5); // never paints past the clip edge
  });

  it("compresses with speed: at 2x, ten source seconds fill a five second clip", () => {
    const fast = { trimStartFrames: 0, durationFrames: 150, speed: 2, fps: FPS };
    const [b] = turnsToBars([turn("S1", 0, 5)], fast);
    expect(b!.left).toBeCloseTo(0, 5);
    expect(b!.width).toBeCloseTo(0.5, 5); // 5s of 10s of source
  });

  it("keeps several speakers in order and never overlaps them", () => {
    const bars = turnsToBars([turn("S1", 0, 3), turn("S2", 3, 6), turn("S1", 6, 10)], whole);
    expect(bars.map((b) => b.speaker)).toEqual(["S1", "S2", "S1"]);
    for (let i = 1; i < bars.length; i++) {
      expect(bars[i]!.left).toBeGreaterThanOrEqual(bars[i - 1]!.left + bars[i - 1]!.width - 1e-9);
    }
  });

  it("drops slivers too thin to see rather than painting invisible specks", () => {
    expect(turnsToBars([turn("S1", 1, 1.0001)], whole)).toEqual([]);
  });

  it("returns nothing for a zero-length clip instead of dividing by zero", () => {
    expect(turnsToBars([turn("S1", 0, 5)], { ...whole, durationFrames: 0 })).toEqual([]);
  });

  it("treats a nonsensical zero speed as normal speed rather than producing NaN", () => {
    const bars = turnsToBars([turn("S1", 0, 5)], { ...whole, speed: 0 });
    expect(bars[0]!.width).toBeCloseTo(0.5, 5);
  });
});

describe("speakerColour", () => {
  it("gives each speaker a different colour", () => {
    const order = ["S1", "S2", "S3"];
    const seen = new Set(order.map((s) => speakerColour(s, order)));
    expect(seen.size).toBe(3);
  });

  it("gives the same speaker the same colour every time, so the lane is readable across clips", () => {
    const order = ["S1", "S2"];
    expect(speakerColour("S2", order)).toBe(speakerColour("S2", order));
  });

  it("still returns a colour for a label it has never seen", () => {
    expect(speakerColour("Anna", [])).toMatch(/^#[0-9a-f]{6}$/i);
  });

  it("wraps round rather than running out on a crowded recording", () => {
    const order = Array.from({ length: 12 }, (_, i) => `S${i + 1}`);
    for (const s of order) expect(speakerColour(s, order)).toMatch(/^#[0-9a-f]{6}$/i);
  });
});
