// Multi-camera alignment: work out where each angle has to sit on the timeline so that the same
// instant of the real event lands on the same frame across every camera.
//
// The measuring is done elsewhere (audio-envelope correlation, shared with sync_audio); what lives
// here is the placement arithmetic, which is where the interesting mistake is. A camera that
// STARTED ROLLING FIRST has to begin BEFORE the reference on the timeline — at a negative frame,
// which does not exist. Clamping it to zero silently leaves that angle out of sync by however far
// it overshot, and nothing in the result says so. Instead the whole rig slides right by the worst
// overshoot: relative alignment is what matters, absolute position is not.

/** One camera as measured: `lagSamples` is null when its audio could not be matched. */
export interface AngleMeasurement {
  id: string;
  /** Envelope-sample lag vs the reference; positive = this angle started rolling earlier. */
  lagSamples: number | null;
  durationFrames: number;
  confidence?: number;
}

export interface AnglePlacement {
  id: string;
  startFrame: number;
  /** How far this angle moved relative to a naive "everything at zero" layout. */
  offsetFrames: number;
  durationFrames: number;
  aligned: boolean;
  confidence?: number;
}

/**
 * Turn measured lags into timeline starts.
 *
 * The reference is passed with `lagSamples: 0`. Angles that failed to match keep the reference's
 * start and are marked `aligned: false` — they stay on the timeline, because footage you can see
 * and nudge by hand beats footage that silently vanished, but the flag has to reach the user.
 */
export function planAnglePlacements(angles: AngleMeasurement[], fps: number, envRate: number): AnglePlacement[] {
  if (angles.length === 0) return [];
  const perSample = fps / envRate;
  // A camera whose sound arrives LATER in its own recording started earlier, so it begins further
  // left on the timeline: hence the negation.
  const raw = angles.map((a) => (a.lagSamples === null ? 0 : -a.lagSamples * perSample));
  const shift = -Math.min(0, ...raw);
  return angles.map((a, i) => ({
    id: a.id,
    startFrame: Math.max(0, Math.round(raw[i]! + shift)),
    offsetFrames: Math.round(raw[i]!),
    durationFrames: a.durationFrames,
    aligned: a.lagSamples !== null,
    ...(a.confidence === undefined ? {} : { confidence: a.confidence }),
  }));
}

/**
 * Which angle should the others align to?
 *
 * The longest one: it is the most likely to overlap every other camera, and an angle that overlaps
 * the reference by only a second or two gives correlation almost nothing to work with. Ties go to
 * the first, so the order the user picked their files in still means something.
 */
export function pickReference(angles: { id: string; durationFrames: number }[]): string | null {
  let best: { id: string; durationFrames: number } | null = null;
  for (const a of angles) {
    if (!best || a.durationFrames > best.durationFrames) best = a;
  }
  return best?.id ?? null;
}

/** Human-readable seconds for a frame offset, signed, so a report reads like a person wrote it. */
export function offsetLabel(frames: number, fps: number): string {
  if (frames === 0) return "0s";
  const s = frames / fps;
  return `${s > 0 ? "+" : ""}${(Math.round(s * 1000) / 1000).toFixed(3)}s`;
}
