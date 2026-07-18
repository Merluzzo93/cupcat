// Local smooth slow-motion (B4): render a motion-interpolated slowed version of a clip with
// ffmpeg's `minterpolate` — it synthesizes in-between frames along estimated motion vectors, the
// same idea as RIFE but built into the bundled ffmpeg, so no extra binary or model download. CapCut
// paywalls "smooth slow-mo"; here it's local and free. Output is a NEW video asset the user can
// drop on the timeline.

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FFMPEG_BIN, mediaDir } from "./config";
import { probeMedia } from "./ffmpeg";
import { run } from "./proc";

export interface SlowMoResult {
  path: string;
  factor: number;
  outFps: number;
  durationSeconds: number;
}

/** Render `src` slowed by `factor` (e.g. 0.5 = half speed, twice as long) with motion interpolation.
 * outFps defaults to the source fps so the slowed clip is smooth (interpolated), not stuttered. */
export async function smoothSlowMo(src: string, factor: number, opts: { outFps?: number } = {}): Promise<SlowMoResult> {
  const f = Math.min(1, Math.max(0.1, factor)); // slow-mo only (<1); 1 would be a no-op
  const probe = await probeMedia(src);
  const dur = probe.durationSeconds || 0;
  if (dur <= 0) throw new Error("Could not read the video's duration.");
  const srcFps = probe.fps && probe.fps > 0 ? probe.fps : 30;
  const outFps = Math.round(opts.outFps ?? srcFps);

  const tmp = await mkdtemp(join(tmpdir(), "ccslowmo-"));
  try {
    const outPath = join(mediaDir, `slowmo_${Math.round(1 / f * 100)}pct_${Math.round(dur * 1000)}.mp4`);
    // setpts slows the presentation timestamps; minterpolate then fills the new frame slots along
    // motion vectors (mci = motion-compensated interpolation) for fluid motion instead of duplicates.
    const vf = `setpts=${(1 / f).toFixed(4)}*PTS,minterpolate=fps=${outFps}:mi_mode=mci:mc_mode=aobmc:me_mode=bidir:vsbmc=1`;
    const args = [
      "-y",
      "-i", src,
      "-vf", vf,
      "-an", // slowed audio is rarely wanted; keep it silent (the user can keep the original audio track)
      "-c:v", "libx264", "-preset", "medium", "-crf", "17", "-pix_fmt", "yuv420p",
      "-movflags", "+faststart",
      outPath,
    ];
    const { code, stderr } = await run(FFMPEG_BIN, args);
    if (code !== 0) throw new Error(`ffmpeg minterpolate failed: ${stderr.split("\n").slice(-4).join(" ")}`);
    const outProbe = await probeMedia(outPath);
    return { path: outPath, factor: f, outFps, durationSeconds: outProbe.durationSeconds || dur / f };
  } finally {
    await rm(tmp, { recursive: true, force: true }).catch(() => {});
  }
}
