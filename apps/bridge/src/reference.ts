// Read an edit off a finished video, so it can be rebuilt with someone else's footage.
//
// The request behind this is "make mine like THIS one", and it is one of the few things an agent can
// do that a human editor finds tedious: watch a reference frame by frame, write down where every cut
// lands, how loud each shot is, where the music turns, and then rebuild that shape with different
// material. CupCat could already measure all of it — analyze_footage finds the cuts, detect_beats
// finds the tempo, audioEnvelope gives the loudness — but nothing put the measurements together into
// something you can act on.
//
// Everything here is pure: it takes numbers that ffmpeg already produced and returns a plan. That is
// deliberate — the interesting decisions (which cut is real, what counts as a drop, which of your
// clips belongs on which shot) are judgement calls, and judgement calls need tests.

/** One shot of the reference: the span between two cuts. */
export interface Shot {
  index: number;
  startSeconds: number;
  endSeconds: number;
  durationSeconds: number;
  /** Loudness of this shot relative to the loudest one, 0..1. The proxy for "how intense". */
  energy: number;
  /** Whether the cut that OPENS this shot lands on a beat of the music. */
  onBeat: boolean;
}

export interface Blueprint {
  durationSeconds: number;
  shots: Shot[];
  bpm: number;
  beatConfidence: number;
  /** Where the track opens up — the biggest sustained lift in loudness, or null if there isn't one. */
  dropSeconds: number | null;
  /** Fraction of cuts that land on a beat, 0..1. High means the reference was cut to the music. */
  cutsOnBeat: number;
  medianShotSeconds: number;
  shortestShotSeconds: number;
  longestShotSeconds: number;
}

export interface ShotOptions {
  /** Cuts closer together than this are treated as one shot. */
  minShotSeconds?: number;
}

/**
 * Turn scene-change timestamps into shots.
 *
 * ffmpeg's scene score fires more than once on a single hard cut — a flash frame, a whip pan, a
 * dissolve's midpoint — and a blueprint full of 4-frame "shots" describes an edit nobody made. Cuts
 * closer together than minShotSeconds are therefore folded into the shot before them, which is the
 * conservative direction: merging two real cuts loses a beat of detail, while inventing cuts would
 * make the rebuilt edit stutter.
 */
export function shotsFromScenes(sceneChanges: number[], durationSeconds: number, opts: ShotOptions = {}): Shot[] {
  const minShot = opts.minShotSeconds ?? 0.25;
  if (!(durationSeconds > 0)) return [];

  const cuts = [...new Set(sceneChanges.filter((t) => Number.isFinite(t) && t > 0 && t < durationSeconds))].sort((a, b) => a - b);

  const boundaries: number[] = [0];
  for (const c of cuts) {
    if (c - boundaries[boundaries.length - 1]! >= minShot) boundaries.push(c);
  }
  // A final shot shorter than the minimum is a tail, not a shot: give it back to its predecessor.
  if (boundaries.length > 1 && durationSeconds - boundaries[boundaries.length - 1]! < minShot) boundaries.pop();

  return boundaries.map((start, i) => {
    const end = i + 1 < boundaries.length ? boundaries[i + 1]! : durationSeconds;
    return { index: i, startSeconds: start, endSeconds: end, durationSeconds: end - start, energy: 0, onBeat: false };
  });
}

/** Mean of an envelope over [start, end), in envelope units. */
function meanEnergy(env: Float32Array, envRate: number, start: number, end: number): number {
  const a = Math.max(0, Math.floor(start * envRate));
  const b = Math.min(env.length, Math.ceil(end * envRate));
  if (b <= a) return 0;
  let sum = 0;
  for (let i = a; i < b; i++) sum += env[i]!;
  return sum / (b - a);
}

/**
 * Score each shot 0..1 by how loud it is against the loudest shot.
 *
 * Relative, not absolute: the question a rebuild asks is "is this a calm moment or a big one *in this
 * video*", and a quiet reference and a mastered one should produce the same shape. With no audio at
 * all every shot scores 0, and the caller can say so rather than pretending to have measured energy.
 */
export function scoreShotEnergy(shots: Shot[], env: Float32Array | null, envRate: number): Shot[] {
  if (!env || env.length === 0) return shots.map((s) => ({ ...s, energy: 0 }));
  const raw = shots.map((s) => meanEnergy(env, envRate, s.startSeconds, s.endSeconds));
  const peak = Math.max(...raw, 0);
  if (!(peak > 0)) return shots.map((s) => ({ ...s, energy: 0 }));
  return shots.map((s, i) => ({ ...s, energy: Math.round((raw[i]! / peak) * 100) / 100 }));
}

export interface DropOptions {
  /** How long a stretch to compare on each side of a candidate moment. */
  windowSeconds?: number;
  /** How much louder the lift has to be to count, as a ratio of the quieter side. */
  minRatio?: number;
  /** Ignore candidates in the first and last few seconds — a fade-in is not a drop. */
  edgeSeconds?: number;
}

/**
 * The moment the track opens up: the largest sustained step from quiet to loud.
 *
 * Sustained is the operative word. A snare hit is louder than everything around it for 200 ms and is
 * not a drop, so both sides are averaged over a window of seconds. Returns null rather than a
 * best-guess when nothing clears minRatio, because most footage — an interview, a talking head, a
 * steady music bed — genuinely has no drop, and a tool that always names one teaches you to ignore it.
 */
export function findDrop(env: Float32Array | null, envRate: number, opts: DropOptions = {}): number | null {
  if (!env || env.length === 0) return null;
  const win = opts.windowSeconds ?? 2;
  const minRatio = opts.minRatio ?? 1.8;
  const edge = opts.edgeSeconds ?? win;
  const total = env.length / envRate;
  if (total < win * 2 + edge * 2) return null;

  let best: { t: number; ratio: number } | null = null;
  const step = 1 / 10; // 100 ms is finer than any drop is meaningful
  for (let t = edge + win; t <= total - edge - win; t += step) {
    const before = meanEnergy(env, envRate, t - win, t);
    const after = meanEnergy(env, envRate, t, t + win);
    if (before <= 1e-6) continue;
    const ratio = after / before;
    if (!best || ratio > best.ratio) best = { t, ratio };
  }
  if (!best || best.ratio < minRatio) return null;
  return Math.round(best.t * 100) / 100;
}

/** Fraction of shot openings that land within tolerance of a beat. The first shot opens at 0, which
 * every grid trivially matches, so it does not count towards the score. */
export function beatAlignment(shots: Shot[], beats: number[], toleranceSeconds = 0.12): { cutsOnBeat: number; shots: Shot[] } {
  const cuts = shots.slice(1);
  const marked = shots.map((s, i) => {
    if (i === 0) return { ...s, onBeat: false };
    const near = beats.some((b) => Math.abs(b - s.startSeconds) <= toleranceSeconds);
    return { ...s, onBeat: near };
  });
  if (cuts.length === 0 || beats.length === 0) return { cutsOnBeat: 0, shots: marked };
  const hits = marked.slice(1).filter((s) => s.onBeat).length;
  return { cutsOnBeat: Math.round((hits / cuts.length) * 100) / 100, shots: marked };
}

export function median(xs: number[]): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

/** Assemble the measurements into the blueprint the tool reports. */
export function buildBlueprint(
  sceneChanges: number[],
  durationSeconds: number,
  env: Float32Array | null,
  envRate: number,
  beats: { bpm: number; beats: number[]; confidence: number },
  opts: ShotOptions & DropOptions = {},
): Blueprint {
  const shots = scoreShotEnergy(shotsFromScenes(sceneChanges, durationSeconds, opts), env, envRate);
  const { cutsOnBeat, shots: marked } = beatAlignment(shots, beats.beats);
  const lens = marked.map((s) => s.durationSeconds);
  return {
    durationSeconds: Math.round(durationSeconds * 100) / 100,
    shots: marked,
    bpm: beats.bpm,
    beatConfidence: beats.confidence,
    dropSeconds: findDrop(env, envRate, opts),
    cutsOnBeat,
    medianShotSeconds: Math.round(median(lens) * 100) / 100,
    shortestShotSeconds: lens.length ? Math.round(Math.min(...lens) * 100) / 100 : 0,
    longestShotSeconds: lens.length ? Math.round(Math.max(...lens) * 100) / 100 : 0,
  };
}

// ── matching your footage to the reference's shape ──────────────────────────

/** A piece of the user's material that could fill a slot. */
export interface Candidate {
  /** Library asset id. */
  mediaRef: string;
  name: string;
  /** How much of it is usable, in seconds. */
  durationSeconds: number;
  /** How lively it is, 0..1. Motion for video, loudness for audio-led material — the caller decides. */
  energy: number;
}

export interface Assignment {
  shotIndex: number;
  startSeconds: number;
  durationSeconds: number;
  mediaRef: string;
  name: string;
  /** Where in the candidate to start, so repeated use of one clip does not show the same frames. */
  sourceStartSeconds: number;
  why: string;
}

export interface MatchOptions {
  /** Refuse to place a candidate that cannot cover the slot (rather than stretching it). */
  minCoverage?: number;
}

/**
 * Fill every shot of the blueprint with the user's footage, matching intensity to intensity.
 *
 * The slot's energy is a position, not a measurement to compare. Shot energies are already normalised
 * against the reference's own loudest moment, so 0.8 means "near the top of THIS video" — and that
 * position is used to index into the candidates sorted by energy. Absolute values are never compared
 * across the two recordings, because they share no scale: a reference mastered for streaming and a
 * phone clip are not on the same axis, but "the liveliest of what you have" is always meaningful.
 *
 * The first version ranked slots against each other instead, and had a hole a single shot fell
 * straight through: rank 0 of 1 is position 0, so a lone slot always drew the CALMEST clip no matter
 * how loud it was. Using the slot's own energy has no such degenerate case.
 *
 * Reuse is expected — a blueprint routinely has more shots than you have clips. Slots are filled in
 * timeline order and each clip keeps a cursor, so the montage reads a clip forwards as it goes
 * forwards, and wraps to the start rather than running off the end.
 *
 * A slot LONGER than every clip you own is the case that has to be got right, and the first version
 * got it wrong: it placed a 17-second clip over a 21.5-second shot, which is not a clip — it is 4.5
 * seconds of whatever ffmpeg does past the end of a file. There is no honest single-clip answer, so
 * such a slot is filled by consecutive pieces instead, which is what a human editor does. It costs a
 * cut the reference did not have, so it only happens when nothing can cover the slot in one take:
 * whenever some clip is long enough, the clip wraps to its start rather than the shot being broken.
 *
 * When every slot scores the same — a silent reference, so there was no loudness to measure — energy
 * says nothing, and matching on it would hand every single shot to the same clip. Then the footage is
 * simply cycled, which at least produces a montage.
 */
export function matchFootage(shots: Shot[], candidates: Candidate[], opts: MatchOptions = {}): Assignment[] {
  if (shots.length === 0 || candidates.length === 0) return [];
  const minCoverage = opts.minCoverage ?? 0.5;
  const EPS = 1e-6;

  const usable = candidates.filter((c) => c.durationSeconds > 0);
  if (usable.length === 0) return [];

  const ranked = [...usable].sort((a, b) => a.energy - b.energy);
  const byLength = [...usable].sort((a, b) => b.durationSeconds - a.durationSeconds);
  const longest = byLength[0]!;
  // One shot is trivially "flat" and must NOT take the cycling path: its own energy is meaningful and
  // is the whole reason it should get the liveliest (or calmest) clip.
  const flat = shots.length > 1 && shots.every((s) => s.energy === shots[0]!.energy);
  const cursor = new Map<string, number>();
  const out: Assignment[] = [];

  let n = 0;
  let alt = 0;
  for (const shot of [...shots].sort((a, b) => a.startSeconds - b.startSeconds)) {
    const pos = Math.min(1, Math.max(0, shot.energy));
    const matched = flat ? ranked[n % ranked.length]! : ranked[Math.round(pos * (ranked.length - 1))]!;
    n++;
    const matchWhy = flat
      ? "nothing to match on (no audio in the reference) → cycling through your clips"
      : shot.energy >= 0.66
        ? "high-energy slot → liveliest footage"
        : shot.energy <= 0.33
          ? "calm slot → calmest footage"
          : "mid-energy slot";

    let filled = 0;
    let previous: Candidate | null = null;
    // 256 is a backstop against a pathological candidate set, not a real limit: it takes clips
    // shorter than a 256th of the slot to reach it.
    for (let guard = 0; filled < shot.durationSeconds - EPS && guard < 256; guard++) {
      const need = shot.durationSeconds - filled;
      let pick: Candidate;
      let why: string;
      if (previous === null) {
        pick = matched;
        why = matchWhy;
        // A candidate that cannot cover even half the slot would be a stutter; prefer the longest one
        // available instead, and say why the energy match was given up.
        if (pick.durationSeconds < shot.durationSeconds * minCoverage && longest.durationSeconds > pick.durationSeconds) {
          pick = longest;
          why = `slot is ${shot.durationSeconds.toFixed(1)}s — took the longest clip available`;
        }
      } else {
        // Continuing a shot nothing could cover: take the longest clip that is not the one just used,
        // so the join reads as a cut between two takes rather than as a jump inside one.
        const alts = byLength.filter((c) => c.mediaRef !== previous!.mediaRef);
        pick = alts.length > 0 ? alts[alt++ % alts.length]! : previous;
        why = `shot is ${shot.durationSeconds.toFixed(1)}s and nothing is that long — continues here`;
      }

      const at = cursor.get(pick.mediaRef) ?? 0;
      const room = pick.durationSeconds - at;
      // Prefer unseen material; but if the clip can cover the whole remainder from its start, wrap to
      // the start instead of cutting the shot in two.
      let start = room >= need ? at : pick.durationSeconds >= need ? 0 : at;
      let take = Math.min(need, pick.durationSeconds - start);
      if (take <= EPS) {
        start = 0;
        take = Math.min(need, pick.durationSeconds);
      }
      cursor.set(pick.mediaRef, start + take);

      out.push({
        shotIndex: shot.index,
        startSeconds: Math.round((shot.startSeconds + filled) * 100) / 100,
        durationSeconds: Math.round(take * 100) / 100,
        mediaRef: pick.mediaRef,
        name: pick.name,
        sourceStartSeconds: Math.round(start * 100) / 100,
        why,
      });
      filled += take;
      previous = pick;
    }

    // Only reachable through the backstop above. A gap is black on screen, which is worse than the
    // last piece running a moment long, so the remainder goes onto it.
    const short = shot.durationSeconds - filled;
    if (short > EPS && out.length > 0) {
      const last = out[out.length - 1]!;
      last.durationSeconds = Math.round((last.durationSeconds + short) * 100) / 100;
    }
  }

  return out;
}
