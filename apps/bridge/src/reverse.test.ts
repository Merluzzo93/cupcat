// The chunking arithmetic behind reverse_video, and the real thing on a real file.
//
// ffmpeg's reverse filter buffers every decoded frame, so the only interesting decisions here are how
// big a chunk may be and whether the chunks tile the video exactly — a missing tenth of a second at a
// join is a dropped frame in the middle of the finished clip.

import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chunkRanges, chunkSeconds, reverseVideo } from "./reverse";
import { probeMedia } from "./ffmpeg";

describe("chunkSeconds", () => {
  test("a small frame gets a long chunk, 4K a short one", () => {
    const sd = chunkSeconds(640, 360, 30, 800_000_000);
    const uhd = chunkSeconds(3840, 2160, 30, 800_000_000);
    expect(sd).toBeGreaterThan(uhd);
  });

  test("stays inside the budget it was given", () => {
    const budget = 800_000_000;
    for (const [w, h, fps] of [[1920, 1080, 30], [3840, 2160, 60], [1280, 720, 24]] as const) {
      const s = chunkSeconds(w, h, fps, budget);
      if (s > 2) expect(s * fps * w * h * 1.5).toBeLessThanOrEqual(budget); // 2s is the floor, budget or not
    }
  });

  test("never returns 0 or a chunk longer than 15s, whatever the numbers", () => {
    expect(chunkSeconds(7680, 4320, 120, 1000)).toBe(2);
    expect(chunkSeconds(16, 16, 1, 8_000_000_000)).toBe(15);
  });
});

describe("chunkRanges", () => {
  test("tiles the whole video with no gap and no overlap", () => {
    const rs = chunkRanges(17, 5);
    expect(rs).toHaveLength(4);
    expect(rs[0]!.start).toBe(0);
    for (let i = 1; i < rs.length; i++) expect(rs[i]!.start).toBeCloseTo(rs[i - 1]!.start + rs[i - 1]!.length, 6);
    expect(rs.reduce((s, r) => s + r.length, 0)).toBeCloseTo(17, 6);
  });

  test("an exact multiple does not produce a trailing zero-length chunk", () => {
    const rs = chunkRanges(15, 5);
    expect(rs).toHaveLength(3);
    expect(rs.every((r) => r.length > 0)).toBe(true);
  });

  test("shorter than one chunk is one chunk", () => {
    expect(chunkRanges(3, 5)).toEqual([{ start: 0, length: 3 }]);
  });
});

// The bundled ffmpeg, never the one on PATH — they are different builds and behave differently.
const BUNDLED_FFMPEG = process.env.CUPCAT_FFMPEG_BIN ?? join(import.meta.dir, "../../desktop/src-tauri/sidecars/ffmpeg.exe");
const haveFfmpeg = existsSync(BUNDLED_FFMPEG);

describe.skipIf(!haveFfmpeg)("reverseVideo end to end", () => {
  test(
    "reverses a real file, in more than one chunk, keeping its length and its sound",
    async () => {
      // Synthesised rather than checked in: a counting clip is the only kind where 'is it backwards?'
      // has an answer a test can read, and it keeps this runnable on a clean machine.
      const src = join(tmpdir(), `cctest-fwd-${process.pid}.mp4`);
      const mk = Bun.spawnSync([
        BUNDLED_FFMPEG, "-y",
        "-f", "lavfi", "-i", "testsrc=size=320x240:rate=25:duration=6",
        "-f", "lavfi", "-i", "sine=frequency=440:duration=6",
        "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", src,
      ]);
      expect(mk.exitCode).toBe(0);

      // A tiny budget forces the chunked path on a short clip, which is the path worth testing.
      const res = await reverseVideo(src, { frameBudgetBytes: 5_000_000 });
      try {
        expect(res.chunks).toBeGreaterThan(1);
        expect(res.hasAudio).toBe(true);
        const before = await probeMedia(src);
        const after = await probeMedia(res.path);
        expect(after.durationSeconds).toBeCloseTo(before.durationSeconds, 0);
        expect(after.width).toBe(before.width!);
        expect(after.hasAudio).toBe(true);
      } finally {
        await rm(res.path, { force: true }).catch(() => {});
        await rm(src, { force: true }).catch(() => {});
      }
    },
    600_000,
  );
});
