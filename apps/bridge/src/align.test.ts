// Alignment. Two things have to hold at once: the fast path must find the SAME offset the
// exhaustive scan finds, and it must stay fast on half-hour recordings — the case that pinned a
// machine and made the editor look dead.

import { describe, expect, it } from "bun:test";
import { decimate, findLag, probeSeconds, scanLags } from "./align";

const ENV = 100;

/** Speech-like envelope: bursts separated by pauses, deterministic, non-periodic. */
function envelope(seconds: number, offsetSamples = 0, seed = 12345): Float32Array {
  const n = Math.round(seconds * ENV);
  const a = new Float32Array(n);
  let s = seed >>> 0;
  const rnd = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
  // Build one "recording" then read a shifted view of it, so two envelopes really are the same
  // event heard at different times rather than two unrelated noises.
  const total = n + Math.abs(offsetSamples) + 2;
  const src = new Float32Array(total);
  let level = 0.1;
  let hold = 0;
  for (let i = 0; i < total; i++) {
    if (hold-- <= 0) {
      level = rnd() < 0.45 ? 0.05 + rnd() * 0.1 : 0.5 + rnd() * 0.5;
      hold = 15 + Math.floor(rnd() * 120);
    }
    src[i] = level * (0.85 + 0.3 * rnd());
  }
  for (let i = 0; i < n; i++) a[i] = src[i + Math.max(0, offsetSamples)]!;
  return a;
}

describe("decimate", () => {
  it("shrinks by the factor and keeps the average", () => {
    const a = Float32Array.from([1, 3, 2, 4]);
    const d = decimate(a, 2);
    expect(Array.from(d)).toEqual([2, 3]);
  });

  it("returns the input untouched for a factor of 1", () => {
    const a = Float32Array.from([1, 2, 3]);
    expect(decimate(a, 1)).toBe(a);
  });

  it("drops a trailing partial block rather than averaging a short one", () => {
    expect(decimate(Float32Array.from([1, 1, 1, 1, 9]), 2).length).toBe(2);
  });
});

describe("findLag agrees with the exhaustive scan", () => {
  const cases = [0, 37, -37, 400, -400, 1503];
  for (const shift of cases) {
    it(`finds a ${shift / ENV}s offset exactly, same as scanning every lag`, () => {
      const ref = envelope(120, 0);
      const tgt = envelope(120, shift);
      const lim = 30 * ENV;
      const exhaustive = scanLags(ref, tgt, -lim, lim);
      const fast = findLag(ref, tgt, -lim, lim);
      expect(fast.lag).toBe(exhaustive.lag);
      expect(fast.confidence).toBeCloseTo(exhaustive.confidence, 2);
    });
  }

  it("reports high confidence when the two really are the same event", () => {
    const ref = envelope(120, 0);
    const tgt = envelope(120, 250);
    expect(findLag(ref, tgt, -3000, 3000).confidence).toBeGreaterThan(0.9);
  });

  it("reports LOW confidence for two unrelated recordings, so they can be refused", () => {
    const ref = envelope(120, 0, 111);
    const tgt = envelope(120, 0, 999);
    expect(findLag(ref, tgt, -3000, 3000).confidence).toBeLessThan(0.6);
  });

  it("falls back to a plain scan when the search range is tiny", () => {
    const ref = envelope(30, 0);
    const tgt = envelope(30, 5);
    expect(findLag(ref, tgt, -20, 20).lag).toBe(scanLags(ref, tgt, -20, 20).lag);
  });

  it("never returns a lag outside the range it was given", () => {
    const ref = envelope(60, 0);
    const tgt = envelope(60, 2000);
    const r = findLag(ref, tgt, -500, 500);
    expect(r.lag).toBeGreaterThanOrEqual(-500);
    expect(r.lag).toBeLessThanOrEqual(500);
  });

  it("handles envelopes of different lengths, as cameras that stopped at different times are", () => {
    const ref = envelope(180, 0);
    const tgt = envelope(90, 300);
    expect(() => findLag(ref, tgt, -3000, 3000)).not.toThrow();
  });
});

describe("findLag stays fast on half-hour recordings", () => {
  it("resolves a 30-minute pair in well under a second", () => {
    // The old exhaustive scan took ~6.6s here, blocking the whole bridge: no progress, no stop, and
    // the editor reporting a lost connection. Anything near that is a regression.
    const ref = envelope(1800, 0);
    // The helper's offset advances the target INTO the recording, so it is heard earlier: the lag
    // that lines them up is the negative of it.
    const tgt = envelope(1800, 811);
    const t0 = Date.now();
    const r = findLag(ref, tgt, -30 * ENV, 30 * ENV);
    const ms = Date.now() - t0;
    expect(r.lag).toBe(-811);
    expect(r.confidence).toBeGreaterThan(0.9);
    expect(ms).toBeLessThan(1000);
  });
});

describe("probeSeconds", () => {
  it("reads only a few minutes rather than a whole half-hour camera", () => {
    expect(probeSeconds(30, 1800)).toBe(180);
  });

  it("grows with the search window, so a wide search still has context to work with", () => {
    expect(probeSeconds(120, 1800)).toBe(720);
  });

  it("never asks for more than the recording holds", () => {
    expect(probeSeconds(30, 45)).toBe(45);
  });

  it("always asks for something, even for a nonsensical duration", () => {
    expect(probeSeconds(30, 0)).toBeGreaterThan(0);
  });
});
