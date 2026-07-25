// Which cameras count as "angles" at a given instant, and which one is on air.
//
// The rule has to hold without any multicam object in the project: angles are just the clips that
// cover the playhead on separate video tracks, whether Sync cameras stacked them or a person did.

import { describe, expect, it } from "vitest";
import type { Clip, Project, Track } from "@cupcat/editor-core";
import { anglesAt } from "./Angles";

function clip(over: Partial<Clip> & { id: string; startFrame: number; durationFrames: number }): Clip {
  return {
    mediaRef: `asset_${over.id}`,
    mediaType: "video",
    sourceClipType: "video",
    trimStartFrame: 0,
    trimEndFrame: 0,
    speed: 1,
    volume: 1,
    fadeInFrames: 0,
    fadeOutFrames: 0,
    fadeInInterpolation: "linear",
    fadeOutInterpolation: "linear",
    opacity: 1,
    transform: { x: 0, y: 0, scale: 1, rotation: 0, centerX: 0.5, centerY: 0.5 },
    crop: { left: 0, right: 0, top: 0, bottom: 0 },
    ...over,
  } as Clip;
}

function track(over: Partial<Track> & { id: string; clips: Clip[] }): Track {
  return { type: "video", muted: false, hidden: false, locked: false, syncLocked: true, ...over } as Track;
}

function project(tracks: Track[]): Project {
  const media = tracks.flatMap((t) => t.clips.map((c) => ({ id: c.mediaRef, name: c.mediaRef.replace("asset_", ""), type: "video" as const })));
  return { media, timeline: { fps: 25, tracks } } as unknown as Project;
}

describe("finding the angles at a frame", () => {
  it("lists one angle per video track covering that frame, top track first", () => {
    const p = project([
      track({ id: "t0", clips: [clip({ id: "camB", startFrame: 0, durationFrames: 500 })] }),
      track({ id: "t1", clips: [clip({ id: "camA", startFrame: 0, durationFrames: 500 })] }),
    ]);
    const a = anglesAt(p, 100);
    expect(a.map((x) => x.clip.id)).toEqual(["camB", "camA"]);
  });

  it("leaves out a camera that has not started yet", () => {
    // The real case: sync put one camera 55.7s (1671 frames) later than the other.
    const p = project([
      track({ id: "t0", clips: [clip({ id: "late", startFrame: 1671, durationFrames: 5000 })] }),
      track({ id: "t1", clips: [clip({ id: "early", startFrame: 0, durationFrames: 5000 })] }),
    ]);
    expect(anglesAt(p, 100).map((x) => x.clip.id)).toEqual(["early"]);
    expect(anglesAt(p, 2000).map((x) => x.clip.id)).toEqual(["late", "early"]);
  });

  it("marks the top-most visible clip as the one on air", () => {
    const p = project([
      track({ id: "t0", clips: [clip({ id: "top", startFrame: 0, durationFrames: 500, opacity: 0 })] }),
      track({ id: "t1", clips: [clip({ id: "mid", startFrame: 0, durationFrames: 500 })] }),
    ]);
    const a = anglesAt(p, 10);
    // The top clip is transparent, so what a viewer actually sees is the one under it.
    expect(a.find((x) => x.live)?.clip.id).toBe("mid");
  });

  it("ignores audio tracks, hidden tracks and text clips", () => {
    const p = project([
      track({ id: "t0", hidden: true, clips: [clip({ id: "hiddenCam", startFrame: 0, durationFrames: 500 })] }),
      track({ id: "t1", clips: [clip({ id: "title", startFrame: 0, durationFrames: 500, mediaType: "text" })] }),
      track({ id: "t2", type: "audio", clips: [clip({ id: "music", startFrame: 0, durationFrames: 500, mediaType: "audio" })] }),
      track({ id: "t3", clips: [clip({ id: "cam", startFrame: 0, durationFrames: 500 })] }),
    ]);
    expect(anglesAt(p, 10).map((x) => x.clip.id)).toEqual(["cam"]);
  });

  it("says there is nothing to choose between when a single camera covers the frame", () => {
    const p = project([track({ id: "t0", clips: [clip({ id: "only", startFrame: 0, durationFrames: 500 })] })]);
    // The multicam tab keys off this: one angle means no tab at all.
    expect(anglesAt(p, 10).length).toBe(1);
  });

  it("is end-exclusive, like every other clip range in the editor", () => {
    const p = project([track({ id: "t0", clips: [clip({ id: "c", startFrame: 0, durationFrames: 100 })] })]);
    expect(anglesAt(p, 99).length).toBe(1);
    expect(anglesAt(p, 100).length).toBe(0);
  });

  it("returns nothing rather than throwing when no project is loaded", () => {
    expect(anglesAt(null, 0)).toEqual([]);
  });
});
