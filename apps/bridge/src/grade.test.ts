// The colour maths is where an "auto" pass can quietly make footage worse, so the rules that keep
// it safe are pinned here: never flatten a legitimately bright or punchy shot, never reduce
// saturation, and solve white balance on both chroma axes rather than one.

import { describe, expect, it } from "bun:test";
import { computeCorrection, correctionChain, parseSignalStats, type ColorStats } from "./grade";

const stats = (o: Partial<ColorStats> = {}): ColorStats => ({
  yavg: 128,
  ymin: 10,
  ymax: 240,
  uavg: 128,
  vavg: 128,
  satavg: 20,
  frames: 12,
  ...o,
});

describe("parseSignalStats", () => {
  it("averages the per-frame values", () => {
    const s = parseSignalStats(
      "signalstats.YAVG=100\nsignalstats.YAVG=140\nsignalstats.UAVG=130\nsignalstats.VAVG=126\nsignalstats.YMIN=10\nsignalstats.YMAX=200",
    );
    expect(s).not.toBeNull();
    expect(s!.yavg).toBeCloseTo(120);
    expect(s!.uavg).toBeCloseTo(130);
    expect(s!.frames).toBe(2);
  });

  it("averages YMIN/YMAX rather than taking the extremes — one flash frame must not suppress the fix", () => {
    const s = parseSignalStats(
      "signalstats.YAVG=128\nsignalstats.YMIN=100\nsignalstats.YMAX=150\nsignalstats.YAVG=128\nsignalstats.YMIN=0\nsignalstats.YMAX=255",
    );
    expect(s!.ymin).toBeCloseTo(50);
    expect(s!.ymax).toBeCloseTo(202.5);
  });

  it("returns null when there is nothing to read", () => {
    expect(parseSignalStats("no stats here")).toBeNull();
  });
});

describe("computeCorrection — exposure", () => {
  it("leaves a legitimately bright shot alone", () => {
    // A high-key plate on white averages bright ON PURPOSE; pulling it to mid-grey is a downgrade.
    expect(computeCorrection(stats({ yavg: 150 })).brightness).toBe(0);
  });

  it("leaves a legitimately dark shot alone", () => {
    expect(computeCorrection(stats({ yavg: 80 })).brightness).toBe(0);
  });

  it("lifts genuinely underexposed footage", () => {
    expect(computeCorrection(stats({ yavg: 35 })).brightness).toBeGreaterThan(0);
  });

  it("pulls back blown-out footage", () => {
    expect(computeCorrection(stats({ yavg: 220 })).brightness).toBeLessThan(0);
  });

  it("aims at the reference's brightness when matching", () => {
    const c = computeCorrection(stats({ yavg: 100 }), 1, stats({ yavg: 150 }));
    expect(c.brightness).toBeGreaterThan(0);
  });
});

describe("computeCorrection — contrast and saturation", () => {
  it("boosts contrast only on a flat picture", () => {
    expect(computeCorrection(stats({ ymin: 90, ymax: 160 })).contrast).toBeGreaterThan(1);
  });

  it("never reduces contrast on an already punchy shot", () => {
    expect(computeCorrection(stats({ ymin: 0, ymax: 255 })).contrast).toBe(1);
  });

  it("never reduces saturation", () => {
    expect(computeCorrection(stats({ satavg: 60 })).saturation).toBe(1);
  });

  it("lifts flat/log-ish footage", () => {
    expect(computeCorrection(stats({ satavg: 4 })).saturation).toBeGreaterThan(1);
  });
});

describe("computeCorrection — white balance", () => {
  it("does nothing when the picture is already neutral", () => {
    const c = computeCorrection(stats({ uavg: 128, vavg: 128 }));
    expect(c.rGain).toBe(1);
    expect(c.bGain).toBe(1);
  });

  it("pulls blue down on a blue cast", () => {
    // U above neutral is a blue cast: the blue channel has to come down.
    expect(computeCorrection(stats({ uavg: 136, vavg: 128 })).bGain).toBeLessThan(1);
  });

  it("pulls red down on a warm cast", () => {
    expect(computeCorrection(stats({ uavg: 128, vavg: 136 })).rGain).toBeLessThan(1);
  });

  it("ignores a drift too small to be a real cast", () => {
    const c = computeCorrection(stats({ uavg: 129, vavg: 128.5 }));
    expect(c.rGain).toBe(1);
    expect(c.bGain).toBe(1);
  });

  it("clamps an extreme cast so it never becomes a colour effect", () => {
    const c = computeCorrection(stats({ uavg: 200, vavg: 60 }));
    expect(c.bGain).toBeGreaterThanOrEqual(0.88);
    expect(c.rGain).toBeLessThanOrEqual(1.12);
  });

  it("targets the reference's chroma when matching", () => {
    const c = computeCorrection(stats({ uavg: 128, vavg: 128 }), 1, stats({ uavg: 140, vavg: 128 }));
    expect(c.bGain).toBeGreaterThan(1); // move toward the reference's blue look
  });
});

describe("correctionChain", () => {
  it("is empty when nothing needs doing", () => {
    expect(correctionChain({ brightness: 0, contrast: 1, saturation: 1, rGain: 1, bGain: 1 })).toBe("");
  });

  it("emits eq and colorchannelmixer only for the parts that changed", () => {
    const chain = correctionChain({ brightness: 0.1, contrast: 1, saturation: 1, rGain: 1, bGain: 0.95 });
    expect(chain).toContain("eq=brightness=");
    expect(chain).not.toContain("contrast=");
    expect(chain).toContain("colorchannelmixer=");
  });

  it("skips gains too small to be worth a re-encode", () => {
    expect(correctionChain({ brightness: 0, contrast: 1, saturation: 1, rGain: 1.001, bGain: 0.999 })).toBe("");
  });
});
