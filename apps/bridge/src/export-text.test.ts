// What the exporter hands the two text renderers.
//
// A caption looked right in the preview and ran off both edges of the exported file, and a title
// written on two lines came out as one. Both had the same cause: the export decided the text was a
// single line and neither renderer was told about the clip's box. These pin the two decisions —
// where the text is broken (drawtext) and how a break is spelled (libass).

import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { makeClip } from "@cupcat/editor-core";
import { assEscape, drawnText, textPlacement } from "./export";
import { measureLine } from "./textmetrics";

const ARIAL_BOLD = "C:/Windows/Fonts/arialbd.ttf";
const haveFont = existsSync(ARIAL_BOLD);
const LONG = "Nel capannone Spiezia Tyres e Meetaly continuavano a lottare per la conquista del capannone";

function textClip(content: string, opts?: { fontSize?: number; width?: number }) {
  return makeClip({
    mediaRef: "",
    mediaType: "text",
    sourceClipType: "text",
    startFrame: 0,
    durationFrames: 60,
    textContent: content,
    textStyle: { fontName: "Helvetica-Bold", fontSize: opts?.fontSize ?? 48, color: "#ffffff", alignment: "center" },
    transform: { centerX: 0.5, centerY: 0.9, width: opts?.width ?? 0.9, height: 0.2, rotation: 0, flipHorizontal: false, flipVertical: false },
  });
}

describe("drawnText", () => {
  test.skipIf(!haveFont)("a caption too long for the frame is broken, not run off the edges", () => {
    const out = drawnText(textClip(LONG), 1280);
    expect(out).toContain("\n");
    for (const line of out.split("\n")) {
      expect(measureLine(line, ARIAL_BOLD, 48)).toBeLessThanOrEqual(0.9 * 1280);
    }
  });

  test.skipIf(!haveFont)("the break respects the clip's own box, not the frame", () => {
    const narrow = drawnText(textClip(LONG, { width: 0.4 }), 1280).split("\n");
    const wide = drawnText(textClip(LONG, { width: 0.9 }), 1280).split("\n");
    expect(narrow.length).toBeGreaterThan(wide.length);
    for (const line of narrow) expect(measureLine(line, ARIAL_BOLD, 48)).toBeLessThanOrEqual(0.4 * 1280);
  });

  test.skipIf(!haveFont)("a line the user typed survives — it used to be flattened into a space", () => {
    expect(drawnText(textClip("Riga uno\nRiga due"), 1280)).toBe("Riga uno\nRiga due");
  });

  test.skipIf(!haveFont)("nothing is dropped, whatever the box", () => {
    expect(drawnText(textClip(LONG, { width: 0.3 }), 1280).replace(/\s+/g, " ")).toBe(LONG);
  });

  test.skipIf(!haveFont)("bigger type on the same box needs more lines", () => {
    const small = drawnText(textClip(LONG, { fontSize: 24 }), 1280).split("\n").length;
    const big = drawnText(textClip(LONG, { fontSize: 72 }), 1280).split("\n").length;
    expect(big).toBeGreaterThan(small);
  });

  test("a clip with no text produces no text", () => {
    const c = textClip("");
    expect(drawnText(c, 1280)).toBe("");
  });
});

describe("textPlacement", () => {
  test("centred text centres its lines too — the second line used to hang off to the left", () => {
    const p = textPlacement(textClip("a\nb"), 1280);
    expect(p.textAlign).toBe("C");
    expect(p.x).toBe("640-text_w/2");
  });

  test("left-aligned text goes to the left edge of its own box, not the middle of the frame", () => {
    const c = textClip("a\nb", { width: 0.5 });
    c.textStyle!.alignment = "left";
    // Box is half the frame centred at 0.5, so its left edge is at 320.
    expect(textPlacement(c, 1280)).toEqual({ x: "320", textAlign: "L" });
  });

  test("right-aligned text ends at the right edge of its box", () => {
    const c = textClip("a\nb", { width: 0.5 });
    c.textStyle!.alignment = "right";
    expect(textPlacement(c, 1280)).toEqual({ x: "960-text_w", textAlign: "R" });
  });

  test("a clip with no style at all is treated as centred", () => {
    const c = textClip("a");
    c.textStyle = undefined;
    expect(textPlacement(c, 1280).textAlign).toBe("C");
  });
});

describe("assEscape", () => {
  test("a newline becomes ASS's own break, not a space", () => {
    expect(assEscape("Riga uno\nRiga due")).toBe("Riga uno\\NRiga due");
    expect(assEscape("Riga uno\r\nRiga due")).toBe("Riga uno\\NRiga due");
  });

  test("override braces and stray backslashes are still stripped", () => {
    // Left in, they would be read as libass tags and could restyle or hide the rest of the line.
    expect(assEscape("{\\an8}ciao")).toBe("an8ciao");
  });

  test("the break added for a newline is not stripped by the backslash rule that runs first", () => {
    expect(assEscape("a\nb")).toContain("\\N");
  });
});
