// Timeline data model — a faithful TypeScript port of Palmier Pro's model.
//
// All timing is in integer FRAMES at the timeline fps (frame = seconds * fps).
// Spatial values (transform, crop) are NORMALIZED to the canvas in 0..1.

import { newId } from "./ids";

// ─────────────────────────────────────────────────────────────────────────────
// Clip type
// ─────────────────────────────────────────────────────────────────────────────

export type ClipType = "video" | "audio" | "image" | "text" | "lottie" | "adjustment";
/** "bezier" is only meaningful on keyframes (it reads the keyframe's handle fields);
 * fades keep using the classic three. */
export type Interpolation = "linear" | "hold" | "smooth" | "bezier";

export function isVisual(t: ClipType): boolean {
  // "adjustment" is visual so adjustment layers can live on (and move between) video tracks.
  return t === "video" || t === "image" || t === "text" || t === "lottie" || t === "adjustment";
}

/** Track placement compatibility: same type, or any two visual types interchangeably. Audio is isolated. */
export function isCompatible(a: ClipType, b: ClipType): boolean {
  return a === b || (isVisual(a) && isVisual(b));
}

export function clipTypeFromExtension(ext: string): ClipType | null {
  switch (ext.toLowerCase().replace(/^\./, "")) {
    case "mov":
    case "mp4":
    case "m4v":
    case "webm": // incl. VP9-alpha motion graphics
    case "mkv":
      return "video";
    case "mp3":
    case "wav":
    case "aac":
    case "m4a":
    case "aiff":
    case "aif":
    case "aifc":
    case "flac":
      return "audio";
    case "png":
    case "jpg":
    case "jpeg":
    case "tiff":
    case "heic":
    case "webp":
      return "image";
    case "json":
    case "lottie":
      return "lottie";
    default:
      return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Transform / Crop
// ─────────────────────────────────────────────────────────────────────────────

/** Position/size in normalized canvas coords (0..1), center-based. */
export interface Transform {
  centerX: number; // 0.5 = horizontal center
  centerY: number; // 0.5 = vertical center
  width: number; // 1 = fills the canvas width
  height: number; // 1 = fills the canvas height
  rotation: number; // degrees, clockwise positive
  flipHorizontal: boolean;
  flipVertical: boolean;
}

export function defaultTransform(): Transform {
  return { centerX: 0.5, centerY: 0.5, width: 1, height: 1, rotation: 0, flipHorizontal: false, flipVertical: false };
}

export function transformTopLeft(t: Transform): { x: number; y: number } {
  return { x: t.centerX - t.width / 2, y: t.centerY - t.height / 2 };
}

export function isDefaultTransform(t: Transform): boolean {
  return (
    t.centerX === 0.5 &&
    t.centerY === 0.5 &&
    t.width === 1 &&
    t.height === 1 &&
    t.rotation === 0 &&
    !t.flipHorizontal &&
    !t.flipVertical
  );
}

/** Per-clip shape mask: keeps the inside (or outside, if inverted) visible, with a soft edge. */
export interface MaskSpec {
  shape: "rect" | "ellipse" | "path";
  cx: number; // center X, normalized 0..1 (for "path": bounding-box center, kept for UI/inspection)
  cy: number; // center Y, normalized 0..1
  rw: number; // half-width, normalized 0..1 (for "path": bounding-box half-size)
  rh: number; // half-height, normalized 0..1
  feather: number; // edge softness as a fraction (0 = hard)
  invert: boolean; // hide the inside, keep the outside
  /** Freeform pen vertices in CLIP space (0..1), ≥3, closed implicitly — only for shape "path". */
  points?: [number, number][];
  /** Catmull-Rom smoothing through the points instead of straight polygon edges (shape "path"). */
  smooth?: boolean;
}

/** Per-clip crop as edge insets in normalized (0..1) source coords. */
export interface Crop {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export function defaultCrop(): Crop {
  return { left: 0, top: 0, right: 0, bottom: 0 };
}

export function isIdentityCrop(c: Crop): boolean {
  return c.left === 0 && c.top === 0 && c.right === 0 && c.bottom === 0;
}

// ─────────────────────────────────────────────────────────────────────────────
// Color grade + effects (per-clip) — ported from Palmier Pro's grading / FX stack.
// ─────────────────────────────────────────────────────────────────────────────

/** Per-clip primary color grade. All knobs optional; omitted = neutral. Rendered via ffmpeg
 * eq / curves / colortemperature / colorbalance / lut3d. */
export interface ColorGrade {
  exposure?: number; // -3..3 EV (overall brightness)
  contrast?: number; // 0.5..1.5 (1 = neutral)
  saturation?: number; // 0..2 (1 = neutral; <1 mutes)
  vibrance?: number; // -1..1 (skin-protected saturation)
  temperature?: number; // 2000..11000 K (6500 = neutral; HIGHER = warmer)
  tint?: number; // -100..100 (+ green / − magenta)
  highlights?: number; // -1..1 (recover <0 / lift >0)
  shadows?: number; // -1..1 (lift >0 / deepen <0)
  blacks?: number; // -1..1 (black point)
  whites?: number; // -1..1 (white point)
  gamma?: number; // 0.5..2 midtone gamma (1 = neutral)
  lut?: string; // absolute path to a .cube LUT
  lutStrength?: number; // 0..1
}

export function isNeutralGrade(g?: ColorGrade): boolean {
  if (!g) return true;
  return (
    (g.exposure ?? 0) === 0 &&
    (g.contrast ?? 1) === 1 &&
    (g.saturation ?? 1) === 1 &&
    (g.vibrance ?? 0) === 0 &&
    (g.temperature ?? 6500) === 6500 &&
    (g.tint ?? 0) === 0 &&
    (g.highlights ?? 0) === 0 &&
    (g.shadows ?? 0) === 0 &&
    (g.blacks ?? 0) === 0 &&
    (g.whites ?? 0) === 0 &&
    (g.gamma ?? 1) === 1 &&
    !g.lut
  );
}

/** One entry in a clip's ordered effect stack (non-color FX). type is a registry id such as
 * "vignette", "grain", "blur", "sharpen", "glow", "chromakey". */
export interface Effect {
  type: string;
  enabled?: boolean; // default true
  params?: Record<string, number | string>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Keyframes
// ─────────────────────────────────────────────────────────────────────────────

/** Two-component keyframe value: position (top-left x, y) or scale (width, height). */
export interface AnimPair {
  a: number;
  b: number;
}

export interface Keyframe<V> {
  frame: number; // CLIP-RELATIVE (0 = first frame of the clip)
  value: V;
  interpolationOut: Interpolation; // default "smooth"
  /** Cubic-bezier control handles for "bezier" segments, CSS-timing-function style, in the
   * NORMALIZED (t, v) space of one segment: x = fraction of the segment's frame span (0..1),
   * y = fraction of the segment's value delta (unclamped, so curves can overshoot).
   * bezierOut is P1 of the segment LEAVING this keyframe; bezierIn is P2 of the segment
   * ENTERING this keyframe from the previous one. Missing handles fall back to the smoothstep
   * equivalents (see BEZIER_DEFAULT_OUT/IN in keyframes.ts). */
  bezierOut?: [number, number];
  bezierIn?: [number, number];
}

export interface KeyframeTrack<V> {
  keyframes: Keyframe<V>[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Text
// ─────────────────────────────────────────────────────────────────────────────

export interface TextStyle {
  fontName: string; // PostScript or family name, e.g. "Helvetica-Bold"
  fontSize: number; // canvas points (≈50 caption, ≈120 title on 1080p)
  color: string; // "#RRGGBB" or "#RRGGBBAA"
  alignment: "left" | "center" | "right";
  highlightColor?: string; // karaoke captions: color of the word being spoken
}

/** One word of a karaoke caption cue; times are frames RELATIVE to the clip's startFrame,
 * so the cue stays in sync when the clip is moved. */
export interface KaraokeWord {
  word: string;
  startFrame: number;
  endFrame: number;
}

/** Rich-text styling for one substring of a text clip's textContent — character offsets,
 * start inclusive / end exclusive. Only the attributes a range sets override the clip's base
 * TextStyle, so ranges can layer (a word can be red AND bold from two separate ranges). */
export interface TextStyleRange {
  start: number;
  end: number;
  color?: string; // "#RRGGBB" or "#RRGGBBAA"
  bold?: boolean;
  italic?: boolean;
  fontSizeScale?: number; // multiplier on textStyle.fontSize (e.g. 1.3)
}

export function defaultTextStyle(): TextStyle {
  return { fontName: "Helvetica-Bold", fontSize: 96, color: "#FFFFFF", alignment: "center" };
}

// ─────────────────────────────────────────────────────────────────────────────
// Clip
// ─────────────────────────────────────────────────────────────────────────────

export interface Clip {
  id: string;
  mediaRef: string; // -> MediaAsset.id (empty for pure text and adjustment clips)
  mediaType: ClipType; // default "video"
  sourceClipType: ClipType; // original media type for derived clips (color-coding)
  /** Display label for media-less clips (adjustment layers) — they have no asset name to show. */
  name?: string;

  startFrame: number; // timeline position
  durationFrames: number; // length on the timeline

  // SOURCE-media offsets in PROJECT frames (timeline fps), NOT timeline positions.
  trimStartFrame: number;
  trimEndFrame: number;

  speed: number; // 1 normal; <1 slows (clip gets longer); >1 speeds up
  volume: number; // 0..1 linear, outer gain
  audioDenoise?: number; // 0..1 noise reduction strength (afftdn); 0/undefined = off
  audioNormalize?: boolean; // loudness-normalize this clip's audio (loudnorm ≈ -16 LUFS)
  audioHighpass?: boolean; // roll off low rumble below ~80 Hz
  audioDuck?: boolean; // auto-duck this clip under all other audio on export (music bed under voice)
  /** Voice effect applied to this clip's audio on export: pitch (semitones via amount), robot, echo, radio. */
  audioFx?: { type: "pitch" | "robot" | "echo" | "radio"; amount?: number };

  fadeInFrames: number;
  fadeOutFrames: number;
  fadeInInterpolation: Interpolation;
  fadeOutInterpolation: Interpolation;

  opacity: number; // 0..1
  transform: Transform;
  crop: Crop;

  linkGroupId?: string; // e.g. a video clip linked to its detached audio
  captionGroupId?: string; // caption clips sharing one styled group
  /** -> Project.compounds[].id — this clip renders a nested (compound) timeline instead of media.
   * mediaRef stays "" (like text/adjustment); trim/speed/effects apply on top of the composited
   * sub-timeline. Depth is 1 by construction: a compound's own timeline never holds compound clips. */
  compoundId?: string;

  // Text clips only.
  textContent?: string;
  textStyle?: TextStyle;
  karaokeWords?: KaraokeWord[]; // per-word timing for karaoke captions (relative frames)
  styleRanges?: TextStyleRange[]; // per-substring rich styling (char offsets into textContent)

  // Keyframe tracks; undefined when no animation exists on that property.
  opacityTrack?: KeyframeTrack<number>; // 0..1
  positionTrack?: KeyframeTrack<AnimPair>; // top-left x,y (normalized)
  scaleTrack?: KeyframeTrack<AnimPair>; // width,height (normalized)
  rotationTrack?: KeyframeTrack<number>; // degrees
  cropTrack?: KeyframeTrack<Crop>;
  mask?: MaskSpec; // optional shape mask (rect/ellipse, feather, invert)
  volumeTrack?: KeyframeTrack<number>; // dB envelope (0 dB = unity)

  // Color grade + ordered effect stack (video/image clips). Undefined = none.
  color?: ColorGrade;
  effects?: Effect[];
  blendMode?: BlendMode; // how this clip composites onto the layers below it. Undefined = "normal".
}

export const BLEND_MODES = [
  "normal", "multiply", "screen", "overlay", "darken", "lighten", "difference", "exclusion", "softlight", "hardlight", "add", "subtract",
] as const;
export type BlendMode = (typeof BLEND_MODES)[number];

export type ClipInit = Pick<Clip, "mediaRef" | "startFrame" | "durationFrames"> & Partial<Clip>;

export function makeClip(init: ClipInit): Clip {
  const mediaType = init.mediaType ?? "video";
  return {
    id: init.id ?? newId("clip"),
    mediaRef: init.mediaRef,
    mediaType,
    sourceClipType: init.sourceClipType ?? mediaType,
    name: init.name,
    startFrame: init.startFrame,
    durationFrames: init.durationFrames,
    trimStartFrame: init.trimStartFrame ?? 0,
    trimEndFrame: init.trimEndFrame ?? 0,
    speed: init.speed ?? 1,
    volume: init.volume ?? 1,
    audioDenoise: init.audioDenoise,
    audioNormalize: init.audioNormalize,
    audioHighpass: init.audioHighpass,
    audioDuck: init.audioDuck,
    audioFx: init.audioFx,
    fadeInFrames: init.fadeInFrames ?? 0,
    fadeOutFrames: init.fadeOutFrames ?? 0,
    fadeInInterpolation: init.fadeInInterpolation ?? "linear",
    fadeOutInterpolation: init.fadeOutInterpolation ?? "linear",
    opacity: init.opacity ?? 1,
    transform: init.transform ?? defaultTransform(),
    crop: init.crop ?? defaultCrop(),
    linkGroupId: init.linkGroupId,
    captionGroupId: init.captionGroupId,
    compoundId: init.compoundId,
    textContent: init.textContent,
    textStyle: init.textStyle,
    karaokeWords: init.karaokeWords,
    styleRanges: init.styleRanges,
    opacityTrack: init.opacityTrack,
    positionTrack: init.positionTrack,
    scaleTrack: init.scaleTrack,
    rotationTrack: init.rotationTrack,
    cropTrack: init.cropTrack,
    mask: init.mask,
    volumeTrack: init.volumeTrack,
    color: init.color,
    effects: init.effects,
    blendMode: init.blendMode,
  };
}

/** Frame where this clip ends on the timeline (exclusive). */
export function clipEndFrame(c: Clip): number {
  return c.startFrame + c.durationFrames;
}

export function clipContains(c: Clip, frame: number): boolean {
  return frame >= c.startFrame && frame < clipEndFrame(c);
}

/** Source frames consumed by the visible portion (accounts for speed). */
export function clipSourceFramesConsumed(c: Clip): number {
  return Math.round(c.durationFrames * c.speed);
}

/** Total source frames referenced, including both trims. */
export function clipSourceDurationFrames(c: Clip): number {
  return clipSourceFramesConsumed(c) + c.trimStartFrame + c.trimEndFrame;
}

// ─────────────────────────────────────────────────────────────────────────────
// Track
// ─────────────────────────────────────────────────────────────────────────────

export interface Track {
  id: string;
  type: ClipType;
  /** Stable display name assigned at creation ("Video 2") — array position renumbering confused users. */
  name?: string;
  muted: boolean;
  hidden: boolean;
  locked: boolean; // editing locked (no clip mutations through the UI)
  syncLocked: boolean; // default true: ripple edits shift this track to preserve sync
  clips: Clip[];
}

export function makeTrack(type: ClipType, init?: Partial<Track>): Track {
  return {
    id: init?.id ?? newId("track"),
    type,
    name: init?.name,
    muted: init?.muted ?? false,
    hidden: init?.hidden ?? false,
    locked: init?.locked ?? false,
    syncLocked: init?.syncLocked ?? true,
    clips: init?.clips ?? [],
  };
}

export function trackEndFrame(t: Track): number {
  let max = 0;
  for (const c of t.clips) max = Math.max(max, clipEndFrame(c));
  return max;
}

// ─────────────────────────────────────────────────────────────────────────────
// Timeline
// ─────────────────────────────────────────────────────────────────────────────

/** A bookmark pinned to a timeline frame — the agent and the user drop these to annotate key
 * moments ("dove ridono") without touching any clip. Rendered as colored flags on the ruler. */
export interface TimelineMarker {
  id: string;
  frame: number;
  color: string; // "#RRGGBB"
  note?: string;
}

export interface Timeline {
  fps: number; // default 30
  width: number; // default 1920
  height: number; // default 1080
  settingsConfigured: boolean;
  tracks: Track[];
  /** Optional so legacy project.json stays valid; kept sorted by frame. */
  markers?: TimelineMarker[];
}

export function makeTimeline(init?: Partial<Timeline>): Timeline {
  return {
    fps: init?.fps ?? 30,
    width: init?.width ?? 1920,
    height: init?.height ?? 1080,
    settingsConfigured: init?.settingsConfigured ?? false,
    tracks: init?.tracks ?? [],
    markers: init?.markers,
  };
}

export function timelineTotalFrames(tl: Timeline): number {
  let max = 0;
  for (const t of tl.tracks) max = Math.max(max, trackEndFrame(t));
  return max;
}

// ─────────────────────────────────────────────────────────────────────────────
// Media library
// ─────────────────────────────────────────────────────────────────────────────

export type GenerationStatusKind = "none" | "generating" | "downloading" | "rendering" | "failed";

export interface GenerationStatus {
  kind: GenerationStatusKind;
  error?: string; // set when kind === "failed"
}

/** What an asset was generated from. Refined when the Generate executor is ported. */
export interface GenerationInput {
  kind: "video" | "image" | "audio" | "upscale" | "import";
  prompt?: string;
  model?: string;
  references?: string[]; // mediaRefs
  [k: string]: unknown;
}

export interface MediaAsset {
  id: string;
  type: ClipType;
  name: string;
  /** Local file path (or URL) once resolved; absent while a generation/import is pending. */
  url?: string;
  durationSeconds: number;
  sourceWidth?: number;
  sourceHeight?: number;
  sourceFPS?: number;
  hasAudio: boolean;
  folderId?: string;
  generationStatus: GenerationStatus;
  generationInput?: GenerationInput;
}

export function isGeneratedAsset(a: MediaAsset): boolean {
  return a.generationInput != null;
}

export function isAssetPending(a: MediaAsset): boolean {
  const k = a.generationStatus.kind;
  return k === "generating" || k === "downloading" || k === "rendering";
}

export interface MediaFolder {
  id: string;
  name: string;
  parentFolderId?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Project (the editable document)
// ─────────────────────────────────────────────────────────────────────────────

/** A nested (compound) timeline: a full Timeline stored beside the main one, rendered wherever a
 * clip with a matching compoundId sits. Several clips may reference the same sequence (instances). */
export interface CompoundSequence {
  id: string;
  name: string;
  timeline: Timeline;
}

export interface Project {
  id: string;
  name: string;
  timeline: Timeline;
  media: MediaAsset[];
  folders: MediaFolder[];
  /** Nested timelines referenced by compound clips. Optional so legacy project.json stays valid. */
  compounds?: CompoundSequence[];
}

export function makeProject(init?: Partial<Project>): Project {
  return {
    id: init?.id ?? newId("proj"),
    name: init?.name ?? "Untitled",
    timeline: init?.timeline ?? makeTimeline(),
    media: init?.media ?? [],
    folders: init?.folders ?? [],
    compounds: init?.compounds,
  };
}

export const Defaults = {
  fps: 30,
  width: 1920,
  height: 1080,
  /** A still placed on the timeline defaults to this many seconds. */
  imageDurationSeconds: 5,
} as const;
