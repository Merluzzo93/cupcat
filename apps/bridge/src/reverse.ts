// Play a video backwards, without running the machine out of memory.
//
// ffmpeg has a `reverse` filter and it is a trap: it buffers every decoded frame in RAM, so the
// one-line version works on the ten-second clip you test it with and dies on the two-minute one the
// user actually has. A minute of 1080p is roughly 5 GB of raw frames.
//
// So the picture is reversed in chunks — each chunk decoded, reversed and encoded on its own, then
// the chunks concatenated in the opposite order, which is the same thing as reversing the whole file.
// Chunk length is chosen from the frame size so the buffer stays near a fixed budget: small frames get
// long chunks, 4K gets short ones. Audio does not need this — a reversed audio track is a few hundred
// megabytes even for a long video — so it is done in one pass and muxed back in, which also avoids the
// clicks that per-chunk AAC encoding leaves at every join.

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FFMPEG_BIN, mediaDir } from "./config";
import { probeMedia } from "./ffmpeg";
import { run } from "./proc";

export interface ReverseResult {
  path: string;
  durationSeconds: number;
  /** How many pieces the picture had to be reversed in. 1 means it fitted in one pass. */
  chunks: number;
  hasAudio: boolean;
}

export interface ReverseOptions {
  onProgress?: (done: number, total: number) => void;
  killTag?: string;
  /** Peak decoded-frame buffer to aim for, in bytes. Lower it on a machine that is short on RAM. */
  frameBudgetBytes?: number;
}

/** Seconds of video whose decoded frames stay inside the budget. Clamped: below ~2s the chunk joins
 * start costing more than the memory they save, above ~15s a 4K source blows past the budget anyway. */
export function chunkSeconds(width: number, height: number, fps: number, budgetBytes: number): number {
  const perFrame = Math.max(1, width * height * 1.5); // yuv420p
  const frames = budgetBytes / perFrame;
  const seconds = frames / Math.max(1, fps);
  return Math.min(15, Math.max(2, Math.floor(seconds)));
}

/** Chunk boundaries covering [0, duration), longest-first order NOT applied — plain forward order. */
export function chunkRanges(durationSeconds: number, seconds: number): { start: number; length: number }[] {
  const out: { start: number; length: number }[] = [];
  for (let t = 0; t < durationSeconds - 1e-6; t += seconds) {
    out.push({ start: Math.round(t * 1000) / 1000, length: Math.round(Math.min(seconds, durationSeconds - t) * 1000) / 1000 });
  }
  return out;
}

const V_CODEC = ["-c:v", "libx264", "-preset", "medium", "-crf", "18", "-pix_fmt", "yuv420p"];

export async function reverseVideo(src: string, opts: ReverseOptions = {}): Promise<ReverseResult> {
  const probe = await probeMedia(src);
  const dur = probe.durationSeconds || 0;
  if (dur <= 0) throw new Error("Could not read the video's duration.");
  const fps = probe.fps && probe.fps > 0 ? probe.fps : 30;
  const seconds = chunkSeconds(probe.width ?? 1920, probe.height ?? 1080, fps, opts.frameBudgetBytes ?? 800_000_000);
  const ranges = chunkRanges(dur, seconds);
  // The app makes this folder at startup, but this function is also called before that has happened —
  // ffmpeg's answer to a missing output directory is "No such file or directory" after all the work.
  await mkdir(mediaDir, { recursive: true });
  const outPath = join(mediaDir, `reversed_${Math.round(dur * 1000)}_${Date.now()}.mp4`);
  const tag = opts.killTag;

  // Short enough to hold whole: one pass, and the audio comes along for free.
  if (ranges.length <= 1) {
    const args = ["-y", "-i", src, "-vf", "reverse", ...(probe.hasAudio ? ["-af", "areverse", "-c:a", "aac", "-b:a", "192k"] : ["-an"]), ...V_CODEC, "-movflags", "+faststart", outPath];
    opts.onProgress?.(0, 1);
    const { code, stderr } = await run(FFMPEG_BIN, args, { tag });
    if (code !== 0) throw new Error(`ffmpeg reverse failed: ${stderr.split("\n").slice(-4).join(" ")}`);
    opts.onProgress?.(1, 1);
    const out = await probeMedia(outPath);
    return { path: outPath, durationSeconds: out.durationSeconds || dur, chunks: 1, hasAudio: probe.hasAudio };
  }

  const tmp = await mkdtemp(join(tmpdir(), "ccrev-"));
  try {
    const total = ranges.length + (probe.hasAudio ? 2 : 1);
    const pieces: string[] = [];
    for (let i = 0; i < ranges.length; i++) {
      const r = ranges[i]!;
      const piece = join(tmp, `p${String(i).padStart(5, "0")}.mp4`);
      // -ss/-t BEFORE -i: ffmpeg decodes from the keyframe before the mark and discards, so the cut
      // is frame-accurate. Keyframe-snapped seeking here would drop or double frames at every join.
      const args = ["-y", "-ss", String(r.start), "-t", String(r.length), "-i", src, "-an", "-vf", "reverse", ...V_CODEC, piece];
      const { code, stderr } = await run(FFMPEG_BIN, args, { tag });
      if (code !== 0) throw new Error(`ffmpeg reverse (piece ${i + 1}/${ranges.length}) failed: ${stderr.split("\n").slice(-4).join(" ")}`);
      pieces.push(piece);
      opts.onProgress?.(i + 1, total);
    }

    // Last piece first: reversing every piece and then playing them back-to-front IS the reversal.
    const listPath = join(tmp, "list.txt");
    await writeFile(listPath, [...pieces].reverse().map((p) => `file '${p.replace(/\\/g, "/").replace(/'/g, "'\\''")}'`).join("\n"), "utf8");

    let audioPath: string | null = null;
    if (probe.hasAudio) {
      audioPath = join(tmp, "audio.m4a");
      const { code, stderr } = await run(FFMPEG_BIN, ["-y", "-i", src, "-vn", "-af", "areverse", "-c:a", "aac", "-b:a", "192k", audioPath], { tag });
      // Losing the sound is not a reason to lose the picture; the caller reports it.
      if (code !== 0) {
        audioPath = null;
        void stderr;
      }
      opts.onProgress?.(ranges.length + 1, total);
    }

    const muxArgs = [
      "-y",
      "-f", "concat", "-safe", "0", "-i", listPath,
      ...(audioPath ? ["-i", audioPath, "-c:a", "copy"] : []),
      "-c:v", "copy",
      "-movflags", "+faststart",
      outPath,
    ];
    const { code, stderr } = await run(FFMPEG_BIN, muxArgs, { tag });
    if (code !== 0) throw new Error(`ffmpeg concat failed: ${stderr.split("\n").slice(-4).join(" ")}`);
    opts.onProgress?.(total, total);

    const out = await probeMedia(outPath);
    return { path: outPath, durationSeconds: out.durationSeconds || dur, chunks: ranges.length, hasAudio: audioPath !== null };
  } finally {
    await rm(tmp, { recursive: true, force: true }).catch(() => {});
  }
}
