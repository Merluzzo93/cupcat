import { describe, expect, it } from "bun:test";
import {
  addClips,
  EditorDocument,
  fpsRational,
  type MediaAsset,
  setProjectFormat,
  frameSecondsString,
  frameToSeconds,
  frameToTicks,
  TICKS_PER_SECOND,
  ticksPerFrame,
  ticksToFrame,
} from "../src";

describe("mediatime", () => {
  it("maps NTSC decimals to their exact broadcast rationals", () => {
    expect(fpsRational(29.97)).toEqual({ num: 30000, den: 1001 });
    expect(fpsRational(23.976)).toEqual({ num: 24000, den: 1001 });
    expect(fpsRational(59.94)).toEqual({ num: 60000, den: 1001 });
    expect(fpsRational(30)).toEqual({ num: 30, den: 1 });
    expect(fpsRational(120)).toEqual({ num: 120, den: 1 });
  });

  it("ticksPerFrame is an exact integer for every common rate", () => {
    expect(ticksPerFrame(24)).toBe(5000);
    expect(ticksPerFrame(25)).toBe(4800);
    expect(ticksPerFrame(30)).toBe(4000);
    expect(ticksPerFrame(50)).toBe(2400);
    expect(ticksPerFrame(60)).toBe(2000);
    expect(ticksPerFrame(120)).toBe(1000);
    // NTSC: 120000 * 1001 / num — exact by construction of the tick base.
    expect(ticksPerFrame(29.97)).toBe(4004);
    expect(ticksPerFrame(23.976)).toBe(5005);
    expect(ticksPerFrame(59.94)).toBe(2002);
  });

  it("frameToTicks/ticksToFrame round-trip exactly at every supported rate", () => {
    for (const fps of [24, 25, 30, 50, 60, 120, 29.97, 23.976, 59.94]) {
      for (const frame of [0, 1, 29, 30000, 123457, 4_320_000]) {
        const ticks = frameToTicks(frame, fps);
        expect(ticksToFrame(ticks, fps)).toBe(frame);
        expect(ticks).toBe(frame * ticksPerFrame(fps));
      }
    }
  });

  it("frame 30000 at 29.97 fps is EXACTLY 1001 seconds (the float division is not)", () => {
    expect(frameToSeconds(30000, 29.97)).toBe(1001);
    expect(30000 / 29.97).not.toBe(1001); // the naive math this module replaces
    expect(frameSecondsString(30000, 29.97)).toBe("1001");
  });

  it("frameToSeconds is exact for integer rates", () => {
    expect(frameToSeconds(90, 30)).toBe(3);
    expect(frameToSeconds(68, 30)).toBeCloseTo(68 / 30, 15);
    expect(frameToSeconds(7200, 24)).toBe(300);
  });

  it("no drift over 10 hours at NTSC rates", () => {
    // 10 h of 29.97 fps ≈ 1,078,920 frames. Exactness invariant: seconds*30000 must equal
    // frame*1001 as integers (both stay below 2^53, so doubles carry them exactly).
    const frames = 1_078_920;
    const secs = frameToSeconds(frames, 29.97);
    expect(secs * 30000).toBe(frames * 1001);
    // The float-fps division accumulates visible error at this scale; the rational does not.
    const drift = Math.abs(frames / 29.97 - secs);
    expect(drift).toBeGreaterThan(1e-3); // the bug being prevented is real…
    expect(frameToTicks(frames, 29.97) / TICKS_PER_SECOND).toBe(secs); // …and the ticks agree
  });

  it("frameSecondsString emits ≤7 decimals with trailing zeros trimmed", () => {
    expect(frameSecondsString(90, 30)).toBe("3");
    expect(frameSecondsString(68, 30)).toBe("2.2666667"); // the 1-frame-black boundary case
    expect(frameSecondsString(1, 29.97)).toBe("0.0333667"); // 1001/30000 rounded at 7 decimals
    expect(frameSecondsString(3, 24)).toBe("0.125");
    expect(frameSecondsString(0, 60)).toBe("0");
  });

  it("frameSecondsString stays within half a tick of the true rational", () => {
    for (const fps of [30, 29.97, 23.976, 59.94, 60]) {
      for (const frame of [1, 7, 999, 30000, 1_078_920]) {
        const exact = frameToSeconds(frame, fps);
        expect(Math.abs(Number(frameSecondsString(frame, fps)) - exact)).toBeLessThan(5e-8);
      }
    }
  });

  it("frameSecondsString accepts fractional frame counts (speed-scaled durations)", () => {
    expect(frameSecondsString(45.5, 30)).toBe("1.5166667");
    expect(Number(frameSecondsString(30000.5, 29.97))).toBeCloseTo(30000.5 * (1001 / 30000), 6);
  });

  it("ticksPerFrame divides the second grid evenly for NTSC pairs (1001-frame group = 1001·ticks)", () => {
    // 30000 NTSC frames must span exactly 1001 seconds on the tick grid too.
    expect(frameToTicks(30000, 29.97)).toBe(1001 * TICKS_PER_SECOND);
    expect(frameToTicks(24000, 23.976)).toBe(1001 * TICKS_PER_SECOND);
    expect(frameToTicks(60000, 59.94)).toBe(1001 * TICKS_PER_SECOND);
  });
});

describe("set_project_format NTSC rates", () => {
  const video = (id: string, durationSeconds = 4000): MediaAsset => ({
    id,
    type: "video",
    name: id,
    durationSeconds,
    hasAudio: false,
    generationStatus: { kind: "none" },
  });

  it("accepts 29.97 without flooring it, rejects other fractions", () => {
    const doc = new EditorDocument();
    setProjectFormat(doc, { fps: 29.97 });
    expect(doc.timeline.fps).toBe(29.97);
    setProjectFormat(doc, { fps: 23.976 });
    expect(doc.timeline.fps).toBe(23.976);
    expect(() => setProjectFormat(doc, { fps: 29.5 })).toThrow(/NTSC/);
    expect(() => setProjectFormat(doc, { fps: 0 })).toThrow();
  });

  it("30→29.97→30 round-trips clip frames unchanged (exact rational ratio)", () => {
    const doc = new EditorDocument();
    doc.addAsset(video("v1"));
    addClips(doc, { entries: [{ mediaRef: "v1", startFrame: 30000, durationFrames: 900 }] });
    setProjectFormat(doc, { fps: 29.97 });
    const c1 = doc.timeline.tracks[0]!.clips[0]!;
    expect(c1.startFrame).toBe(29970); // 30000·(1000/1001) rounded
    setProjectFormat(doc, { fps: 30 });
    const c2 = doc.timeline.tracks[0]!.clips[0]!;
    expect(c2.startFrame).toBe(30000);
    expect(c2.durationFrames).toBe(900);
  });
});
