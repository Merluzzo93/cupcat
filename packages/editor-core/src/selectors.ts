// Read selectors — serialize the document for the read tools (get_timeline, get_media,
// list_folders). Mirrors Palmier's contract: fields equal to their defaults are omitted to
// keep payloads small, and caption clips collapse into per-track captionGroups.

import { EditorDocument } from "./document";
import { BEZIER_DEFAULT_IN, BEZIER_DEFAULT_OUT } from "./keyframes";
import {
  type Clip,
  type Keyframe,
  type Track,
  clipEndFrame,
  isDefaultTransform,
  isIdentityCrop,
  timelineTotalFrames,
} from "./types";

const CAPTION_ROW_CAP = 200;

export interface GetTimelineOptions {
  startFrame?: number;
  endFrame?: number;
  canGenerate?: boolean;
}

function serializeKeyframes(c: Clip): Record<string, unknown> | undefined {
  const out: Record<string, unknown> = {};
  // Bezier rows echo the same shape set_keyframes accepts ([..., "bezier", outX, outY, inX, inY])
  // so the agent can read a track back and resubmit it unchanged.
  const tail = (k: Keyframe<unknown>): (string | number)[] =>
    k.interpolationOut === "bezier"
      ? [k.interpolationOut, ...(k.bezierOut ?? BEZIER_DEFAULT_OUT), ...(k.bezierIn ?? BEZIER_DEFAULT_IN)]
      : [k.interpolationOut];
  const scalar = (rows: Keyframe<number>[] | undefined) => rows?.map((k) => [k.frame, k.value, ...tail(k)]);
  const pair = (rows: Keyframe<{ a: number; b: number }>[] | undefined) => rows?.map((k) => [k.frame, k.value.a, k.value.b, ...tail(k)]);
  if (c.opacityTrack) out.opacity = scalar(c.opacityTrack.keyframes);
  if (c.volumeTrack) out.volume = scalar(c.volumeTrack.keyframes);
  if (c.rotationTrack) out.rotation = scalar(c.rotationTrack.keyframes);
  if (c.positionTrack) out.position = pair(c.positionTrack.keyframes);
  if (c.scaleTrack) out.scale = pair(c.scaleTrack.keyframes);
  if (c.cropTrack)
    out.crop = c.cropTrack.keyframes.map((k) => [k.frame, k.value.top, k.value.right, k.value.bottom, k.value.left, ...tail(k)]);
  return Object.keys(out).length ? out : undefined;
}

function serializeClip(c: Clip): Record<string, unknown> {
  const o: Record<string, unknown> = { clipId: c.id, startFrame: c.startFrame, durationFrames: c.durationFrames };
  if (c.mediaRef) o.mediaRef = c.mediaRef;
  if (c.mediaType !== "video") o.mediaType = c.mediaType;
  if (c.sourceClipType !== c.mediaType) o.sourceClipType = c.sourceClipType;
  if (c.name) o.name = c.name;
  // Trim offsets are meaningless without real media (text/adjustment) — hide the noise a split can
  // leave on them (splitOneClip bumps trims on every non-text clip).
  if (c.mediaType !== "text" && c.mediaType !== "adjustment") {
    if (c.trimStartFrame !== 0) o.trimStartFrame = c.trimStartFrame;
    if (c.trimEndFrame !== 0) o.trimEndFrame = c.trimEndFrame;
  }
  if (c.speed !== 1) o.speed = c.speed;
  if (c.volume !== 1) o.volume = c.volume;
  if (c.opacity !== 1) o.opacity = c.opacity;
  if (c.fadeInFrames !== 0) o.fadeInFrames = c.fadeInFrames;
  if (c.fadeOutFrames !== 0) o.fadeOutFrames = c.fadeOutFrames;
  if (!isDefaultTransform(c.transform)) o.transform = c.transform;
  if (!isIdentityCrop(c.crop)) o.crop = c.crop;
  if (c.linkGroupId) o.linkGroupId = c.linkGroupId;
  if (c.compoundId) o.compoundId = c.compoundId; // a nested-timeline clip — open_compound to edit inside
  if (c.mediaType === "text") {
    if (c.textContent) o.textContent = c.textContent;
    if (c.textStyle) o.textStyle = c.textStyle;
  }
  const kf = serializeKeyframes(c);
  if (kf) o.keyframes = kf;
  return o;
}

function serializeTrack(track: Track, index: number, win: { start: number; end: number } | null): Record<string, unknown> {
  const inWindow = (c: Clip) => !win || (c.startFrame < win.end && clipEndFrame(c) > win.start);
  const visible = track.clips.filter(inWindow);

  const o: Record<string, unknown> = { index, type: track.type };
  if (track.muted) o.muted = true;
  if (track.hidden) o.hidden = true;
  if (!track.syncLocked) o.syncLocked = false;

  const captionClips = visible.filter((c) => c.captionGroupId);
  const plainClips = visible.filter((c) => !c.captionGroupId);
  if (plainClips.length) o.clips = plainClips.map(serializeClip);

  if (captionClips.length) {
    const groups = new Map<string, Clip[]>();
    for (const c of captionClips) {
      const g = groups.get(c.captionGroupId!) ?? [];
      g.push(c);
      groups.set(c.captionGroupId!, g);
    }
    o.captionGroups = [...groups.entries()].map(([groupId, clips]) => {
      const first = clips[0]!;
      return {
        captionGroupId: groupId,
        shared: first.textStyle ? { ...first.textStyle, centerX: first.transform.centerX, centerY: first.transform.centerY } : undefined,
        clipCount: clips.length,
        rows: clips.slice(0, CAPTION_ROW_CAP).map((c) => [c.id, c.startFrame, c.durationFrames, c.textContent ?? ""]),
      };
    });
  }

  if (win && track.clips.length !== visible.length) o.totalClips = track.clips.length;
  return o;
}

export function getTimeline(doc: EditorDocument, opts: GetTimelineOptions = {}): Record<string, unknown> {
  const tl = doc.timeline;
  const win =
    opts.startFrame !== undefined || opts.endFrame !== undefined
      ? { start: opts.startFrame ?? 0, end: opts.endFrame ?? Number.MAX_SAFE_INTEGER }
      : null;
  const out: Record<string, unknown> = {
    fps: tl.fps,
    resolution: { width: tl.width, height: tl.height },
    totalFrames: timelineTotalFrames(tl),
    canGenerate: opts.canGenerate ?? true,
    // Where the editing context points: null = the main timeline; {id, name} = every tool in this
    // session currently reads/writes THAT compound's sub-timeline (close_compound to return).
    activeCompound: doc.activeCompound,
    tracks: tl.tracks.map((t, i) => serializeTrack(t, i, win)),
  };
  // Bookmarks ride along so the agent can list/reference them without a dedicated read tool.
  if (tl.markers?.length) out.markers = tl.markers;
  return out;
}

export function getMedia(doc: EditorDocument): Record<string, unknown> {
  return {
    media: doc.project.media.map((a) => {
      const o: Record<string, unknown> = { id: a.id, name: a.name, type: a.type };
      if (a.durationSeconds) o.durationSeconds = Math.round(a.durationSeconds * 1000) / 1000;
      if (a.sourceWidth && a.sourceHeight) o.resolution = { width: a.sourceWidth, height: a.sourceHeight };
      if (a.type === "video") o.hasAudio = a.hasAudio;
      if (a.folderId) o.folderId = a.folderId;
      o.generationStatus = a.generationStatus.kind;
      if (a.generationStatus.kind === "failed" && a.generationStatus.error) o.error = a.generationStatus.error;
      return o;
    }),
  };
}

export function listFolders(doc: EditorDocument): Record<string, unknown> {
  return {
    folders: doc.project.folders.map((f) => ({ id: f.id, name: f.name, parentFolderId: f.parentFolderId ?? null })),
  };
}
