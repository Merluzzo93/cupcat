// How wide is this line, really?
//
// Three different engines draw CupCat's text — the browser in the preview, ffmpeg's drawtext for
// plain text, libass for karaoke and rich text — and each one breaks long lines its own way. That
// is why a caption looked right while playing and ran off both edges of the exported file: the
// preview wrapped it inside the clip's box, drawtext does not wrap at all, and libass wraps at a
// width of its own choosing. Measured on a real caption: 1276 px of text across a 1280 px frame.
//
// The fix is to stop asking any of them. Line breaks are decided HERE, from the font's own advance
// widths, and written into the text as real newlines; every engine then draws the same lines because
// there is nothing left for it to decide.
//
// Reading advance widths means reading the font file: `head` for unitsPerEm, `maxp` for the glyph
// count, `hhea`+`hmtx` for the advances and `cmap` to get from a character to its glyph. Kerning is
// not applied — it is a fraction of a percent on the strings captions are made of, and it can only
// make the real line NARROWER than the estimate, which is the safe direction to be wrong in.

import { existsSync, readFileSync } from "node:fs";

const FONT = process.env.CUPCAT_FONT ?? "C:/Windows/Fonts/arialbd.ttf";

// Map a text clip's fontName (from the editor's font picker) to a Windows system font file.
// Every path below was verified to ship with Windows 10/11; fontFileFor still stats the file at
// first use so a stripped-down install degrades to the default font instead of failing drawtext.
const FONT_FILES: Record<string, string> = {
  "Helvetica-Bold": "C:/Windows/Fonts/arialbd.ttf",
  Arial: "C:/Windows/Fonts/arial.ttf",
  Georgia: "C:/Windows/Fonts/georgia.ttf",
  "Times New Roman": "C:/Windows/Fonts/times.ttf",
  Verdana: "C:/Windows/Fonts/verdana.ttf",
  "Trebuchet MS": "C:/Windows/Fonts/trebuc.ttf",
  "Courier New": "C:/Windows/Fonts/cour.ttf",
  Impact: "C:/Windows/Fonts/impact.ttf",
  "Comic Sans MS": "C:/Windows/Fonts/comic.ttf",
  "Segoe UI": "C:/Windows/Fonts/segoeui.ttf",
  "Segoe UI Semibold": "C:/Windows/Fonts/seguisb.ttf",
  Bahnschrift: "C:/Windows/Fonts/bahnschrift.ttf",
  Candara: "C:/Windows/Fonts/Candara.ttf",
  Consolas: "C:/Windows/Fonts/consola.ttf",
  Constantia: "C:/Windows/Fonts/constan.ttf",
  Corbel: "C:/Windows/Fonts/corbel.ttf",
};
// Existence cache: one stat per font file per process — the export must never hand ffmpeg a
// missing fontfile (drawtext aborts the whole render).
const fontFileSeen = new Map<string, boolean>();

/** The file behind a font name from the picker, falling back to the default face. */
export function fontFileFor(name?: string): string {
  const mapped = name ? FONT_FILES[name] : undefined;
  if (!mapped) return FONT;
  let ok = fontFileSeen.get(mapped);
  if (ok === undefined) {
    try {
      ok = existsSync(mapped);
    } catch {
      ok = false;
    }
    fontFileSeen.set(mapped, ok);
  }
  return ok ? mapped : FONT;
}

interface FontMetrics {
  unitsPerEm: number;
  /** glyph id → advance width in font units */
  advance: (glyph: number) => number;
  /** code point → glyph id (0 = missing) */
  glyph: (cp: number) => number;
}

const cache = new Map<string, FontMetrics | null>();

function tag(buf: Buffer, off: number): string {
  return String.fromCharCode(buf[off]!, buf[off + 1]!, buf[off + 2]!, buf[off + 3]!);
}

/** The (3,1) Windows BMP subtable is what every font in the picker has; (3,10) and (0,x) are
 * accepted as fallbacks so an unusual font still measures instead of silently going unwrapped. */
function pickCmap(buf: Buffer, base: number): number | null {
  const n = buf.readUInt16BE(base + 2);
  let best: { score: number; off: number } | null = null;
  for (let i = 0; i < n; i++) {
    const rec = base + 4 + i * 8;
    const platform = buf.readUInt16BE(rec);
    const encoding = buf.readUInt16BE(rec + 2);
    const off = base + buf.readUInt32BE(rec + 4);
    const score = platform === 3 && encoding === 1 ? 3 : platform === 3 && encoding === 10 ? 2 : platform === 0 ? 1 : 0;
    if (score > 0 && (!best || score > best.score)) best = { score, off };
  }
  return best?.off ?? null;
}

function readFont(path: string): FontMetrics | null {
  const buf = readFileSync(path);
  // TrueType outlines (0x00010000) and CFF ones ("OTTO") both carry head/hhea/hmtx/cmap, which is
  // all this needs; a font collection ("ttcf") is not handled and falls back to estimation.
  const kind = buf.readUInt32BE(0);
  if (kind !== 0x00010000 && tag(buf, 0) !== "OTTO") return null;

  const numTables = buf.readUInt16BE(4);
  const tables = new Map<string, { off: number; len: number }>();
  for (let i = 0; i < numTables; i++) {
    const rec = 12 + i * 16;
    tables.set(tag(buf, rec), { off: buf.readUInt32BE(rec + 8), len: buf.readUInt32BE(rec + 12) });
  }
  const head = tables.get("head");
  const hhea = tables.get("hhea");
  const hmtx = tables.get("hmtx");
  const maxp = tables.get("maxp");
  const cmap = tables.get("cmap");
  if (!head || !hhea || !hmtx || !maxp || !cmap) return null;

  const unitsPerEm = buf.readUInt16BE(head.off + 18);
  const numGlyphs = buf.readUInt16BE(maxp.off + 4);
  const numHMetrics = buf.readUInt16BE(hhea.off + 34);
  if (unitsPerEm <= 0 || numHMetrics === 0) return null;

  // hmtx holds numHMetrics (advance, lsb) pairs; every glyph after that reuses the last advance —
  // how monospaced tails are stored.
  const lastAdvance = buf.readUInt16BE(hmtx.off + (numHMetrics - 1) * 4);
  const advance = (g: number): number => {
    if (g < 0 || g >= numGlyphs) return lastAdvance;
    return g < numHMetrics ? buf.readUInt16BE(hmtx.off + g * 4) : lastAdvance;
  };

  const sub = pickCmap(buf, cmap.off);
  if (sub === null) return null;
  const format = buf.readUInt16BE(sub);

  let glyph: (cp: number) => number;
  if (format === 4) {
    const segX2 = buf.readUInt16BE(sub + 6);
    const seg = segX2 / 2;
    const endO = sub + 14;
    const startO = endO + segX2 + 2;
    const deltaO = startO + segX2;
    const rangeO = deltaO + segX2;
    glyph = (cp) => {
      if (cp > 0xffff) return 0;
      for (let i = 0; i < seg; i++) {
        if (buf.readUInt16BE(endO + i * 2) < cp) continue;
        const start = buf.readUInt16BE(startO + i * 2);
        if (start > cp) return 0;
        const delta = buf.readInt16BE(deltaO + i * 2);
        const rangeOffset = buf.readUInt16BE(rangeO + i * 2);
        if (rangeOffset === 0) return (cp + delta) & 0xffff;
        const at = rangeO + i * 2 + rangeOffset + (cp - start) * 2;
        if (at + 1 >= buf.length) return 0;
        const g = buf.readUInt16BE(at);
        return g === 0 ? 0 : (g + delta) & 0xffff;
      }
      return 0;
    };
  } else if (format === 12) {
    const nGroups = buf.readUInt32BE(sub + 12);
    glyph = (cp) => {
      let lo = 0;
      let hi = nGroups - 1;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        const g = sub + 16 + mid * 12;
        const s = buf.readUInt32BE(g);
        const e = buf.readUInt32BE(g + 4);
        if (cp < s) hi = mid - 1;
        else if (cp > e) lo = mid + 1;
        else return buf.readUInt32BE(g + 8) + (cp - s);
      }
      return 0;
    };
  } else {
    return null;
  }

  return { unitsPerEm, advance, glyph };
}

function metrics(fontFile: string): FontMetrics | null {
  const hit = cache.get(fontFile);
  if (hit !== undefined) return hit;
  let m: FontMetrics | null = null;
  try {
    m = readFont(fontFile);
  } catch {
    m = null; // an unreadable font must never take an export down with it
  }
  cache.set(fontFile, m);
  return m;
}

/** Rough fallback when the font cannot be read: the mean advance of Latin text is close to 0.5 em
 * for regular faces and a little more for bold. Only ever used to avoid crashing on an exotic font. */
const FALLBACK_EM = 0.55;

/** Width of `text` in pixels at `fontSizePx`. Newlines are not handled here — measure a line. */
export function measureLine(text: string, fontFile: string, fontSizePx: number): number {
  const m = metrics(fontFile);
  if (!m) return text.length * fontSizePx * FALLBACK_EM;
  try {
    let units = 0;
    for (const ch of text) units += m.advance(m.glyph(ch.codePointAt(0)!));
    return (units / m.unitsPerEm) * fontSizePx;
  } catch {
    // The lookups above read the font lazily, so a truncated or malformed table only shows up here,
    // long after the file parsed. Estimating is a worse answer than measuring; taking an export down
    // over a font is a worse answer than either.
    return text.length * fontSizePx * FALLBACK_EM;
  }
}

export interface WrapOptions {
  fontFile: string;
  fontSizePx: number;
  /** Pixels available for one line. */
  maxWidthPx: number;
  /** Hard ceiling on lines; the text is NOT truncated when it needs more — `overflow` says so. */
  maxLines?: number;
}

export interface WrapResult {
  lines: string[];
  /** The widest line, in pixels — what a caller checks against the box. */
  widestPx: number;
  /** True when the text needed more lines than `maxLines`; the caller decides what to do (captions
   * split the cue in two rather than shrink or clip). */
  overflow: boolean;
}

/**
 * Break `text` into lines that fit `maxWidthPx`.
 *
 * Existing newlines are honoured as hard breaks — a line the user wrote is a line they meant.
 * Two-line results are rebalanced, because "a full line and one orphan word" is the layout that
 * reads worst and it is the one greedy filling always produces.
 */
export function wrapText(text: string, opts: WrapOptions): WrapResult {
  const { fontFile, fontSizePx, maxWidthPx } = opts;
  const width = (s: string) => measureLine(s, fontFile, fontSizePx);
  const out: string[] = [];

  for (const hard of text.split(/\r?\n/)) {
    const words = hard.split(/\s+/).filter((w) => w !== "");
    if (words.length === 0) {
      out.push("");
      continue;
    }
    const lines: string[] = [];
    let cur = "";
    for (const w of words) {
      const candidate = cur === "" ? w : `${cur} ${w}`;
      if (cur !== "" && width(candidate) > maxWidthPx) {
        lines.push(cur);
        cur = w;
      } else {
        cur = candidate;
      }
      // A single word wider than the box (a URL, a long compound) still has to go somewhere: break
      // it by characters rather than let it run off the frame.
      while (width(cur) > maxWidthPx && cur.length > 1) {
        let cut = cur.length - 1;
        while (cut > 1 && width(cur.slice(0, cut)) > maxWidthPx) cut--;
        lines.push(cur.slice(0, cut));
        cur = cur.slice(cut);
      }
    }
    if (cur !== "") lines.push(cur);
    out.push(...(lines.length === 2 ? rebalance(lines[0]!, lines[1]!, width, maxWidthPx) : lines));
  }

  const widestPx = out.reduce((n, l) => Math.max(n, width(l)), 0);
  return { lines: out, widestPx, overflow: opts.maxLines !== undefined && out.length > opts.maxLines };
}

/** Fraction of the frame width a caption is allowed to occupy. */
export const CAPTION_BOX = 0.9;
/** Subtitle practice everywhere: never more than two lines at once. A third line covers the shot. */
export const CAPTION_MAX_LINES = 2;

/**
 * A spoken segment laid out as one or more cues that fit the caption box.
 *
 * Whisper hands back whole sentences, and a sentence does not fit on a line: the export used to draw
 * one straight across the frame and off both edges. Lines are decided here, from the font's real
 * advance widths, and written into the cue as newlines — so the preview, drawtext and libass all
 * draw the same two lines instead of each guessing. When even two lines cannot hold the sentence it
 * becomes two cues, which is what a subtitler would do; shrinking the type or letting it spill are
 * the two things that are never right.
 */
export function layoutCaption(text: string, opts: Omit<WrapOptions, "maxLines">): string[] {
  const full = { ...opts, maxLines: CAPTION_MAX_LINES };
  const whole = wrapText(text, full);
  if (!whole.overflow) return [whole.lines.join("\n")];

  const words = text.split(/\s+/).filter((w) => w !== "");
  const cues: string[] = [];
  let cur: string[] = [];
  for (const w of words) {
    const next = [...cur, w];
    if (cur.length > 0 && wrapText(next.join(" "), full).overflow) {
      cues.push(wrapText(cur.join(" "), full).lines.join("\n"));
      cur = [w];
    } else {
      cur = next;
    }
  }
  if (cur.length > 0) cues.push(wrapText(cur.join(" "), full).lines.join("\n"));
  return cues.length > 0 ? cues : [whole.lines.join("\n")];
}

/** Move the break of a two-line block to wherever the two halves come out closest in width, as long
 * as both still fit. Greedy wrapping leaves "…………………… word"; this leaves two even lines. */
function rebalance(a: string, b: string, width: (s: string) => number, maxWidthPx: number): string[] {
  const words = `${a} ${b}`.split(" ");
  let best: { lines: string[]; diff: number } | null = null;
  for (let i = 1; i < words.length; i++) {
    const l1 = words.slice(0, i).join(" ");
    const l2 = words.slice(i).join(" ");
    const w1 = width(l1);
    const w2 = width(l2);
    if (w1 > maxWidthPx || w2 > maxWidthPx) continue;
    const diff = Math.abs(w1 - w2);
    if (!best || diff < best.diff) best = { lines: [l1, l2], diff };
  }
  return best?.lines ?? [a, b];
}
