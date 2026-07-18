// Punch-in ("meme zoom") and lens magnifier — one-call tools that encapsulate the zoom geometry
// that is easy to get wrong when composed by hand from split_clip + transforms + keyframes:
//   • a zoom of factor S framing source point p needs   center = 0.5 + (0.5 − p)·S
//   • p must first be clamped to [0.5/S, 1 − 0.5/S] per axis, otherwise the framed region leaves
//     the source and the canvas shows black at the edge — mathematically impossible after clamping,
//     because |center − 0.5| = S·|0.5 − p'| ≤ S·(0.5 − 0.5/S) = (S − 1)/2, i.e. the scaled clip
//     always covers the whole canvas.
// Both tools also clear stale position/scale keyframes on the target segment: leftover keyframes
// silently override a static transform and are a proven source of "why is it black" loops.

import type { Clip, EditorDocument } from "@cupcat/editor-core";
import { clipEndFrame, newId } from "@cupcat/editor-core";

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
const r3 = (n: number) => Math.round(n * 1000) / 1000;

/** Clamp the target into the zoomable region and return the canvas-space clip center. */
function zoomCenter(px: number, py: number, S: number): { cx: number; cy: number; tx: number; ty: number; clamped: boolean } {
  const tx = clamp(px, 0.5 / S, 1 - 0.5 / S);
  const ty = clamp(py, 0.5 / S, 1 - 0.5 / S);
  return { cx: 0.5 + (0.5 - tx) * S, cy: 0.5 + (0.5 - ty) * S, tx, ty, clamped: tx !== px || ty !== py };
}

/** Split `clip` so [startFrame, endFrame) is its own segment on the track; returns that segment.
 * Must run inside doc.mutate — uses the raw split ops so linked audio partners split in sync. */
function isolateWindow(doc: EditorDocument, trackIndex: number, clip: Clip, startFrame: number, endFrame: number): Clip {
  const track = doc.timeline.tracks[trackIndex]!;
  if (startFrame > clip.startFrame) doc.splitClip(clip.id, startFrame);
  let seg = track.clips.find((c) => c.startFrame === startFrame && clipEndFrame(c) > startFrame)!;
  if (endFrame < clipEndFrame(seg)) {
    doc.splitClip(seg.id, endFrame);
    seg = track.clips.find((c) => c.startFrame === startFrame)!;
  }
  return seg;
}

export interface PunchInArgs {
  clipId: string;
  targetX?: number;
  targetY?: number;
  scale?: number;
  startFrame?: number;
  endFrame?: number;
  mode?: "cut" | "smooth";
  rampFrames?: number;
  bw?: boolean;
  shake?: boolean;
  vignette?: boolean;
}

export function punchIn(doc: EditorDocument, a: PunchInArgs): string {
  const loc = doc.findClip(a.clipId);
  if (!loc) throw new Error(`Clip not found: ${a.clipId}`);
  const orig = doc.timeline.tracks[loc.trackIndex]!.clips[loc.clipIndex]!;
  if (orig.mediaType !== "video" && orig.mediaType !== "image") throw new Error("punch_in works on video/image clips.");
  const S = clamp(a.scale ?? 2.2, 1.05, 8);
  const px = clamp(a.targetX ?? 0.5, 0, 1);
  const py = clamp(a.targetY ?? 0.5, 0, 1);
  const start = Math.max(orig.startFrame, Math.round(a.startFrame ?? orig.startFrame));
  const end = Math.min(clipEndFrame(orig), Math.round(a.endFrame ?? clipEndFrame(orig)));
  if (!(end > start)) throw new Error(`Empty window: [${start}, ${end}).`);
  const { cx, cy, tx, ty, clamped } = zoomCenter(px, py, S);
  const mode = a.mode === "smooth" ? "smooth" : "cut";

  let segId = "";
  doc.mutate("Punch In", "agent", () => {
    const seg = isolateWindow(doc, loc.trackIndex, orig, start, end);
    segId = seg.id;
    // stale animation would override the transform below — always drop it
    seg.positionTrack = undefined;
    seg.scaleTrack = undefined;
    seg.transform = { ...seg.transform, centerX: cx, centerY: cy, width: S, height: S };
    if (mode === "smooth") {
      const dur = clipEndFrame(seg) - seg.startFrame;
      const ramp = clamp(Math.round(a.rampFrames ?? 6), 1, Math.max(1, Math.floor(dur / 2)));
      const t0 = { x: seg.transform.centerX - S / 2, y: seg.transform.centerY - S / 2 }; // zoomed top-left
      // ease from identity into the zoom and back out; the static transform above is the hold pose
      seg.positionTrack = {
        keyframes: [
          { frame: 0, value: { a: 0, b: 0 }, interpolationOut: "smooth" },
          { frame: ramp, value: { a: t0.x, b: t0.y }, interpolationOut: "smooth" },
          { frame: dur - ramp, value: { a: t0.x, b: t0.y }, interpolationOut: "smooth" },
          { frame: dur, value: { a: 0, b: 0 }, interpolationOut: "smooth" },
        ],
      };
      seg.scaleTrack = {
        keyframes: [
          { frame: 0, value: { a: 1, b: 1 }, interpolationOut: "smooth" },
          { frame: ramp, value: { a: S, b: S }, interpolationOut: "smooth" },
          { frame: dur - ramp, value: { a: S, b: S }, interpolationOut: "smooth" },
          { frame: dur, value: { a: 1, b: 1 }, interpolationOut: "smooth" },
        ],
      };
    }
    if (a.bw) seg.color = { ...seg.color, saturation: 0 };
    if (a.shake && !seg.effects?.some((e) => e.type === "shake")) {
      seg.effects = [...(seg.effects ?? []), { type: "shake", params: { amount: 0.5 } }];
    }
    if (a.vignette && !seg.effects?.some((e) => e.type === "vignette")) {
      seg.effects = [...(seg.effects ?? []), { type: "vignette", params: { amount: 0.45 } }];
    }
  });

  const clampNote = clamped
    ? ` Target (${r3(px)}, ${r3(py)}) was clamped to (${r3(tx)}, ${r3(ty)}) — at ${r3(S)}x the view can frame centers only within [${r3(0.5 / S)}, ${r3(1 - 0.5 / S)}], closer to an edge would show past the source.`
    : "";
  const fx = [a.bw && "b/w", a.shake && "shake", a.vignette && "vignette"].filter(Boolean).join("+");
  return `Punch-in ${r3(S)}x on ${segId} (frames ${start}–${end}, ${mode}${fx ? `, ${fx}` : ""}), framing (${r3(tx)}, ${r3(ty)}).${clampNote} Preview and export match; no black edges by construction.`;
}

export interface MagnifyArgs {
  clipId: string;
  targetX?: number;
  targetY?: number;
  zoom?: number;
  radius?: number;
  feather?: number;
  startFrame?: number;
  endFrame?: number;
}

/** Lens magnifier: a zoomed duplicate of the clip on a muted track above, ellipse-masked around
 * the target so it reads as a magnifying glass fixed over that spot. */
export function magnify(doc: EditorDocument, a: MagnifyArgs): string {
  const loc = doc.findClip(a.clipId);
  if (!loc) throw new Error(`Clip not found: ${a.clipId}`);
  const base = doc.timeline.tracks[loc.trackIndex]!.clips[loc.clipIndex]!;
  if (base.mediaType !== "video" && base.mediaType !== "image") throw new Error("magnify works on video/image clips.");
  const S = clamp(a.zoom ?? 2, 1.2, 6);
  const px = clamp(a.targetX ?? 0.5, 0.02, 0.98);
  const py = clamp(a.targetY ?? 0.5, 0.02, 0.98);
  const radius = clamp(a.radius ?? 0.16, 0.04, 0.45); // fraction of the canvas' short side
  const feather = clamp(a.feather ?? 0.08, 0, 0.5);
  const start = Math.max(base.startFrame, Math.round(a.startFrame ?? base.startFrame));
  const end = Math.min(clipEndFrame(base), Math.round(a.endFrame ?? clipEndFrame(base)));
  if (!(end > start)) throw new Error(`Empty window: [${start}, ${end}).`);

  const W = doc.timeline.width;
  const H = doc.timeline.height;
  const minDim = Math.min(W, H);
  // keep the magnified target under the lens: canvasPos(p) = c + (p − 0.5)·S = p  ⇒  c = p(1−S) + S/2
  const cx = px * (1 - S) + S / 2;
  const cy = py * (1 - S) + S / 2;
  const speed = base.speed > 0 ? base.speed : 1;

  let lensId = "";
  let trackIdx = 0;
  doc.mutate("Magnify", "agent", () => {
    trackIdx = doc.insertTrack(loc.trackIndex, "video");
    const track = doc.timeline.tracks[trackIdx]!;
    track.muted = true; // lens is picture-only — its audio would double the base clip's
    const lens = structuredClone(base);
    const dup: Clip = {
      ...lens,
      id: newId("clip"),
      startFrame: start,
      durationFrames: end - start,
      trimStartFrame: base.trimStartFrame + Math.round((start - base.startFrame) * speed),
      trimEndFrame: 0,
      linkGroupId: undefined,
      positionTrack: undefined,
      scaleTrack: undefined,
      opacityTrack: undefined,
      volumeTrack: undefined,
      karaokeWords: undefined,
      transform: { ...base.transform, centerX: cx, centerY: cy, width: S, height: S },
      mask: {
        shape: "ellipse",
        cx: px,
        cy: py,
        rw: (radius * minDim) / (W * S),
        rh: (radius * minDim) / (H * S),
        feather,
        invert: false,
      },
    };
    track.clips.push(dup);
    lensId = dup.id;
  });

  return `Magnifier lens ${r3(S)}x over (${r3(px)}, ${r3(py)}) as ${lensId} on new muted track ${trackIdx} (frames ${start}–${end}, radius ${r3(radius)}, feather ${r3(feather)}). The lens stays fixed over the spot; remove it by deleting that clip. The feathered edge is visible live in the preview.`;
}
