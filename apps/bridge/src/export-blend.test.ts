// Placing a blend-mode layer, and reading ffmpeg's mind when it gives up.
//
// A teaser with four screen-blended flash frames, each scaled to nearly twice the canvas, exported
// to a zero-byte file. `pad` only ever grows a frame, so a layer bigger than the canvas asked it to
// pad to a SMALLER size at a NEGATIVE offset; ffmpeg refused with EINVAL, the graph never built, and
// the message that reached the user was "Could not open encoder before EOF" — from the audio
// encoder, which had simply never been handed a frame. Both halves of that are pinned here.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EditorDocument, makeClip, makeTrack } from "@cupcat/editor-core";
import { FFMPEG_BIN, projectRoot, setProjectDir } from "./config";
import { blendFitFilter, exportTimeline, ffmpegFailureReason } from "./export";

// The render below goes through FFMPEG_BIN, the same binary the app uses, and the fixture is built
// with it too — so that is the one that has to be there for the test to mean anything. Asking it for
// its version is the only honest check: FFMPEG_BIN is a bare "ffmpeg" on a dev machine and a path to
// the bundled build in the app. With none available the render skips, and the arithmetic tests still
// pin the fault that caused this.
const ffmpeg = Bun.spawnSync([FFMPEG_BIN, "-version"]).exitCode === 0 ? FFMPEG_BIN : null;

let dir = "";
let previous = "";
let source = "";

beforeAll(async () => {
  previous = projectRoot;
  dir = mkdtempSync(join(tmpdir(), "cupcat-blend-"));
  setProjectDir(dir);
  mkdirSync(join(dir, "exports"), { recursive: true }); // where exports land; a real project has it
  if (ffmpeg) {
    // A real one-second file: the fault only ever showed up in a real render.
    source = join(dir, "src.mp4");
    Bun.spawnSync([ffmpeg, "-v", "error", "-f", "lavfi", "-i", "testsrc=size=640x360:rate=30:duration=1",
      "-f", "lavfi", "-i", "sine=frequency=440:duration=1", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", "-y", source]);
  }
});

afterAll(() => {
  setProjectDir(previous);
  rmSync(dir, { recursive: true, force: true });
});

describe("blendFitFilter", () => {
  test("a layer that fits is placed where it was asked, and nothing is cropped away", () => {
    const f = blendFitFilter(100, 50, 1920, 1080);
    expect(f).toContain("pad=1920:1080:100:50:color=black@0.0");
    expect(f).toContain("x='min(0,iw-1)'");
    expect(f).toContain("y='min(0,ih-1)'");
  });

  test("a layer hanging off the top-left pads from zero and crops the overflow", () => {
    // This is the case that killed the export: pad=1920:1080:-864:-486.
    const f = blendFitFilter(-864, -486, 1920, 1080);
    expect(f).toContain("pad=1920:1080:0:0:color=black@0.0");
    expect(f).toContain("x='min(864,iw-1)'");
    expect(f).toContain("y='min(486,ih-1)'");
  });

  test("no geometry can produce a negative pad offset — that is the whole bug", () => {
    for (const [x, y] of [[-864, -486], [-5000, 12], [0, -1], [-0.4, -0.6], [3000, 3000]] as const) {
      const pad = blendFitFilter(x, y, 1920, 1080).match(/pad=\d+:\d+:(-?\d+):(-?\d+)/)!;
      expect(Number(pad[1])).toBeGreaterThanOrEqual(0);
      expect(Number(pad[2])).toBeGreaterThanOrEqual(0);
    }
  });

  test("a layer pushed past the right edge still leaves a legal crop width", () => {
    // W - px would go to zero or below; the width must never be asked to be 0.
    expect(blendFitFilter(1920, 1080, 1920, 1080)).toContain("min(iw-0,1)");
  });

  test("fractional positions are rounded, not passed through as decimals ffmpeg would reject", () => {
    expect(blendFitFilter(10.6, -10.6, 1920, 1080)).toContain("pad=1920:1080:11:0:");
  });
});

describe("ffmpegFailureReason", () => {
  // Trimmed from the real failure, in the order ffmpeg printed it.
  const REAL = [
    "[Parsed_pad_46 @ 000001] Padded dimensions cannot be smaller than input dimensions.",
    "[AVFilterGraph @ 000002] Error initializing filter 'pad' with args '1920:1080:-864:-486:color=black@0.0'",
    "[vost#0:0/libx264 @ 000003] Terminating thread with return code -22 (Invalid argument)",
    "[aost#0:1/aac @ 000004] [enc:aac @ 000005] Could not open encoder before EOF",
    "[aost#0:1/aac @ 000004] Task finished with error code: -22 (Invalid argument)",
    "[aost#0:1/aac @ 000004] Terminating thread with return code -22 (Invalid argument)",
    "[out#0/mp4 @ 000006] Nothing was written into output file, because at least one of its streams received no packets.",
    "frame=    0 fps=0.0 q=0.0 Lsize=       0KiB time=N/A bitrate=N/A speed=N/A",
    "Conversion failed!",
  ].join("\n");

  test("the cause is reported, not the wreckage that follows it", () => {
    const reason = ffmpegFailureReason(REAL);
    expect(reason).toContain("Padded dimensions cannot be smaller than input dimensions");
  });

  test("the tail is kept too, so nothing that was shown before is lost", () => {
    expect(ffmpegFailureReason(REAL)).toContain("Conversion failed!");
  });

  test("the audio encoder's complaint is no longer the headline", () => {
    const first = ffmpegFailureReason(REAL).split("\n")[0]!;
    expect(first).not.toContain("Could not open encoder before EOF");
  });

  test("a failure with no obvious cause line still says something", () => {
    const vague = "some output\nmore output\nConversion failed!";
    expect(ffmpegFailureReason(vague).length).toBeGreaterThan(0);
  });

  test("blank lines do not become the answer", () => {
    expect(ffmpegFailureReason("\n\n\n")).toBe("");
  });
});

describe("exporting a blend-mode clip bigger than the canvas", () => {
  /** A 320x180 canvas with one full-frame clip and one screen-blended clip scaled to ~1.9x. */
  function doc(): EditorDocument {
    const d = new EditorDocument();
    d.project.name = "Blend";
    d.project.media.push({
      id: "a1", name: "src.mp4", type: "video", url: source, durationSeconds: 1, hasAudio: true,
      generationStatus: { kind: "none" },
    } as never);
    d.project.timeline.fps = 30;
    d.project.timeline.width = 320;
    d.project.timeline.height = 180;

    const flash = makeTrack("video");
    flash.clips.push(
      makeClip({
        mediaRef: "a1", mediaType: "video", sourceClipType: "video", startFrame: 0, durationFrames: 15, trimStartFrame: 0,
        blendMode: "screen",
        // 1.9x the canvas, centred: the top-left corner lands at -0.45 → a negative offset.
        transform: { centerX: 0.5, centerY: 0.5, width: 1.9, height: 1.9, rotation: 0, flipHorizontal: false, flipVertical: false },
      }),
    );
    const bed = makeTrack("video");
    bed.clips.push(makeClip({ mediaRef: "a1", mediaType: "video", sourceClipType: "video", startFrame: 0, durationFrames: 30, trimStartFrame: 0 }));
    d.project.timeline.tracks.push(flash, bed);
    return d;
  }

  test.skipIf(ffmpeg === null)("produces a real file instead of dying on the audio encoder", async () => {
    const res = await exportTimeline(doc(), "blend.mp4", "mp4_h264");
    expect(res.error ?? "").toBe("");
    expect(res.ok).toBe(true);
    expect(statSync(res.path!).size).toBeGreaterThan(1000);
  }, 180_000);
});
