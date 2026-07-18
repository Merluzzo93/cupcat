import { describe, expect, it } from "bun:test";
import { splitStyleSegments } from "../src";
import { addTexts, EditorDocument, setClipProperties } from "../src";

describe("splitStyleSegments", () => {
  it("returns one unstyled segment when there are no ranges", () => {
    expect(splitStyleSegments("HELLO", undefined)).toEqual([{ text: "HELLO" }]);
    expect(splitStyleSegments("HELLO", [])).toEqual([{ text: "HELLO" }]);
  });

  it("splits a middle range into before / styled / after segments", () => {
    const segs = splitStyleSegments("CIAO MONDO ROSSO", [{ start: 11, end: 16, color: "#FF2020", bold: true }]);
    expect(segs).toEqual([
      { text: "CIAO MONDO " },
      { text: "ROSSO", color: "#FF2020", bold: true },
    ]);
  });

  it("merges attributes of overlapping ranges, later range winning on conflicts", () => {
    const segs = splitStyleSegments("ABCDEF", [
      { start: 0, end: 4, color: "#FF0000", bold: true },
      { start: 2, end: 6, color: "#00FF00", italic: true },
    ]);
    expect(segs).toEqual([
      { text: "AB", color: "#FF0000", bold: true },
      { text: "CD", color: "#00FF00", bold: true, italic: true }, // color overridden, bold kept
      { text: "EF", color: "#00FF00", italic: true },
    ]);
  });

  it("is order-independent: unsorted ranges produce sorted segments", () => {
    const segs = splitStyleSegments("ABCDEF", [
      { start: 4, end: 6, italic: true },
      { start: 0, end: 2, bold: true },
    ]);
    expect(segs.map((s) => s.text)).toEqual(["AB", "CD", "EF"]);
    expect(segs[0]!.bold).toBe(true);
    expect(segs[1]).toEqual({ text: "CD" });
    expect(segs[2]!.italic).toBe(true);
  });

  it("clamps out-of-bounds ranges to the text instead of throwing", () => {
    const segs = splitStyleSegments("ABC", [{ start: -5, end: 99, color: "#112233" }]);
    expect(segs).toEqual([{ text: "ABC", color: "#112233" }]);
  });

  it("drops empty, reversed, and fully out-of-range ranges", () => {
    const segs = splitStyleSegments("ABC", [
      { start: 1, end: 1, bold: true }, // empty
      { start: 2, end: 1, bold: true }, // reversed
      { start: 7, end: 9, bold: true }, // beyond the text → clamps empty
    ]);
    expect(segs).toEqual([{ text: "ABC" }]);
  });

  it("keeps adjacent ranges contiguous with no gap or overlap", () => {
    const segs = splitStyleSegments("ABCD", [
      { start: 0, end: 2, bold: true },
      { start: 2, end: 4, italic: true },
    ]);
    expect(segs).toEqual([
      { text: "AB", bold: true },
      { text: "CD", italic: true },
    ]);
    expect(segs.map((s) => s.text).join("")).toBe("ABCD");
  });

  it("supports fontSizeScale and a range covering the whole text", () => {
    const segs = splitStyleSegments("HI", [{ start: 0, end: 2, fontSizeScale: 1.3 }]);
    expect(segs).toEqual([{ text: "HI", fontSizeScale: 1.3 }]);
  });
});

describe("styleRanges commands", () => {
  function textDoc(): { doc: EditorDocument; clipId: string } {
    const doc = new EditorDocument();
    addTexts(doc, { entries: [{ content: "CIAO MONDO ROSSO", startFrame: 0, durationFrames: 90 }] });
    return { doc, clipId: doc.timeline.tracks[0]!.clips[0]!.id };
  }

  it("add_texts accepts styleRanges per entry", () => {
    const doc = new EditorDocument();
    addTexts(doc, {
      entries: [
        {
          content: "CIAO MONDO ROSSO",
          startFrame: 0,
          durationFrames: 90,
          styleRanges: [{ start: 11, end: 16, color: "#FF2020", bold: true }],
        },
      ],
    });
    expect(doc.timeline.tracks[0]!.clips[0]!.styleRanges).toEqual([{ start: 11, end: 16, color: "#FF2020", bold: true }]);
  });

  it("set_clip_properties replaces the whole list and null clears it", () => {
    const { doc, clipId } = textDoc();
    setClipProperties(doc, { clipIds: [clipId], styleRanges: [{ start: 0, end: 4, italic: true, fontSizeScale: 1.3 }] });
    expect(doc.getClip(clipId)!.styleRanges).toEqual([{ start: 0, end: 4, italic: true, fontSizeScale: 1.3 }]);
    setClipProperties(doc, { clipIds: [clipId], styleRanges: [{ start: 5, end: 10, bold: true }] });
    expect(doc.getClip(clipId)!.styleRanges).toEqual([{ start: 5, end: 10, bold: true }]); // replaced, not merged
    setClipProperties(doc, { clipIds: [clipId], styleRanges: null });
    expect(doc.getClip(clipId)!.styleRanges).toBeUndefined();
  });

  it("rejects malformed ranges and bad colors up front", () => {
    const { doc, clipId } = textDoc();
    expect(() => setClipProperties(doc, { clipIds: [clipId], styleRanges: [{ start: 5, end: 2 }] })).toThrow(/start < end/);
    expect(() => setClipProperties(doc, { clipIds: [clipId], styleRanges: [{ start: 0, end: 4, color: "red" }] })).toThrow(/RRGGBB/);
  });
});
