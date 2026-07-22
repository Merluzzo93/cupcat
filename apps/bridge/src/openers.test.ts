// Intros and outros. The rules that matter: a starter must still work when the brand kit is empty,
// and making room at the head must not leave a clip sitting on top of its neighbour.

import { describe, expect, it } from "bun:test";
import { DEFAULT_BRAND, OPENERS, openersOfKind, planOpener, rippleRight } from "./openers";

const byId = (id: string) => OPENERS.find((o) => o.id === id)!;

describe("OPENERS", () => {
  it("offers both intros and outros", () => {
    expect(openersOfKind("intro").length).toBeGreaterThan(0);
    expect(openersOfKind("outro").length).toBeGreaterThan(0);
  });

  it("keeps ids unique, since they are what the picker sends back", () => {
    expect(new Set(OPENERS.map((o) => o.id)).size).toBe(OPENERS.length);
  });

  it("gives every starter a sane default length", () => {
    for (const o of OPENERS) expect(o.defaultSeconds).toBeGreaterThan(0.5);
  });
});

describe("planOpener", () => {
  it("builds a full-frame card: backdrop first, then the words on top", () => {
    const l = planOpener(byId("title-card"), { title: "Episode 1", brand: DEFAULT_BRAND });
    expect(l[0]!.type).toBe("matte");
    expect(l.some((x) => x.type === "text" && x.content === "Episode 1")).toBe(true);
  });

  it("puts a title OVER the picture without a backdrop", () => {
    const l = planOpener(byId("title-over"), { title: "Hello", brand: DEFAULT_BRAND });
    expect(l.some((x) => x.type === "matte")).toBe(false);
  });

  it("uses the brand colours", () => {
    const brand = { background: "#123456", accent: "#ABCDEF" };
    const l = planOpener(byId("title-card"), { title: "X", brand });
    expect(l.find((x) => x.type === "matte")).toMatchObject({ color: "#123456" });
    expect(l.find((x) => x.type === "text")).toMatchObject({ color: "#ABCDEF" });
  });

  it("includes the logo when the brand kit has one", () => {
    const l = planOpener(byId("logo-open"), { brand: { ...DEFAULT_BRAND, logoRef: "asset_logo" } });
    expect(l.some((x) => x.type === "image" && x.mediaRef === "asset_logo")).toBe(true);
  });

  it("still produces a usable card when no logo has been set", () => {
    // Degrading to text beats failing, and beats drawing a hole where a logo should be.
    const l = planOpener(byId("logo-open"), { brand: DEFAULT_BRAND });
    expect(l.some((x) => x.type === "image")).toBe(false);
    expect(l.some((x) => x.type === "text")).toBe(true);
  });

  it("moves the heading down to leave room for the logo above it", () => {
    const withLogo = planOpener(byId("logo-open"), { brand: { ...DEFAULT_BRAND, logoRef: "l" } });
    const without = planOpener(byId("logo-open"), { brand: DEFAULT_BRAND });
    const y = (ls: ReturnType<typeof planOpener>) => (ls.find((x) => x.type === "text") as { yFraction: number }).yFraction;
    expect(y(withLogo)).toBeGreaterThan(y(without));
  });

  it("falls back to wording rather than an empty card when no title is given", () => {
    const intro = planOpener(byId("title-card"), { brand: DEFAULT_BRAND });
    const outro = planOpener(byId("end-card"), { brand: DEFAULT_BRAND });
    const text = (ls: ReturnType<typeof planOpener>) => (ls.find((x) => x.type === "text") as { content: string }).content;
    expect(text(intro).length).toBeGreaterThan(0);
    expect(text(outro).length).toBeGreaterThan(0);
    expect(text(intro)).not.toBe(text(outro)); // an outro should not say "your title"
  });

  it("ignores a whitespace-only title", () => {
    const l = planOpener(byId("title-card"), { title: "   ", brand: DEFAULT_BRAND });
    expect((l.find((x) => x.type === "text") as { content: string }).content.trim().length).toBeGreaterThan(0);
  });

  it("adds a subtitle below the heading when given one", () => {
    const l = planOpener(byId("title-card"), { title: "A", subtitle: "B", brand: DEFAULT_BRAND });
    const texts = l.filter((x) => x.type === "text") as { content: string; yFraction: number; fontSize: number }[];
    expect(texts).toHaveLength(2);
    expect(texts[1]!.yFraction).toBeGreaterThan(texts[0]!.yFraction);
    expect(texts[1]!.fontSize).toBeLessThan(texts[0]!.fontSize);
  });
});

describe("rippleRight", () => {
  const clips = [
    { id: "a", trackIndex: 0, startFrame: 0 },
    { id: "b", trackIndex: 0, startFrame: 100 },
    { id: "c", trackIndex: 1, startFrame: 50 },
  ];

  it("shifts every clip on every track by the same amount", () => {
    const m = rippleRight(clips, 90);
    expect(m).toHaveLength(3);
    for (const mv of m) expect(mv.toFrame).toBe(clips.find((c) => c.id === mv.clipId)!.startFrame + 90);
  });

  it("moves the rightmost clip first, so nothing lands on ground still occupied", () => {
    const m = rippleRight(clips, 90);
    expect(m.map((x) => x.clipId)).toEqual(["b", "c", "a"]);
  });

  it("keeps each clip on its own track", () => {
    for (const mv of rippleRight(clips, 30)) {
      expect(mv.toTrack).toBe(clips.find((c) => c.id === mv.clipId)!.trackIndex);
    }
  });

  it("does nothing for a zero or negative shift", () => {
    expect(rippleRight(clips, 0)).toEqual([]);
    expect(rippleRight(clips, -10)).toEqual([]);
  });

  it("handles an empty timeline", () => {
    expect(rippleRight([], 60)).toEqual([]);
  });
});
