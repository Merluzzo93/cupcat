// The "what's new" card is shown exactly once, after an update. The rules worth pinning are the
// ones that decide whether somebody sees the right thing: skipping a release must not swallow it,
// and going nowhere must not show a card at all.

import { describe, expect, it } from "bun:test";
import { CHANGELOG, entriesBetween, entryFor } from "./changelog";

describe("CHANGELOG", () => {
  it("is newest first, so the card leads with what just changed", () => {
    const rank = (v: string) => v.split(".").map(Number).reduce((a, n) => a * 1000 + n, 0);
    for (let i = 1; i < CHANGELOG.length; i++) {
      expect(rank(CHANGELOG[i - 1]!.version)).toBeGreaterThan(rank(CHANGELOG[i]!.version));
    }
  });

  it("has a title and at least one point for every version", () => {
    for (const e of CHANGELOG) {
      expect(e.title.length).toBeGreaterThan(0);
      expect(e.points.length).toBeGreaterThan(0);
    }
  });
});

describe("entryFor", () => {
  it("finds a version that exists", () => {
    expect(entryFor(CHANGELOG[0]!.version)?.title).toBe(CHANGELOG[0]!.title);
  });

  it("returns null for a version with nothing written for it", () => {
    expect(entryFor("0.0.1")).toBeNull();
  });
});

describe("entriesBetween", () => {
  it("shows the release you just moved to", () => {
    const got = entriesBetween("1.7.12", "1.7.13");
    expect(got.map((e) => e.version)).toEqual(["1.7.13"]);
  });

  it("shows EVERY release you skipped, not just the newest", () => {
    const got = entriesBetween("1.7.11", "1.7.13");
    expect(got.map((e) => e.version)).toEqual(["1.7.13", "1.7.12"]);
  });

  it("shows nothing when the version has not moved — no card on an ordinary launch", () => {
    expect(entriesBetween("1.7.13", "1.7.13")).toEqual([]);
  });

  it("shows nothing when going backwards, e.g. after installing an older build", () => {
    expect(entriesBetween("1.7.13", "1.7.12")).toEqual([]);
  });

  it("compares numerically, so 1.7.9 → 1.7.13 is an upgrade rather than a downgrade", () => {
    expect(entriesBetween("1.7.9", "1.7.13").length).toBeGreaterThan(0);
  });

  it("survives a malformed stored version instead of throwing on launch", () => {
    expect(() => entriesBetween("", "1.7.13")).not.toThrow();
    expect(() => entriesBetween("nonsense", "1.7.13")).not.toThrow();
  });
});
