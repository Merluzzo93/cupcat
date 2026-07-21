// Command layer — validated, tool-facing timeline operations.
//
// One function per editing gesture, mirroring Palmier's ToolExecutor handlers: validate
// inputs up front (all-or-nothing, no partial state), run the mutation as one undoable step
// via EditorDocument, and return a short human summary. The MCP bridge maps tool names to
// these; the web UI calls the same functions with source "user".

import { EditorDocument, type EditSource, type FrameRange, type RippleInsertSpec } from "./document";
import { fpsRational, NTSC_RATES } from "./mediatime";
import {
  type AnimPair,
  type BlendMode,
  type Clip,
  type ClipType,
  type ColorGrade,
  type Crop,
  type Effect,
  type Interpolation,
  type Keyframe,
  type KeyframeTrack,
  type MediaFolder,
  type TextStyleRange,
  type TimelineMarker,
  BLEND_MODES,
  clipEndFrame,
  defaultTextStyle,
  defaultTransform,
  isCompatible,
  isNeutralGrade,
  makeClip,
  makeTimeline,
  makeTrack,
  type MaskSpec,
  type Track,
} from "./types";
import { newId } from "./ids";

export class CommandError extends Error {}

// ── arg helpers ─────────────────────────────────────────────────────────────
type Args = Record<string, unknown>;

function str(a: Args, k: string): string | undefined {
  const v = a[k];
  return typeof v === "string" && v.length > 0 ? v : undefined;
}
function reqStr(a: Args, k: string): string {
  const v = str(a, k);
  if (v === undefined) throw new CommandError(`Missing required argument: ${k}`);
  return v;
}
function num(a: Args, k: string): number | undefined {
  const v = a[k];
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Number(v);
  return undefined;
}
function int(a: Args, k: string): number | undefined {
  const v = num(a, k);
  return v === undefined ? undefined : Math.trunc(v);
}
function reqInt(a: Args, k: string): number {
  const v = int(a, k);
  if (v === undefined) throw new CommandError(`Missing required argument: ${k}`);
  return v;
}
function strArray(a: Args, k: string): string[] {
  const v = a[k];
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}
function plural(n: number): string {
  return n === 1 ? "" : "s";
}

// ── add_clips ─────────────────────────────────────────────────────────────────

interface PlaceTarget {
  assetId: string;
  trackId: string | null;
  startFrame: number;
  durationFrames: number;
  trimStartFrame?: number;
  trimEndFrame?: number;
  isAudio: boolean;
}

export function addClips(doc: EditorDocument, args: Args, source: EditSource = "agent"): string {
  const entries = Array.isArray(args.entries) ? (args.entries as Args[]) : [];
  if (entries.length === 0) throw new CommandError("Missing or empty 'entries' array");

  const targets: PlaceTarget[] = entries.map((e, idx) => {
    const assetId = reqStr(e, "mediaRef");
    const asset = doc.asset(assetId);
    if (!asset) throw new CommandError(`entries[${idx}]: media asset not found: ${assetId}`);
    const startFrame = reqInt(e, "startFrame");
    const durationFrames = reqInt(e, "durationFrames");
    if (durationFrames < 1) throw new CommandError(`entries[${idx}]: durationFrames must be >= 1`);
    if (startFrame < 0) throw new CommandError(`entries[${idx}]: startFrame must be >= 0`);
    let trackId: string | null = null;
    const ti = int(e, "trackIndex");
    if (ti !== undefined) {
      const track = doc.timeline.tracks[ti];
      if (!track)
        throw new CommandError(
          doc.timeline.tracks.length === 0
            ? `entries[${idx}]: the timeline has no tracks yet — omit trackIndex on every entry and the needed tracks are created automatically`
            : `entries[${idx}]: track index ${ti} out of range (0–${doc.timeline.tracks.length - 1})`,
        );
      if (!isCompatible(asset.type, track.type))
        throw new CommandError(`entries[${idx}]: ${asset.type} is not compatible with ${track.type} track ${ti}`);
      trackId = track.id;
    }
    return {
      assetId,
      trackId,
      startFrame,
      durationFrames,
      trimStartFrame: int(e, "trimStartFrame"),
      trimEndFrame: int(e, "trimEndFrame"),
      isAudio: asset.type === "audio",
    };
  });

  const omitted = targets.filter((t) => t.trackId === null).length;
  if (omitted !== 0 && omitted !== targets.length) {
    throw new CommandError(
      `Mixed trackIndex: ${omitted} of ${targets.length} entries omitted it. Set it on every entry or omit it on every entry.`,
    );
  }

  // Placing onto an explicit track clears the destination region — which silently DESTROYS whatever
  // was there (the classic accident: dropping music onto the voice track wipes the voice). The UI
  // keeps that drag-and-drop semantic, but an agent must opt in with replace:true; otherwise an
  // occupied region is an error that tells it what to do instead.
  if (source !== "user" && args.replace !== true) {
    for (let i = 0; i < targets.length; i++) {
      const t = targets[i]!;
      if (t.trackId === null) continue;
      const ti = doc.timeline.tracks.findIndex((x) => x.id === t.trackId);
      const track = doc.timeline.tracks[ti]!;
      const end = t.startFrame + t.durationFrames;
      const hit = track.clips.find((c) => c.startFrame < end && clipEndFrame(c) > t.startFrame);
      if (hit) {
        throw new CommandError(
          `entries[${i}]: track ${ti} already has ${hit.id} in frames ${t.startFrame}–${end} — placing there would DELETE it. ` +
            `Omit trackIndex to auto-create a fresh track (the right move for music beds/overlays), pick an empty range, or pass replace:true to intentionally overwrite.`,
        );
      }
    }
  }

  const created: string[] = [];
  const summaries: string[] = [];
  doc.mutate(targets.length === 1 ? "Add Clip" : "Add Clips", source, () => {
    const tracksBefore = new Set(doc.timeline.tracks.map((t) => t.id));
    const nonEmptyBefore = new Set(doc.timeline.tracks.filter((t) => t.clips.length > 0).map((t) => t.id));

    if (omitted === targets.length) {
      let videoTrackId: string | null = null;
      let audioTrackId: string | null = null;
      if (targets.some((t) => !t.isAudio)) videoTrackId = doc.timeline.tracks[doc.insertTrack(0, "video")]!.id;
      if (targets.some((t) => t.isAudio)) audioTrackId = doc.timeline.tracks[doc.insertTrack(0, "audio")]!.id;
      for (const t of targets) t.trackId = t.isAudio ? audioTrackId : videoTrackId;
    }

    const order = targets
      .map((_, i) => i)
      .sort((a, b) => {
        const ta = targets[a]!;
        const tb = targets[b]!;
        if (ta.isAudio !== tb.isAudio) return ta.isAudio ? -1 : 1;
        if (ta.trackId !== tb.trackId) return (ta.trackId ?? "") < (tb.trackId ?? "") ? -1 : 1;
        return ta.startFrame - tb.startFrame;
      });

    for (const i of order) {
      const t = targets[i]!;
      const trackIndex = doc.timeline.tracks.findIndex((x) => x.id === t.trackId);
      if (trackIndex < 0) throw new CommandError(`entries[${i}]: destination track no longer exists`);
      const asset = doc.asset(t.assetId)!;
      doc.clearRegion(trackIndex, t.startFrame, t.startFrame + t.durationFrames);
      const ids = doc.placeClip(
        {
          asset,
          startFrame: t.startFrame,
          durationFrames: t.durationFrames,
          trimStartFrame: t.trimStartFrame,
          trimEndFrame: t.trimEndFrame,
        },
        trackIndex,
      );
      const primary = ids[0];
      if (!primary) throw new CommandError(`entries[${i}]: failed to place clip`);
      const paired = ids.length > 1 ? ` (+linked audio ${ids[1]})` : "";
      summaries.push(`${primary} on track ${trackIndex} @ ${t.startFrame} for ${t.durationFrames}${paired}`);
    }

    doc.removeEmptyTracks(nonEmptyBefore);
    for (let i = 0; i < doc.timeline.tracks.length; i++) {
      const tr = doc.timeline.tracks[i]!;
      if (!tracksBefore.has(tr.id)) created.push(`track ${i} ('${doc.trackDisplayLabel(i)}', ${tr.type})`);
    }

    // Match the canvas to the first clip when starting from an empty timeline (CapCut-style), unless
    // the user already chose a format. A 4K or vertical source then "just works" — no manual step.
    // Dimensions only: changing fps here would reinterpret the durations just placed.
    if (nonEmptyBefore.size === 0 && !doc.timeline.settingsConfigured) {
      const firstVisual = order.map((i) => targets[i]!).find((t) => !t.isAudio);
      const a = firstVisual ? doc.asset(firstVisual.assetId) : null;
      if (a?.sourceWidth && a.sourceHeight && a.sourceWidth >= 16 && a.sourceHeight >= 16) {
        doc.timeline.width = Math.round(a.sourceWidth);
        doc.timeline.height = Math.round(a.sourceHeight);
      }
    }
  });

  const prefix = created.length ? `Created ${created.join(", ")}. ` : "";
  return `${prefix}Added ${targets.length} clip${plural(targets.length)}: ${summaries.join("; ")}`;
}

// ── insert_clips ────────────────────────────────────────────────────────────

export function insertClips(doc: EditorDocument, args: Args, source: EditSource = "agent"): string {
  const trackIndex = reqInt(args, "trackIndex");
  const atFrame = reqInt(args, "atFrame");
  const entries = Array.isArray(args.entries) ? (args.entries as Args[]) : [];
  if (entries.length === 0) throw new CommandError("Missing or empty 'entries' array");
  const track = doc.timeline.tracks[trackIndex];
  if (!track) throw new CommandError(`trackIndex ${trackIndex} out of range`);
  if (atFrame < 0) throw new CommandError("atFrame must be >= 0");

  const specs: RippleInsertSpec[] = entries.map((e, idx) => {
    const asset = doc.asset(reqStr(e, "mediaRef"));
    if (!asset) throw new CommandError(`entries[${idx}]: media asset not found`);
    if (!isCompatible(asset.type, track.type))
      throw new CommandError(`entries[${idx}]: ${asset.type} not compatible with ${track.type} track`);
    const duration = int(e, "durationFrames") ?? doc.clipDurationFor(asset);
    if (duration < 1) throw new CommandError(`entries[${idx}]: durationFrames must be >= 1`);
    return { asset, durationFrames: duration, trimStartFrame: int(e, "trimStartFrame"), trimEndFrame: int(e, "trimEndFrame") };
  });

  const totalPush = specs.reduce((s, x) => s + x.durationFrames, 0);
  let ids: string[] = [];
  doc.mutate(specs.length === 1 ? "Insert Clip" : "Insert Clips", source, () => {
    ids = doc.rippleInsert(specs, trackIndex, atFrame);
  });
  if (ids.length === 0) throw new CommandError(`Insert failed on track ${trackIndex} at frame ${atFrame}`);
  return `Inserted ${specs.length} clip${plural(specs.length)} at frame ${atFrame} on track ${trackIndex}, pushed later clips +${totalPush}f: ${ids.join(", ")}.`;
}

// ── remove_clips ──────────────────────────────────────────────────────────────

export function removeClips(doc: EditorDocument, args: Args, source: EditSource = "agent"): string {
  const clipIds = strArray(args, "clipIds");
  if (clipIds.length === 0) throw new CommandError("Missing or empty 'clipIds' array");
  for (const id of clipIds) if (!doc.getClip(id)) throw new CommandError(`Clip not found: ${id}`);
  const expanded = doc.expandToLinkGroupOverlapping(new Set(clipIds));
  let pruned = 0;
  doc.mutate("Remove Clips", source, () => {
    const nonEmptyBefore = new Set(doc.timeline.tracks.filter((t) => t.clips.length > 0).map((t) => t.id));
    doc.removeClipsByIds(expanded);
    pruned = doc.removeEmptyTracks(nonEmptyBefore);
  });
  const linked = expanded.size - clipIds.length;
  const linkNote = linked > 0 ? ` (+${linked} linked)` : "";
  const pruneNote = pruned > 0 ? `. Pruned ${pruned} empty track${plural(pruned)} — indices shifted, re-read get_timeline` : "";
  return `Removed ${expanded.size} clip${plural(expanded.size)}${linkNote}${pruneNote}: ${clipIds.join(", ")}`;
}

// ── remove_tracks ─────────────────────────────────────────────────────────────

export function removeTracks(doc: EditorDocument, args: Args, source: EditSource = "agent"): string {
  const raw = Array.isArray(args.trackIndexes) ? (args.trackIndexes as unknown[]) : [];
  const indexes = raw.map((x) => (typeof x === "number" ? Math.trunc(x) : NaN));
  if (indexes.length === 0 || indexes.some((i) => Number.isNaN(i)))
    throw new CommandError("remove_tracks: trackIndexes must be a non-empty array of integers");
  for (const i of indexes) if (!doc.timeline.tracks[i]) throw new CommandError(`remove_tracks: track index ${i} out of range`);
  let removed: { id: string; label: string; clipCount: number; index: number }[] = [];
  doc.mutate("Remove Tracks", source, () => {
    removed = doc.removeTracksByIndexes(indexes);
  });
  return JSON.stringify({
    removedTracks: removed.map((r) => ({ trackIndex: r.index, label: r.label, clipCount: r.clipCount })),
  });
}

// ── reorder_tracks ─────────────────────────────────────────────────────────────

export function reorderTracks(doc: EditorDocument, args: Args, source: EditSource = "agent"): string {
  const from = reqInt(args, "from");
  const to = reqInt(args, "to");
  if (!doc.timeline.tracks[from]) throw new CommandError(`reorder_tracks: 'from' index ${from} out of range`);
  if (to < 0 || to >= doc.timeline.tracks.length) throw new CommandError(`reorder_tracks: 'to' index ${to} out of range`);
  let moved = false;
  doc.mutate("Reorder Tracks", source, () => {
    moved = doc.moveTrack(from, to);
  });
  return moved ? `Moved track ${from} → ${to}.` : `No change (from=${from}, to=${to}).`;
}

// ── move_clips ────────────────────────────────────────────────────────────────

export function moveClips(doc: EditorDocument, args: Args, source: EditSource = "agent"): string {
  const moves = Array.isArray(args.moves) ? (args.moves as Args[]) : [];
  if (moves.length === 0) throw new CommandError("Missing or empty 'moves' array");

  const parsed = moves.map((m, idx) => {
    const clipId = reqStr(m, "clipId");
    const toTrack = int(m, "toTrack");
    const toFrame = int(m, "toFrame");
    if (toTrack === undefined && toFrame === undefined)
      throw new CommandError(`moves[${idx}]: at least one of 'toTrack' or 'toFrame' is required`);
    const loc = doc.findClip(clipId);
    if (!loc) throw new CommandError(`moves[${idx}]: clip not found: ${clipId}`);
    let destTrackId: string | null = null;
    if (toTrack !== undefined) {
      const dest = doc.timeline.tracks[toTrack];
      if (!dest) throw new CommandError(`moves[${idx}]: toTrack ${toTrack} out of range`);
      const srcType = doc.timeline.tracks[loc.trackIndex]!.type;
      if (!isCompatible(dest.type, srcType))
        throw new CommandError(`moves[${idx}]: toTrack ${toTrack} (${dest.type}) incompatible with ${srcType} clip`);
      destTrackId = dest.id;
    }
    if (toFrame !== undefined && toFrame < 0) throw new CommandError(`moves[${idx}]: toFrame must be >= 0`);
    return { clipId, destTrackId, toFrame };
  });

  // Expand to linked partners (track changes don't propagate; frame deltas do).
  const seen = new Set(parsed.map((p) => p.clipId));
  const all = [...parsed];
  for (const p of parsed) {
    if (p.toFrame === undefined) continue;
    for (const pm of doc.partnerMoves(p.clipId, p.toFrame)) {
      if (!seen.has(pm.clipId)) {
        all.push({ clipId: pm.clipId, destTrackId: null, toFrame: pm.toFrame });
        seen.add(pm.clipId);
      }
    }
  }
  const linked = all.length - parsed.length;

  doc.mutate(parsed.length === 1 ? "Move Clip" : "Move Clips", source, () => {
    const resolved = all
      .map((m) => {
        const loc = doc.findClip(m.clipId);
        if (!loc) return null;
        const cur = doc.timeline.tracks[loc.trackIndex]!.clips[loc.clipIndex]!;
        const toTrack =
          m.destTrackId !== null ? doc.timeline.tracks.findIndex((t) => t.id === m.destTrackId) : loc.trackIndex;
        return { clipId: m.clipId, toTrack: toTrack < 0 ? loc.trackIndex : toTrack, toFrame: m.toFrame ?? cur.startFrame };
      })
      .filter((x): x is { clipId: string; toTrack: number; toFrame: number } => x !== null);
    doc.moveClips(resolved);
  });

  const linkNote = linked > 0 ? ` (+${linked} linked)` : "";
  const summary = parsed
    .map((p) => `${p.clipId}: ${[p.destTrackId !== null ? "track" : null, p.toFrame !== undefined ? "frame" : null].filter(Boolean).join(", ")}`)
    .join("; ");
  return `Moved ${parsed.length} clip${plural(parsed.length)}${linkNote}: ${summary}`;
}

// ── set_clip_properties ────────────────────────────────────────────────────────

const HEX = /^#([0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;

/** Validate a tool-supplied styleRanges payload. The whole array replaces the clip's list;
 * null means clear — both callers (set_clip_properties, add_texts) share the same rules so a
 * bad range is rejected up front instead of surfacing as a broken render. */
function parseStyleRanges(v: unknown, ctx: string): TextStyleRange[] | null | undefined {
  if (v === undefined) return undefined;
  if (v === null) return null;
  if (!Array.isArray(v)) throw new CommandError(`${ctx}: styleRanges must be an array of {start, end, ...} (or null to clear)`);
  return v.map((raw, i) => {
    const r = (raw ?? {}) as Args;
    const start = int(r, "start");
    const end = int(r, "end");
    if (start === undefined || end === undefined || start < 0 || end <= start)
      throw new CommandError(`${ctx}: styleRanges[${i}] needs integer character offsets with 0 <= start < end`);
    const color = str(r, "color");
    if (color && !HEX.test(color))
      throw new CommandError(`${ctx}: styleRanges[${i}].color '${color}' must be '#RRGGBB' or '#RRGGBBAA'`);
    const scale = num(r, "fontSizeScale");
    if (scale !== undefined && !(scale > 0 && scale <= 10))
      throw new CommandError(`${ctx}: styleRanges[${i}].fontSizeScale must be in 0–10 (1 = the clip's fontSize)`);
    const out: TextStyleRange = { start, end };
    if (color) out.color = color;
    if (typeof r.bold === "boolean") out.bold = r.bold;
    if (typeof r.italic === "boolean") out.italic = r.italic;
    if (scale !== undefined) out.fontSizeScale = scale;
    return out;
  });
}

function applyProps(doc: EditorDocument, clipId: string, a: Args, asText: boolean): string[] {
  const before = doc.getClip(clipId);
  const oldEnd = before ? before.startFrame + before.durationFrames : 0;
  const changed: string[] = [];
  doc.commitClipProperty(clipId, (clip) => {
    const durationFrames = int(a, "durationFrames");
    const trimStartFrame = int(a, "trimStartFrame");
    const trimEndFrame = int(a, "trimEndFrame");
    const speed = num(a, "speed");
    const volume = num(a, "volume");
    const opacity = num(a, "opacity");
    const blendModeRaw = str(a, "blendMode");
    if (blendModeRaw !== undefined && !BLEND_MODES.includes(blendModeRaw as BlendMode))
      throw new CommandError(`blendMode must be one of: ${BLEND_MODES.join(", ")}`);
    const blendMode = blendModeRaw as BlendMode | undefined;

    if (durationFrames !== undefined) {
      clip.durationFrames = durationFrames;
      changed.push("durationFrames");
    }
    if (trimStartFrame !== undefined) {
      clip.trimStartFrame = trimStartFrame;
      changed.push("trimStartFrame");
    }
    if (trimEndFrame !== undefined) {
      clip.trimEndFrame = trimEndFrame;
      changed.push("trimEndFrame");
    }
    if (speed !== undefined) {
      if (durationFrames === undefined && speed > 0) {
        const sourceConsumed = clip.durationFrames * clip.speed;
        const newDur = Math.max(1, Math.round(sourceConsumed / speed));
        // Rescale keyframe positions to the new duration so animations keep their relative timing and
        // aren't stranded past the clip's new end — changing speed must never "lose" keyframes.
        if (clip.durationFrames > 0 && newDur !== clip.durationFrames) {
          const ratio = newDur / clip.durationFrames;
          for (const t of [clip.scaleTrack, clip.positionTrack, clip.opacityTrack, clip.volumeTrack, clip.rotationTrack, clip.cropTrack]) {
            if (t?.keyframes) for (const k of t.keyframes) k.frame = Math.round(k.frame * ratio);
          }
        }
        clip.durationFrames = newDur;
        changed.push("durationFrames");
      }
      clip.speed = speed;
      changed.push("speed");
    }
    if (volume !== undefined) {
      clip.volume = volume;
      clip.volumeTrack = undefined;
      changed.push("volume");
    }
    if (opacity !== undefined) {
      clip.opacity = opacity;
      clip.opacityTrack = undefined;
      changed.push("opacity");
    }
    if (blendMode !== undefined) {
      clip.blendMode = blendMode;
      changed.push("blendMode");
    }
    if (typeof a.audioDuck === "boolean") {
      clip.audioDuck = a.audioDuck;
      changed.push("audioDuck");
    }
    if (a.audioFx !== undefined) {
      if (a.audioFx === null || a.audioFx === "none") {
        clip.audioFx = undefined;
        changed.push("audioFx");
      } else {
        const fx = a.audioFx as { type?: string; amount?: number };
        const type = ["pitch", "robot", "echo", "radio"].find((t) => t === fx?.type);
        if (!type) throw new CommandError("audioFx.type must be one of: pitch, robot, echo, radio (or null to remove)");
        const amount = typeof fx.amount === "number" ? fx.amount : undefined;
        clip.audioFx = { type: type as "pitch" | "robot" | "echo" | "radio", amount };
        changed.push("audioFx");
      }
    }
    const tf = a.transform as Args | undefined;
    if (tf && typeof tf === "object") {
      const cur = clip.transform;
      clip.transform = {
        ...cur,
        centerX: num(tf, "centerX") ?? cur.centerX,
        centerY: num(tf, "centerY") ?? cur.centerY,
        width: num(tf, "width") ?? cur.width,
        height: num(tf, "height") ?? cur.height,
        rotation: num(tf, "rotation") ?? cur.rotation,
        flipHorizontal: typeof tf.flipHorizontal === "boolean" ? tf.flipHorizontal : cur.flipHorizontal,
        flipVertical: typeof tf.flipVertical === "boolean" ? tf.flipVertical : cur.flipVertical,
      };
      changed.push("transform");
    }
    const cr = a.crop as Args | undefined;
    if (cr && typeof cr === "object") {
      const cc = clip.crop;
      clip.crop = {
        left: num(cr, "left") ?? cc.left,
        top: num(cr, "top") ?? cc.top,
        right: num(cr, "right") ?? cc.right,
        bottom: num(cr, "bottom") ?? cc.bottom,
      };
      changed.push("crop");
    }
    const fadeIn = int(a, "fadeInFrames");
    if (fadeIn !== undefined) {
      clip.fadeInFrames = Math.max(0, fadeIn);
      changed.push("fadeInFrames");
    }
    const fadeOut = int(a, "fadeOutFrames");
    if (fadeOut !== undefined) {
      clip.fadeOutFrames = Math.max(0, fadeOut);
      changed.push("fadeOutFrames");
    }
    if (asText) {
      const content = str(a, "content");
      const fontName = str(a, "fontName");
      const fontSize = num(a, "fontSize");
      const color = str(a, "color");
      const alignment = str(a, "alignment");
      if (content !== undefined) {
        clip.textContent = content;
        changed.push("content");
      }
      if (fontName || fontSize !== undefined || color || alignment) {
        const style = clip.textStyle ?? defaultTextStyle();
        if (fontName) {
          style.fontName = fontName;
          changed.push("fontName");
        }
        if (fontSize !== undefined) {
          style.fontSize = fontSize;
          changed.push("fontSize");
        }
        if (color) {
          if (!HEX.test(color)) throw new CommandError(`invalid color '${color}'. Expected '#RRGGBB' or '#RRGGBBAA'.`);
          style.color = color;
          changed.push("color");
        }
        if (alignment) {
          if (!["left", "center", "right"].includes(alignment))
            throw new CommandError(`invalid alignment '${alignment}'.`);
          style.alignment = alignment as "left" | "center" | "right";
          changed.push("alignment");
        }
        clip.textStyle = style;
      }
      // Rich per-substring styling: the array REPLACES the clip's list (null/[] clears) — merge
      // semantics on char ranges would be ambiguous once the text changes underneath them.
      if (a.styleRanges !== undefined) {
        const ranges = parseStyleRanges(a.styleRanges, "set_clip_properties");
        clip.styleRanges = ranges == null || ranges.length === 0 ? undefined : ranges;
        changed.push("styleRanges");
      }
    }
  });
  // Ripple on speed-driven duration changes: slowing a clip grows it in place, which would OVERLAP
  // the next clip on its track; speeding it up would leave a black gap. Shift everything downstream
  // on the same track by the delta so the track stays tight — this is what "make the first half
  // slow-mo" means on a timeline. (Explicit durationFrames/trim edits keep their non-ripple
  // semantics; each linked partner runs this on its own track when the change propagates.)
  if (changed.includes("speed") && changed.includes("durationFrames") && int(a, "durationFrames") === undefined) {
    const after = doc.getClip(clipId);
    const loc = doc.findClip(clipId);
    if (after && loc) {
      const delta = after.startFrame + after.durationFrames - oldEnd;
      if (delta !== 0) {
        const track = doc.timeline.tracks[loc.trackIndex]!;
        for (const o of track.clips) {
          if (o.id !== clipId && o.startFrame >= oldEnd) o.startFrame = Math.max(0, o.startFrame + delta);
        }
        track.clips.sort((x, y) => x.startFrame - y.startFrame);
      }
    }
  }
  return changed;
}

export function setClipProperties(doc: EditorDocument, args: Args, source: EditSource = "agent"): string {
  const clipIds = strArray(args, "clipIds");
  if (clipIds.length === 0) throw new CommandError("Missing or empty 'clipIds' array");
  const df = int(args, "durationFrames");
  if (df !== undefined && df < 1) throw new CommandError("durationFrames must be >= 1");

  // Validate numeric inputs up front: reject NaN/Infinity and out-of-range values so a bad agent arg
  // can't corrupt the clip or overflow downstream integer math.
  const spd = num(args, "speed");
  if (spd !== undefined && !(Number.isFinite(spd) && spd > 0 && spd <= 100))
    throw new CommandError("speed must be a finite number in 0–100 (0.5 = half speed, 2 = double).");
  const vol = num(args, "volume");
  if (vol !== undefined && !(Number.isFinite(vol) && vol >= 0 && vol <= 16))
    throw new CommandError("volume must be a finite number in 0–16 (1 = unchanged).");
  const op = num(args, "opacity");
  if (op !== undefined && !(Number.isFinite(op) && op >= 0 && op <= 1))
    throw new CommandError("opacity must be in 0–1.");
  for (const k of ["trimStartFrame", "trimEndFrame", "fadeInFrames", "fadeOutFrames"] as const) {
    const v = int(args, k);
    if (v !== undefined && (!Number.isFinite(v) || v < 0 || v > 10_000_000))
      throw new CommandError(`${k} must be an integer between 0 and 10000000.`);
  }

  const types = new Map<string, string>();
  for (const id of clipIds) {
    const c = doc.getClip(id);
    if (!c) throw new CommandError(`Clip not found: ${id}`);
    types.set(id, c.mediaType);
  }
  const textOnlyUsed = ["content", "fontName", "fontSize", "color", "alignment", "styleRanges"].filter((k) => args[k] !== undefined);
  if (textOnlyUsed.length) {
    const nonText = [...types.entries()].filter(([, t]) => t !== "text").map(([id]) => id);
    if (nonText.length)
      throw new CommandError(`text-only fields '${textOnlyUsed.join("', '")}' rejected on non-text clips: ${nonText.join(", ")}`);
  }
  const anyProp =
    df !== undefined ||
    [
      "trimStartFrame",
      "trimEndFrame",
      "speed",
      "volume",
      "opacity",
      "transform",
      "crop",
      "fadeInFrames",
      "fadeOutFrames",
      "content",
      "fontName",
      "fontSize",
      "color",
      "alignment",
      "styleRanges",
      "blendMode",
      "audioDuck",
      "audioFx",
    ].some((k) => args[k] !== undefined);
  if (!anyProp) throw new CommandError("set_clip_properties needs at least one property to apply");

  const propagatesTiming = ["durationFrames", "trimStartFrame", "trimEndFrame", "speed"].some((k) => args[k] !== undefined);
  const partners = propagatesTiming ? doc.timingPartners(new Set(clipIds)) : new Set<string>();

  const summaries: string[] = [];
  doc.mutate(clipIds.length === 1 ? "Set Clip Property" : "Set Clip Properties", source, () => {
    for (const id of clipIds) {
      const changed = applyProps(doc, id, args, types.get(id) === "text");
      summaries.push(`${id}${changed.length ? `: ${changed.join(", ")}` : " (no-op)"}`);
    }
    for (const pid of partners) {
      const isText = doc.getClip(pid)?.mediaType === "text";
      const timingOnly: Args = {
        durationFrames: args.durationFrames,
        trimStartFrame: isText ? undefined : args.trimStartFrame,
        trimEndFrame: isText ? undefined : args.trimEndFrame,
        speed: isText ? undefined : args.speed,
      };
      applyProps(doc, pid, timingOnly, false);
    }
  });

  const linkNote = partners.size ? ` (+${partners.size} linked)` : "";
  return `Updated ${clipIds.length} clip${plural(clipIds.length)}${linkNote}: ${summaries.join("; ")}`;
}

// ── set_keyframes ──────────────────────────────────────────────────────────────

const KF_PROPS = ["volume", "opacity", "rotation", "position", "scale", "crop"] as const;

function parseInterp(v: unknown): Interpolation {
  if (v === undefined || v === null) return "smooth";
  if (v === "linear" || v === "hold" || v === "smooth" || v === "bezier") return v;
  throw new CommandError(`interp must be one of 'linear', 'hold', 'smooth', 'bezier' (got ${JSON.stringify(v)})`);
}

/** Parse the 4 handle numbers a "bezier" row may append after the interp: outX outY inX inY.
 * Handle X is time within the segment, so it must stay in [0,1] (keeps the curve a function of
 * time); handle Y is the value axis and stays unclamped so eases can overshoot. */
function parseBezierHandles(raw: unknown[], at: number, i: number): { bezierOut: [number, number]; bezierIn: [number, number] } {
  const nums = raw.slice(at, at + 4).map((x) => Number(x));
  if (nums.some((n) => !Number.isFinite(n)))
    throw new CommandError(`keyframes[${i}]: bezier handles must be 4 finite numbers (outX, outY, inX, inY)`);
  const [outX, outY, inX, inY] = nums as [number, number, number, number];
  if (outX < 0 || outX > 1 || inX < 0 || inX > 1)
    throw new CommandError(`keyframes[${i}]: bezier handle X values must be within 0..1 (got outX=${outX}, inX=${inX})`);
  return { bezierOut: [outX, outY], bezierIn: [inX, inY] };
}

function parseRows<V>(rows: unknown[], fields: number, build: (vals: number[]) => V): KeyframeTrack<V> {
  const out: Keyframe<V>[] = [];
  rows.forEach((raw, i) => {
    if (!Array.isArray(raw)) throw new CommandError(`keyframes[${i}]: expected an array row`);
    // fields+6 = bezier row with explicit handles: [frame, ...vals, "bezier", outX, outY, inX, inY].
    if (raw.length !== fields + 1 && raw.length !== fields + 2 && raw.length !== fields + 6)
      throw new CommandError(`keyframes[${i}]: expected ${fields + 1}, ${fields + 2} or ${fields + 6} elements`);
    const frame = Math.trunc(Number(raw[0]));
    const vals = raw.slice(1, fields + 1).map((x) => Number(x));
    if (!Number.isFinite(frame) || vals.some((v) => !Number.isFinite(v)))
      throw new CommandError(`keyframes[${i}]: values must be finite numbers`);
    const interp = parseInterp(raw[fields + 1]);
    if (raw.length === fields + 6 && interp !== "bezier")
      throw new CommandError(`keyframes[${i}]: handle values are only valid with interp 'bezier'`);
    const handles = raw.length === fields + 6 ? parseBezierHandles(raw, fields + 2, i) : undefined;
    out.push({ frame, value: build(vals), interpolationOut: interp, ...handles });
  });
  out.sort((a, b) => a.frame - b.frame);
  const deduped: Keyframe<V>[] = [];
  for (const kf of out) {
    if (deduped.length && deduped[deduped.length - 1]!.frame === kf.frame) deduped[deduped.length - 1] = kf;
    else deduped.push(kf);
  }
  return { keyframes: deduped };
}

export function setKeyframes(doc: EditorDocument, args: Args, source: EditSource = "agent"): string {
  const clipId = reqStr(args, "clipId");
  const property = reqStr(args, "property");
  const rows = Array.isArray(args.keyframes) ? (args.keyframes as unknown[]) : null;
  if (!rows) throw new CommandError("Missing required field 'keyframes' (must be an array)");
  if (!KF_PROPS.includes(property as (typeof KF_PROPS)[number]))
    throw new CommandError(`Unknown property '${property}'. Expected one of: ${KF_PROPS.join(", ")}`);
  if (!doc.getClip(clipId)) throw new CommandError(`Clip not found: ${clipId}`);

  doc.mutate("Set Keyframes", source, () => {
    doc.commitClipProperty(clipId, (clip) => {
      const setScalar = (t: KeyframeTrack<number>) => (t.keyframes.length ? t : undefined);
      switch (property) {
        case "volume":
          clip.volumeTrack = setScalar(parseRows(rows, 1, (v) => v[0]!));
          break;
        case "opacity":
          clip.opacityTrack = setScalar(parseRows(rows, 1, (v) => v[0]!));
          break;
        case "rotation":
          clip.rotationTrack = setScalar(parseRows(rows, 1, (v) => v[0]!));
          break;
        case "position": {
          const t = parseRows<AnimPair>(rows, 2, (v) => ({ a: v[0]!, b: v[1]! }));
          clip.positionTrack = t.keyframes.length ? t : undefined;
          break;
        }
        case "scale": {
          const t = parseRows<AnimPair>(rows, 2, (v) => ({ a: v[0]!, b: v[1]! }));
          clip.scaleTrack = t.keyframes.length ? t : undefined;
          break;
        }
        case "crop": {
          const t = parseRows<Crop>(rows, 4, (v) => ({ top: v[0]!, right: v[1]!, bottom: v[2]!, left: v[3]! }));
          clip.cropTrack = t.keyframes.length ? t : undefined;
          break;
        }
      }
    });
  });
  return rows.length ? `set ${rows.length} keyframes on ${property} for ${clipId}` : `cleared keyframes on ${property} for ${clipId}`;
}

// ── split_clip ───────────────────────────────────────────────────────────────

export function splitClip(doc: EditorDocument, args: Args, source: EditSource = "agent"): string {
  const clipId = reqStr(args, "clipId");
  const clip = doc.getClip(clipId);
  if (!clip) throw new CommandError(`Clip not found: ${clipId}`);
  // Accept a single atFrame OR a batch atFrames[] — split the clip into many pieces in one call.
  const single = int(args, "atFrame");
  const multi = Array.isArray(args.atFrames)
    ? (args.atFrames as unknown[]).map((f) => Math.round(Number(f))).filter((f) => Number.isFinite(f))
    : null;
  let frames = multi && multi.length ? multi : single !== undefined ? [single] : [];
  if (frames.length === 0) throw new CommandError("Provide 'atFrame' (number) or 'atFrames' (array of project frames).");
  const lo = clip.startFrame;
  const hi = clipEndFrame(clip);
  frames = [...new Set(frames)];
  for (const f of frames) if (f <= lo || f >= hi) throw new CommandError(`Frame ${f} is outside clip range (${lo}..${hi})`);
  // Split descending: the LEFT piece keeps clipId, so every cut targets the same (shrinking) clip id.
  frames.sort((a, b) => b - a);
  const created: string[] = [];
  doc.mutate(frames.length === 1 ? "Split Clip" : "Split Clip (batch)", source, () => {
    for (const f of frames) created.push(...doc.splitClip(clipId, f));
  });
  const ascending = [...frames].sort((a, b) => a - b);
  // Spell out exact frame ranges per resulting piece — with a batch split, and now that a linked
  // partner (e.g. a video's detached audio) is split in tandem, "new piece(s): id1, id2" alone is too
  // easy to misread as "which is earlier" and apply the wrong effect to the wrong half.
  const describe = (id: string) => {
    const c = doc.getClip(id);
    return c ? `${id} (${c.mediaType}, frames ${c.startFrame}..${clipEndFrame(c)})` : id;
  };
  return (
    `Split at ${frames.length} point(s) (frame${frames.length > 1 ? "s" : ""} ${ascending.join(", ")}). ` +
    `'${clipId}' keeps the FIRST/earliest piece: ${describe(clipId)}. ` +
    `New, LATER piece(s) (each clipId's own startFrame tells you where it begins): ${created.map(describe).join(", ") || "none"}.`
  );
}

// ── ripple_delete_ranges ───────────────────────────────────────────────────────

export function rippleDeleteRanges(doc: EditorDocument, args: Args, source: EditSource = "agent"): string {
  const ranges = Array.isArray(args.ranges) ? (args.ranges as unknown[]) : [];
  if (ranges.length === 0) throw new CommandError("Missing or empty 'ranges' array");
  const units = str(args, "units") ?? "frames";
  if (units !== "frames" && units !== "seconds") throw new CommandError(`units must be 'seconds' or 'frames' (got '${units}')`);
  const clipId = str(args, "clipId");
  const trackIndex = int(args, "trackIndex");
  if ((clipId !== undefined) === (trackIndex !== undefined))
    throw new CommandError("Provide exactly one of 'clipId' or 'trackIndex'.");

  const pairs = ranges.map((r, i) => {
    if (!Array.isArray(r) || r.length !== 2) throw new CommandError(`ranges[${i}]: expected [start, end]`);
    const a = Number(r[0]);
    const b = Number(r[1]);
    if (!(b > a)) throw new CommandError(`ranges[${i}]: end (${b}) must be greater than start (${a})`);
    return [a, b] as [number, number];
  });

  const fps = doc.timeline.fps;
  let resolvedTrack: number;
  const frameRanges: FrameRange[] = [];
  let dropped = 0;

  if (clipId !== undefined) {
    const loc = doc.findClip(clipId);
    if (!loc) throw new CommandError(`Clip not found: ${clipId}`);
    const clip = doc.timeline.tracks[loc.trackIndex]!.clips[loc.clipIndex]!;
    const speed = clip.speed > 0 ? clip.speed : 1;
    const toFrame = (v: number) =>
      units === "frames" ? v : clip.startFrame + (v * fps - clip.trimStartFrame) / speed;
    const SNAP = 3; // absorb a sub-3-frame sliver at a clip edge so a head/tail cut leaves no fragment
    const cs = clip.startFrame;
    const ce = clipEndFrame(clip);
    for (const [a, b] of pairs) {
      let s = Math.max(cs, Math.min(ce, Math.round(toFrame(a))));
      let e = Math.max(cs, Math.min(ce, Math.round(toFrame(b))));
      if (s > cs && s - cs <= SNAP) s = cs; // a near-start cut → snap to the clip head
      if (e < ce && ce - e <= SNAP) e = ce; // a near-end cut → snap to the clip tail
      if (e > s) frameRanges.push({ start: s, end: e });
      else dropped++;
    }
    if (frameRanges.length === 0) throw new CommandError(`No ranges fall within clip ${clipId}.`);
    resolvedTrack = loc.trackIndex;
  } else {
    if (units !== "frames") throw new CommandError("units 'seconds' requires a clipId.");
    if (!doc.timeline.tracks[trackIndex!]) throw new CommandError(`Track index out of range: ${trackIndex}`);
    for (const [a, b] of pairs) {
      const s = Math.max(0, Math.round(a));
      const e = Math.round(b);
      if (e > s) frameRanges.push({ start: s, end: e });
      else dropped++;
    }
    if (frameRanges.length === 0) throw new CommandError(`No valid project-frame ranges on track ${trackIndex}.`);
    resolvedTrack = trackIndex!;
  }

  const ignoreSyncLock = args.ignoreSyncLock === true;
  const outcome = doc.mutate("Ripple Delete", source, () => doc.rippleDelete(resolvedTrack, frameRanges, { ignoreSyncLock }));
  if ("refused" in outcome) throw new CommandError(outcome.refused);
  const payload: Record<string, unknown> = { ...outcome };
  if (dropped > 0) payload.rangesIgnored = dropped;
  return JSON.stringify(payload);
}

// ── add_texts ──────────────────────────────────────────────────────────────────

export function addTexts(doc: EditorDocument, args: Args, source: EditSource = "agent"): string {
  const entries = Array.isArray(args.entries) ? (args.entries as Args[]) : [];
  if (entries.length === 0) throw new CommandError("Missing or empty 'entries' array");

  const parsed = entries.map((e, idx) => {
    const content = reqStr(e, "content");
    const startFrame = reqInt(e, "startFrame");
    const durationFrames = reqInt(e, "durationFrames");
    if (durationFrames < 1) throw new CommandError(`entries[${idx}]: durationFrames must be >= 1`);
    if (startFrame < 0) throw new CommandError(`entries[${idx}]: startFrame must be >= 0`);
    let trackId: string | null = null;
    const ti = int(e, "trackIndex");
    if (ti !== undefined) {
      const track = doc.timeline.tracks[ti];
      if (!track)
        throw new CommandError(
          doc.timeline.tracks.length === 0
            ? `entries[${idx}]: the timeline has no tracks yet — omit trackIndex on every entry and the needed tracks are created automatically`
            : `entries[${idx}]: track index ${ti} out of range (0–${doc.timeline.tracks.length - 1})`,
        );
      if (track.type === "audio") throw new CommandError(`entries[${idx}]: cannot place text on an audio track`);
      trackId = track.id;
    }
    const style = defaultTextStyle();
    const fontName = str(e, "fontName");
    const fontSize = num(e, "fontSize");
    const color = str(e, "color");
    const alignment = str(e, "alignment");
    if (fontName) style.fontName = fontName;
    if (fontSize !== undefined) style.fontSize = fontSize;
    if (color) {
      if (!HEX.test(color)) throw new CommandError(`entries[${idx}]: invalid color '${color}'`);
      style.color = color;
    }
    if (alignment) {
      if (!["left", "center", "right"].includes(alignment)) throw new CommandError(`entries[${idx}]: invalid alignment`);
      style.alignment = alignment as "left" | "center" | "right";
    }
    const tf = e.transform as Args | undefined;
    const transform = defaultTransform();
    transform.width = 0.8;
    transform.height = 0.2;
    if (tf && typeof tf === "object") {
      transform.centerX = num(tf, "centerX") ?? transform.centerX;
      transform.centerY = num(tf, "centerY") ?? transform.centerY;
      transform.width = num(tf, "width") ?? transform.width;
      transform.height = num(tf, "height") ?? transform.height;
    }
    const styleRanges = parseStyleRanges(e.styleRanges, `entries[${idx}]`) ?? undefined;
    return { trackId, content, startFrame, durationFrames, style, transform, styleRanges };
  });

  const omitted = parsed.filter((p) => p.trackId === null).length;
  if (omitted !== 0 && omitted !== parsed.length)
    throw new CommandError("Mixed trackIndex: set it on every entry or omit it on every entry.");

  const summaries: string[] = [];
  let createdTrack: string | null = null;
  doc.mutate(parsed.length === 1 ? "Add Text" : "Add Texts", source, () => {
    if (omitted === parsed.length) {
      const idx = doc.insertTrack(0, "video");
      createdTrack = `track ${idx} ('${doc.trackDisplayLabel(idx)}', video)`;
      const id = doc.timeline.tracks[idx]!.id;
      for (const p of parsed) p.trackId = id;
    }
    for (const p of parsed) {
      const trackIndex = doc.timeline.tracks.findIndex((t) => t.id === p.trackId);
      if (trackIndex < 0) throw new CommandError("destination track no longer exists");
      doc.clearRegion(trackIndex, p.startFrame, p.startFrame + p.durationFrames);
      const clip: Clip = {
        ...makeTextClip(p.content, p.startFrame, p.durationFrames),
        textStyle: p.style,
        transform: p.transform,
        styleRanges: p.styleRanges && p.styleRanges.length ? p.styleRanges : undefined,
      };
      doc.timeline.tracks[trackIndex]!.clips.push(clip);
      doc.timeline.tracks[trackIndex]!.clips.sort((a, b) => a.startFrame - b.startFrame);
      summaries.push(`${clip.id} ('${p.content.slice(0, 24)}') on track ${trackIndex} @ ${p.startFrame} for ${p.durationFrames}`);
    }
  });
  const prefix = createdTrack ? `Created ${createdTrack}. ` : "";
  return `${prefix}Added ${parsed.length} text clip${plural(parsed.length)}: ${summaries.join("; ")}`;
}

// ── add_adjustment_layer ──────────────────────────────────────────────────────

/** Create an adjustment layer: a media-less clip whose color grade / effect stack is applied to
 * EVERYTHING composited below it during its time window (CapCut/AE semantics). The layer itself is
 * created neutral — grade it afterwards with apply_color / apply_effect on the returned clipId. */
export function addAdjustmentLayer(doc: EditorDocument, args: Args, source: EditSource = "agent"): string {
  const startFrame = reqInt(args, "startFrame");
  const durationFrames = reqInt(args, "durationFrames");
  if (startFrame < 0) throw new CommandError("startFrame must be >= 0");
  if (durationFrames < 1) throw new CommandError("durationFrames must be >= 1");
  const name = str(args, "name");
  const ti = int(args, "trackIndex");
  if (ti !== undefined) {
    const track = doc.timeline.tracks[ti];
    if (!track)
      throw new CommandError(
        doc.timeline.tracks.length === 0
          ? "the timeline has no tracks yet — omit trackIndex and a fresh TOP track is created automatically"
          : `track index ${ti} out of range (0–${doc.timeline.tracks.length - 1})`,
      );
    if (track.type === "audio") throw new CommandError("cannot place an adjustment layer on an audio track");
    // Same protection as add_clips: silently clearing an occupied region would DELETE what's there.
    const end = startFrame + durationFrames;
    const hit = track.clips.find((c) => c.startFrame < end && clipEndFrame(c) > startFrame);
    if (hit)
      throw new CommandError(
        `track ${ti} already has ${hit.id} in frames ${startFrame}–${end} — omit trackIndex to create a fresh TOP track (the usual home for an adjustment layer), or pick an empty range.`,
      );
  }
  let clipId = "";
  let createdTrack: string | null = null;
  doc.mutate("Add Adjustment Layer", source, () => {
    let trackIndex: number;
    if (ti === undefined) {
      // Index 0 is the TOP of the stack (the compositor walks tracks bottom-up in reverse array
      // order), so a fresh track here puts the adjustment above every existing video layer.
      trackIndex = doc.insertTrack(0, "video");
      createdTrack = `track ${trackIndex} ('${doc.trackDisplayLabel(trackIndex)}', video)`;
    } else {
      trackIndex = ti;
    }
    const clip = makeClip({ mediaRef: "", mediaType: "adjustment", startFrame, durationFrames, name });
    doc.timeline.tracks[trackIndex]!.clips.push(clip);
    doc.timeline.tracks[trackIndex]!.clips.sort((a, b) => a.startFrame - b.startFrame);
    clipId = clip.id;
  });
  const prefix = createdTrack ? `Created ${createdTrack}. ` : "";
  return (
    `${prefix}Added adjustment layer ${clipId} @ ${startFrame} for ${durationFrames} frames — it affects every layer below it while active. ` +
    `Now grade it with apply_color / apply_effect (clipIds:["${clipId}"]).`
  );
}

function makeTextClip(content: string, startFrame: number, durationFrames: number): Clip {
  return {
    id: newId("clip"),
    mediaRef: "",
    mediaType: "text",
    sourceClipType: "text",
    startFrame,
    durationFrames,
    trimStartFrame: 0,
    trimEndFrame: 0,
    speed: 1,
    volume: 1,
    fadeInFrames: 0,
    fadeOutFrames: 0,
    fadeInInterpolation: "linear",
    fadeOutInterpolation: "linear",
    opacity: 1,
    transform: defaultTransform(),
    crop: { left: 0, top: 0, right: 0, bottom: 0 },
    textContent: content,
    textStyle: defaultTextStyle(),
  };
}

// ── undo ──────────────────────────────────────────────────────────────────────

export function undo(doc: EditorDocument): string {
  const last = doc.lastEdit;
  if (!last) throw new CommandError("No assistant edit to undo this session. The user's own edits are theirs to undo.");
  if (last.source !== "agent")
    throw new CommandError(`The most recent change ('${last.actionName}') wasn't made by the assistant — not undoing it.`);
  const done = doc.undo();
  return `Undid: ${done?.actionName}. Re-read with get_timeline before editing again.`;
}

export function redo(doc: EditorDocument): string {
  const next = doc.nextRedo;
  if (!next) throw new CommandError("Nothing to redo — no edit has been undone (or a newer edit discarded the redo chain).");
  const done = doc.redo();
  return `Redid: ${done?.actionName}. Re-read with get_timeline before editing again.`;
}

// ── media library (folders, rename, delete) ─────────────────────────────────────

export function createFolder(doc: EditorDocument, args: Args, source: EditSource = "agent"): string {
  const entries = Array.isArray(args.entries)
    ? (args.entries as Args[])
    : [{ name: reqStr(args, "name"), parentFolderId: str(args, "parentFolderId") }];
  const created: MediaFolder[] = [];
  doc.mutate("Create Folder", source, () => {
    for (const e of entries) {
      const name = reqStr(e, "name");
      const parentFolderId = str(e, "parentFolderId");
      if (parentFolderId && !doc.folder(parentFolderId)) throw new CommandError(`parentFolderId not found: ${parentFolderId}`);
      const folder: MediaFolder = { id: newId("folder"), name, parentFolderId };
      doc.project.folders.push(folder);
      created.push(folder);
    }
  });
  return JSON.stringify(created.length === 1 ? created[0] : { folders: created });
}

export function moveToFolder(doc: EditorDocument, args: Args, source: EditSource = "agent"): string {
  const entries = Array.isArray(args.entries)
    ? (args.entries as Args[])
    : [{ assetIds: args.assetIds, folderId: args.folderId }];
  let moved = 0;
  doc.mutate("Move to Folder", source, () => {
    for (const e of entries) {
      const folderId = str(e, "folderId");
      if (folderId && !doc.folder(folderId)) throw new CommandError(`folderId not found: ${folderId}`);
      for (const id of strArray(e, "assetIds")) {
        const a = doc.asset(id);
        if (a) {
          a.folderId = folderId;
          moved++;
        }
      }
    }
  });
  return `Moved ${moved} asset${plural(moved)}.`;
}

export function renameMedia(doc: EditorDocument, args: Args, source: EditSource = "agent"): string {
  const entries = Array.isArray(args.entries)
    ? (args.entries as Args[])
    : [{ mediaRef: reqStr(args, "mediaRef"), name: reqStr(args, "name") }];
  let renamed = 0;
  doc.mutate("Rename Media", source, () => {
    for (const e of entries) {
      const a = doc.asset(reqStr(e, "mediaRef"));
      if (!a) throw new CommandError(`Media asset not found: ${e.mediaRef}`);
      a.name = reqStr(e, "name");
      renamed++;
    }
  });
  return `Renamed ${renamed} asset${plural(renamed)}.`;
}

export function renameFolder(doc: EditorDocument, args: Args, source: EditSource = "agent"): string {
  const entries = Array.isArray(args.entries)
    ? (args.entries as Args[])
    : [{ folderId: reqStr(args, "folderId"), name: reqStr(args, "name") }];
  let renamed = 0;
  doc.mutate("Rename Folder", source, () => {
    for (const e of entries) {
      const f = doc.folder(reqStr(e, "folderId"));
      if (!f) throw new CommandError(`Folder not found: ${e.folderId}`);
      f.name = reqStr(e, "name");
      renamed++;
    }
  });
  return `Renamed ${renamed} folder${plural(renamed)}.`;
}

export function duplicateMedia(doc: EditorDocument, args: Args, source: EditSource = "agent"): string {
  const mediaRef = reqStr(args, "mediaRef");
  const asset = doc.asset(mediaRef);
  if (!asset) throw new CommandError(`Media not found: ${mediaRef}`);
  let name = "";
  doc.mutate("Duplicate Media", source, () => {
    const copy = { ...asset, id: newId("asset"), name: `${asset.name} copy` };
    doc.addAsset(copy);
    name = copy.name;
  });
  return `Duplicated media as "${name}".`;
}

export function deleteMedia(doc: EditorDocument, args: Args, source: EditSource = "agent"): string {
  const ids = strArray(args, "assetIds");
  if (ids.length === 0) throw new CommandError("Missing or empty 'assetIds' array");
  let removedClips = 0;
  doc.mutate("Delete Media", source, () => {
    removedClips = doc.removeAssets(new Set(ids)).removedClipIds.length;
  });
  return `Deleted ${ids.length} asset${plural(ids.length)}; removed ${removedClips} referencing clip${plural(removedClips)}.`;
}

export function deleteFolder(doc: EditorDocument, args: Args, source: EditSource = "agent"): string {
  const folderIds = strArray(args, "folderIds");
  if (folderIds.length === 0) throw new CommandError("Missing or empty 'folderIds' array");
  doc.mutate("Delete Folder", source, () => {
    const toDelete = new Set<string>(folderIds);
    // Cascade to descendant folders.
    let grew = true;
    while (grew) {
      grew = false;
      for (const f of doc.project.folders) {
        if (f.parentFolderId && toDelete.has(f.parentFolderId) && !toDelete.has(f.id)) {
          toDelete.add(f.id);
          grew = true;
        }
      }
    }
    const assetIds = new Set(doc.project.media.filter((a) => a.folderId && toDelete.has(a.folderId)).map((a) => a.id));
    doc.removeAssets(assetIds);
    doc.project.folders = doc.project.folders.filter((f) => !toDelete.has(f.id));
  });
  return `Deleted ${folderIds.length} folder${plural(folderIds.length)} and their contents.`;
}

// ── timeline markers (bookmarks with notes) ───────────────────────────────────

// Amber by default — readable on the dark ruler and distinct from the red playhead.
const DEFAULT_MARKER_COLOR = "#F59E0B";

function markerList(doc: EditorDocument): TimelineMarker[] {
  return doc.timeline.markers ?? [];
}

export function addMarker(doc: EditorDocument, args: Args, source: EditSource = "agent"): string {
  const frame = reqInt(args, "frame");
  if (frame < 0) throw new CommandError("frame must be >= 0.");
  const color = str(args, "color") ?? DEFAULT_MARKER_COLOR;
  if (!HEX.test(color)) throw new CommandError(`Invalid marker color '${color}' — use '#RRGGBB'.`);
  const marker: TimelineMarker = { id: newId("marker"), frame, color, note: str(args, "note") };
  doc.mutate("Add Marker", source, () => {
    const list = doc.timeline.markers ?? (doc.timeline.markers = []);
    list.push(marker);
    list.sort((a, b) => a.frame - b.frame);
  });
  return JSON.stringify(marker);
}

export function removeMarker(doc: EditorDocument, args: Args, source: EditSource = "agent"): string {
  const markerId = reqStr(args, "markerId");
  if (!markerList(doc).some((m) => m.id === markerId)) throw new CommandError(`Marker not found: ${markerId}`);
  doc.mutate("Remove Marker", source, () => {
    const left = markerList(doc).filter((m) => m.id !== markerId);
    // Drop the empty array entirely so default-omission (selectors, project.json) stays clean.
    doc.timeline.markers = left.length ? left : undefined;
  });
  return `Removed marker ${markerId}.`;
}

export function updateMarker(doc: EditorDocument, args: Args, source: EditSource = "agent"): string {
  const markerId = reqStr(args, "markerId");
  const marker = markerList(doc).find((m) => m.id === markerId);
  if (!marker) throw new CommandError(`Marker not found: ${markerId}`);
  const frame = int(args, "frame");
  const color = str(args, "color");
  // Distinguish "note omitted" (keep) from note:"" (clear) — str() collapses both to undefined.
  const hasNote = typeof args.note === "string";
  if (frame === undefined && color === undefined && !hasNote)
    throw new CommandError("Pass at least one of note, color, frame.");
  if (frame !== undefined && frame < 0) throw new CommandError("frame must be >= 0.");
  if (color !== undefined && !HEX.test(color)) throw new CommandError(`Invalid marker color '${color}' — use '#RRGGBB'.`);
  doc.mutate("Update Marker", source, () => {
    if (frame !== undefined) marker.frame = frame;
    if (color !== undefined) marker.color = color;
    if (hasNote) marker.note = (args.note as string).trim() || undefined;
    doc.timeline.markers?.sort((a, b) => a.frame - b.frame);
  });
  return JSON.stringify(marker);
}

// ── dispatch map for timeline-local tools (the bridge adds generation/IO tools) ──

// ── apply_color / apply_effect ─────────────────────────────────────────────────

const COLOR_KNOBS = [
  "exposure",
  "contrast",
  "saturation",
  "vibrance",
  "temperature",
  "tint",
  "highlights",
  "shadows",
  "blacks",
  "whites",
  "gamma",
] as const;

/** Merge a color grade onto one or more video/image clips. Only passed knobs change (unless reset). */
export function applyColor(doc: EditorDocument, args: Args, source: EditSource = "agent"): string {
  const clipIds = strArray(args, "clipIds");
  if (clipIds.length === 0) throw new CommandError("Missing or empty 'clipIds' array");
  const reset = args.reset === true;
  const lut = str(args, "lut");
  const lutStrength = num(args, "lutStrength");
  const provided: Record<string, number> = {};
  for (const k of COLOR_KNOBS) {
    const v = num(args, k);
    if (v !== undefined) provided[k] = v;
  }
  if (Object.keys(provided).length === 0 && lut === undefined && !reset)
    throw new CommandError("apply_color needs at least one grade parameter (or reset:true)");
  for (const id of clipIds) {
    const c = doc.getClip(id);
    if (!c) throw new CommandError(`Clip not found: ${id}`);
    // Adjustment layers are graded exactly like footage — the grade just lands on the composite.
    if (c.mediaType !== "video" && c.mediaType !== "image" && c.mediaType !== "adjustment")
      throw new CommandError(`Clip ${id} is a ${c.mediaType} clip; apply_color needs a video, image, or adjustment clip`);
  }
  doc.mutate(clipIds.length === 1 ? "Apply Color" : `Apply Color ×${clipIds.length}`, source, () => {
    for (const id of clipIds) {
      const c = doc.getClip(id)!;
      const base: ColorGrade = reset ? {} : { ...(c.color ?? {}) };
      Object.assign(base, provided);
      if (lut !== undefined) {
        base.lut = lut || undefined;
        if (lutStrength !== undefined) base.lutStrength = lutStrength;
      }
      c.color = isNeutralGrade(base) ? undefined : base;
    }
  });
  const desc =
    Object.keys(provided).concat(lut !== undefined ? ["lut"] : []).join(", ") || (reset ? "reset to neutral" : "no-op");
  return `Graded ${clipIds.length} clip${plural(clipIds.length)}: ${desc}`;
}

/** Effect registry: type → numeric param ranges [min,max,default] and optional string-param defaults. */
const EFFECT_REGISTRY: Record<string, { params: Record<string, [number, number, number]>; strParams?: Record<string, string> }> = {
  vignette: { params: { amount: [0, 1, 0.4] } },
  grain: { params: { amount: [0, 1, 0.25] } },
  blur: { params: { amount: [0, 50, 8] } },
  sharpen: { params: { amount: [0, 3, 1] } },
  glow: { params: { amount: [0, 1, 0.5], radius: [1, 60, 18], threshold: [0, 1, 0.6] } },
  chromakey: { params: { similarity: [0, 1, 0.3], blend: [0, 1, 0.1] }, strParams: { color: "0x00ff00" } },
  shake: { params: { amount: [0, 1, 0.5] } },
  look: { params: { amount: [0, 1, 1] }, strParams: { name: "cinematic" } },
};

/** Add/update/remove non-color effects on one or more video/image clips (merge semantics). */
export function applyEffect(doc: EditorDocument, args: Args, source: EditSource = "agent"): string {
  const clipIds = strArray(args, "clipIds");
  if (clipIds.length === 0) throw new CommandError("Missing or empty 'clipIds' array");
  const adds = Array.isArray(args.effects) ? (args.effects as Record<string, unknown>[]) : [];
  const removes = Array.isArray(args.remove) ? (args.remove as unknown[]).map(String) : [];
  if (adds.length === 0 && removes.length === 0)
    throw new CommandError("apply_effect needs effects to add/update or types to remove");
  for (const e of adds) {
    const t = String(e?.type ?? "");
    if (!EFFECT_REGISTRY[t]) throw new CommandError(`Unknown effect '${t}'. Available: ${Object.keys(EFFECT_REGISTRY).join(", ")}`);
  }
  for (const id of clipIds) {
    const c = doc.getClip(id);
    if (!c) throw new CommandError(`Clip not found: ${id}`);
    // Adjustment layers carry an effect stack too — it renders on everything below them.
    if (c.mediaType !== "video" && c.mediaType !== "image" && c.mediaType !== "adjustment")
      throw new CommandError(`Clip ${id} is a ${c.mediaType} clip; apply_effect needs a video, image, or adjustment clip`);
  }
  doc.mutate(clipIds.length === 1 ? "Apply Effect" : `Apply Effect ×${clipIds.length}`, source, () => {
    for (const id of clipIds) {
      const c = doc.getClip(id)!;
      let stack: Effect[] = c.effects ? c.effects.map((e) => ({ ...e, params: { ...e.params } })) : [];
      for (const t of removes) stack = stack.filter((e) => e.type !== t);
      for (const e of adds) {
        const t = String(e.type);
        const reg = EFFECT_REGISTRY[t]!;
        let eff = stack.find((x) => x.type === t);
        if (!eff) {
          eff = { type: t, params: {} };
          stack.push(eff);
        }
        if (typeof e.enabled === "boolean") eff.enabled = e.enabled;
        const inParams = e.params && typeof e.params === "object" ? (e.params as Record<string, unknown>) : {};
        eff.params = eff.params ?? {};
        for (const [pk, spec] of Object.entries(reg.params)) {
          if (inParams[pk] !== undefined) {
            const v = Number(inParams[pk]);
            if (Number.isFinite(v)) eff.params[pk] = Math.min(spec[1], Math.max(spec[0], v));
          } else if (eff.params[pk] === undefined) eff.params[pk] = spec[2];
        }
        for (const [pk, dflt] of Object.entries(reg.strParams ?? {})) {
          if (typeof inParams[pk] === "string") eff.params[pk] = inParams[pk] as string;
          else if (eff.params[pk] === undefined) eff.params[pk] = dflt;
        }
      }
      c.effects = stack.length ? stack : undefined;
    }
  });
  const note = `+[${adds.map((a) => a.type).join(", ") || "—"}] -[${removes.join(", ") || "—"}]`;
  return `Updated effects on ${clipIds.length} clip${plural(clipIds.length)}: ${note}`;
}

// ── set_track_properties ────────────────────────────────────────────────────────

export function setTrackProperties(doc: EditorDocument, args: Args, source: EditSource = "agent"): string {
  const ti = reqInt(args, "trackIndex");
  if (!doc.timeline.tracks[ti]) throw new CommandError(`track index ${ti} out of range`);
  const changed: string[] = [];
  doc.mutate("Set Track Properties", source, () => {
    const t = doc.timeline.tracks[ti]!;
    if (typeof args.muted === "boolean") {
      t.muted = args.muted;
      changed.push(`muted=${args.muted}`);
    }
    if (typeof args.hidden === "boolean") {
      t.hidden = args.hidden;
      changed.push(`hidden=${args.hidden}`);
    }
    if (typeof args.locked === "boolean") {
      t.locked = args.locked;
      changed.push(`locked=${args.locked}`);
    }
  });
  if (!changed.length) throw new CommandError("set_track_properties needs muted, hidden, and/or locked");
  return `Track ${ti}: ${changed.join(", ")}`;
}

// ── trim_clip (source-aware left/right edge trim) ─────────────────────────────────

export function trimClip(doc: EditorDocument, args: Args, source: EditSource = "agent"): string {
  const clipId = reqStr(args, "clipId");
  const edge = str(args, "edge");
  const delta = reqInt(args, "deltaFrames"); // +trim in, −extend out
  const ripple = args.ripple === true; // also shift downstream clips so no gap/overlap opens
  if (edge !== "left" && edge !== "right") throw new CommandError("edge must be 'left' or 'right'");
  if (!doc.findClip(clipId)) throw new CommandError(`Clip not found: ${clipId}`);
  doc.mutate("Trim Clip", source, () => {
    const loc = doc.findClip(clipId)!;
    const track = doc.timeline.tracks[loc.trackIndex]!;
    const c = track.clips[loc.clipIndex]!;
    const oldEnd = c.startFrame + c.durationFrames;
    const speed = c.speed > 0 ? c.speed : 1;
    // Media-less clips (text, adjustment) have no source to run out of — they extend freely.
    const bounded = c.mediaType !== "text" && c.mediaType !== "image" && c.mediaType !== "adjustment";
    const trims = c.mediaType !== "text" && c.mediaType !== "adjustment"; // trim offsets only mean something with real media
    let applied = 0;
    if (edge === "left") {
      const maxExtend = bounded ? Math.floor(c.trimStartFrame / speed) : c.startFrame; // limited by source head / timeline 0
      const d = Math.max(-Math.min(maxExtend, c.startFrame), Math.min(c.durationFrames - 1, delta));
      c.startFrame += d;
      c.durationFrames -= d;
      if (trims) c.trimStartFrame = Math.max(0, c.trimStartFrame + Math.round(d * speed));
      applied = d;
      // Ripple-left: keep this clip anchored at its old start (trim only the head content) and pull
      // every downstream clip in by d, so the head edit closes the gap instead of leaving one.
      if (ripple && d !== 0) {
        c.startFrame -= d;
        for (const o of track.clips) if (o.id !== c.id && o.startFrame >= oldEnd) o.startFrame = Math.max(0, o.startFrame - d);
      }
    } else {
      const d = Math.min(c.durationFrames - 1, delta);
      c.durationFrames -= d;
      if (trims) c.trimEndFrame = Math.max(0, c.trimEndFrame + Math.round(d * speed));
      applied = d;
      // Ripple-right: shift every clip after this one by the same amount its end moved (−d).
      if (ripple && d !== 0) {
        for (const o of track.clips) if (o.id !== c.id && o.startFrame >= oldEnd) o.startFrame = Math.max(0, o.startFrame - d);
      }
    }
    if (c.durationFrames < 1) c.durationFrames = 1;
    if (ripple && applied !== 0) track.clips.sort((a, b) => a.startFrame - b.startFrame);
  });
  return `Trimmed ${clipId} ${edge} edge by ${delta}f${ripple ? " (ripple)" : ""}`;
}


/**
 * SLIP: change WHICH part of the source a clip shows, without moving it on the timeline or changing
 * its length. Both trim offsets shift together — the classic NLE slip edit, used when the framing
 * is right but the action is a beat early or late.
 *
 * The move is clamped to the media that actually exists: you cannot slip past the head of the
 * source, and (when the asset's duration is known) not past its tail either. A partial slip is
 * applied rather than refused, because "slip as far as it goes" is what an editor dragging the clip
 * would get.
 */
export function slipClip(doc: EditorDocument, args: Args, source: EditSource = "agent"): string {
  const clipId = reqStr(args, "clipId");
  const delta = reqInt(args, "deltaFrames"); // + shows LATER source content, − shows earlier
  const loc0 = doc.findClip(clipId);
  if (!loc0) throw new CommandError(`Clip not found: ${clipId}`);
  const c0 = doc.timeline.tracks[loc0.trackIndex]!.clips[loc0.clipIndex]!;
  if (c0.mediaType === "text" || c0.mediaType === "adjustment") {
    throw new CommandError("Slip needs a clip with source media — text and adjustment layers have none.");
  }
  let applied = 0;
  doc.mutate("Slip Clip", source, () => {
    const loc = doc.findClip(clipId)!;
    const c = doc.timeline.tracks[loc.trackIndex]!.clips[loc.clipIndex]!;
    const speed = c.speed > 0 ? c.speed : 1;
    const want = Math.round(delta * speed); // timeline frames → source frames
    // Head limit: trimStartFrame can't go below zero.
    const minShift = -c.trimStartFrame;
    // Tail limit: trimEndFrame is measured from the END of the source, so it can't go below zero
    // either. Together these bound the slip without needing the asset's duration at all.
    const maxShift = c.trimEndFrame;
    const shift = Math.max(minShift, Math.min(maxShift, want));
    c.trimStartFrame += shift;
    c.trimEndFrame -= shift;
    applied = Math.round(shift / speed);
  });
  if (applied === 0) return `No slip applied to ${clipId} — already at the ${delta > 0 ? "end" : "start"} of the source.`;
  return `Slipped ${clipId} by ${applied}f (${applied > 0 ? "later" : "earlier"} source content); position and length unchanged`;
}

/**
 * CLOSE GAPS: pull clips left so the empty space between them disappears, keeping their order and
 * lengths. This is the "delete every gap" pass an editor does after ripple-deleting a few takes.
 *
 * Gaps shorter than `minFrames` are left alone — a one-frame sliver is usually deliberate spacing,
 * not a hole. Leading space before the first clip is only closed when asked, since a deliberate
 * offset at the head of a track (an intro pad) is common.
 */
export function closeGaps(doc: EditorDocument, args: Args, source: EditSource = "agent"): string {
  const trackIndex = int(args, "trackIndex");
  const minFrames = Math.max(1, int(args, "minFrames") ?? 2);
  const fromStart = args.fromStart === true;
  const tracks = doc.timeline.tracks;
  if (trackIndex !== undefined && !tracks[trackIndex]) throw new CommandError(`Track not found: ${trackIndex}`);
  const targets = trackIndex !== undefined ? [trackIndex] : tracks.map((_, i) => i);

  let closed = 0;
  let recovered = 0;
  // Clips already moved as somebody's linked partner: a video clip and its audio share a
  // linkGroupId, and closing a gap on the video track while leaving the audio behind would silently
  // knock the take out of sync. Whichever track is processed first carries its partners along, and
  // the partner is then skipped when its own track comes round.
  const movedAsPartner = new Set<string>();
  doc.mutate("Close Gaps", source, () => {
    for (const ti of targets) {
      const track = tracks[ti];
      if (!track) continue;
      const clips = [...track.clips].sort((a, b) => a.startFrame - b.startFrame);
      // Where the next clip should butt up against. Starting at the first clip's own start keeps a
      // deliberate head offset unless fromStart says otherwise.
      let cursor = fromStart ? 0 : (clips[0]?.startFrame ?? 0);
      for (const c of clips) {
        if (movedAsPartner.has(c.id)) {
          cursor = c.startFrame + c.durationFrames; // already positioned with its partner
          continue;
        }
        const gap = c.startFrame - cursor;
        if (gap >= minFrames) {
          for (const m of doc.partnerMoves(c.id, cursor)) {
            const p = doc.getClip(m.clipId);
            if (p) {
              p.startFrame = Math.max(0, m.toFrame);
              movedAsPartner.add(p.id);
            }
          }
          c.startFrame = cursor;
          closed++;
          recovered += gap;
        } else if (gap > 0) {
          cursor = c.startFrame; // sliver left as-is
        }
        cursor = c.startFrame + c.durationFrames;
      }
      track.clips.sort((a, b) => a.startFrame - b.startFrame);
    }
    for (const t of tracks) t.clips.sort((a, b) => a.startFrame - b.startFrame);
  });
  if (closed === 0) return "No gaps to close.";
  return `Closed ${closed} gap(s), recovering ${recovered} frames${trackIndex !== undefined ? ` on track ${trackIndex}` : " across all tracks"}.`;
}

// ── duplicate_clips / paste_clips (clipboard) ─────────────────────────────────────

function cloneClipData(src: Partial<Clip>, startFrame: number): Clip {
  return makeClip({ ...(src as Clip), id: undefined, startFrame: Math.max(0, startFrame), linkGroupId: undefined, captionGroupId: undefined });
}

export function duplicateClips(doc: EditorDocument, args: Args, source: EditSource = "agent"): string {
  const clipIds = strArray(args, "clipIds");
  if (clipIds.length === 0) throw new CommandError("Missing or empty 'clipIds' array");
  const created: string[] = [];
  doc.mutate(clipIds.length === 1 ? "Duplicate Clip" : "Duplicate Clips", source, () => {
    for (const id of clipIds) {
      const loc = doc.findClip(id);
      if (!loc) continue;
      const tr = doc.timeline.tracks[loc.trackIndex]!;
      const orig = tr.clips[loc.clipIndex]!;
      const clone = cloneClipData(orig, orig.startFrame + orig.durationFrames);
      doc.clearRegion(loc.trackIndex, clone.startFrame, clone.startFrame + clone.durationFrames);
      tr.clips.push(clone);
      tr.clips.sort((a, b) => a.startFrame - b.startFrame);
      created.push(clone.id);
    }
  });
  if (!created.length) throw new CommandError("No clips duplicated");
  return `Duplicated ${created.length} clip${plural(created.length)}: ${created.join(", ")}`;
}

/** Recreate clips from full property objects (the web clipboard) at a target frame. */
export function pasteClips(doc: EditorDocument, args: Args, source: EditSource = "agent"): string {
  const clips = Array.isArray(args.clips) ? (args.clips as Args[]) : [];
  if (clips.length === 0) throw new CommandError("paste_clips needs a non-empty 'clips' array");
  // Depth-1 invariant: a copied compound clip must not land inside another compound's timeline.
  if (doc.activeCompound && clips.some((c) => str(c, "compoundId")))
    throw new CommandError("Cannot paste a compound clip inside a compound (nesting is not supported) — close_compound first.");
  const atFrame = int(args, "atFrame");
  const minStart = Math.min(...clips.map((c) => (int(c, "startFrame") ?? 0)));
  const created: string[] = [];
  doc.mutate(clips.length === 1 ? "Paste Clip" : "Paste Clips", source, () => {
    for (const cd of clips) {
      const mediaType = (str(cd, "mediaType") ?? "video") as ClipType;
      const wantAudio = mediaType === "audio";
      let ti = doc.timeline.tracks.findIndex((t) => (wantAudio ? t.type === "audio" : t.type === "video"));
      if (ti < 0) ti = doc.insertTrack(doc.timeline.tracks.length, wantAudio ? "audio" : "video");
      const origStart = int(cd, "startFrame") ?? 0;
      const newStart = (atFrame ?? minStart) + (origStart - minStart);
      const clip = cloneClipData(cd as Partial<Clip>, newStart);
      doc.clearRegion(ti, clip.startFrame, clip.startFrame + clip.durationFrames);
      doc.timeline.tracks[ti]!.clips.push(clip);
      doc.timeline.tracks[ti]!.clips.sort((a, b) => a.startFrame - b.startFrame);
      created.push(clip.id);
    }
  });
  return `Pasted ${created.length} clip${plural(created.length)}: ${created.join(", ")}`;
}

// ── add_transition (fade-based) ───────────────────────────────────────────────────

export function addTransition(doc: EditorDocument, args: Args, source: EditSource = "agent"): string {
  const clipId = reqStr(args, "clipId");
  const type = str(args, "type") ?? "cross"; // fade_in|fade_out|cross|slide_in|slide_out|zoom_in|zoom_out
  const dur = reqInt(args, "durationFrames");
  const dir = str(args, "direction") ?? "left"; // slide direction: left|right|up|down
  if (!doc.getClip(clipId)) throw new CommandError(`Clip not found: ${clipId}`);
  doc.mutate("Add Transition", source, () => {
    const c = doc.getClip(clipId)!;
    const d = Math.max(1, Math.min(dur, Math.floor(c.durationFrames / 2)));
    const end = c.durationFrames;
    const pk = (frame: number, a: number, b: number) => ({ frame, value: { a, b }, interpolationOut: "smooth" as const });
    const off = dir === "right" ? { a: 1, b: 0 } : dir === "up" ? { a: 0, b: -1 } : dir === "down" ? { a: 0, b: 1 } : { a: -1, b: 0 };
    if (type === "fade_in" || type === "cross") c.fadeInFrames = d;
    if (type === "fade_out" || type === "cross") c.fadeOutFrames = d;
    if (type === "cross") {
      const loc = doc.findClip(clipId)!;
      const tr = doc.timeline.tracks[loc.trackIndex]!;
      const sorted = [...tr.clips].sort((a, b) => a.startFrame - b.startFrame);
      const idx = sorted.findIndex((x) => x.id === clipId);
      const prev = sorted[idx - 1];
      if (prev) prev.fadeOutFrames = Math.max(prev.fadeOutFrames, Math.min(d, Math.floor(prev.durationFrames / 2)));
    }
    // Motion transitions reuse the keyframe render (position/scale) already honored by preview + export.
    if (type === "slide_in") c.positionTrack = { keyframes: [pk(0, off.a, off.b), pk(d, 0, 0)] };
    if (type === "slide_out") c.positionTrack = { keyframes: [pk(Math.max(0, end - d), 0, 0), pk(end, off.a, off.b)] };
    if (type === "zoom_in") {
      c.scaleTrack = { keyframes: [pk(0, 1.3, 1.3), pk(d, 1, 1)] };
      c.positionTrack = { keyframes: [pk(0, -0.15, -0.15), pk(d, 0, 0)] };
    }
    if (type === "zoom_out") {
      c.scaleTrack = { keyframes: [pk(Math.max(0, end - d), 1, 1), pk(end, 1.3, 1.3)] };
      c.positionTrack = { keyframes: [pk(Math.max(0, end - d), 0, 0), pk(end, -0.15, -0.15)] };
    }
  });
  return `Transition '${type}'${type.startsWith("slide") ? ` (${dir})` : ""} (${dur}f) applied to ${clipId}`;
}

// ── set_project_format (canvas resolution / fps) ──────────────────────────────

/** Rescale every frame-denominated field of a clip by rn/rd = newFps/oldFps so its TIMES in
 * seconds stay identical when the project frame rate changes. The ratio is an exact integer
 * rational (never a float like 29.97/30, whose binary rounding can flip a Math.round at frame
 * boundaries) so NTSC round-trips like 30→29.97→30 restore every frame exactly. Boundaries
 * (not durations) are mapped so adjacent clips stay exactly adjacent at any ratio. */
function rescaleClipFps(c: Clip, rn: number, rd: number): void {
  const sc = (f: number) => Math.round((f * rn) / rd);
  const end = sc(c.startFrame + c.durationFrames);
  c.startFrame = sc(c.startFrame);
  c.durationFrames = Math.max(1, end - c.startFrame);
  c.trimStartFrame = sc(c.trimStartFrame);
  c.trimEndFrame = sc(c.trimEndFrame);
  c.fadeInFrames = sc(c.fadeInFrames);
  c.fadeOutFrames = sc(c.fadeOutFrames);
  if (c.karaokeWords) {
    for (const w of c.karaokeWords) {
      const e = sc(w.endFrame);
      w.startFrame = sc(w.startFrame);
      w.endFrame = Math.max(w.startFrame + 1, e);
    }
  }
  for (const tr of [c.opacityTrack, c.positionTrack, c.scaleTrack, c.rotationTrack, c.cropTrack, c.volumeTrack]) {
    if (tr) for (const k of tr.keyframes) k.frame = sc(k.frame);
  }
}

export function setProjectFormat(doc: EditorDocument, args: Args, source: EditSource = "agent"): string {
  const width = int(args, "width");
  const height = int(args, "height");
  // num, not int: int() truncates, silently turning the NTSC rates (29.97 → 29) into wrong fps.
  const fps = num(args, "fps");
  if (width === undefined && height === undefined && fps === undefined)
    throw new CommandError("Provide width and/or height (and optionally fps).");
  const W = width ?? doc.timeline.width;
  const H = height ?? doc.timeline.height;
  const F = fps ?? doc.timeline.fps;
  if (!(W >= 16 && W <= 7680 && H >= 16 && H <= 7680)) throw new CommandError("width/height must be 16–7680.");
  if (!NTSC_RATES.includes(F) && !(Number.isInteger(F) && F >= 1 && F <= 120))
    throw new CommandError("fps must be an integer 1–120, or an NTSC rate: 23.976, 29.97, 59.94.");
  const newFps = F;
  const oldFps = doc.timeline.fps;
  doc.mutate("Set Project Format", source, () => {
    doc.timeline.width = Math.round(W);
    doc.timeline.height = Math.round(H);
    doc.timeline.fps = newFps;
    doc.timeline.settingsConfigured = true;
    // Frame counts mean nothing without a rate: changing fps rescales every frame-denominated
    // field so clips keep their exact seconds. Without this, 30→60fps silently halves the
    // timeline's duration and exports cut the video short. The ratio goes through the exact
    // fps rationals (30000/1001 for 29.97 etc.), not the decimal fps values.
    if (newFps !== oldFps && oldFps > 0) {
      const nr = fpsRational(newFps);
      const or = fpsRational(oldFps);
      for (const t of doc.timeline.tracks) for (const c of t.clips) rescaleClipFps(c, nr.num * or.den, nr.den * or.num);
    }
  });
  const fpsNote = newFps !== oldFps ? ` Clips were rescaled from ${oldFps}fps so their timing in seconds is unchanged.` : "";
  return `Canvas set to ${Math.round(W)}×${Math.round(H)} @ ${newFps}fps. Clip transforms are normalized, so they reframe to the new aspect automatically.${fpsNote}`;
}

// ── clean_audio (denoise / normalize / highpass) ──────────────────────────────

export function cleanAudio(doc: EditorDocument, args: Args, source: EditSource = "agent"): string {
  const clipIds = strArray(args, "clipIds");
  if (clipIds.length === 0) throw new CommandError("Missing or empty 'clipIds' array");
  for (const id of clipIds) if (!doc.getClip(id)) throw new CommandError(`Clip not found: ${id}`);
  const denoise = num(args, "denoise");
  const normalize = typeof args.normalize === "boolean" ? args.normalize : undefined;
  const highpass = typeof args.highpass === "boolean" ? args.highpass : undefined;
  if (denoise === undefined && normalize === undefined && highpass === undefined)
    throw new CommandError("Pass at least one of denoise (0..1), normalize (bool), highpass (bool).");
  doc.mutate("Clean Audio", source, () => {
    for (const id of clipIds) {
      const c = doc.getClip(id)!;
      if (denoise !== undefined) c.audioDenoise = Math.max(0, Math.min(1, denoise));
      if (normalize !== undefined) c.audioNormalize = normalize;
      if (highpass !== undefined) c.audioHighpass = highpass;
    }
  });
  const on = [denoise ? "denoise" : "", normalize ? "normalize" : "", highpass ? "highpass" : ""].filter(Boolean).join(", ");
  return `Audio cleanup updated on ${clipIds.length} clip(s)${on ? `: ${on}` : ""}.`;
}

// ── speed_ramp (segmented variable speed) ─────────────────────────────────────

export function speedRamp(doc: EditorDocument, args: Args, source: EditSource = "agent"): string {
  const clipId = reqStr(args, "clipId");
  const from = num(args, "fromSpeed") ?? 1;
  const to = num(args, "toSpeed") ?? 2;
  if (!(from > 0) || !(to > 0)) throw new CommandError("fromSpeed and toSpeed must be greater than 0.");
  const N = Math.max(2, Math.min(24, int(args, "segments") ?? 10));
  const loc = doc.findClip(clipId);
  if (!loc) throw new CommandError(`Clip not found: ${clipId}`);
  let count = 0;
  doc.mutate("Speed Ramp", source, () => {
    const track = doc.timeline.tracks[loc.trackIndex]!;
    const clip = track.clips[loc.clipIndex]!;
    const D = clip.durationFrames;
    const baseStart = clip.startFrame;
    // Fixed timeline footprint: N equal-duration segments over [start, start+D], each a constant
    // speed (s0→s1). Each consumes speed×segDur source frames, so playback rate ramps with no ripple.
    let srcOff = clip.trimStartFrame;
    let tPos = baseStart;
    const segs: Clip[] = [];
    for (let i = 0; i < N; i++) {
      const sp = from + (to - from) * (i / (N - 1));
      const segDur = i === N - 1 ? baseStart + D - tPos : Math.max(1, Math.round(D / N));
      if (segDur <= 0) break;
      segs.push(
        makeClip({
          ...(clip as Clip),
          id: undefined,
          startFrame: tPos,
          durationFrames: segDur,
          trimStartFrame: Math.round(srcOff),
          speed: sp,
          linkGroupId: undefined,
          captionGroupId: undefined,
        }),
      );
      srcOff += sp * segDur;
      tPos += segDur;
    }
    track.clips.splice(loc.clipIndex, 1, ...segs);
    track.clips.sort((a, b) => a.startFrame - b.startFrame);
    count = segs.length;
  });
  return `Speed ramp ${from}×→${to}× applied as ${count} segments (timeline length unchanged).`;
}

// ── set_mask (shape mask) ─────────────────────────────────────────────────────

export function setMask(doc: EditorDocument, args: Args, source: EditSource = "agent"): string {
  const clipIds = strArray(args, "clipIds");
  if (clipIds.length === 0) throw new CommandError("Missing or empty 'clipIds' array");
  for (const id of clipIds) if (!doc.getClip(id)) throw new CommandError(`Clip not found: ${id}`);
  const clear = args.clear === true;
  const shape = str(args, "shape");
  if (!clear && shape !== "rect" && shape !== "ellipse" && shape !== "path")
    throw new CommandError("shape must be 'rect', 'ellipse' or 'path' (or pass clear:true to remove the mask).");
  const cl = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
  let m: MaskSpec | undefined;
  if (!clear && shape === "path") {
    // Freeform pen mask: normalized clip-space vertices, closed implicitly. Clamp each coordinate
    // to 0..1 rather than rejecting near-edge clicks — the pen UI sends raw pointer math.
    const raw = args.points;
    if (!Array.isArray(raw) || raw.length < 3)
      throw new CommandError("shape 'path' needs 'points': an array of at least 3 [x, y] pairs in 0..1 clip space.");
    const points: [number, number][] = raw.map((p, i) => {
      if (!Array.isArray(p) || typeof p[0] !== "number" || typeof p[1] !== "number" || !Number.isFinite(p[0]) || !Number.isFinite(p[1]))
        throw new CommandError(`points[${i}] must be a [x, y] pair of finite numbers.`);
      return [cl(p[0], 0, 1), cl(p[1], 0, 1)];
    });
    // cx/cy/rw/rh mirror the path's bounding box so shape-agnostic consumers (inspector readouts,
    // future snapping) get sane geometry without special-casing "path".
    const xs = points.map((p) => p[0]);
    const ys = points.map((p) => p[1]);
    const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
    m = {
      shape: "path",
      cx: (x0 + x1) / 2,
      cy: (y0 + y1) / 2,
      rw: Math.max(0.01, (x1 - x0) / 2),
      rh: Math.max(0.01, (y1 - y0) / 2),
      feather: cl(num(args, "feather") ?? 0.05, 0, 1),
      invert: args.invert === true,
      points,
      smooth: args.smooth === true,
    };
  } else if (!clear) {
    m = {
      shape: shape as "rect" | "ellipse",
      cx: cl(num(args, "cx") ?? 0.5, 0, 1),
      cy: cl(num(args, "cy") ?? 0.5, 0, 1),
      rw: cl(num(args, "rw") ?? 0.4, 0.01, 1),
      rh: cl(num(args, "rh") ?? 0.4, 0.01, 1),
      feather: cl(num(args, "feather") ?? 0.05, 0, 1),
      invert: args.invert === true,
    };
  }
  doc.mutate("Set Mask", source, () => {
    for (const id of clipIds) doc.getClip(id)!.mask = m;
  });
  return clear
    ? `Mask cleared on ${clipIds.length} clip(s).`
    : `${m!.shape} mask${m!.shape === "path" ? ` (${m!.points!.length} points${m!.smooth ? ", smoothed" : ""})` : ""} applied to ${clipIds.length} clip(s).`;
}

// ── apply_layout (predefined multi-clip arrangements) ─────────────────────────

interface LayoutSlot {
  centerX: number;
  centerY: number;
  width: number;
  height: number;
}
const grid = (cols: number, rows: number): LayoutSlot[] =>
  Array.from({ length: cols * rows }, (_, i) => {
    const col = i % cols;
    const row = Math.floor(i / cols);
    return { centerX: (col + 0.5) / cols, centerY: (row + 0.5) / rows, width: 1 / cols, height: 1 / rows };
  });
const LAYOUT_SLOTS: Record<string, LayoutSlot[]> = {
  "side-by-side": [
    { centerX: 0.25, centerY: 0.5, width: 0.5, height: 1 },
    { centerX: 0.75, centerY: 0.5, width: 0.5, height: 1 },
  ],
  "top-bottom": [
    { centerX: 0.5, centerY: 0.25, width: 1, height: 0.5 },
    { centerX: 0.5, centerY: 0.75, width: 1, height: 0.5 },
  ],
  "pip-top-left": [
    { centerX: 0.5, centerY: 0.5, width: 1, height: 1 },
    { centerX: 0.18, centerY: 0.18, width: 0.3, height: 0.3 },
  ],
  "pip-top-right": [
    { centerX: 0.5, centerY: 0.5, width: 1, height: 1 },
    { centerX: 0.82, centerY: 0.18, width: 0.3, height: 0.3 },
  ],
  "pip-bottom-left": [
    { centerX: 0.5, centerY: 0.5, width: 1, height: 1 },
    { centerX: 0.18, centerY: 0.82, width: 0.3, height: 0.3 },
  ],
  "pip-bottom-right": [
    { centerX: 0.5, centerY: 0.5, width: 1, height: 1 },
    { centerX: 0.82, centerY: 0.82, width: 0.3, height: 0.3 },
  ],
  "grid-2x2": grid(2, 2),
  "grid-3x3": grid(3, 3),
};
export const LAYOUT_NAMES = Object.keys(LAYOUT_SLOTS);

export function applyLayout(doc: EditorDocument, args: Args, source: EditSource = "agent"): string {
  const layout = reqStr(args, "layout");
  const slots = LAYOUT_SLOTS[layout];
  if (!slots) throw new CommandError(`Unknown layout '${layout}'. Available: ${LAYOUT_NAMES.join(", ")}`);

  // Accept either a flat 'clipIds' (one clip per slot, in order) or 'slots' (an array of
  // {clipIds:[...]}) when a slot should hold several clips over time (e.g. a sequence of guests
  // sharing the same PiP corner).
  let slotClipIds: string[][];
  if (Array.isArray(args.slots)) {
    slotClipIds = (args.slots as Args[]).map((s) => strArray(s, "clipIds"));
  } else {
    slotClipIds = strArray(args, "clipIds").map((id) => [id]);
  }
  if (slotClipIds.length === 0) throw new CommandError("Provide 'clipIds' (one per slot) or 'slots' ([{clipIds:[...]}, ...]).");
  if (slotClipIds.length > slots.length) throw new CommandError(`Layout '${layout}' has ${slots.length} slot(s); got ${slotClipIds.length} group(s).`);

  const summaries: string[] = [];
  doc.mutate("Apply Layout", source, () => {
    slotClipIds.forEach((ids, slotIndex) => {
      const box = slots[slotIndex]!;
      for (const id of ids) {
        const clip = doc.getClip(id);
        if (!clip) throw new CommandError(`Clip not found: ${id}`);
        clip.transform = { ...clip.transform, centerX: box.centerX, centerY: box.centerY, width: box.width, height: box.height };
        summaries.push(`${id}→slot${slotIndex}`);
      }
    });
  });
  return `Applied '${layout}' layout: ${summaries.join(", ")}.`;
}

// ── make_compound / uncompound (nested timelines) ─────────────────────────────

/** Group clips into a nested (compound) timeline: the selection moves — with its relative layout
 * across all involved tracks — into a fresh sub-timeline, and ONE compound clip spanning the
 * selection replaces it on the topmost involved visual track. Depth is 1: a selection containing a
 * compound clip is refused, so a compound's own timeline can never hold another compound. */
export function makeCompound(doc: EditorDocument, args: Args, source: EditSource = "agent"): string {
  if (doc.activeCompound)
    throw new CommandError("Already inside a compound — call close_compound first (compounds cannot be nested).");
  const clipIds = strArray(args, "clipIds");
  if (clipIds.length === 0) throw new CommandError("Missing or empty 'clipIds' array");
  for (const id of clipIds) if (!doc.getClip(id)) throw new CommandError(`Clip not found: ${id}`);
  // Pull in time-overlapping linked partners (a video's detached audio) — compounding only the
  // picture would silently desync it from its own sound, the classic linked-clip failure.
  const ids = doc.expandToLinkGroupOverlapping(new Set(clipIds));
  for (const id of ids) {
    if (doc.getClip(id)!.compoundId)
      throw new CommandError(`Clip ${id} is already a compound clip — compounds cannot be nested (depth 1).`);
  }

  const tl = doc.timeline;
  // Involved tracks in stacking order; selection span across all of them.
  const involved: { track: Track; index: number; clips: Clip[] }[] = [];
  let minStart = Number.MAX_SAFE_INTEGER;
  let maxEnd = 0;
  tl.tracks.forEach((track, index) => {
    const picked = track.clips.filter((c) => ids.has(c.id));
    if (!picked.length) return;
    involved.push({ track, index, clips: picked });
    for (const c of picked) {
      minStart = Math.min(minStart, c.startFrame);
      maxEnd = Math.max(maxEnd, clipEndFrame(c));
    }
  });
  const target = involved.find((e) => e.track.type !== "audio");
  if (!target) throw new CommandError("make_compound needs at least one visual (video/image/text) clip in the selection.");
  // All-or-nothing: the compound clip will span [minStart, maxEnd) on the target track — an
  // unselected clip inside that span would be silently destroyed by the placement.
  const blocker = target.track.clips.find((c) => !ids.has(c.id) && c.startFrame < maxEnd && clipEndFrame(c) > minStart);
  if (blocker)
    throw new CommandError(
      `Track ${target.index} has unselected clip ${blocker.id} inside the selection span ${minStart}–${maxEnd} — include it in the compound or move it first.`,
    );

  const name = str(args, "name") ?? "Compound";
  const compId = newId("comp");
  let clipId = "";
  doc.mutate("Make Compound", source, () => {
    const nonEmptyBefore = new Set(tl.tracks.filter((t) => t.clips.length > 0).map((t) => t.id));
    // Sub-timeline: same canvas/fps as the project; involved tracks keep their relative order and
    // render flags, clips are MOVED (same objects — keyframes/effects/links ride along) and
    // normalized so the earliest selected frame becomes 0.
    const sub = makeTimeline({ fps: tl.fps, width: tl.width, height: tl.height, settingsConfigured: true });
    for (const e of involved) {
      const t = makeTrack(e.track.type, { name: e.track.name, muted: e.track.muted, hidden: e.track.hidden });
      t.clips = e.clips.map((c) => {
        c.startFrame -= minStart;
        return c;
      });
      t.clips.sort((a, b) => a.startFrame - b.startFrame);
      sub.tracks.push(t);
    }
    doc.removeClipsByIds(ids);
    (doc.project.compounds ??= []).push({ id: compId, name, timeline: sub });
    const clip = makeClip({
      mediaRef: "",
      mediaType: "video",
      sourceClipType: "video",
      startFrame: minStart,
      durationFrames: maxEnd - minStart,
      name,
      compoundId: compId,
    });
    const host = tl.tracks.find((t) => t.id === target.track.id)!;
    host.clips.push(clip);
    host.clips.sort((a, b) => a.startFrame - b.startFrame);
    clipId = clip.id;
    doc.removeEmptyTracks(nonEmptyBefore);
  });
  const linked = ids.size - clipIds.length;
  const linkNote = linked > 0 ? ` (+${linked} linked)` : "";
  return (
    `Created compound '${name}' (${compId}) from ${ids.size} clip${plural(ids.size)}${linkNote} → compound clip ${clipId} @ ${minStart} for ${maxEnd - minStart} frames. ` +
    `Track indices may have shifted — re-read get_timeline. Edit inside with open_compound {clipId:"${clipId}"}.`
  );
}

/** Inverse of make_compound: expand a compound clip back into its clips at the clip's position
 * (the stored relative layout re-offset by the clip's startFrame), on fresh tracks spliced in at
 * the compound clip's stacking position. The compounds[] entry is deleted only when this was the
 * last clip referencing it (duplicates of a compound clip are independent instances). */
export function uncompound(doc: EditorDocument, args: Args, source: EditSource = "agent"): string {
  if (doc.activeCompound)
    throw new CommandError("Close the compound first (close_compound) — uncompound works from the main timeline.");
  const clipId = reqStr(args, "clipId");
  const loc = doc.findClip(clipId);
  if (!loc) throw new CommandError(`Clip not found: ${clipId}`);
  const tl = doc.timeline;
  const clip = tl.tracks[loc.trackIndex]!.clips[loc.clipIndex]!;
  if (!clip.compoundId) throw new CommandError(`Clip ${clipId} is not a compound clip.`);
  const comp = doc.project.compounds?.find((c) => c.id === clip.compoundId);
  if (!comp) throw new CommandError(`Compound sequence ${clip.compoundId} no longer exists.`);
  const refs = tl.tracks.reduce((n, t) => n + t.clips.filter((c) => c.compoundId === clip.compoundId).length, 0);
  const lastRef = refs <= 1;

  let expanded = 0;
  doc.mutate("Uncompound", source, () => {
    const nonEmptyBefore = new Set(tl.tracks.filter((t) => t.clips.length > 0).map((t) => t.id));
    const base = clip.startFrame;
    // Remove the compound clip first, then splice the expanded tracks in at its stacking position.
    tl.tracks[loc.trackIndex]!.clips.splice(loc.clipIndex, 1);
    const newTracks = comp.timeline.tracks.map((t) => {
      const nt = makeTrack(t.type, { name: t.name, muted: t.muted, hidden: t.hidden });
      // Last reference: move the original clip objects back (ids survive — nice for the caller's
      // diff). Other instances remain: expand COPIES with fresh ids so ids stay unique.
      nt.clips = t.clips.map((c) => {
        const out = lastRef ? c : { ...structuredClone(c), id: newId("clip") };
        out.startFrame = c.startFrame + base;
        expanded++;
        return out;
      });
      nt.clips.sort((a, b) => a.startFrame - b.startFrame);
      return nt;
    });
    tl.tracks.splice(loc.trackIndex, 0, ...newTracks);
    if (lastRef) doc.project.compounds = doc.project.compounds!.filter((c) => c.id !== comp.id);
    doc.removeEmptyTracks(nonEmptyBefore);
  });
  const keepNote = lastRef ? "" : ` The '${comp.name}' sequence still exists (other clips reference it).`;
  return `Expanded compound '${comp.name}' into ${expanded} clip${plural(expanded)} at frame ${clip.startFrame}.${keepNote} Track indices shifted — re-read get_timeline.`;
}

export type TimelineCommand = (doc: EditorDocument, args: Args, source?: EditSource) => string;

export const TIMELINE_COMMANDS: Record<string, TimelineCommand> = {
  apply_color: applyColor,
  apply_effect: applyEffect,
  set_track_properties: setTrackProperties,
  trim_clip: trimClip,
  slip_clip: slipClip,
  close_gaps: closeGaps,
  duplicate_clips: duplicateClips,
  paste_clips: pasteClips,
  add_transition: addTransition,
  add_clips: addClips,
  insert_clips: insertClips,
  remove_clips: removeClips,
  remove_tracks: removeTracks,
  reorder_tracks: reorderTracks,
  apply_layout: applyLayout,
  move_clips: moveClips,
  set_clip_properties: setClipProperties,
  set_keyframes: setKeyframes,
  split_clip: splitClip,
  ripple_delete_ranges: rippleDeleteRanges,
  add_texts: addTexts,
  add_adjustment_layer: addAdjustmentLayer,
  set_project_format: setProjectFormat,
  clean_audio: cleanAudio,
  set_mask: setMask,
  speed_ramp: speedRamp,
  make_compound: makeCompound,
  uncompound,
  create_folder: createFolder,
  move_to_folder: moveToFolder,
  rename_media: renameMedia,
  rename_folder: renameFolder,
  duplicate_media: duplicateMedia,
  delete_media: deleteMedia,
  delete_folder: deleteFolder,
  add_marker: addMarker,
  remove_marker: removeMarker,
  update_marker: updateMarker,
};
