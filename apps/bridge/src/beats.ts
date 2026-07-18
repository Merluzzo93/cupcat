// Beat detection (CapCut-style "beat sync"), no ML: novelty curve from the RMS envelope, adaptive
// peak-picking for onsets, tempo via autocorrelation with a mild preference for the 90–180 BPM
// range, then a phase-fitted beat grid. Good for steady-tempo music beds — exactly the "cut on the
// beat" use case; it is not a general rubato tracker.

export interface BeatAnalysis {
  bpm: number;
  beats: number[]; // seconds, grid-fitted
  onsets: number[]; // seconds, raw detected attacks
  confidence: number; // 0..1 — how periodic the novelty is at the chosen tempo
}

/** Half-wave-rectified log-energy difference — spikes on attacks (drums, plucks, transients).
 * The envelope is box-smoothed (~50 ms) FIRST: raw per-sample RMS wobbles enough (noise floors,
 * quiet passages) to spray spurious log-diff spikes at the full envelope rate. */
function noveltyCurve(env: Float32Array, envRate: number): Float32Array {
  const half = Math.max(1, Math.round(envRate * 0.025));
  const sm = new Float32Array(env.length);
  for (let i = 0; i < env.length; i++) {
    let sum = 0;
    let cnt = 0;
    for (let j = Math.max(0, i - half); j <= Math.min(env.length - 1, i + half); j++) {
      sum += env[j]!;
      cnt++;
    }
    sm[i] = sum / cnt;
  }
  const n = new Float32Array(sm.length);
  const eps = 1e-5;
  for (let i = 1; i < sm.length; i++) {
    const d = Math.log(sm[i]! + eps) - Math.log(sm[i - 1]! + eps);
    n[i] = d > 0 ? d : 0;
  }
  return n;
}

/** Local maxima above an adaptive (moving-average) threshold AND a global prominence gate, with a
 * refractory gap. The global gate (fraction of the 90th percentile) keeps only real attacks when a
 * noisy stretch would otherwise pass the purely local threshold. */
function pickOnsets(nov: Float32Array, envRate: number): number[] {
  // Attacks are sparse (a 120 BPM grid touches ~2% of a 100 Hz novelty curve), so the prominence
  // reference must sit in the top tail: p98 ≈ the attack level itself, noise lives far below it.
  const sorted = Float32Array.from(nov).sort();
  const p98 = sorted[Math.floor(sorted.length * 0.98)] ?? 0;
  const globalGate = p98 * 0.5;
  const win = Math.round(envRate * 0.5); // ±0.5 s adaptive window
  const minGap = Math.round(envRate * 0.12);
  const onsets: number[] = [];
  let last = -minGap;
  for (let i = 1; i < nov.length - 1; i++) {
    if (nov[i]! <= nov[i - 1]! || nov[i]! < nov[i + 1]!) continue;
    if (nov[i]! < globalGate) continue;
    let sum = 0;
    let cnt = 0;
    for (let j = Math.max(0, i - win); j < Math.min(nov.length, i + win); j++) {
      sum += nov[j]!;
      cnt++;
    }
    const thr = (sum / Math.max(1, cnt)) * 1.8 + 0.01;
    if (nov[i]! < thr) continue;
    if (i - last < minGap) continue;
    last = i;
    onsets.push(i / envRate);
  }
  return onsets;
}

/** Tempo from the novelty autocorrelation. Prefers lags whose BPM sits near typical music tempo
 * (gaussian weight around 120 BPM, wide) so double/half-tempo ambiguity resolves musically. */
function estimateTempo(nov: Float32Array, envRate: number): { bpm: number; confidence: number } {
  const minLag = Math.round((60 / 250) * envRate); // 250 BPM
  const maxLag = Math.round((60 / 40) * envRate); // 40 BPM
  const mean = nov.reduce((a, b) => a + b, 0) / Math.max(1, nov.length);
  const zc = Float32Array.from(nov, (v) => v - mean);
  let best = 0;
  let bestLag = minLag;
  let total = 0;
  for (let lag = minLag; lag <= Math.min(maxLag, zc.length - 1); lag++) {
    let acc = 0;
    for (let i = 0; i + lag < zc.length; i++) acc += zc[i]! * zc[i + lag]!;
    const bpm = (60 * envRate) / lag;
    const w = Math.exp(-((Math.log2(bpm / 120) / 1.1) ** 2)); // soft prior around 120 BPM
    const v = Math.max(0, acc) * w;
    total += v;
    if (v > best) {
      best = v;
      bestLag = lag;
    }
  }
  const confidence = total > 0 ? Math.min(1, best / (total / (maxLag - minLag)) / 12) : 0;
  return { bpm: (60 * envRate) / bestLag, confidence };
}

/** Fit the grid phase: shift the beat comb to maximize novelty mass under its teeth, then emit the
 * grid, snapping each beat to a nearby onset (±70 ms) when one exists. */
function fitGrid(
  nov: Float32Array,
  envRate: number,
  bpm: number,
  onsets: number[],
  durSec: number,
): { beats: number[]; refinedBpm: number } {
  const period = 60 / bpm;
  const steps = 24;
  let bestPhase = 0;
  let bestScore = -1;
  for (let s = 0; s < steps; s++) {
    const phase = (s / steps) * period;
    let score = 0;
    for (let t = phase; t < durSec; t += period) {
      const i = Math.round(t * envRate);
      if (i >= 0 && i < nov.length) score += nov[i]!;
    }
    if (score > bestScore) {
      bestScore = score;
      bestPhase = phase;
    }
  }
  // Refine the period from the MEDIAN inter-onset interval — the autocorrelation lag is quantized
  // to the envelope rate, and its tiny error DRIFTS over a long track (0.8 BPM off ≈ 125 ms after
  // 15 s, enough to visibly miss cuts). Intervals are folded by the nearest multiple of the rough
  // period, so missed onsets (gap ≈ 2·p) still vote correctly.
  let p = period;
  const folded: number[] = [];
  for (let i = 1; i < onsets.length; i++) {
    const d = onsets[i]! - onsets[i - 1]!;
    const mult = Math.round(d / p);
    if (mult >= 1 && mult <= 4) {
      const f = d / mult;
      if (Math.abs(f - p) / p < 0.15) folded.push(f);
    }
  }
  if (folded.length >= 4) {
    folded.sort((a, b) => a - b);
    p = folded[Math.floor(folded.length / 2)]!;
  }
  // Re-fit the phase with the refined period (finer comb), then snap each beat to a nearby onset.
  const phSteps = 48;
  let ph = bestPhase % p;
  let phScore = -1;
  for (let s = 0; s < phSteps; s++) {
    const cand = (s / phSteps) * p;
    let score = 0;
    for (let t = cand; t < durSec; t += p) {
      const i = Math.round(t * envRate);
      if (i >= 0 && i < nov.length) score += nov[i]!;
    }
    if (score > phScore) {
      phScore = score;
      ph = cand;
    }
  }
  const beats: number[] = [];
  for (let t = ph; t < durSec; t += p) {
    const snap = onsets.find((o) => Math.abs(o - t) <= 0.07);
    beats.push(Math.round((snap ?? t) * 1000) / 1000);
  }
  return { beats, refinedBpm: 60 / p };
}

export function detectBeatsFromEnvelope(env: Float32Array, envRate: number): BeatAnalysis {
  const nov = noveltyCurve(env, envRate);
  const onsets = pickOnsets(nov, envRate);
  const durSec = env.length / envRate;
  const { bpm, confidence } = estimateTempo(nov, envRate);
  const { beats, refinedBpm } = fitGrid(nov, envRate, bpm, onsets, durSec);
  return {
    bpm: Math.round(refinedBpm * 10) / 10,
    beats,
    onsets: onsets.map((o) => Math.round(o * 1000) / 1000),
    confidence: Math.round(confidence * 100) / 100,
  };
}
