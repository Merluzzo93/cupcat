// Logic test for the external-change toast summarizer.
// Run with `bun test` (bun re-maps the vitest import to bun:test) or `bunx vitest run`.
import { describe, expect, test } from "vitest";
import type { Clip, Project, Track } from "@cupcat/editor-core";
import { summarizeProjectChange } from "./projectDiff";

// Minimal structural fakes — only the fields the summarizer reads.
function clip(id: string, startFrame = 0, durationFrames = 60): Clip {
  return { id, startFrame, durationFrames } as Clip;
}
function track(id: string, clips: Clip[], extra?: Partial<Track>): Track {
  return { id, type: "video", muted: false, hidden: false, locked: false, syncLocked: true, clips, ...extra } as Track;
}
function proj(tracks: Track[], init?: { media?: string[]; width?: number; height?: number; fps?: number }): Project {
  return {
    id: "proj_test",
    name: "test",
    timeline: {
      fps: init?.fps ?? 30,
      width: init?.width ?? 1920,
      height: init?.height ?? 1080,
      settingsConfigured: true,
      tracks,
    },
    media: (init?.media ?? []).map((id) => ({ id, type: "video", name: id, durationSeconds: 1, hasAudio: true, generationStatus: "completed" })),
    folders: [],
  } as unknown as Project;
}

describe("summarizeProjectChange", () => {
  test("identical projects → null", () => {
    const a = proj([track("t1", [clip("clip_a"), clip("clip_b", 60)])], { media: ["m1"] });
    expect(summarizeProjectChange(a, structuredClone(a))).toBeNull();
  });

  test("clips added and removed", () => {
    const prev = proj([track("t1", [clip("clip_a"), clip("clip_b", 60)])]);
    const next = proj([track("t1", [clip("clip_a"), clip("clip_c", 60), clip("clip_d", 120)])]);
    expect(summarizeProjectChange(prev, next)).toBe("Timeline updated: +2 clips, -1 clip");
  });

  test("clips modified in place (trim/move) count as changed", () => {
    const prev = proj([track("t1", [clip("clip_a"), clip("clip_b", 60), clip("clip_c", 120)])]);
    const next = proj([track("t1", [clip("clip_a", 0, 30), clip("clip_b", 90), clip("clip_c", 120, 90)])]);
    expect(summarizeProjectChange(prev, next)).toBe("Timeline updated: 3 clips changed");
  });

  test("track count change", () => {
    const prev = proj([track("t1", []), track("t2", [])]);
    const next = proj([track("t1", []), track("t2", []), track("t3", [])]);
    expect(summarizeProjectChange(prev, next)).toBe("Tracks: 2→3");
  });

  test("library assets added", () => {
    const prev = proj([], { media: ["m1"] });
    const next = proj([], { media: ["m1", "m2", "m3"] });
    expect(summarizeProjectChange(prev, next)).toBe("Library: +2 assets");
  });

  test("format change", () => {
    const prev = proj([], { width: 1920, height: 1080 });
    const next = proj([], { width: 1080, height: 1920 });
    expect(summarizeProjectChange(prev, next)).toBe("Format: 1920×1080 → 1080×1920");
  });

  test("combined changes join with a separator", () => {
    const prev = proj([track("t1", [clip("clip_a")])], { media: [] });
    const next = proj([track("t1", [clip("clip_a")]), track("t2", [clip("clip_b")])], { media: ["m1"] });
    expect(summarizeProjectChange(prev, next)).toBe("Timeline updated: +1 clip · Tracks: 1→2 · Library: +1 asset");
  });

  test("unclassified change (track property) falls back to generic", () => {
    const prev = proj([track("t1", [clip("clip_a")])]);
    const next = proj([track("t1", [clip("clip_a")], { muted: true })]);
    expect(summarizeProjectChange(prev, next)).toBe("Project updated");
  });
});
