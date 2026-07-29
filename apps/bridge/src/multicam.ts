// Multicam cut — one-call camera switching over synced, stacked angle clips.
//
// After sync_audio the angles of a multicam shoot sit on separate video tracks, aligned in time
// and all playing at once (only the top one is visible). Turning that stack into a montage by
// hand takes a long dance of split_clip + remove_clips with an easy-to-break audio story, so this
// tool does the whole switch as ONE undoable action (the isolateWindow-in-mutate approach proven
// by zoom.ts): split every angle at every switch point, keep only the chosen angle's picture per
// segment, and keep exactly ONE camera's audio continuous across the window — picture switches,
// sound never hiccups, which is the standard multicam grammar.

import type { EditorDocument } from "@cupcat/editor-core";
import { clipEndFrame, LAYOUT_SLOTS } from "@cupcat/editor-core";

export interface MulticamCutArgs {
  angleClipIds: string[];
  /** [[timelineFrame, angleIndex], ...] — validated here (raw MCP input). An angleIndex may be a
   *  LIST of indices, meaning "show these cameras together" — a split screen for that segment. */
  cuts: unknown;
  /** Index into angleClipIds whose audio survives (default 0); -1 = leave all audio untouched. */
  audioAngle?: number;
  /** How a multi-angle segment is arranged. Defaults to the frame's own shape: a vertical project
   *  stacks, a horizontal one places side by side. */
  splitLayout?: "side-by-side" | "top-bottom";
}

export function multicamCut(doc: EditorDocument, a: MulticamCutArgs): string {
  const ids = Array.isArray(a.angleClipIds) ? a.angleClipIds : [];
  if (ids.length < 2) throw new Error("multicam_cut needs angleClipIds with 2+ clips — one per camera angle.");
  if (new Set(ids).size !== ids.length) throw new Error("angleClipIds contains duplicates — pass each angle once.");
  const angles = ids.map((id) => {
    const loc = doc.findClip(id);
    if (!loc) throw new Error(`Clip not found: ${id}`);
    const clip = doc.timeline.tracks[loc.trackIndex]!.clips[loc.clipIndex]!;
    if (clip.mediaType !== "video") throw new Error(`${id} is a ${clip.mediaType} clip — multicam angles must be video clips.`);
    // Capture the span NOW: after the splits below, `clip` is mutated into the leftmost piece.
    return { id, trackIndex: loc.trackIndex, clip, origStart: clip.startFrame, origEnd: clipEndFrame(clip) };
  });

  // The montage happens inside the angles' common overlap — outside it some camera has no picture.
  const winStart = Math.max(...angles.map((x) => x.origStart));
  const winEnd = Math.min(...angles.map((x) => x.origEnd));
  if (winEnd <= winStart) {
    throw new Error(
      "Angle clips do not overlap in time — there is no common window to switch inside. Align them first (sync_audio, or move_clips so they share a span).",
    );
  }

  const rawCuts = Array.isArray(a.cuts) ? (a.cuts as unknown[]) : null;
  if (!rawCuts || rawCuts.length === 0) throw new Error("cuts must be a non-empty array of [timelineFrame, angleIndex] pairs.");
  const parsed = rawCuts.map((c, i) => {
    if (!Array.isArray(c) || c.length !== 2 || typeof c[0] !== "number") {
      throw new Error(`cuts[${i}] must be a [timelineFrame, angleIndex] pair — the frame first, then the angle (or a list of angles for a split screen).`);
    }
    const frame = Math.round(c[0]);
    const raw = c[1];
    const list = (Array.isArray(raw) ? raw : [raw]).map((v, k) => {
      if (typeof v !== "number") throw new Error(`cuts[${i}]: angle ${k} is not a number.`);
      const angle = Math.round(v);
      if (angle < 0 || angle >= angles.length) throw new Error(`cuts[${i}]: angleIndex ${angle} is out of range (0–${angles.length - 1}).`);
      return angle;
    });
    const shown = [...new Set(list)];
    if (shown.length === 0) throw new Error(`cuts[${i}]: no angle given.`);
    if (shown.length > 2) {
      throw new Error(
        `cuts[${i}] asks for ${shown.length} angles at once. Two is the automatic case (a split screen while two people talk over each other); for three or more, place the clips yourself and call apply_layout.`,
      );
    }
    if (frame < winStart || frame >= winEnd) {
      throw new Error(`cuts[${i}]: frame ${frame} is outside the angles' common overlap window — valid cut frames are [${winStart}, ${winEnd}).`);
    }
    return { frame, shown };
  });
  // Callers may hand cuts in any order and repeat a frame — last mention of a frame wins, then sort.
  const byFrame = new Map<number, number[]>();
  for (const c of parsed) byFrame.set(c.frame, c.shown);
  const cuts = [...byFrame.entries()].map(([frame, shown]) => ({ frame, shown })).sort((x, y) => x.frame - y.frame);
  const key = (s: number[]) => s.join(",");

  // Two clips sharing the frame need to be told where to sit, or the upper track simply covers the
  // lower one. The slots are the same ones apply_layout uses, so a split made here and one made by
  // hand land in exactly the same places.
  const vertical = (doc.timeline.height ?? 0) > (doc.timeline.width ?? 0);
  const slots = LAYOUT_SLOTS[a.splitLayout ?? (vertical ? "top-bottom" : "side-by-side")];
  if (!slots) throw new Error(`Unknown splitLayout '${a.splitLayout}' — 'side-by-side' or 'top-bottom'.`);

  const audioAngle = a.audioAngle === undefined ? 0 : Math.round(a.audioAngle);
  if (audioAngle < -1 || audioAngle >= angles.length) {
    throw new Error(`audioAngle ${audioAngle} is out of range — 0–${angles.length - 1}, or -1 to leave all audio untouched.`);
  }

  // Segment plan over [winStart, winEnd): before the first cut the first listed angle shows,
  // unless a cut sits exactly at the window start. Switches to the already-showing angle are
  // dropped — they would only dice the timeline into pointless extra pieces.
  const boundaries: number[] = [winStart];
  const segAngles: number[][] = [];
  let current = cuts[0]!.frame === winStart ? cuts[0]!.shown : [0];
  for (const c of cuts) {
    if (c.frame === winStart || key(c.shown) === key(current)) continue;
    boundaries.push(c.frame);
    segAngles.push(current);
    current = c.shown;
  }
  boundaries.push(winEnd);
  segAngles.push(current);

  let detachedAudio = 0;
  let removedAudio = 0;
  let pruned = 0;
  let splitSegments = 0;
  const segIds: string[] = [];
  doc.mutate("Multicam Cut", "agent", () => {
    const nonEmptyBefore = new Set(doc.timeline.tracks.filter((t) => t.clips.length > 0).map((t) => t.id));

    // Audio story FIRST: doc.splitClip drags linked partners through every cut, and the removal
    // below would then delete the kept camera's audio together with its discarded picture pieces.
    // So before any split: detach the surviving audio from its link group (the picture cuts can
    // never fragment it → it stays one continuous clip) and drop the other angles' audio outright.
    const audioToRemove = new Set<string>();
    for (let i = 0; i < angles.length; i++) {
      const group = angles[i]!.clip.linkGroupId;
      if (!group) continue;
      for (const t of doc.timeline.tracks) {
        for (const c of t.clips) {
          if (c.id === angles[i]!.id || c.linkGroupId !== group || c.mediaType !== "audio") continue;
          if (audioAngle >= 0 && i !== audioAngle) {
            audioToRemove.add(c.id);
          } else {
            c.linkGroupId = undefined;
            detachedAudio++;
          }
        }
      }
    }
    doc.removeClipsByIds(audioToRemove);
    removedAudio = audioToRemove.size;

    // Dice every angle at every boundary (window edges included, so a clip reaching past the
    // window keeps its outside part). A boundary splits whichever piece currently contains it —
    // inside [winStart, winEnd] that piece is always a descendant of the angle clip, because the
    // original spanned the window and track clips never overlap.
    for (const ang of angles) {
      const track = doc.timeline.tracks[ang.trackIndex]!;
      for (const b of boundaries) {
        const target = track.clips.find((c) => c.startFrame < b && b < clipEndFrame(c));
        if (target) doc.splitClip(target.id, b);
      }
    }

    // Per segment, keep only the chosen angles' pieces; the removal set is exact clip ids, so no
    // link-group expansion can reach the surviving audio.
    const videoToRemove = new Set<string>();
    for (let s = 0; s < segAngles.length; s++) {
      const b0 = boundaries[s]!;
      const b1 = boundaries[s + 1]!;
      const shown = segAngles[s]!;
      const kept: { id: string; slot: number }[] = [];
      for (let i = 0; i < angles.length; i++) {
        const piece = doc.timeline.tracks[angles[i]!.trackIndex]!.clips.find((c) => c.startFrame === b0 && clipEndFrame(c) === b1);
        if (!piece) continue;
        const slot = shown.indexOf(i);
        if (slot >= 0) kept.push({ id: piece.id, slot });
        else videoToRemove.add(piece.id);
      }
      segIds[s] = kept
        .sort((x, y) => x.slot - y.slot)
        .map((k) => k.id)
        .join("+");
      // Full frame for a single camera, a slot each when two share it. Set explicitly rather than
      // left alone: a piece inherits its parent's transform through the split, so a clip that was
      // in a slot earlier in the window would keep half the frame after the split ended.
      if (kept.length > 0) {
        splitSegments += kept.length > 1 ? 1 : 0;
        for (const k of kept) {
          const clip = doc.getClip(k.id);
          if (!clip) continue;
          const box = kept.length > 1 ? slots[k.slot]! : { centerX: 0.5, centerY: 0.5, width: 1, height: 1 };
          clip.transform = { ...clip.transform, ...box };
        }
      }
    }
    doc.removeClipsByIds(videoToRemove);
    pruned = doc.removeEmptyTracks(nonEmptyBefore);
  });

  const fps = doc.timeline.fps;
  const sec = (f: number) => (Math.round((f / fps) * 100) / 100).toFixed(2);
  const segDesc = segAngles
    .map((shown, s) => `[${boundaries[s]}–${boundaries[s + 1]}) ${shown.length > 1 ? `angles ${shown.join("+")} split` : `angle ${shown[0]}`} (${segIds[s] ?? "?"})`)
    .join(", ");
  const perAngle = angles
    .map((ang, i) => {
      const kept = segAngles.filter((x) => x.includes(i)).length;
      return `angle ${i} (${ang.id}): ${kept} segment${kept === 1 ? "" : "s"}`;
    })
    .join("; ");
  const splitNote =
    splitSegments > 0
      ? ` ${splitSegments} segment${splitSegments === 1 ? " shows" : "s show"} two angles at once, arranged ${a.splitLayout ?? (vertical ? "top-bottom" : "side-by-side")}.`
      : "";
  const audioNote =
    audioAngle < 0
      ? "Audio: all angles' audio left in place (detached from the picture so the cuts could not fragment it)."
      : detachedAudio > 0
        ? `Audio: continuous from angle ${audioAngle} (${angles[audioAngle]!.id}) across the whole window — its audio was detached from the picture and never cut; removed ${removedAudio} audio clip${removedAudio === 1 ? "" : "s"} from the other angles.`
        : `Audio: angle ${audioAngle} (${angles[audioAngle]!.id}) has no linked audio clip, so nothing was kept; removed ${removedAudio} audio clip${removedAudio === 1 ? "" : "s"} from the other angles.`;
  const outside = angles.filter((ang) => ang.origStart < winStart || ang.origEnd > winEnd).map((ang) => ang.id);
  const outsideNote = outside.length > 0 ? ` Picture outside the window (${outside.join(", ")}) was left in place.` : "";
  const pruneNote = pruned > 0 ? ` Pruned ${pruned} empty track${pruned === 1 ? "" : "s"} — indices shifted, re-read get_timeline.` : "";
  return (
    `Multicam cut across ${angles.length} angles in window [${winStart}, ${winEnd}) ` +
    `(${sec(winStart)}s–${sec(winEnd)}s @ ${fps}fps): ${segAngles.length} segment${segAngles.length === 1 ? "" : "s"} — ${segDesc}. ` +
    `${perAngle}. ${audioNote}${splitNote}${outsideNote}${pruneNote}`
  );
}
