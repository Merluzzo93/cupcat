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
import { clipEndFrame } from "@cupcat/editor-core";

export interface MulticamCutArgs {
  angleClipIds: string[];
  /** [[timelineFrame, angleIndex], ...] — validated here (raw MCP input). */
  cuts: unknown;
  /** Index into angleClipIds whose audio survives (default 0); -1 = leave all audio untouched. */
  audioAngle?: number;
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
    if (!Array.isArray(c) || c.length !== 2 || typeof c[0] !== "number" || typeof c[1] !== "number") {
      throw new Error(`cuts[${i}] must be a [timelineFrame, angleIndex] pair of numbers.`);
    }
    const frame = Math.round(c[0]);
    const angle = Math.round(c[1]);
    if (angle < 0 || angle >= angles.length) throw new Error(`cuts[${i}]: angleIndex ${angle} is out of range (0–${angles.length - 1}).`);
    if (frame < winStart || frame >= winEnd) {
      throw new Error(`cuts[${i}]: frame ${frame} is outside the angles' common overlap window — valid cut frames are [${winStart}, ${winEnd}).`);
    }
    return { frame, angle };
  });
  // Callers may hand cuts in any order and repeat a frame — last mention of a frame wins, then sort.
  const byFrame = new Map<number, number>();
  for (const c of parsed) byFrame.set(c.frame, c.angle);
  const cuts = [...byFrame.entries()].map(([frame, angle]) => ({ frame, angle })).sort((x, y) => x.frame - y.frame);

  const audioAngle = a.audioAngle === undefined ? 0 : Math.round(a.audioAngle);
  if (audioAngle < -1 || audioAngle >= angles.length) {
    throw new Error(`audioAngle ${audioAngle} is out of range — 0–${angles.length - 1}, or -1 to leave all audio untouched.`);
  }

  // Segment plan over [winStart, winEnd): before the first cut the first listed angle shows,
  // unless a cut sits exactly at the window start. Switches to the already-showing angle are
  // dropped — they would only dice the timeline into pointless extra pieces.
  const boundaries: number[] = [winStart];
  const segAngles: number[] = [];
  let current = cuts[0]!.frame === winStart ? cuts[0]!.angle : 0;
  for (const c of cuts) {
    if (c.frame === winStart || c.angle === current) continue;
    boundaries.push(c.frame);
    segAngles.push(current);
    current = c.angle;
  }
  boundaries.push(winEnd);
  segAngles.push(current);

  let detachedAudio = 0;
  let removedAudio = 0;
  let pruned = 0;
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

    // Per segment, keep only the chosen angle's piece; the removal set is exact clip ids, so no
    // link-group expansion can reach the surviving audio.
    const videoToRemove = new Set<string>();
    for (let s = 0; s < segAngles.length; s++) {
      const b0 = boundaries[s]!;
      const b1 = boundaries[s + 1]!;
      for (let i = 0; i < angles.length; i++) {
        const piece = doc.timeline.tracks[angles[i]!.trackIndex]!.clips.find((c) => c.startFrame === b0 && clipEndFrame(c) === b1);
        if (!piece) continue;
        if (i === segAngles[s]) segIds[s] = piece.id;
        else videoToRemove.add(piece.id);
      }
    }
    doc.removeClipsByIds(videoToRemove);
    pruned = doc.removeEmptyTracks(nonEmptyBefore);
  });

  const fps = doc.timeline.fps;
  const sec = (f: number) => (Math.round((f / fps) * 100) / 100).toFixed(2);
  const segDesc = segAngles.map((ai, s) => `[${boundaries[s]}–${boundaries[s + 1]}) angle ${ai} (${segIds[s] ?? "?"})`).join(", ");
  const perAngle = angles
    .map((ang, i) => {
      const kept = segAngles.filter((x) => x === i).length;
      return `angle ${i} (${ang.id}): ${kept} segment${kept === 1 ? "" : "s"}`;
    })
    .join("; ");
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
    `${perAngle}. ${audioNote}${outsideNote}${pruneNote}`
  );
}
