// Pre-publish check: the pass a human would do before uploading, done by measurement. Reads the
// file's loudness, looks for clipped audio, dead frames at the head/tail, frozen picture and
// flashing that could trigger photosensitive seizures — then says plainly what to fix.
//
// Read-only: nothing is rendered or modified.

import { FFMPEG_BIN } from "./config";
import { analyzeVideo, probeMedia } from "./ffmpeg";
import { run } from "./proc";
import { LOUDNESS_TARGETS, type LoudnessTarget, measureLoudness } from "./enhance";

export interface QcFinding {
  severity: "error" | "warning" | "ok";
  title: string;
  detail: string;
}

export interface QcReport {
  findings: QcFinding[];
  loudness: { i: number; tp: number } | null;
  durationSeconds: number;
  resolution: string;
  fps: number;
}

/** Peak/clipping statistics from ffmpeg's astats. Pure — unit-tested. */
export function parseClipping(stderr: string): { peakDb: number | null; clippedSamples: number } {
  const peaks = [...stderr.matchAll(/Peak level dB:\s*(-?[0-9.]+|-inf)/g)]
    .map((m) => (m[1] === "-inf" ? -140 : Number.parseFloat(m[1]!)))
    .filter((n) => Number.isFinite(n));
  // "Number of clipped samples" isn't printed by every build; treat a missing value as zero rather
  // than guessing, and let the peak level carry the verdict.
  const clipped = [...stderr.matchAll(/Number of clipped samples:\s*(\d+)/g)].map((m) => Number.parseInt(m[1]!, 10));
  return {
    peakDb: peaks.length ? Math.max(...peaks) : null,
    clippedSamples: clipped.length ? Math.max(...clipped) : 0,
  };
}

/** Count the frames photosensitivity flagged as a flash risk. Pure — unit-tested. */
export function parseFlashes(stderr: string): number {
  // The filter logs one line per flagged frame.
  return [...stderr.matchAll(/photosensitivity.*?frame\s+\d+/gi)].length;
}

export async function runQualityCheck(
  src: string,
  opts: { target?: LoudnessTarget; onProgress?: (t: string) => void } = {},
): Promise<QcReport> {
  const progress = opts.onProgress ?? (() => {});
  const targetKey = (opts.target ?? "youtube") as LoudnessTarget;
  const target = LOUDNESS_TARGETS[targetKey] ?? LOUDNESS_TARGETS.youtube;
  const probe = await probeMedia(src);
  const findings: QcFinding[] = [];

  // ── audio ──
  let loudness: { i: number; tp: number } | null = null;
  if (probe.hasAudio) {
    progress("Measuring loudness…");
    const m = await measureLoudness(src, targetKey);
    if (m) {
      loudness = { i: m.i, tp: m.tp };
      const delta = m.i - target.i;
      if (Math.abs(delta) < 1) {
        findings.push({ severity: "ok", title: "Loudness on target", detail: `${m.i.toFixed(1)} LUFS — right for ${target.label}.` });
      } else {
        findings.push({
          severity: Math.abs(delta) > 3 ? "error" : "warning",
          title: delta > 0 ? "Too loud" : "Too quiet",
          detail: `${m.i.toFixed(1)} LUFS against a ${target.i} target for ${target.label}. Run match_loudness to fix it.`,
        });
      }
      if (m.tp > -0.5) {
        findings.push({
          severity: "error",
          title: "Audio peaks are clipping",
          detail: `True peak ${m.tp.toFixed(1)} dBTP. Anything above -1 distorts once a platform re-encodes it.`,
        });
      }
    }

    progress("Checking for distortion…");
    const st = await run(FFMPEG_BIN, ["-hide_banner", "-i", src, "-af", "astats=metadata=0", "-f", "null", "-"]);
    const { peakDb, clippedSamples } = parseClipping(st.stderr);
    if (clippedSamples > 0) {
      findings.push({
        severity: "error",
        title: "Clipped audio samples",
        detail: `${clippedSamples} samples were recorded past full scale. repair_audio can rebuild them.`,
      });
    } else if (peakDb !== null && peakDb < -20) {
      findings.push({
        severity: "warning",
        title: "Audio recorded very quietly",
        detail: `Peak ${peakDb.toFixed(1)} dB. Normalising will also lift the noise floor — enhance_audio first.`,
      });
    }
  } else {
    findings.push({ severity: "warning", title: "No audio track", detail: "This file is silent." });
  }

  // ── picture ──
  progress("Looking for dead frames…");
  const analysis = await analyzeVideo(src);
  const dur = probe.durationSeconds;
  const head = analysis.blackRanges.find((r) => r.startSeconds < 0.5);
  const tail = analysis.blackRanges.find((r) => dur > 0 && r.endSeconds > dur - 0.5);
  if (head) findings.push({ severity: "warning", title: "Black frames at the start", detail: `Black until ${head.endSeconds.toFixed(1)}s — trim it.` });
  if (tail) findings.push({ severity: "warning", title: "Black frames at the end", detail: `Black from ${tail.startSeconds.toFixed(1)}s — trim it.` });
  const longFreeze = analysis.freezeRanges.find((r) => r.endSeconds - r.startSeconds > 2);
  if (longFreeze) {
    findings.push({
      severity: "warning",
      title: "Frozen picture",
      detail: `The image doesn't move between ${longFreeze.startSeconds.toFixed(1)}s and ${longFreeze.endSeconds.toFixed(1)}s.`,
    });
  }

  progress("Checking for flashing…");
  const ps = await run(FFMPEG_BIN, ["-hide_banner", "-i", src, "-vf", "photosensitivity=skip=2", "-an", "-f", "null", "-"]);
  const flashes = parseFlashes(ps.stderr);
  if (flashes > 0) {
    findings.push({
      severity: "warning",
      title: "Possible flashing hazard",
      detail: `${flashes} frame(s) flagged as a photosensitive-seizure risk. Consider softening the flashes or adding a warning card.`,
    });
  }

  if (!findings.some((f) => f.severity !== "ok")) {
    findings.push({ severity: "ok", title: "Nothing to flag", detail: "Picture and audio both look ready to publish." });
  }

  return {
    findings,
    loudness,
    durationSeconds: dur,
    resolution: probe.width && probe.height ? `${probe.width}×${probe.height}` : "unknown",
    fps: probe.fps ?? 0,
  };
}

/** Human-readable report for the chat / tool result. */
export function formatQcReport(r: QcReport): string {
  const icon = (s: QcFinding["severity"]) => (s === "error" ? "✗" : s === "warning" ? "!" : "✓");
  const lines = [
    `${r.resolution} · ${r.fps ? `${r.fps.toFixed(2)} fps · ` : ""}${r.durationSeconds.toFixed(1)}s${
      r.loudness ? ` · ${r.loudness.i.toFixed(1)} LUFS, peak ${r.loudness.tp.toFixed(1)} dBTP` : ""
    }`,
    "",
    ...r.findings.map((f) => `${icon(f.severity)} ${f.title} — ${f.detail}`),
  ];
  return lines.join("\n");
}
