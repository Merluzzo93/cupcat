// How wide a line is, and where it breaks.
//
// This exists because a caption was measured running 1276 px across a 1280 px frame while the
// preview had it neatly wrapped inside its box the whole time: drawtext does not wrap, libass wraps
// at a width of its own, and the browser wrapped at the clip's box. Line breaks are decided here now
// so all three draw the same thing. The last test renders with the real ffmpeg and compares the
// predicted width against the pixels that came out, because a metric nobody checks against a render
// is just a guess with decimals.

import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CAPTION_MAX_LINES, fontFileFor, layoutCaption, measureLine, wrapText } from "./textmetrics";
import { FFMPEG_BIN } from "./config";

const ARIAL_BOLD = "C:/Windows/Fonts/arialbd.ttf";
const haveFont = existsSync(ARIAL_BOLD);
// The bundled build, not whatever is on PATH — they are different versions and draw differently.
const BUNDLED_FFMPEG = join(import.meta.dir, "../../desktop/src-tauri/sidecars/ffmpeg.exe");
const ffmpeg = existsSync(BUNDLED_FFMPEG) ? BUNDLED_FFMPEG : existsSync(FFMPEG_BIN) ? FFMPEG_BIN : null;
const LONG = "Nel capannone Spiezia Tyres e Meetaly continuavano a lottare per la conquista del capannone";

describe("measureLine", () => {
  test.skipIf(!haveFont)("a longer string is wider, and doubling the size doubles the width", () => {
    expect(measureLine("iiii", ARIAL_BOLD, 48)).toBeLessThan(measureLine("MMMM", ARIAL_BOLD, 48));
    const one = measureLine(LONG, ARIAL_BOLD, 48);
    expect(measureLine(LONG, ARIAL_BOLD, 96)).toBeCloseTo(one * 2, 3);
  });

  test.skipIf(!haveFont)("proportional and monospaced faces disagree about the same letters", () => {
    const mono = "C:/Windows/Fonts/consola.ttf";
    if (!existsSync(mono)) return;
    // In a monospaced face 'i' and 'w' are the same width; in Arial they are not. A reader that
    // ignored the font would give the same answer for both, which is the bug this rules out.
    const arial = measureLine("iiii", ARIAL_BOLD, 40) / measureLine("wwww", ARIAL_BOLD, 40);
    const consolas = measureLine("iiii", mono, 40) / measureLine("wwww", mono, 40);
    expect(consolas).toBeCloseTo(1, 5);
    expect(arial).toBeLessThan(0.7);
  });

  test("an unreadable font falls back instead of throwing — an export must never die on a font", () => {
    const missing = join(tmpdir(), "cupcat-no-such-font.ttf");
    expect(() => measureLine("abc", missing, 48)).not.toThrow();
    expect(measureLine("abc", missing, 48)).toBeGreaterThan(0);
  });

  test("empty text has no width", () => {
    expect(measureLine("", ARIAL_BOLD, 48)).toBe(0);
  });
});

describe("wrapText", () => {
  test.skipIf(!haveFont)("every line fits the box it was given", () => {
    for (const box of [400, 700, 1024, 1600]) {
      const r = wrapText(LONG, { fontFile: ARIAL_BOLD, fontSizePx: 48, maxWidthPx: box });
      expect(r.widestPx).toBeLessThanOrEqual(box);
      expect(r.lines.join(" ").replace(/\s+/g, " ")).toBe(LONG);
    }
  });

  test.skipIf(!haveFont)("a narrower box needs at least as many lines, never fewer", () => {
    const wide = wrapText(LONG, { fontFile: ARIAL_BOLD, fontSizePx: 48, maxWidthPx: 1200 }).lines.length;
    const narrow = wrapText(LONG, { fontFile: ARIAL_BOLD, fontSizePx: 48, maxWidthPx: 500 }).lines.length;
    expect(narrow).toBeGreaterThanOrEqual(wide);
  });

  test.skipIf(!haveFont)("a line the user typed stays a line of its own", () => {
    const r = wrapText("Riga uno\nRiga due", { fontFile: ARIAL_BOLD, fontSizePx: 48, maxWidthPx: 1024 });
    expect(r.lines).toEqual(["Riga uno", "Riga due"]);
  });

  test.skipIf(!haveFont)("one word wider than the box is broken rather than left to run off it", () => {
    const r = wrapText("Donaudampfschiffahrtselektrizitaetenhauptbetriebswerkbauunterbeamtengesellschaft", {
      fontFile: ARIAL_BOLD,
      fontSizePx: 48,
      maxWidthPx: 400,
    });
    expect(r.lines.length).toBeGreaterThan(1);
    expect(r.widestPx).toBeLessThanOrEqual(400);
  });

  test.skipIf(!haveFont)("two lines come out balanced, not full-line-plus-orphan", () => {
    const r = wrapText(LONG, { fontFile: ARIAL_BOLD, fontSizePx: 32, maxWidthPx: 900 });
    expect(r.lines.length).toBe(2);
    const a = measureLine(r.lines[0]!, ARIAL_BOLD, 32);
    const b = measureLine(r.lines[1]!, ARIAL_BOLD, 32);
    // Greedy wrapping put ~870px on the first line and one word on the second; balanced is within
    // a quarter of the box of each other.
    expect(Math.abs(a - b)).toBeLessThan(900 * 0.25);
  });

  test.skipIf(!haveFont)("overflow is reported, not silently truncated", () => {
    const r = wrapText(LONG, { fontFile: ARIAL_BOLD, fontSizePx: 48, maxWidthPx: 400, maxLines: 2 });
    expect(r.overflow).toBe(true);
    expect(r.lines.join(" ").replace(/\s+/g, " ")).toBe(LONG); // nothing was thrown away
  });
});

describe("layoutCaption", () => {
  test.skipIf(!haveFont)("a sentence that fits stays one cue", () => {
    const cues = layoutCaption("Il presidente sta arrivando", { fontFile: ARIAL_BOLD, fontSizePx: 48, maxWidthPx: 1152 });
    expect(cues).toHaveLength(1);
    expect(cues[0]).not.toContain("\n");
  });

  test.skipIf(!haveFont)("no cue is ever more than two lines, and none of them spills", () => {
    const cues = layoutCaption(`${LONG} ${LONG}`, { fontFile: ARIAL_BOLD, fontSizePx: 48, maxWidthPx: 1152 });
    expect(cues.length).toBeGreaterThan(1);
    for (const cue of cues) {
      const lines = cue.split("\n");
      expect(lines.length).toBeLessThanOrEqual(CAPTION_MAX_LINES);
      for (const l of lines) expect(measureLine(l, ARIAL_BOLD, 48)).toBeLessThanOrEqual(1152);
    }
  });

  test.skipIf(!haveFont)("splitting into cues keeps every word, in order", () => {
    const spoken = `${LONG} ${LONG}`;
    const cues = layoutCaption(spoken, { fontFile: ARIAL_BOLD, fontSizePx: 48, maxWidthPx: 1152 });
    expect(cues.join(" ").replace(/\s+/g, " ")).toBe(spoken);
  });
});

describe("fontFileFor", () => {
  test("an unknown name falls back to the default face rather than nothing", () => {
    expect(fontFileFor("Not A Real Font")).toBe(fontFileFor());
    expect(fontFileFor()).toMatch(/\.ttf$/i);
  });
});

// The whole point of reading the font file is that the number matches the render.
describe("against what ffmpeg actually draws", () => {
  test.skipIf(!haveFont || ffmpeg === null)(
    "the predicted width is within 2% of the ink, and never narrower",
    async () => {
      const dir = tmpdir();
      const txt = join(dir, "cupcat-metrics-test.txt");
      const png = join(dir, "cupcat-metrics-test.png");
      const W = 1600;
      const H = 200;
      const size = 48;
      const text = "Nel capannone Spiezia Tyres e Meetaly";
      await Bun.write(txt, text);
      const esc = (p: string) => p.replace(/\\/g, "/").replace(/:/g, "\\\\:");
      const draw = `drawtext=fontfile=${esc(ARIAL_BOLD)}:textfile=${esc(txt)}:fontsize=${size}:fontcolor=white:x=20:y=60`;
      const render = Bun.spawnSync([ffmpeg!, "-v", "error", "-f", "lavfi", "-i", `color=c=black:s=${W}x${H}:d=1`, "-vf", draw, "-frames:v", "1", "-y", png]);
      expect(render.exitCode).toBe(0);

      const gray = Bun.spawnSync([ffmpeg!, "-v", "error", "-i", png, "-f", "rawvideo", "-pix_fmt", "gray", "-"]).stdout;
      let minx = W;
      let maxx = -1;
      for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
          if (gray[y * W + x]! > 90) {
            if (x < minx) minx = x;
            if (x > maxx) maxx = x;
          }
        }
      }
      const drawn = maxx - minx + 1;
      const predicted = measureLine(text, ARIAL_BOLD, size);
      // Predicted is a sum of advances and drawn is ink, so predicted must come out slightly WIDER —
      // the side bearings on the first and last glyph. Narrower would mean text escaping its box.
      expect(predicted).toBeGreaterThanOrEqual(drawn);
      expect((predicted - drawn) / drawn).toBeLessThan(0.02);
    },
    60_000,
  );
});

describe("a font that parses but then misbehaves", () => {
  test("a truncated font file measures instead of taking the export down", async () => {
    // Real header, nothing behind it: the tables parse, the lookups then read past the end.
    const real = new Uint8Array(await Bun.file(ARIAL_BOLD).arrayBuffer());
    const cut = join(tmpdir(), "cupcat-truncated-font.ttf");
    await Bun.write(cut, real.slice(0, Math.min(real.length, 4096)));
    expect(() => measureLine("qualcosa da misurare", cut, 48)).not.toThrow();
    expect(measureLine("qualcosa da misurare", cut, 48)).toBeGreaterThan(0);
  });
});
