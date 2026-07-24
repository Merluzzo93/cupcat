// Finding the time offset between two recordings of the same moment.
//
// The obvious way — try every lag, score each one over the whole recording — is O(samples × lags).
// On two 30-minute cameras that is 180,000 × 6,001 × 2 ≈ 2.2 BILLION iterations, and because the
// bridge is single-threaded it blocks EVERYTHING while it runs: no progress, no stop, no WebSocket
// heartbeat, so the editor decides the engine has died. That is the bug this file exists to fix.
//
// Instead: look at a coarse version first to find roughly where the peak is, then look at full
// resolution only in a narrow band around it. Both passes are small, and the answer is identical
// because the coarse peak and the true peak are never far apart — the refine band is sized to
// cover the coarse pass's own uncertainty.

export interface LagResult {
  lag: number;
  confidence: number;
}

/** Average every `factor` samples. A quieter, shorter version of the same shape. */
export function decimate(a: Float32Array, factor: number): Float32Array {
  if (factor <= 1) return a;
  const n = Math.floor(a.length / factor);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let s = 0;
    const base = i * factor;
    for (let j = 0; j < factor; j++) s += a[base + j]!;
    out[i] = s / factor;
  }
  return out;
}

/**
 * Zero-normalized correlation of ref against tgt over a range of lags — the exhaustive scan, kept
 * for the passes that are small enough to afford it.
 *
 * `minOverlapFraction` guards the edges of the range: out there the two signals barely overlap, and
 * a perfect score over a second of audio means nothing — any repeated sound (a beep, a bar of
 * music) lines up exactly somewhere. A lag has to earn its score over a meaningful span.
 */
export function scanLags(
  ref: Float32Array,
  tgt: Float32Array,
  lagMin: number,
  lagMax: number,
  minOverlapFraction = 0.15,
  minOverlapSamples = 0,
): LagResult {
  let best = -Infinity;
  let bestL = 0;
  let bestN = 0;
  const minOverlap = Math.max(minOverlapSamples, Math.round(minOverlapFraction * Math.min(ref.length, tgt.length)));
  const lim = ref.length + tgt.length;
  const lo = Math.max(lagMin, -lim);
  const hi = Math.min(lagMax, lim);
  for (let L = lo; L <= hi; L++) {
    const i0 = Math.max(0, -L);
    const i1 = Math.min(ref.length, tgt.length - L);
    const n = i1 - i0;
    if (n < minOverlap) continue;
    // Means and correlation in ONE pass: the two-pass version read every sample twice, and this is
    // the innermost loop of the whole operation.
    let sr = 0;
    let st = 0;
    let srr = 0;
    let stt = 0;
    let srt = 0;
    for (let i = i0; i < i1; i++) {
      const a = ref[i]!;
      const b = tgt[i + L]!;
      sr += a;
      st += b;
      srr += a * a;
      stt += b * b;
      srt += a * b;
    }
    const cov = srt - (sr * st) / n;
    const vr = srr - (sr * sr) / n;
    const vt = stt - (st * st) / n;
    const denom = Math.sqrt(vr * vt);
    const corr = denom > 0 ? cov / denom : 0;
    // On a numerical tie prefer the LARGER overlap: float jitter must not let a barely-overlapping
    // echo of the true peak beat the fully-overlapping alignment.
    if (corr > best + 1e-9 || (corr > best - 1e-9 && n > bestN)) {
      best = corr;
      bestL = L;
      bestN = n;
    }
  }
  return { lag: bestL, confidence: Math.max(0, Math.min(1, best)) };
}

/**
 * The lag between two envelopes, coarse-to-fine.
 *
 * `factor` is how much the coarse pass shrinks the signal. The refine band is ±factor samples
 * around the coarse peak — exactly the coarse pass's resolution, so the true peak cannot be
 * outside it — plus a little margin for the averaging having smeared the peak.
 */
export function findLag(ref: Float32Array, tgt: Float32Array, lagMin: number, lagMax: number, factor = 10): LagResult {
  const span = lagMax - lagMin;
  // Small enough to scan outright: skip the two-pass dance and its rounding.
  if (factor <= 1 || span < 4 * factor || Math.min(ref.length, tgt.length) < 8 * factor) {
    return scanLags(ref, tgt, lagMin, lagMax);
  }
  const cr = decimate(ref, factor);
  const ct = decimate(tgt, factor);
  const coarse = scanLags(cr, ct, Math.floor(lagMin / factor), Math.ceil(lagMax / factor));
  const centre = coarse.lag * factor;
  const band = factor * 2;
  const fine = scanLags(
    ref,
    tgt,
    Math.max(lagMin, centre - band),
    Math.min(lagMax, centre + band),
    // The band is narrow, so overlap barely varies across it; the coarse pass already rejected the
    // degenerate edges. Keep a floor so a pathological case can't score on nothing.
    0,
    Math.min(ref.length, tgt.length) >> 1,
  );
  // The fine pass looked at a narrow band and can only improve on the coarse estimate; if it comes
  // back worse, something is odd about the signal and the coarse answer is the safer one.
  return fine.confidence >= coarse.confidence * 0.75 ? fine : { lag: centre, confidence: coarse.confidence };
}

/**
 * How much audio to look at, in seconds, to resolve an offset of at most `searchWindowSeconds`.
 *
 * Reading a 30-minute 10 GB camera end to end costs minutes of disk, and none of it is needed: to
 * place two recordings within ±30s of each other, a few minutes of their common audio is decisive.
 * The window has to be much longer than the offset being searched — otherwise two clips that barely
 * overlap have nothing to agree on — hence the multiple, with a floor for very short searches.
 */
export function probeSeconds(searchWindowSeconds: number, durationSeconds: number): number {
  const wanted = Math.max(180, searchWindowSeconds * 6);
  return Math.max(1, Math.min(wanted, durationSeconds));
}

export interface SyncProbePlan {
  /** How many seconds of audio to read from each camera. */
  probe: number;
  /** How far apart the cameras may have started, in seconds — the lag range searched. */
  window: number;
}

/**
 * How much audio to read, and how wide to search, to line two cameras up.
 *
 * The old fixed +/-30s window was the whole bug: real footage where one camera started nearly a
 * minute before the other simply could not be matched, because the true offset sat outside the
 * window and the search settled on a meaningless edge peak. Reading audio is cheap even on a 26 GB
 * file (it is a few seconds — the video is never touched), so the default is now generous enough to
 * cover cameras started minutes apart, and coarse-to-fine keeps the wide search fast.
 *
 * `attempt` escalates on a poor match: read more of each file and search wider, up to most of the
 * shorter recording, before giving up on a camera.
 */
export function syncProbePlan(shortestSeconds: number, userWindow: number | undefined, attempt = 0): SyncProbePlan {
  const dur = shortestSeconds > 0 ? shortestSeconds : 600;
  // How much audio to read — never more than the shorter recording holds, and at least a few
  // seconds so there is something to correlate.
  const targetByAttempt = userWindow && userWindow > 0 && attempt === 0 ? userWindow * 3 : [420, 1200, dur][Math.min(attempt, 2)]!;
  const probe = Math.min(dur, Math.max(30, targetByAttempt));
  // Search up to 70% of what we read: that leaves a 30% overlap floor at the widest offset, well
  // above the correlation's own 15% guard, so an edge peak on barely-overlapping audio can't win.
  const auto = Math.max(15, Math.min(probe - 30, probe * 0.7));
  const window = userWindow && userWindow > 0 && attempt === 0 ? Math.min(userWindow, Math.max(15, probe - 30)) : auto;
  return { probe, window };
}
