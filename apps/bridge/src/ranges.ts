// Shaping the ranges a detector produces into ranges it is safe to cut.
//
// Both detectors — silence by ear, stillness by eye — hand back raw boundaries, and raw boundaries
// make bad cuts: flush against the first word, or a two-frame sliver of "content" between two gaps
// that survives as a flash. The same two adjustments fix both, so they live here rather than being
// written twice and drifting apart.
//
// Pure functions on plain numbers, deliberately: this is the arithmetic that decides what gets
// deleted from someone's footage, and it should be provable without running ffmpeg.

export interface Range {
  startSeconds: number;
  endSeconds: number;
}

export interface ShapeOptions {
  /** Margin kept on each side, so a cut does not clip the attack of what follows it. */
  pad: number;
  /** Content shorter than this between two ranges is swallowed into the cut rather than surviving
   * as a flash-frame. A breath between two pauses; two moving frames between two still stretches. */
  minKeep: number;
  /** Length of the source, so a range that runs to the end is not padded away from it. */
  assetDur: number;
}

/**
 * Merge near-touching ranges, keep a margin around the content between them, and drop what is left
 * of anything too short to be worth a cut.
 *
 * Padding applies only to INTERIOR edges. A range starting at zero has nothing before it to protect,
 * and padding there just strands a sliver at the head of the clip that no later cut can reach.
 */
export function shapeRanges(raw: Range[], opts: ShapeOptions): Range[] {
  const { pad, minKeep, assetDur } = opts;
  const sorted = [...raw].sort((a, b) => a.startSeconds - b.startSeconds);

  const merged: Range[] = [];
  for (const r of sorted) {
    const prev = merged[merged.length - 1];
    if (prev && r.startSeconds - prev.endSeconds < minKeep) {
      prev.endSeconds = Math.max(prev.endSeconds, r.endSeconds);
    } else {
      merged.push({ ...r });
    }
  }

  return merged
    .map((r) => ({
      startSeconds: r.startSeconds <= 0.05 ? r.startSeconds : r.startSeconds + pad,
      endSeconds: r.endSeconds >= assetDur - 0.05 ? r.endSeconds : r.endSeconds - pad,
    }))
    .filter((r) => r.endSeconds - r.startSeconds > 0.05);
}

/**
 * The overlap of two sets of ranges — where both are true at once.
 *
 * Used to ask "still AND quiet". A motionless picture on its own is not dead air: it is also what a
 * person sitting very still looks like while they finish a sentence, and cutting on stillness alone
 * removes the sentence. Both inputs must be sorted and non-overlapping, which is what shapeRanges
 * returns.
 */
export function intersectRanges(a: Range[], b: Range[]): Range[] {
  const out: Range[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    const start = Math.max(a[i]!.startSeconds, b[j]!.startSeconds);
    const end = Math.min(a[i]!.endSeconds, b[j]!.endSeconds);
    if (end > start) out.push({ startSeconds: start, endSeconds: end });
    // Advance whichever ends first; the other may still overlap what comes next.
    if (a[i]!.endSeconds < b[j]!.endSeconds) i++;
    else j++;
  }
  return out;
}
