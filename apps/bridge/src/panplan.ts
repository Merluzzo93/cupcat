// Putting each voice where its owner is standing.
//
// On a two-shot, a panel or a stage recording, everybody's voice comes out of the middle. A mixer
// fixes that by hand: find where each person is in frame, pan their lines that way, and a
// conversation stops sounding like a conference call. The information needed to do it automatically
// is already in the project — diarization says who is talking when, and the face detector plus the
// mouth-motion pass say which face on screen is theirs.
//
// Two decisions here matter more than the arithmetic:
//
//   The amount is capped well short of hard left/right. Panning a voice fully to one side is
//   unpleasant on headphones, disappears on a phone held sideways, and collapses to a level
//   imbalance in mono. Broadcast dialogue is panned gently — enough to place the voice, not enough
//   to be noticed as an effect. The default here is 0.5 of the way, with a dead zone in the middle
//   so that somebody standing near the centre stays centred instead of wobbling.
//
//   Position is decided per SPEAKER, not per turn. Faces are found by a heuristic that sometimes
//   refuses to answer; taking the median of every answer it did give for one person is steady, where
//   per-turn positions jump around whenever a single measurement goes astray.

/** Where somebody is, and how sure we are: 0 = left edge of frame, 1 = right edge. */
export interface ScreenPosition {
  speaker: string;
  x: number;
  /** How many turns that measurement came from. One is a guess; ten is a position. */
  samples: number;
  /** Median distance of the looks from the median — how much they agreed. 0 with a single look. */
  spread: number;
}

export interface PanSegment {
  startSeconds: number;
  endSeconds: number;
  /** −1 hard left … 0 centre … +1 hard right. Already capped by `strength`. */
  pan: number;
  speaker?: string;
}

/**
 * Screen position → pan.
 *
 * The dead zone is the useful part: three people at 0.48, 0.50 and 0.52 of the frame are, to an ear,
 * all in the middle, and panning them to three different places is an effect rather than a
 * placement. Outside it the mapping is linear up to the cap.
 */
export function panForX(x: number, strength = 0.5, deadZone = 0.08): number {
  const clamped = Math.max(0, Math.min(1, x));
  const off = clamped - 0.5;
  const beyond = Math.abs(off) - deadZone / 2;
  if (beyond <= 0) return 0;
  const scale = 0.5 - deadZone / 2;
  const norm = Math.min(1, beyond / scale);
  return Math.sign(off) * norm * Math.max(0, Math.min(1, strength));
}

const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
};

/** The median x for each speaker — steady where a single measurement is not — plus how much the
 *  looks agreed, because the median of two answers that disagree is a number nobody measured. */
export function positionsFrom(samples: { speaker: string; x: number }[]): ScreenPosition[] {
  const by = new Map<string, number[]>();
  for (const s of samples) {
    if (!by.has(s.speaker)) by.set(s.speaker, []);
    by.get(s.speaker)!.push(s.x);
  }
  return [...by.entries()]
    .map(([speaker, xs]) => {
      const x = median(xs);
      return { speaker, x, samples: xs.length, spread: median(xs.map((v) => Math.abs(v - x))) };
    })
    .sort((a, b) => a.x - b.x);
}

/**
 * Positions solid enough to act on.
 *
 * The thresholds come from running this on a real event recording rather than from taste. A crowded
 * room gave the face detector up to nine faces at once and the mouth-motion pass no clear winner
 * most of the time; what survived was two looks, ninety seconds apart, that happened to agree on a
 * bystander — and the camera had reframed in between, so even an honest pair of looks described two
 * different shots. It rendered a confident, wrong mix.
 *
 * Hence three looks, not two. On the footage this is meant for — a fixed camera, two or three people
 * in frame — the pass succeeds nearly every time and three is met comfortably. On footage it is not
 * meant for, it refuses, which is the answer: a voice panned onto a stranger's shoulder is a defect
 * the user has to catch by ear, while a refusal names what went wrong.
 */
export function reliablePositions(
  positions: ScreenPosition[],
  o: { minLooks?: number; maxSpread?: number } = {},
): { kept: ScreenPosition[]; rejected: { speaker: string; why: string }[] } {
  const minLooks = Math.max(1, o.minLooks ?? 3);
  const maxSpread = o.maxSpread ?? 0.12;
  const kept: ScreenPosition[] = [];
  const rejected: { speaker: string; why: string }[] = [];
  for (const p of positions) {
    if (p.samples < minLooks) rejected.push({ speaker: p.speaker, why: `only ${p.samples} usable look${p.samples === 1 ? "" : "s"} — a guess, not a position` });
    else if (p.spread > maxSpread) rejected.push({ speaker: p.speaker, why: `the looks disagreed by ${(p.spread * 100).toFixed(0)}% of the frame` });
    else kept.push(p);
  }
  return { kept, rejected };
}

export interface PanPlanOptions {
  startSeconds: number;
  endSeconds: number;
  strength?: number;
  deadZone?: number;
  /** Turns shorter than this keep the previous pan (default 0.4s) — a pan that lands and leaves
   *  inside a word is heard as a wobble, not as a placement. */
  minTurnSeconds?: number;
  /** A gap shorter than this is a breath and keeps the speaker's pan (default 1s). */
  minSilenceSeconds?: number;
}

/**
 * The pan over time: one value per stretch of speech, centred wherever nobody identifiable is
 * talking.
 *
 * Silences deliberately return to centre rather than holding the last speaker's pan. Room tone,
 * music and applause belong in the middle, and holding a pan through them drags the whole scene to
 * one side for as long as nobody speaks.
 */
export function planPan(
  turns: { speaker: string; startSeconds: number; endSeconds: number }[],
  positions: ScreenPosition[],
  o: PanPlanOptions,
): PanSegment[] {
  const from = o.startSeconds;
  const to = o.endSeconds;
  if (!(to > from)) throw new Error("The window to pan is empty.");
  const minTurn = Math.max(0, o.minTurnSeconds ?? 0.4);
  const panOf = new Map(positions.map((p) => [p.speaker, panForX(p.x, o.strength ?? 0.5, o.deadZone ?? 0.08)]));

  const spoken = turns
    .filter((t) => panOf.has(t.speaker) && t.endSeconds > from && t.startSeconds < to)
    .map((t) => ({ speaker: t.speaker, startSeconds: Math.max(from, t.startSeconds), endSeconds: Math.min(to, t.endSeconds) }))
    .filter((t) => t.endSeconds - t.startSeconds >= minTurn)
    .sort((a, b) => a.startSeconds - b.startSeconds);

  // Overlaps are resolved by whoever started first keeping the floor until they stop. Two voices
  // cannot be panned two ways in one mix — this is one stereo bus, not stems — so the alternative
  // would be to pick a winner mid-word, which is audible.
  const out: PanSegment[] = [];
  let cursor = from;
  for (const t of spoken) {
    const start = Math.max(cursor, t.startSeconds);
    if (t.endSeconds <= start) continue;
    if (start > cursor) out.push({ startSeconds: cursor, endSeconds: start, pan: 0 });
    out.push({ startSeconds: start, endSeconds: t.endSeconds, pan: panOf.get(t.speaker)!, speaker: t.speaker });
    cursor = t.endSeconds;
  }
  if (cursor < to) out.push({ startSeconds: cursor, endSeconds: to, pan: 0 });

  // A breath between two sentences is not a return to centre. Without this, the pause a person
  // leaves between their own two sentences swings the mix to the middle and back inside a second,
  // which is heard as a wobble — the same mistake the minimum-turn rule exists to prevent, arriving
  // from the other direction.
  const breath = Math.max(0, o.minSilenceSeconds ?? 1);
  const held: PanSegment[] = [];
  for (let i = 0; i < out.length; i++) {
    const s = out[i]!;
    const prev = held[held.length - 1];
    const next = out[i + 1];
    if (s.speaker === undefined && prev && next && s.endSeconds - s.startSeconds < breath) {
      prev.endSeconds = s.endSeconds;
      continue;
    }
    held.push({ ...s });
  }

  // Neighbouring stretches at the same pan are one stretch: two consecutive turns by the same person
  // are not two placements, and every extra breakpoint is another term in the filter expression.
  const merged: PanSegment[] = [];
  for (const s of held) {
    const last = merged[merged.length - 1];
    if (last && last.pan === s.pan && last.endSeconds === s.startSeconds) {
      last.endSeconds = s.endSeconds;
      if (last.speaker !== s.speaker) delete last.speaker;
    } else merged.push({ ...s });
  }
  return merged;
}

/** Constant-power gains for a pan: equal loudness whichever way the voice is placed. */
export function panGains(pan: number): { left: number; right: number } {
  const p = Math.max(-1, Math.min(1, pan));
  const angle = ((p + 1) * Math.PI) / 4;
  return { left: Math.cos(angle), right: Math.sin(angle) };
}

export interface GainPoint {
  t: number;
  gain: number;
}

/**
 * The gain curve for one channel: flat through each stretch, ramped across each change.
 *
 * A pan that steps instantly is heard as a click when it lands mid-sentence, so every change gets a
 * short ramp centred on the boundary. The ramp is centred rather than trailing so the voice arrives
 * in its place at the moment the person starts, instead of sliding there afterwards.
 */
export function gainPoints(segments: PanSegment[], channel: "left" | "right", rampSeconds = 0.12): GainPoint[] {
  if (segments.length === 0) return [];
  const g = (s: PanSegment) => panGains(s.pan)[channel];
  const pts: GainPoint[] = [{ t: segments[0]!.startSeconds, gain: g(segments[0]!) }];
  for (let i = 1; i < segments.length; i++) {
    const b = segments[i]!;
    const prev = segments[i - 1]!;
    if (g(prev) === g(b)) continue;
    // Never let a ramp run past either neighbour's own length, or two ramps overlap and the curve
    // stops passing through the values it is supposed to hold.
    const room = Math.min(prev.endSeconds - prev.startSeconds, b.endSeconds - b.startSeconds) / 2;
    const half = Math.max(0.001, Math.min(rampSeconds, room) / 2);
    pts.push({ t: b.startSeconds - half, gain: g(prev) }, { t: b.startSeconds + half, gain: g(b) });
  }
  const last = segments[segments.length - 1]!;
  pts.push({ t: last.endSeconds, gain: g(last) });
  // Strictly increasing in t: ffmpeg reads the terms in order and a zero- or negative-width ramp
  // would divide by zero building the slope.
  const clean: GainPoint[] = [];
  for (const p of pts) {
    const prev = clean[clean.length - 1];
    if (prev && p.t <= prev.t) {
      prev.gain = p.gain;
      continue;
    }
    clean.push({ ...p });
  }
  return clean;
}

/**
 * A piecewise-linear curve as one ffmpeg expression.
 *
 * Written as a starting level plus a sum of clipped ramps: `clip(t-t0,0,w)` is zero before the ramp,
 * rises through it, and stays at its full width after — so adding one term per breakpoint builds the
 * whole curve without a single conditional. The obvious alternative, nested `if(lt(t,…))`, nests as
 * deep as there are segments and becomes unreadable and slow at the length a real conversation
 * produces.
 */
export function gainExpression(points: GainPoint[]): string {
  if (points.length === 0) return "1";
  if (points.length === 1) return points[0]!.gain.toFixed(4);
  const terms: string[] = [points[0]!.gain.toFixed(4)];
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]!;
    const b = points[i]!;
    const width = b.t - a.t;
    if (width <= 0) continue;
    const slope = (b.gain - a.gain) / width;
    if (Math.abs(slope) < 1e-6) continue;
    terms.push(`${slope.toFixed(6)}*clip(t-${a.t.toFixed(3)},0,${width.toFixed(3)})`);
  }
  return terms.join("+");
}
