// Looking at a video's structure has to be cheap to ask for twice.
//
// The bug this pins: analyzing a 32-minute file decoded the ORIGINAL twice (once for black/freeze,
// once for scenes) and remembered nothing. An assistant asks for it on every turn and again after
// every interruption, so the same seven-minute measurement ran over and over and the user's session
// went by without a single edit being made. The fix is a cache keyed to the file, plus reading the
// light preview copy — the tests below hold both ends of that.

import { describe, expect, it } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { analyzeVideo, scrubProxyPath } from "./ffmpeg";

/**
 * The BUNDLED ffmpeg, not whatever is on PATH.
 *
 * This used to fall back to the bare name "ffmpeg", which quietly meant these tests measured a
 * different build from the one CupCat ships — the exact mistake CLAUDE.md warns about, and one that
 * has already let a filter change through. On a machine with no ffmpeg on PATH the fallback did not
 * even fail honestly: Bun.spawn threw from inside the helper.
 */
const BUNDLED_FFMPEG = resolve(import.meta.dir, "..", "..", "desktop", "src-tauri", "sidecars", "ffmpeg.exe");

async function makeVideo(path: string, seconds: number, color: string): Promise<void> {
  const ff = process.env.CUPCAT_FFMPEG_BIN ?? BUNDLED_FFMPEG;
  const proc = Bun.spawn(
    [ff, "-y", "-v", "error", "-f", "lavfi", "-i", `color=c=${color}:size=160x120:duration=${seconds}:rate=10`, "-pix_fmt", "yuv420p", path],
    { stdout: "ignore", stderr: "ignore" },
  );
  await proc.exited;
}

// Skipped rather than failed when the bundled engines have not been provisioned — `bun run sidecars`
// fetches them, and CI does it before this ever runs.
const haveFfmpeg = !!process.env.CUPCAT_FFMPEG_BIN || existsSync(BUNDLED_FFMPEG);

describe.skipIf(!haveFfmpeg)("analysing a video", () => {
  it("measures once and then answers from the cache", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cupcat-analysis-"));
    try {
      const src = join(dir, "clip.mp4");
      await makeVideo(src, 1, "black");

      const first = await analyzeVideo(src);
      // The cache is written beside the media, like the waveform peaks.
      expect(await Bun.file(`${src}.analysis.json`).exists()).toBe(true);

      const second = await analyzeVideo(src);
      expect(second).toEqual(first);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 60_000);

  it("measures again when the file itself changed", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cupcat-analysis-"));
    try {
      const src = join(dir, "clip.mp4");
      await makeVideo(src, 1, "black");
      await analyzeVideo(src);
      const cached = await Bun.file(`${src}.analysis.json`).json();

      // Re-encode over the same path: a stale answer for different footage is worse than no cache.
      await new Promise((r) => setTimeout(r, 1100)); // mtime has second resolution on some filesystems
      await makeVideo(src, 2, "white");
      await analyzeVideo(src);
      const fresh = await Bun.file(`${src}.analysis.json`).json();

      expect(fresh.mtimeMs).not.toBe(cached.mtimeMs);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 60_000);

  it("reads the light preview copy when one exists", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cupcat-analysis-"));
    try {
      const src = join(dir, "clip.mp4");
      await makeVideo(src, 1, "black");
      // A proxy whose CONTENT differs from the original: if the analysis came from the original,
      // the scene change between the proxy's two halves could not appear.
      const proxy = scrubProxyPath(src);
      const ff = process.env.CUPCAT_FFMPEG_BIN ?? BUNDLED_FFMPEG;
      const p = Bun.spawn(
        [
          ff, "-y", "-v", "error",
          "-f", "lavfi", "-i", "color=c=black:size=160x120:duration=1:rate=10",
          "-f", "lavfi", "-i", "color=c=white:size=160x120:duration=1:rate=10",
          "-filter_complex", "[0:v][1:v]concat=n=2:v=1[v]", "-map", "[v]", "-pix_fmt", "yuv420p", proxy,
        ],
        { stdout: "ignore", stderr: "ignore" },
      );
      await p.exited;

      const a = await analyzeVideo(src);
      // Black to white is as big a scene change as exists; the original is one flat colour.
      expect(a.sceneChanges.length).toBeGreaterThan(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 60_000);

  it("does not answer a full analysis from a scenes-only measurement", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cupcat-analysis-"));
    try {
      const src = join(dir, "clip.mp4");
      await makeVideo(src, 1, "black");
      await analyzeVideo(src, { scenesOnly: true });
      const cached = await Bun.file(`${src}.analysis.json`).json();
      expect(cached.scenesOnly).toBe(true);

      await analyzeVideo(src); // full: needs black/freeze, which the cached run never looked for
      const after = await Bun.file(`${src}.analysis.json`).json();
      expect(after.scenesOnly).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 60_000);

  it("survives a corrupt cache file rather than failing the call", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cupcat-analysis-"));
    try {
      const src = join(dir, "clip.mp4");
      await makeVideo(src, 1, "black");
      await writeFile(`${src}.analysis.json`, "{not json");
      const a = await analyzeVideo(src);
      expect(Array.isArray(a.sceneChanges)).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 60_000);
});
