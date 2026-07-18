import { describe, expect, it } from "bun:test";
import {
  addClips,
  addTexts,
  EditorDocument,
  getTimeline,
  type MediaAsset,
  rippleDeleteRanges,
  setClipProperties,
  setProjectFormat,
  splitClip,
  undo,
} from "../src";

function video(id: string, durationSeconds = 10): MediaAsset {
  return { id, type: "video", name: id, durationSeconds, hasAudio: true, generationStatus: { kind: "none" } };
}
function image(id: string): MediaAsset {
  return { id, type: "image", name: id, durationSeconds: 0, hasAudio: false, generationStatus: { kind: "none" } };
}

describe("editor-core commands", () => {
  it("auto-creates a video track and a linked audio track for a video-with-audio", () => {
    const doc = new EditorDocument();
    doc.addAsset(video("v1"));
    addClips(doc, { entries: [{ mediaRef: "v1", startFrame: 0, durationFrames: 60 }] });
    const v = doc.timeline.tracks.find((t) => t.type === "video")!;
    const a = doc.timeline.tracks.find((t) => t.type === "audio")!;
    expect(v.clips.length).toBe(1);
    expect(a.clips.length).toBe(1);
    expect(v.clips[0]!.linkGroupId).toBeDefined();
    expect(a.clips[0]!.linkGroupId).toBe(v.clips[0]!.linkGroupId);
  });

  it("overwrites overlapping clips on the same track (clearRegion, UI drag semantics)", () => {
    const doc = new EditorDocument();
    doc.addAsset(image("i1"));
    doc.mutate("setup", "user", () => doc.insertTrack(0, "video"));
    addClips(doc, { entries: [{ mediaRef: "i1", trackIndex: 0, startFrame: 0, durationFrames: 60 }] }, "user");
    addClips(doc, { entries: [{ mediaRef: "i1", trackIndex: 0, startFrame: 30, durationFrames: 60 }] }, "user");
    const clips = doc.timeline.tracks[0]!.clips;
    expect(clips.length).toBe(2);
    expect(clips[0]!.startFrame).toBe(0);
    expect(clips[0]!.durationFrames).toBe(30); // trimmed to make room
    expect(clips[1]!.startFrame).toBe(30);
    expect(clips[1]!.durationFrames).toBe(60);
  });

  it("splits a clip and undoes the split", () => {
    const doc = new EditorDocument();
    doc.addAsset(image("i1"));
    doc.mutate("setup", "user", () => doc.insertTrack(0, "video"));
    addClips(doc, { entries: [{ mediaRef: "i1", trackIndex: 0, startFrame: 0, durationFrames: 90 }] });
    const id = doc.timeline.tracks[0]!.clips[0]!.id;
    splitClip(doc, { clipId: id, atFrame: 30 });
    expect(doc.timeline.tracks[0]!.clips.length).toBe(2);
    undo(doc);
    expect(doc.timeline.tracks[0]!.clips.length).toBe(1);
    expect(doc.timeline.tracks[0]!.clips[0]!.durationFrames).toBe(90);
  });

  it("ripple-deletes a project-frame range and closes the gap", () => {
    const doc = new EditorDocument();
    doc.addAsset(image("i1"));
    doc.mutate("setup", "user", () => doc.insertTrack(0, "video"));
    addClips(doc, { entries: [{ mediaRef: "i1", trackIndex: 0, startFrame: 0, durationFrames: 30 }] });
    addClips(doc, { entries: [{ mediaRef: "i1", trackIndex: 0, startFrame: 30, durationFrames: 60 }] });
    const json = rippleDeleteRanges(doc, { trackIndex: 0, ranges: [[10, 20]] });
    const rep = JSON.parse(json);
    expect(rep.removedFrames).toBe(10);
    const clips = doc.timeline.tracks[0]!.clips;
    expect(clips[clips.length - 1]!.startFrame).toBe(20); // 30 shifted left by 10
  });

  it("rescales duration when speed changes (no explicit duration)", () => {
    const doc = new EditorDocument();
    doc.addAsset(video("v1"));
    doc.mutate("setup", "user", () => doc.insertTrack(0, "video"));
    addClips(doc, { entries: [{ mediaRef: "v1", trackIndex: 0, startFrame: 0, durationFrames: 60 }] });
    const id = doc.timeline.tracks[0]!.clips[0]!.id;
    setClipProperties(doc, { clipIds: [id], speed: 2 });
    expect(doc.timeline.tracks[0]!.clips[0]!.durationFrames).toBe(30);
    expect(doc.timeline.tracks[0]!.clips[0]!.speed).toBe(2);
  });

  it("adds a text clip on an auto-created track", () => {
    const doc = new EditorDocument();
    addTexts(doc, { entries: [{ content: "Hello", startFrame: 0, durationFrames: 90 }] });
    const t = doc.timeline.tracks[0]!;
    expect(t.clips[0]!.mediaType).toBe("text");
    expect(t.clips[0]!.textContent).toBe("Hello");
  });

  it("partitions karaokeWords when a karaoke caption is split", () => {
    const doc = new EditorDocument();
    addTexts(doc, { entries: [{ content: "uno due tre quattro", startFrame: 0, durationFrames: 120 }] });
    const t = doc.timeline.tracks[0]!;
    const clip = t.clips[0]!;
    clip.karaokeWords = [
      { word: "uno", startFrame: 0, endFrame: 30 },
      { word: "due", startFrame: 30, endFrame: 60 },
      { word: "tre", startFrame: 60, endFrame: 90 },
      { word: "quattro", startFrame: 90, endFrame: 120 },
    ];
    doc.mutate("split", "user", () => doc.splitClip(clip.id, 60));
    const [left, right] = t.clips;
    expect(left!.karaokeWords!.map((w) => w.word)).toEqual(["uno", "due"]);
    expect(right!.karaokeWords!.map((w) => w.word)).toEqual(["tre", "quattro"]);
    expect(right!.karaokeWords![0]).toEqual({ word: "tre", startFrame: 0, endFrame: 30 });
    expect(left!.textContent).toBe("uno due");
    expect(right!.textContent).toBe("tre quattro");
  });

  it("changing project fps rescales clips so seconds are preserved", () => {
    const doc = new EditorDocument(); // default fps 30
    doc.addAsset(video("v1"));
    doc.mutate("setup", "user", () => doc.insertTrack(0, "video"));
    addClips(doc, {
      entries: [
        { mediaRef: "v1", trackIndex: 0, startFrame: 0, durationFrames: 90 },
        { mediaRef: "v1", trackIndex: 0, startFrame: 90, durationFrames: 45 },
      ],
    });
    const [a, b] = doc.timeline.tracks[0]!.clips;
    a!.trimStartFrame = 15;
    a!.fadeInFrames = 6;
    a!.karaokeWords = [{ word: "ciao", startFrame: 3, endFrame: 9 }];
    a!.opacityTrack = { keyframes: [{ frame: 30, value: 0.5, interpolationOut: "smooth" }] };
    setProjectFormat(doc, { fps: 60 });
    expect(doc.timeline.fps).toBe(60);
    // 90 frames @30fps (3s) → 180 frames @60fps (still 3s)
    expect(a!.durationFrames).toBe(180);
    expect(a!.trimStartFrame).toBe(30);
    expect(a!.fadeInFrames).toBe(12);
    expect(a!.karaokeWords![0]).toEqual({ word: "ciao", startFrame: 6, endFrame: 18 });
    expect(a!.opacityTrack!.keyframes[0]!.frame).toBe(60);
    // adjacency preserved: b starts exactly where a ends
    expect(b!.startFrame).toBe(180);
    expect(b!.durationFrames).toBe(90);
    // and back down to 30 restores the original grid
    setProjectFormat(doc, { fps: 30 });
    expect(a!.durationFrames).toBe(90);
    expect(b!.startFrame).toBe(90);
  });

  it("agent add_clips refuses to overwrite an occupied region (replace:true opts in)", () => {
    const doc = new EditorDocument();
    doc.addAsset(video("v1"));
    doc.mutate("setup", "user", () => doc.insertTrack(0, "video"));
    addClips(doc, { entries: [{ mediaRef: "v1", trackIndex: 0, startFrame: 0, durationFrames: 60 }] });
    // agent placing over it → error naming the clip and the fix
    expect(() => addClips(doc, { entries: [{ mediaRef: "v1", trackIndex: 0, startFrame: 30, durationFrames: 60 }] }, "agent")).toThrow(/would DELETE/);
    // the UI keeps drag-onto-track overwrite
    addClips(doc, { entries: [{ mediaRef: "v1", trackIndex: 0, startFrame: 30, durationFrames: 60 }] }, "user");
    // agent CAN overwrite when explicit
    addClips(doc, { entries: [{ mediaRef: "v1", trackIndex: 0, startFrame: 0, durationFrames: 30 }], replace: true }, "agent");
    expect(doc.timeline.tracks[0]!.clips.length).toBeGreaterThan(1);
  });

  it("omits default-valued fields in get_timeline", () => {
    const doc = new EditorDocument();
    doc.addAsset(image("i1"));
    doc.mutate("setup", "user", () => doc.insertTrack(0, "video"));
    addClips(doc, { entries: [{ mediaRef: "i1", trackIndex: 0, startFrame: 0, durationFrames: 60 }] });
    const tl = getTimeline(doc) as { tracks: { clips: Record<string, unknown>[] }[] };
    const clip = tl.tracks[0]!.clips[0]!;
    expect(clip).not.toHaveProperty("speed");
    expect(clip).not.toHaveProperty("opacity");
    expect(clip).toHaveProperty("durationFrames", 60);
  });
});
