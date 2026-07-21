// Slip edit and gap closing. Both are edits an editor does by dragging, so the rules that matter are
// the ones that stop a drag from destroying work: slip must never move or resize the clip, and
// closing gaps must never reorder or overlap what's already there.

import { describe, expect, it } from "bun:test";
import { addClips, closeGaps, EditorDocument, type MediaAsset, slipClip, undo } from "../src";

function video(id: string, durationSeconds = 10): MediaAsset {
  return { id, type: "video", name: id, durationSeconds, hasAudio: false, generationStatus: { kind: "none" } };
}

/** A clip with room to slip in both directions: 30f trimmed off each end of the source. */
function docWithSlippableClip() {
  const doc = new EditorDocument();
  doc.addAsset(video("v1"));
  doc.mutate("setup", "user", () => doc.insertTrack(0, "video"));
  addClips(doc, { entries: [{ mediaRef: "v1", trackIndex: 0, startFrame: 60, durationFrames: 90 }] }, "user");
  const c = doc.timeline.tracks[0]!.clips[0]!;
  doc.mutate("setup trims", "user", () => {
    c.trimStartFrame = 30;
    c.trimEndFrame = 30;
  });
  return { doc, clip: doc.timeline.tracks[0]!.clips[0]! };
}

describe("slip_clip", () => {
  it("shows later source content without moving or resizing the clip", () => {
    const { doc, clip } = docWithSlippableClip();
    const startBefore = clip.startFrame;
    const durBefore = clip.durationFrames;
    slipClip(doc, { clipId: clip.id, deltaFrames: 10 });
    const c = doc.timeline.tracks[0]!.clips[0]!;
    expect(c.startFrame).toBe(startBefore); // the whole point of a slip
    expect(c.durationFrames).toBe(durBefore);
    expect(c.trimStartFrame).toBe(40);
    expect(c.trimEndFrame).toBe(20);
  });

  it("shows earlier content on a negative slip", () => {
    const { doc, clip } = docWithSlippableClip();
    slipClip(doc, { clipId: clip.id, deltaFrames: -10 });
    const c = doc.timeline.tracks[0]!.clips[0]!;
    expect(c.trimStartFrame).toBe(20);
    expect(c.trimEndFrame).toBe(40);
  });

  it("keeps the two trims summing to the same total — no source is invented", () => {
    const { doc, clip } = docWithSlippableClip();
    const total = clip.trimStartFrame + clip.trimEndFrame;
    slipClip(doc, { clipId: clip.id, deltaFrames: 17 });
    const c = doc.timeline.tracks[0]!.clips[0]!;
    expect(c.trimStartFrame + c.trimEndFrame).toBe(total);
  });

  it("clamps at the head of the source instead of going negative", () => {
    const { doc, clip } = docWithSlippableClip();
    slipClip(doc, { clipId: clip.id, deltaFrames: -9999 });
    const c = doc.timeline.tracks[0]!.clips[0]!;
    expect(c.trimStartFrame).toBe(0);
    expect(c.trimEndFrame).toBe(60);
    expect(c.startFrame).toBe(60);
    expect(c.durationFrames).toBe(90);
  });

  it("clamps at the tail of the source", () => {
    const { doc, clip } = docWithSlippableClip();
    slipClip(doc, { clipId: clip.id, deltaFrames: 9999 });
    const c = doc.timeline.tracks[0]!.clips[0]!;
    expect(c.trimEndFrame).toBe(0);
    expect(c.trimStartFrame).toBe(60);
  });

  it("says so rather than pretending when there is nothing left to slip", () => {
    const { doc, clip } = docWithSlippableClip();
    slipClip(doc, { clipId: clip.id, deltaFrames: 9999 });
    expect(slipClip(doc, { clipId: clip.id, deltaFrames: 10 })).toContain("No slip applied");
  });

  it("scales the move by clip speed, since trims are source frames", () => {
    const { doc, clip } = docWithSlippableClip();
    doc.mutate("speed", "user", () => {
      doc.timeline.tracks[0]!.clips[0]!.speed = 2;
    });
    slipClip(doc, { clipId: clip.id, deltaFrames: 10 }); // 10 timeline frames = 20 source frames
    expect(doc.timeline.tracks[0]!.clips[0]!.trimStartFrame).toBe(50);
  });

  it("refuses clips that have no source to slip through", () => {
    const doc = new EditorDocument();
    doc.mutate("setup", "user", () => doc.insertTrack(0, "video"));
    doc.addAsset(video("v1"));
    addClips(doc, { entries: [{ mediaRef: "v1", trackIndex: 0, startFrame: 0, durationFrames: 30 }] }, "user");
    const c = doc.timeline.tracks[0]!.clips[0]!;
    doc.mutate("make it text", "user", () => {
      c.mediaType = "text";
    });
    expect(() => slipClip(doc, { clipId: c.id, deltaFrames: 5 })).toThrow();
  });

  it("is undoable", () => {
    const { doc, clip } = docWithSlippableClip();
    slipClip(doc, { clipId: clip.id, deltaFrames: 10 });
    undo(doc, {});
    expect(doc.timeline.tracks[0]!.clips[0]!.trimStartFrame).toBe(30);
  });
});

describe("close_gaps", () => {
  /** Three clips with a 40f hole after the first and a 20f hole after the second. */
  function docWithGaps() {
    const doc = new EditorDocument();
    doc.addAsset(video("v1"));
    doc.mutate("setup", "user", () => doc.insertTrack(0, "video"));
    addClips(
      doc,
      {
        entries: [
          { mediaRef: "v1", trackIndex: 0, startFrame: 10, durationFrames: 30 },
          { mediaRef: "v1", trackIndex: 0, startFrame: 80, durationFrames: 30 },
          { mediaRef: "v1", trackIndex: 0, startFrame: 130, durationFrames: 30 },
        ],
      },
      "user",
    );
    return doc;
  }

  it("pulls clips left so they butt up against each other", () => {
    const doc = docWithGaps();
    closeGaps(doc, { trackIndex: 0 });
    const starts = doc.timeline.tracks[0]!.clips.map((c) => c.startFrame);
    expect(starts).toEqual([10, 40, 70]);
  });

  it("keeps the head offset unless asked to close it", () => {
    const doc = docWithGaps();
    closeGaps(doc, { trackIndex: 0 });
    expect(doc.timeline.tracks[0]!.clips[0]!.startFrame).toBe(10); // deliberate intro pad survives
    closeGaps(doc, { trackIndex: 0, fromStart: true });
    expect(doc.timeline.tracks[0]!.clips[0]!.startFrame).toBe(0);
  });

  it("never changes clip order or length", () => {
    const doc = docWithGaps();
    const before = doc.timeline.tracks[0]!.clips.map((c) => ({ id: c.id, d: c.durationFrames }));
    closeGaps(doc, { trackIndex: 0 });
    const after = doc.timeline.tracks[0]!.clips.map((c) => ({ id: c.id, d: c.durationFrames }));
    expect(after).toEqual(before);
  });

  it("leaves slivers alone — a couple of frames is usually deliberate spacing", () => {
    const doc = new EditorDocument();
    doc.addAsset(video("v1"));
    doc.mutate("setup", "user", () => doc.insertTrack(0, "video"));
    addClips(
      doc,
      {
        entries: [
          { mediaRef: "v1", trackIndex: 0, startFrame: 0, durationFrames: 30 },
          { mediaRef: "v1", trackIndex: 0, startFrame: 31, durationFrames: 30 }, // 1f gap
        ],
      },
      "user",
    );
    closeGaps(doc, { trackIndex: 0, minFrames: 5 });
    expect(doc.timeline.tracks[0]!.clips[1]!.startFrame).toBe(31);
  });

  it("reports when there is nothing to do", () => {
    const doc = new EditorDocument();
    doc.addAsset(video("v1"));
    doc.mutate("setup", "user", () => doc.insertTrack(0, "video"));
    addClips(doc, { entries: [{ mediaRef: "v1", trackIndex: 0, startFrame: 0, durationFrames: 30 }] }, "user");
    expect(closeGaps(doc, { trackIndex: 0 })).toContain("No gaps");
  });

  it("rejects a track index that doesn't exist", () => {
    const doc = docWithGaps();
    expect(() => closeGaps(doc, { trackIndex: 99 })).toThrow();
  });

  it("is undoable", () => {
    const doc = docWithGaps();
    closeGaps(doc, { trackIndex: 0 });
    undo(doc, {});
    expect(doc.timeline.tracks[0]!.clips.map((c) => c.startFrame)).toEqual([10, 80, 130]);
  });

  it("drags linked audio along so a take never falls out of sync", () => {
    // A video-with-audio lands as two linked clips on two tracks. Closing the gap on the video
    // track alone would leave the audio where it was and silently break lip sync.
    const doc = new EditorDocument();
    doc.addAsset({ id: "v1", type: "video", name: "v1", durationSeconds: 10, hasAudio: true, generationStatus: { kind: "none" } });
    addClips(
      doc,
      {
        entries: [
          { mediaRef: "v1", startFrame: 0, durationFrames: 30 },
          { mediaRef: "v1", startFrame: 90, durationFrames: 30 },
        ],
      },
      "user",
    );
    const v = doc.timeline.tracks.find((t) => t.type === "video")!;
    const a = doc.timeline.tracks.find((t) => t.type === "audio")!;
    expect(a.clips).toHaveLength(2);
    closeGaps(doc, { trackIndex: doc.timeline.tracks.indexOf(v) });
    const vStarts = v.clips.map((c) => c.startFrame);
    const aStarts = a.clips.map((c) => c.startFrame);
    expect(vStarts).toEqual([0, 30]);
    expect(aStarts).toEqual(vStarts); // still in sync
  });
});
