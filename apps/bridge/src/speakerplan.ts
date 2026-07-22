// Turning speaker turns into timeline edits.
//
// Turns are measured in SOURCE seconds — where the words are inside the file. A clip on the timeline
// shows a window of that source, possibly trimmed at both ends and possibly sped up. Every mistake
// in this file looks harmless and lands the cut in the wrong place, so the mapping lives here on its
// own, in plain arithmetic, with tests.

export interface Turn {
  speaker: string;
  startSeconds: number;
  endSeconds: number;
}

export interface ClipWindow {
  startFrame: number;
  durationFrames: number;
  trimStartFrame: number;
  speed: number;
  fps: number;
}

const spd = (w: ClipWindow) => (w.speed > 0 ? w.speed : 1);

/** Source second → timeline frame, for a clip that may be trimmed and sped up. */
export function sourceToTimeline(sourceSeconds: number, w: ClipWindow): number {
  const srcStart = w.trimStartFrame / w.fps;
  return w.startFrame + ((sourceSeconds - srcStart) * w.fps) / spd(w);
}

/** Timeline frame → source second: the inverse, used to ask "who is talking in this piece?". */
export function timelineToSource(frame: number, w: ClipWindow): number {
  const srcStart = w.trimStartFrame / w.fps;
  return srcStart + ((frame - w.startFrame) * spd(w)) / w.fps;
}

/** Whoever is speaking at a source second, or null in a gap between turns. */
export function speakerAtSource(turns: Turn[], sourceSeconds: number): string | null {
  for (const t of turns) {
    if (sourceSeconds >= t.startSeconds && sourceSeconds < t.endSeconds) return t.speaker;
  }
  return null;
}

/**
 * Frames at which to cut a clip so that no resulting piece contains two different speakers.
 *
 * Only boundaries STRICTLY inside the clip are returned: a cut on the clip's own edge splits
 * nothing and the split command rejects it. Sub-frame boundaries land on the same frame after
 * rounding, so the result is deduplicated — otherwise a rapid exchange would ask for the same cut
 * several times and the second one would fail.
 */
export function splitFramesForTurns(turns: Turn[], w: ClipWindow): number[] {
  const lo = w.startFrame;
  const hi = w.startFrame + w.durationFrames;
  const frames = new Set<number>();
  for (const t of turns) {
    for (const s of [t.startSeconds, t.endSeconds]) {
      const f = Math.round(sourceToTimeline(s, w));
      if (f > lo && f < hi) frames.add(f);
    }
  }
  return [...frames].sort((a, b) => a - b);
}

/**
 * Which speaker owns each piece, judged at the piece's MIDPOINT.
 *
 * The midpoint rather than the start: rounding a boundary to a whole frame can leave a piece
 * starting a hair before its speaker does, and reading the label there would attribute the piece to
 * the previous speaker — an off-by-one-frame error that silently mislabels the whole piece.
 */
export function assignPieces(
  pieces: { id: string; startFrame: number; durationFrames: number }[],
  turns: Turn[],
  w: ClipWindow,
): { id: string; speaker: string | null }[] {
  return pieces.map((p) => ({
    id: p.id,
    speaker: speakerAtSource(turns, timelineToSource(p.startFrame + p.durationFrames / 2, w)),
  }));
}

/** Speakers in the order they first talk — the order their tracks and colours follow. */
export function speakerOrder(turns: Turn[]): string[] {
  const seen: string[] = [];
  for (const t of [...turns].sort((a, b) => a.startSeconds - b.startSeconds)) {
    if (!seen.includes(t.speaker)) seen.push(t.speaker);
  }
  return seen;
}
