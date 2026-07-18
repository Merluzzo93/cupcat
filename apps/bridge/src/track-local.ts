// Local motion tracking (B6): follow a region (a face, an object) through a shot with pure-JS
// template matching on downscaled grayscale frames — no ML model, no extra binary. Returns the
// tracked region's CENTER as frame fractions per sampled time; the executor turns that into position
// keyframes so a text/sticker/overlay "sticks" to the moving subject. Deterministic and offline.

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FFMPEG_BIN } from "./config";
import { run } from "./proc";

const TRACK_W = 256; // downscaled tracking width (height derived from aspect)

export interface TrackPoint {
  sourceSeconds: number;
  cx: number; // tracked-region center X, fraction 0..1 of the frame
  cy: number;
}

export interface Roi {
  x: number; // top-left, fraction 0..1
  y: number;
  w: number;
  h: number;
}

/** Read one downscaled grayscale frame (TRACK_W × th) at `atSeconds` into a Uint8Array, or null. */
async function grayFrame(src: string, atSeconds: number, th: number, tmp: string, seq: number): Promise<Uint8Array | null> {
  const raw = join(tmp, `t_${seq}.gray`);
  const args = ["-y"];
  if (atSeconds > 0.001) args.push("-ss", String(atSeconds));
  args.push("-i", src, "-frames:v", "1", "-vf", `scale=${TRACK_W}:${th},format=gray`, "-f", "rawvideo", "-pix_fmt", "gray", raw);
  const { code } = await run(FFMPEG_BIN, args);
  if (code !== 0) return null;
  const f = Bun.file(raw);
  if (!(await f.exists())) return null;
  const buf = new Uint8Array(await f.arrayBuffer());
  return buf.length >= TRACK_W * th ? buf : null;
}

/** Sum of absolute differences between the template and the frame window at (ox, oy). */
function sad(frame: Uint8Array, fw: number, fh: number, tpl: Uint8Array, tw: number, th: number, ox: number, oy: number): number {
  let s = 0;
  for (let y = 0; y < th; y++) {
    const fr = (oy + y) * fw + ox;
    const tr = y * tw;
    for (let x = 0; x < tw; x++) s += Math.abs(frame[fr + x] - tpl[tr + x]);
  }
  return s;
}

/**
 * Track `roi` across the given source-time samples. Uses a fixed template from the first sample and
 * a local search around the previous match each step (with a light template refresh to survive slow
 * appearance change). Returns one center point per sample time.
 */
export async function trackMotion(src: string, roi: Roi, sampleSecs: number[], aspect: number): Promise<TrackPoint[]> {
  if (sampleSecs.length === 0) return [];
  const th = Math.max(16, Math.round(TRACK_W / (aspect > 0 ? aspect : 16 / 9)));
  const fw = TRACK_W;
  const fh = th;

  // Template geometry in tracking pixels (clamped inside the frame).
  let tw = Math.max(8, Math.min(fw - 2, Math.round(roi.w * fw)));
  let tht = Math.max(8, Math.min(fh - 2, Math.round(roi.h * fh)));
  let tx = Math.max(0, Math.min(fw - tw, Math.round(roi.x * fw)));
  let ty = Math.max(0, Math.min(fh - tht, Math.round(roi.y * fh)));

  const tmp = await mkdtemp(join(tmpdir(), "cctrack-"));
  try {
    const first = await grayFrame(src, sampleSecs[0], th, tmp, 0);
    if (!first) throw new Error("Could not read the first frame to track.");
    let tpl = new Uint8Array(tw * tht);
    for (let y = 0; y < tht; y++) for (let x = 0; x < tw; x++) tpl[y * tw + x] = first[(ty + y) * fw + (tx + x)];

    const out: TrackPoint[] = [{ sourceSeconds: sampleSecs[0], cx: (tx + tw / 2) / fw, cy: (ty + tht / 2) / fh }];
    let px = tx;
    let py = ty;
    const R = Math.max(6, Math.round(fw * 0.06)); // search radius in tracking pixels

    for (let i = 1; i < sampleSecs.length; i++) {
      const frame = await grayFrame(src, sampleSecs[i], th, tmp, i);
      if (!frame) {
        out.push(out[out.length - 1]); // hold last known position on a read failure
        continue;
      }
      let best = Infinity;
      let bx = px;
      let by = py;
      const x0 = Math.max(0, px - R);
      const x1 = Math.min(fw - tw, px + R);
      const y0 = Math.max(0, py - R);
      const y1 = Math.min(fh - tht, py + R);
      for (let oy = y0; oy <= y1; oy++) {
        for (let ox = x0; ox <= x1; ox++) {
          const s = sad(frame, fw, fh, tpl, tw, tht, ox, oy);
          if (s < best) {
            best = s;
            bx = ox;
            by = oy;
          }
        }
      }
      px = bx;
      py = by;
      out.push({ sourceSeconds: sampleSecs[i], cx: (px + tw / 2) / fw, cy: (py + tht / 2) / fh });
      // Light template refresh (blend 15% of the current match) to follow gradual appearance change
      // without drifting off a good lock.
      for (let y = 0; y < tht; y++) {
        for (let x = 0; x < tw; x++) {
          const cur = frame[(py + y) * fw + (px + x)];
          const idx = y * tw + x;
          tpl[idx] = Math.round(tpl[idx] * 0.85 + cur * 0.15);
        }
      }
    }
    return out;
  } finally {
    await rm(tmp, { recursive: true, force: true }).catch(() => {});
  }
}
