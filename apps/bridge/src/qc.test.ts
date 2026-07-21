// Parsers for the pre-publish check and the loudness measurement. Both read ffmpeg's stderr, which
// varies between builds, so they have to degrade rather than throw when a field is absent.

import { describe, expect, it } from "bun:test";
import { parseLoudnorm } from "./enhance";
import { parseClipping, parseFlashes } from "./qc";

describe("parseLoudnorm", () => {
  const json = `[Parsed_loudnorm_0 @ 000]
{
	"input_i" : "-16.48",
	"input_tp" : "-2.75",
	"input_lra" : "3.00",
	"input_thresh" : "-26.65",
	"output_i" : "-14.00",
	"target_offset" : "-0.91"
}`;

  it("reads the measurement block", () => {
    const m = parseLoudnorm(json);
    expect(m).not.toBeNull();
    expect(m!.i).toBeCloseTo(-16.48);
    expect(m!.tp).toBeCloseTo(-2.75);
    expect(m!.offset).toBeCloseTo(-0.91);
  });

  it("finds the block even after pages of encoder chatter", () => {
    expect(parseLoudnorm(`frame= 1 fps=0\nframe= 2 fps=0\n${json}`)).not.toBeNull();
  });

  it("returns null rather than throwing when there is no block", () => {
    expect(parseLoudnorm("frame= 1 fps=0")).toBeNull();
    expect(parseLoudnorm("{not json")).toBeNull();
  });

  it("returns null when a required field is missing", () => {
    expect(parseLoudnorm('{"input_i":"-16.0"}')).toBeNull();
  });
});

describe("parseClipping", () => {
  it("takes the worst peak across channels", () => {
    const r = parseClipping("Peak level dB: -12.30\nPeak level dB: -3.10");
    expect(r.peakDb).toBeCloseTo(-3.1);
  });

  it("treats -inf (silence) as a floor instead of NaN", () => {
    expect(parseClipping("Peak level dB: -inf").peakDb).toBe(-140);
  });

  it("reads the clipped-sample count when the build prints one", () => {
    expect(parseClipping("Number of clipped samples: 412").clippedSamples).toBe(412);
  });

  it("reports zero clipping rather than guessing when the field is absent", () => {
    const r = parseClipping("Peak level dB: -6.0");
    expect(r.clippedSamples).toBe(0);
  });

  it("survives stderr with nothing useful in it", () => {
    expect(parseClipping("")).toEqual({ peakDb: null, clippedSamples: 0 });
  });
});

describe("parseFlashes", () => {
  it("counts one flagged frame per logged line", () => {
    expect(parseFlashes("[Parsed_photosensitivity_0] frame 120\n[Parsed_photosensitivity_0] frame 121")).toBe(2);
  });

  it("reports none for clean footage", () => {
    expect(parseFlashes("frame= 240 fps=30")).toBe(0);
  });
});
