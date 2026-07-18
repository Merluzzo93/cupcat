// Rich text — per-substring styling of a text clip's textContent (Clip.styleRanges).
//
// One shared splitter feeds both renderers (web preview spans + export ASS override tags),
// so what the user sees in the preview is exactly what libass burns into the export.

import type { TextStyleRange } from "./types";

/** One contiguous run of textContent that shares a single set of style attributes. */
export interface TextSegment {
  text: string;
  color?: string;
  bold?: boolean;
  italic?: boolean;
  fontSizeScale?: number;
}

/** Split `text` into contiguous segments at every style-range boundary, each carrying the merged
 * attributes of all ranges covering it (later ranges in the array win on conflicting attributes).
 * Ranges are normalized first — clamped to the text, empty/reversed/non-numeric ones dropped,
 * order-independent — so stale offsets (e.g. after the text itself was edited) degrade to plain
 * text instead of throwing mid-render. */
export function splitStyleSegments(text: string, ranges?: TextStyleRange[]): TextSegment[] {
  if (!text) return [];
  const norm = (ranges ?? [])
    .filter((r) => Number.isFinite(r?.start) && Number.isFinite(r?.end))
    .map((r) => ({ ...r, start: Math.max(0, Math.trunc(r.start)), end: Math.min(text.length, Math.trunc(r.end)) }))
    .filter((r) => r.end > r.start);
  if (norm.length === 0) return [{ text }];
  // Elementary intervals between all boundaries — each is uniform, so attrs merge per interval.
  const cuts = [...new Set([0, text.length, ...norm.flatMap((r) => [r.start, r.end])])].sort((a, b) => a - b);
  const out: TextSegment[] = [];
  for (let i = 0; i < cuts.length - 1; i++) {
    const a = cuts[i]!;
    const b = cuts[i + 1]!;
    const seg: TextSegment = { text: text.slice(a, b) };
    for (const r of norm) {
      if (r.start > a || r.end < b) continue;
      if (r.color !== undefined) seg.color = r.color;
      if (r.bold !== undefined) seg.bold = r.bold;
      if (r.italic !== undefined) seg.italic = r.italic;
      if (r.fontSizeScale !== undefined) seg.fontSizeScale = r.fontSizeScale;
    }
    out.push(seg);
  }
  return out;
}
