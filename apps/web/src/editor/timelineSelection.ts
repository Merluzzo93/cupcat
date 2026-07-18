// Pure selection logic for the Timeline: marquee hit-testing, shift-click range selection and
// pointer-down selection semantics. Kept free of React/DOM so it can be unit-tested
// (timelineSelection.test.ts) — Timeline.tsx only converts pixels to these coordinates.

/** The clip fields the selection math needs (structural subset of editor-core's Clip). */
export interface ClipSpan {
  id: string;
  startFrame: number;
  durationFrames: number;
}

/** Marquee rectangle in timeline coordinates: x in FRAMES, y in PIXELS from the tracks-area top. */
export interface MarqueeRect {
  x1: number; // left (frames)
  x2: number; // right (frames)
  y1: number; // top (px)
  y2: number; // bottom (px)
}

/**
 * Every clip intersecting the marquee. A track row [ti*trackH, (ti+1)*trackH] counts when the
 * rect's vertical span touches it; a clip counts when its [start, end) frame range STRICTLY
 * overlaps the rect's frame range — strict so a zero-width click on empty lane selects nothing
 * (that's the "click empty area clears selection" gesture).
 */
export function marqueeHitIds(tracks: { clips: ClipSpan[] }[], rect: MarqueeRect, trackH: number): string[] {
  const hits: string[] = [];
  tracks.forEach((track, ti) => {
    const rowTop = ti * trackH;
    const rowBottom = rowTop + trackH;
    if (rect.y2 < rowTop || rect.y1 > rowBottom) return;
    for (const clip of track.clips) {
      if (clip.startFrame < rect.x2 && clip.startFrame + clip.durationFrames > rect.x1) hits.push(clip.id);
    }
  });
  return hits;
}

/**
 * Shift-click range on ONE track: every clip between anchor and target in TIME ORDER (inclusive,
 * input order irrelevant). Falls back to just the target when the anchor isn't on this track — a
 * cross-track "range" has no obvious meaning, so we don't invent one. Empty when the target is
 * unknown (defensive: a stale id must never wipe the selection).
 */
export function rangeOnTrack(clips: ClipSpan[], anchorId: string, targetId: string): string[] {
  const ordered = [...clips].sort((a, b) => a.startFrame - b.startFrame);
  const ai = ordered.findIndex((c) => c.id === anchorId);
  const ti = ordered.findIndex((c) => c.id === targetId);
  if (ti < 0) return [];
  if (ai < 0) return [targetId];
  const [lo, hi] = ai <= ti ? [ai, ti] : [ti, ai];
  return ordered.slice(lo, hi + 1).map((c) => c.id);
}

export interface ClipClick {
  current: string[]; // selection before the click
  clickedId: string;
  additive: boolean; // Ctrl/Cmd held → toggle membership
  range: boolean; // Shift held → range on the clicked clip's track
  trackClips: ClipSpan[]; // clips on the clicked clip's track (for shift ranges)
}

/**
 * Selection resulting from a pointer-down on a clip (Timeline.beginDrag). Plain click on a clip
 * already inside a multi-selection KEEPS the selection — that's how a group drag starts; the
 * collapse-to-one happens on pointer-up only when no drag followed (handled by the caller, which
 * knows whether the pointer moved).
 */
export function nextClipSelection(click: ClipClick): string[] {
  const { current, clickedId, additive, range, trackClips } = click;
  if (additive) {
    return current.includes(clickedId) ? current.filter((x) => x !== clickedId) : [...current, clickedId];
  }
  if (range) {
    // Anchor = the most recently selected clip on the same track. Union with the existing
    // selection so a shift-range never silently drops picks made on other tracks.
    const onTrack = new Set(trackClips.map((c) => c.id));
    const anchor = [...current].reverse().find((id) => onTrack.has(id));
    const span = anchor ? rangeOnTrack(trackClips, anchor, clickedId) : [clickedId];
    return [...new Set([...current, ...span])];
  }
  return current.includes(clickedId) ? current : [clickedId];
}
