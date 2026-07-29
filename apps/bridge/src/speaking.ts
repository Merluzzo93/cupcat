// Which face in shot is the one talking — the measuring half.
//
// emphasis.ts holds the arithmetic and its tests; this holds the two things that need a decoder: a
// span of small grayscale frames, and the pass that turns them into an answer. It lives apart from
// the tools because more than one of them needs the same answer, and two copies of a heuristic drift
// into two different heuristics.

import { join } from "node:path";
import { rm } from "node:fs/promises";
import { exportsDir, FFMPEG_BIN } from "./config";
import { detectFacesAt, iou } from "./faceblur";
import { type Box, isConfident, mouthRegion, rankSpeakers, regionMotion } from "./emphasis";
import { run } from "./proc";

/** Grayscale frames of a span, small and evenly spaced, for measuring movement. One decode. */
export async function grayFrames(
  srcPath: string,
  fromSeconds: number,
  durSeconds: number,
  fps: number,
  width: number,
): Promise<{ frames: Uint8Array[]; width: number; height: number } | null> {
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
  const raw = join(exportsDir, `_mouth_${stamp}_${Math.round(fromSeconds * 1000)}.gray`);
  try {
    const height = Math.round(width * 0.5625) & ~1;
    const r = await run(FFMPEG_BIN, [
      "-y", "-ss", fromSeconds.toFixed(3), "-t", durSeconds.toFixed(3), "-i", srcPath,
      "-vf", `fps=${fps.toFixed(3)},scale=${width}:${height},format=gray`,
      "-f", "rawvideo", "-pix_fmt", "gray", raw,
    ]);
    if (r.code !== 0) return null;
    const buf = new Uint8Array(await Bun.file(raw).arrayBuffer());
    const per = width * height;
    const n = Math.floor(buf.length / per);
    if (n < 2) return null;
    const frames: Uint8Array[] = [];
    for (let i = 0; i < n; i++) frames.push(buf.subarray(i * per, (i + 1) * per));
    return { frames, width, height };
  } catch {
    return null;
  } finally {
    void rm(raw, { force: true }).catch(() => {});
  }
}

export type SpeakingResult =
  | { ok: true; face: Box; of: number }
  /** Deliberately not a face: a wrong confident answer is worse than an admitted one. */
  | { ok: false; why: string; faces: number };

/**
 * The face doing the talking across a stretch of a video.
 *
 * Faces are gathered from a few instants and merged by overlap, so somebody who moves is one
 * candidate rather than four. With a single face there is nothing to decide; with several, the
 * mouth-motion pass decides, and is allowed to refuse.
 */
export async function whoIsSpeaking(srcPath: string, fromSeconds: number, durSeconds: number): Promise<SpeakingResult> {
  // Boxes from several instants, merged by overlap so one person who moved a little is one
  // candidate. On crowded or moving footage this still over-counts — the detector's output is not
  // stable frame to frame, and a person who moves by more than half a head width becomes two
  // entries whose mouth movement is then split between them. That shows up as a near-tie, and the
  // confidence check below turns a near-tie into a refusal rather than a guess, which is the
  // behaviour worth keeping until there is a tracker to replace it.
  const times = [0.2, 0.4, 0.6, 0.8].map((f) => fromSeconds + durSeconds * f);
  const hits = await detectFacesAt(srcPath, times);
  const candidates: Box[] = [];
  for (const boxes of hits ?? []) {
    for (const b of boxes) {
      if (!candidates.some((c) => iou(c, b) > 0.3)) candidates.push(b);
    }
  }
  if (candidates.length === 0) return { ok: false, why: "no face found", faces: 0 };
  if (candidates.length === 1) return { ok: true, face: candidates[0]!, of: 1 };

  // 960 wide. On a five-person conference grid (faces ~7% of the width) the right face won by
  // roughly 6x at 320, 640 and 960 alike, so this is headroom rather than a fix: a mouth needs
  // pixels to measure, and 320 leaves about seven across on a face that size.
  const g = await grayFrames(srcPath, fromSeconds, Math.min(durSeconds, 6), 8, 960);
  if (!g) return { ok: false, why: "could not measure who was talking", faces: candidates.length };
  const mouthSeries: number[][] = candidates.map(() => []);
  const frameSeries: number[] = [];
  for (let k = 1; k < g.frames.length; k++) {
    const a = g.frames[k - 1]!;
    const b = g.frames[k]!;
    frameSeries.push(regionMotion(a, b, g.width, g.height, { x: 0, y: 0, w: 1, h: 1 }));
    candidates.forEach((c, ci) => mouthSeries[ci]!.push(regionMotion(a, b, g.width, g.height, mouthRegion(c))));
  }
  const ranked = rankSpeakers(mouthSeries, frameSeries);
  if (!isConfident(ranked)) return { ok: false, why: `${candidates.length} faces and none clearly speaking`, faces: candidates.length };
  return { ok: true, face: candidates[ranked[0]!.index]!, of: candidates.length };
}
