// Punching in on whoever is talking.
//
// Diarization says WHEN each person speaks. When several faces are in shot it does not say WHICH of
// them it is, and that is a genuinely open problem (active speaker detection). The published models
// — Light-ASD, TalkNet — have no ONNX build to bundle, so this uses the idea underneath them without
// the network: the person talking is the one whose MOUTH is moving. Face positions come from the
// detector we already ship; the mouth region is the lower middle of the face box; the score is how
// much that region changes from frame to frame, measured against the movement of the whole picture
// so that a pan or a cut does not hand the win to everybody at once.
//
// It is a heuristic and it is treated as one: when the winner is not clearly ahead of the runner-up,
// the caller is told the choice is uncertain instead of being given a confident wrong answer.

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** The mouth: lower-middle of the face box. Narrower than the box so a moving shoulder or a hand
 * near the chin does not read as speech. */
export function mouthRegion(b: Box): Box {
  return {
    x: b.x + b.w * 0.25,
    y: b.y + b.h * 0.58,
    w: b.w * 0.5,
    h: b.h * 0.32,
  };
}

/** Mean absolute difference inside a region between two grayscale frames of the same size. */
export function regionMotion(a: Uint8Array, b: Uint8Array, width: number, height: number, r: Box): number {
  const x0 = Math.max(0, Math.min(width - 1, Math.round(r.x * width)));
  const x1 = Math.max(x0 + 1, Math.min(width, Math.round((r.x + r.w) * width)));
  const y0 = Math.max(0, Math.min(height - 1, Math.round(r.y * height)));
  const y1 = Math.max(y0 + 1, Math.min(height, Math.round((r.y + r.h) * height)));
  let sum = 0;
  let n = 0;
  for (let y = y0; y < y1; y++) {
    const row = y * width;
    for (let x = x0; x < x1; x++) {
      sum += Math.abs((a[row + x] ?? 0) - (b[row + x] ?? 0));
      n++;
    }
  }
  return n > 0 ? sum / n : 0;
}

export interface SpeakingScore {
  index: number;
  score: number;
}

/**
 * Rank candidate faces by how much their mouths moved, relative to the picture as a whole.
 *
 * Dividing by the frame's own motion is what makes this survive a handheld shot or a cut: those
 * move every mouth region equally, so they cancel instead of scoring everyone highly.
 */
export function rankSpeakers(mouthMotion: number[][], frameMotion: number[]): SpeakingScore[] {
  const scores: SpeakingScore[] = [];
  for (let i = 0; i < mouthMotion.length; i++) {
    const series = mouthMotion[i] ?? [];
    let total = 0;
    let n = 0;
    for (let k = 0; k < series.length; k++) {
      const base = Math.max(1, frameMotion[k] ?? 1);
      total += (series[k] ?? 0) / base;
      n++;
    }
    scores.push({ index: i, score: n > 0 ? total / n : 0 });
  }
  return scores.sort((a, b) => b.score - a.score);
}

/**
 * Is the top-ranked face a clear winner?
 *
 * Two faces within a whisker of each other means the measurement did not actually decide — a still
 * listener and a talker score far apart, so a near-tie is a signal that something (an off-screen
 * voice, everyone nodding, a face too small to measure) has defeated the method. Saying so beats
 * punching in on the wrong person.
 */
export function isConfident(ranked: SpeakingScore[], margin = 1.25): boolean {
  if (ranked.length === 0) return false;
  if (ranked.length === 1) return ranked[0]!.score > 0;
  const top = ranked[0]!.score;
  const next = ranked[1]!.score;
  if (top <= 0) return false;
  return next <= 0 ? true : top / next >= margin;
}

/**
 * Scale and top-left position that frame a face, as a fraction of the canvas.
 *
 * `zoom` is how much of the frame height the face should end up occupying. The window is clamped
 * inside the canvas rather than allowed to hang off an edge, because a crop that runs past the
 * picture shows black — and it is clamped by MOVING the window, not by shrinking it, so the
 * requested magnification is what you actually get.
 */
export function framingFor(face: Box, zoom: number): { scale: number; x: number; y: number } {
  const target = Math.max(0.05, Math.min(0.9, zoom));
  // How much bigger the picture has to be for the face to occupy `target` of the height.
  const scale = Math.max(1, Math.min(6, face.h > 0 ? target / face.h : 1));
  // Centre of the face, then the window that centres on it, in canvas fractions AFTER scaling.
  const cx = face.x + face.w / 2;
  const cy = face.y + face.h / 2;
  // Head-room: aim slightly above centre so the face is not dead-centre like a passport photo.
  const aim = Math.max(0, cy - 0.06);
  const halfW = 0.5 / scale;
  const halfH = 0.5 / scale;
  const clampedX = Math.max(halfW, Math.min(1 - halfW, cx));
  const clampedY = Math.max(halfH, Math.min(1 - halfH, aim));
  // Top-left of the scaled picture, in canvas fractions: the transform convention CupCat uses.
  return { scale, x: 0.5 - clampedX * scale, y: 0.5 - clampedY * scale };
}
