// Local, free auto-reframe (B2): reframe a 16:9 (or any) video to a vertical/other aspect WITHOUT
// the cloud. Each shot is framed on the people in it when there are any — the bundled face detector
// says where they stand — and otherwise on horizontal "interest" (gradient-energy centroid, i.e.
// where the detail sits). The crop window is centred there per scene, and the
// shots are re-encoded and concatenated. It's a virtual camera operator that picks framing per
// shot. No ML model download, no credits, deterministic. The Higgsfield `reframe` tool remains the
// AI content-aware alternative when the user wants it.

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FFMPEG_BIN, mediaDir } from "./config";
import { detectFacesAt } from "./faceblur";
import { analyzeVideo, probeMedia } from "./ffmpeg";
import { run } from "./proc";

const SAMPLE_W = 64;
const SAMPLE_H = 36;

export interface ReframeLocalResult {
  path: string;
  width: number;
  height: number;
  durationSeconds: number;
  shots: number;
}

/** Parse "9:16" → 0.5625. Falls back to vertical when unparseable. */
function aspectValue(ar: string): number {
  const m = ar.match(/^\s*(\d+(?:\.\d+)?)\s*[:x/]\s*(\d+(?:\.\d+)?)\s*$/);
  if (m) {
    const w = Number(m[1]);
    const h = Number(m[2]);
    if (w > 0 && h > 0) return w / h;
  }
  return 9 / 16;
}

/** Horizontal interest center (0..1) of one sampled time: gradient-energy centroid over columns. */
async function interestCenterX(src: string, atSeconds: number, tmp: string): Promise<number> {
  const raw = join(tmp, `f_${Math.round(atSeconds * 1000)}.gray`);
  const args = ["-y"];
  if (atSeconds > 0.001) args.push("-ss", String(atSeconds));
  args.push("-i", src, "-frames:v", "1", "-vf", `scale=${SAMPLE_W}:${SAMPLE_H},format=gray`, "-f", "rawvideo", "-pix_fmt", "gray", raw);
  const { code } = await run(FFMPEG_BIN, args);
  if (code !== 0) return 0.5;
  const f = Bun.file(raw);
  if (!(await f.exists())) return 0.5;
  const buf = new Uint8Array(await f.arrayBuffer());
  if (buf.length < SAMPLE_W * SAMPLE_H) return 0.5;
  // Per-column energy = sum over rows of the horizontal gradient magnitude. High-detail columns
  // (edges, faces, text) dominate; flat sky/wall columns contribute little.
  const colEnergy = new Float64Array(SAMPLE_W);
  for (let y = 0; y < SAMPLE_H; y++) {
    const row = y * SAMPLE_W;
    for (let x = 1; x < SAMPLE_W; x++) {
      colEnergy[x] += Math.abs(buf[row + x] - buf[row + x - 1]);
    }
  }
  let sum = 0;
  let weighted = 0;
  for (let x = 0; x < SAMPLE_W; x++) {
    sum += colEnergy[x];
    weighted += colEnergy[x] * (x + 0.5);
  }
  if (sum <= 0) return 0.5;
  return Math.min(1, Math.max(0, weighted / sum / SAMPLE_W));
}

/**
 * Horizontal centre of the faces in a frame, or null if nobody is there.
 *
 * When there are people in shot this beats the gradient centroid outright: gradient energy is drawn
 * to whatever has the most detail — a bookshelf, a window, on-screen text — so a talking head in
 * front of a busy wall gets framed on the wall. Weighting by face area keeps the camera on the
 * person nearest the lens when a group is spread across the frame.
 */
export function faceCenterX(boxes: { x: number; y: number; w: number; h: number }[]): number | null {
  return faceCenter(boxes, (b) => b.x + b.w / 2);
}

/** Same, vertically — used when it's the height being cropped, so nobody gets their head cut off. */
export function faceCenterY(boxes: { x: number; y: number; w: number; h: number }[]): number | null {
  // Aim a little below the faces: a head sitting dead-centre looks like a mugshot, whereas leaving
  // room under the chin gives the body some frame, which is how a person would hold the camera.
  const c = faceCenter(boxes, (b) => b.y + b.h / 2);
  return c === null ? null : Math.min(1, c + 0.12);
}

function faceCenter(
  boxes: { x: number; y: number; w: number; h: number }[],
  pick: (b: { x: number; y: number; w: number; h: number }) => number,
): number | null {
  let area = 0;
  let weighted = 0;
  for (const b of boxes) {
    const a = b.w * b.h;
    if (a <= 0) continue;
    area += a;
    weighted += a * pick(b);
  }
  return area > 0 ? Math.min(1, Math.max(0, weighted / area)) : null;
}

/** Split a duration into shots on scene changes, merging shots shorter than minShot seconds. */
function buildShots(sceneChanges: number[], dur: number, minShot = 1.2): [number, number][] {
  const cuts = [...new Set(sceneChanges.filter((t) => t > minShot && t < dur - 0.3))].sort((a, b) => a - b);
  const bounds = [0, ...cuts, dur];
  const shots: [number, number][] = [];
  for (let i = 0; i < bounds.length - 1; i++) {
    const start = bounds[i];
    const end = bounds[i + 1];
    if (end - start < minShot && shots.length > 0) {
      shots[shots.length - 1][1] = end; // absorb a too-short tail into the previous shot
    } else {
      shots.push([start, end]);
    }
  }
  return shots.length ? shots : [[0, dur]];
}

export async function reframeLocal(src: string, targetAspect: string, opts: { smooth?: boolean } = {}): Promise<ReframeLocalResult> {
  const probe = await probeMedia(src);
  const W = probe.width ?? 0;
  const H = probe.height ?? 0;
  const dur = probe.durationSeconds || 0;
  if (W <= 0 || H <= 0 || dur <= 0) throw new Error("Could not read the video's dimensions/duration.");

  const arT = aspectValue(targetAspect);
  // Keep full height and crop width when the target is narrower than the source (the 16:9→9:16 case);
  // otherwise keep full width and crop height.
  let cropW = Math.round(H * arT);
  let cropH = H;
  let vertical = false;
  if (cropW > W) {
    cropW = W;
    cropH = Math.round(W / arT);
    vertical = true;
  }
  cropW -= cropW % 2;
  cropH -= cropH % 2;

  const tmp = await mkdtemp(join(tmpdir(), "ccreframe-"));
  try {
    const { sceneChanges } = await analyzeVideo(src).catch(() => ({ sceneChanges: [] as number[] }));
    const shots = buildShots(sceneChanges, dur);

    // Where the people are, one look per shot. Faces are what a human operator frames on, so they
    // win when present; the gradient centroid still handles landscape, product and b-roll shots.
    const midpoints = shots.map(([s, e]) => s + (e - s) / 2);
    const faceHits = await detectFacesAt(src, midpoints).catch(() => null);

    // Interest center per shot (sampled at the shot midpoint; a second sample averaged in for long shots).
    const segFiles: string[] = [];
    const smooth = opts.smooth !== false;
    let prevCenter = 0.5;
    for (let i = 0; i < shots.length; i++) {
      const [s, e] = shots[i];
      const mid = s + (e - s) / 2;
      let center = faceCenterX(faceHits?.[i] ?? []);
      if (center === null) {
        center = await interestCenterX(src, mid, tmp);
        if (e - s > 4) {
          const c2 = await interestCenterX(src, s + (e - s) * 0.25, tmp);
          center = (center + c2) / 2;
        }
      }
      // Light temporal smoothing so framing doesn't snap wildly between adjacent shots. The first
      // shot has nothing to smooth against, and blending it toward the middle just drags the
      // opening frame off its subject — so it keeps the centre it measured.
      if (smooth && i > 0) center = prevCenter * 0.35 + center * 0.65;
      prevCenter = center;

      // Convert the interest center to a valid top-left crop origin, clamped in-bounds.
      let cx = Math.round(center * W - cropW / 2);
      cx = Math.max(0, Math.min(W - cropW, cx));
      let cy = 0;
      if (vertical) {
        const fy = faceCenterY(faceHits?.[i] ?? []) ?? 0.5;
        cy = Math.max(0, Math.min(H - cropH, Math.round(fy * H - cropH / 2)));
      }
      cx -= cx % 2;
      cy -= cy % 2;

      const seg = join(tmp, `seg_${String(i).padStart(3, "0")}.mp4`);
      const filter = `crop=${cropW}:${cropH}:${cx}:${cy}`;
      const args = [
        "-y",
        "-ss", String(s),
        "-to", String(e),
        "-i", src,
        "-vf", filter,
        "-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-pix_fmt", "yuv420p",
        "-c:a", "aac", "-b:a", "192k",
        "-movflags", "+faststart",
        seg,
      ];
      const { code, stderr } = await run(FFMPEG_BIN, args);
      if (code !== 0) throw new Error(`ffmpeg failed on shot ${i + 1}: ${stderr.split("\n").slice(-4).join(" ")}`);
      segFiles.push(seg);
    }

    // Concat the reframed shots into a persistent file in the project's media dir.
    const stamp = `${Math.round(dur * 1000)}_${shots.length}_${cropW}x${cropH}`;
    const outPath = join(mediaDir, `reframed_${targetAspect.replace(/[^0-9]/g, "")}_${stamp}.mp4`);
    if (segFiles.length === 1) {
      await Bun.write(outPath, Bun.file(segFiles[0]));
    } else {
      const listPath = join(tmp, "concat.txt");
      await Bun.write(listPath, segFiles.map((p) => `file '${p.replace(/'/g, "'\\''")}'`).join("\n"));
      const { code, stderr } = await run(FFMPEG_BIN, [
        "-y", "-f", "concat", "-safe", "0", "-i", listPath, "-c", "copy", "-movflags", "+faststart", outPath,
      ]);
      if (code !== 0) throw new Error(`concat failed: ${stderr.split("\n").slice(-4).join(" ")}`);
    }
    return { path: outPath, width: cropW, height: cropH, durationSeconds: dur, shots: shots.length };
  } finally {
    await rm(tmp, { recursive: true, force: true }).catch(() => {});
  }
}
