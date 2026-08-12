// What may be deleted from a project's exports/ folder, and what may never be.
//
// The folder holds two very different things side by side: the videos the user rendered, which are
// the whole point, and CupCat's own working files, which are litter. One project had 5,397 pieces of
// litter and two abandoned browser profiles in it. The sweep exists to fix that, so the tests that
// matter here are the ones that prove it cannot touch the other kind of file.

import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isScratchName, STALE_MS, sweepScratch } from "./scratch";

const OLD = Date.now() - 24 * 60 * 60 * 1000; // yesterday

function fixture(): string {
  const dir = mkdtempSync(join(tmpdir(), "cupcat-scratch-"));
  const aged = (name: string) => {
    const p = join(dir, name);
    writeFileSync(p, "x");
    utimesSync(p, new Date(OLD), new Date(OLD));
  };
  // Litter, all of it a day old.
  aged("_richtext_1786552996286.ass");
  aged("_text_1786552996286.txt");
  aged("_frame_60.jpg");
  aged("_inspect_3.jpg");
  aged("_lossless_concat.txt");
  const prof = join(dir, "_mgprofile_19631");
  mkdirSync(prof);
  writeFileSync(join(prof, "DevToolsActivePort"), "19631");
  utimesSync(prof, new Date(OLD), new Date(OLD));
  // The things that must survive.
  writeFileSync(join(dir, "export.mp4"), "video");
  writeFileSync(join(dir, "teaser.mp4"), "video");
  writeFileSync(join(dir, "subtitles-original.srt"), "1\n");
  writeFileSync(join(dir, "_comp_abc123_ff00.mp4"), "a compound bake, still wanted");
  writeFileSync(join(dir, "clips-2026-08-12"), "a clip folder name");
  return dir;
}

describe("isScratchName", () => {
  test("recognises every working file CupCat writes", () => {
    for (const n of ["_richtext_1.ass", "_text_1.txt", "_frame_0.jpg", "_inspect_9.jpg", "_mgprofile_1786_42", "_lossless_concat.txt"]) {
      expect(isScratchName(n)).toBe(true);
    }
  });

  test("leaves compound bakes alone — they are a cache that gets read back", () => {
    expect(isScratchName("_comp_cmp_a1_9f3e.mp4")).toBe(false);
  });

  test("a user's own file is never litter, whatever it is called", () => {
    for (const n of ["export.mp4", "teaser.mp4", "subtitles-original.srt", "richtext_notes.txt", "frame_grab.jpg", "clips-2026-08-12"]) {
      expect(isScratchName(n)).toBe(false);
    }
  });
});

describe("sweepScratch", () => {
  test("removes stale working files and nothing else", async () => {
    const dir = fixture();
    try {
      const n = await sweepScratch({ dir });
      expect(n).toBe(6);
      const left = readdirSync(dir).sort();
      expect(left).toEqual(["_comp_abc123_ff00.mp4", "clips-2026-08-12", "export.mp4", "subtitles-original.srt", "teaser.mp4"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a working file from a render still running is left where it is", async () => {
    // The reason the sweep is safe to call at the start of an export: a long render writes its
    // subtitle files first and reads them until the last frame.
    const dir = mkdtempSync(join(tmpdir(), "cupcat-scratch-live-"));
    try {
      writeFileSync(join(dir, "_richtext_now.ass"), "in use");
      expect(await sweepScratch({ dir })).toBe(0);
      expect(readdirSync(dir)).toEqual(["_richtext_now.ass"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("the age threshold is what decides, and it is six hours", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cupcat-scratch-age-"));
    try {
      const p = join(dir, "_inspect_1.jpg");
      writeFileSync(p, "x");
      const fiveHours = Date.now() - 5 * 60 * 60 * 1000;
      utimesSync(p, new Date(fiveHours), new Date(fiveHours));
      expect(STALE_MS).toBe(6 * 60 * 60 * 1000);
      expect(await sweepScratch({ dir })).toBe(0);
      expect(await sweepScratch({ dir, now: Date.now() + 2 * 60 * 60 * 1000 })).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a missing exports folder is not an error", async () => {
    expect(await sweepScratch({ dir: join(tmpdir(), "cupcat-does-not-exist-4213") })).toBe(0);
  });

  test("an abandoned browser profile goes with its contents", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cupcat-scratch-prof-"));
    try {
      const prof = join(dir, "_mgprofile_19421");
      mkdirSync(join(prof, "Default"), { recursive: true });
      writeFileSync(join(prof, "Default", "Preferences"), "{}");
      utimesSync(prof, new Date(OLD), new Date(OLD));
      expect(await sweepScratch({ dir })).toBe(1);
      expect(readdirSync(dir)).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
