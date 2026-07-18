// EditorDocument — the canonical, mutable editing document.
//
// Holds the Project and exposes the low-level timeline operations the command layer
// composes (the TypeScript analogue of Palmier's EditorViewModel): placement with
// same-track overwrite, ripple insert/delete, split, move, linked audio groups, and a
// snapshot-based undo history that distinguishes agent edits from the user's own.

import { newId } from "./ids";
import {
  type Clip,
  type ClipType,
  type MediaAsset,
  type MediaFolder,
  type Project,
  type Timeline,
  type Track,
  clipEndFrame,
  clipSourceFramesConsumed,
  Defaults,
  isCompatible,
  makeClip,
  makeProject,
  makeTrack,
} from "./types";

export type EditSource = "agent" | "user";

export interface ClipLocation {
  trackIndex: number;
  clipIndex: number;
}

export interface PlaceSpec {
  asset: MediaAsset;
  startFrame: number;
  durationFrames: number;
  trimStartFrame?: number;
  trimEndFrame?: number;
}

export interface RippleInsertSpec {
  asset: MediaAsset;
  durationFrames: number;
  trimStartFrame?: number;
  trimEndFrame?: number;
}

export interface FrameRange {
  start: number;
  end: number;
}

export interface RippleReport {
  removedFrames: number;
  clearedTracks: number;
  shiftedClips: number;
  anchorTrackIndex: number;
  resultingClips: { clipId: string; startFrame: number; durationFrames: number }[];
  removedClipIds: string[];
}

interface HistoryEntry {
  before: Project;
  actionName: string;
  source: EditSource;
}

// ── trim/split helpers (source-mapping aware) ──────────────────────────────────

function clampedSpeed(c: Clip): number {
  return c.speed > 0 ? c.speed : 1;
}

/** New linkGroupId for the RIGHT piece of a split, derived deterministically from (original group,
 * cut frame). Any operation that cuts linked clips (split_clip, ripple-delete/pause removal via
 * clearRegion, blade…) cuts every track of the group at the SAME frame, so each track's right piece
 * independently derives the SAME new group — the pieces stay paired with each other but detach from
 * the left pair. Without this, all pieces of every cut stay in ONE group forever, and a later
 * speed/duration change on one segment silently propagates to every other segment. */
function derivedLinkGroup(orig: string | undefined, atFrame: number): string | undefined {
  return orig === undefined ? undefined : `${orig}@${atFrame}`;
}

/** Move a clip's left edge right by `delta` timeline frames; advance the source trim. */
function trimLeft(c: Clip, delta: number): void {
  if (delta <= 0) return;
  c.startFrame += delta;
  c.durationFrames -= delta;
  if (c.mediaType !== "text") c.trimStartFrame += Math.round(delta * clampedSpeed(c));
  clampKeyframesToDuration(c);
}

/** Pull a clip's right edge in by `delta` timeline frames; trim the source tail. */
function trimRight(c: Clip, delta: number): void {
  if (delta <= 0) return;
  c.durationFrames -= delta;
  if (c.mediaType !== "text") c.trimEndFrame += Math.round(delta * clampedSpeed(c));
  clampKeyframesToDuration(c);
}

function shiftKeyframes(c: Clip, delta: number): void {
  for (const t of keyframeTracksOf(c)) {
    if (t) for (const k of t.keyframes) k.frame += delta;
  }
}

function keyframeTracksOf(c: Clip) {
  return [c.opacityTrack, c.positionTrack, c.scaleTrack, c.rotationTrack, c.cropTrack, c.volumeTrack];
}

function clampKeyframesToDuration(c: Clip): void {
  const within = (frame: number) => frame >= 0 && frame <= c.durationFrames;
  if (c.opacityTrack) c.opacityTrack.keyframes = c.opacityTrack.keyframes.filter((k) => within(k.frame));
  if (c.positionTrack) c.positionTrack.keyframes = c.positionTrack.keyframes.filter((k) => within(k.frame));
  if (c.scaleTrack) c.scaleTrack.keyframes = c.scaleTrack.keyframes.filter((k) => within(k.frame));
  if (c.rotationTrack) c.rotationTrack.keyframes = c.rotationTrack.keyframes.filter((k) => within(k.frame));
  if (c.cropTrack) c.cropTrack.keyframes = c.cropTrack.keyframes.filter((k) => within(k.frame));
  if (c.volumeTrack) c.volumeTrack.keyframes = c.volumeTrack.keyframes.filter((k) => within(k.frame));
  // Drop now-empty tracks so default-omission in selectors stays clean.
  if (c.opacityTrack && c.opacityTrack.keyframes.length === 0) c.opacityTrack = undefined;
  if (c.positionTrack && c.positionTrack.keyframes.length === 0) c.positionTrack = undefined;
  if (c.scaleTrack && c.scaleTrack.keyframes.length === 0) c.scaleTrack = undefined;
  if (c.rotationTrack && c.rotationTrack.keyframes.length === 0) c.rotationTrack = undefined;
  if (c.cropTrack && c.cropTrack.keyframes.length === 0) c.cropTrack = undefined;
  if (c.volumeTrack && c.volumeTrack.keyframes.length === 0) c.volumeTrack = undefined;
}

function defaultClipDuration(asset: MediaAsset, fps: number): number {
  if (asset.type === "image" || asset.type === "text") {
    return Math.max(1, Math.round(Defaults.imageDurationSeconds * fps));
  }
  return Math.max(1, Math.round(asset.durationSeconds * fps));
}

// ── EditorDocument ─────────────────────────────────────────────────────────────

export class EditorDocument {
  project: Project;
  private history: HistoryEntry[] = [];
  // Redo mirrors undo with the same snapshot approach: each undo pushes the (post-edit) state here,
  // and any NEW edit invalidates the whole redo chain — the standard branch-discard semantics.
  private redoStack: HistoryEntry[] = [];
  private readonly historyLimit = 200;
  private listeners = new Set<() => void>();

  // The open compound sequence, if any. This getter-level switch is what makes nested timelines
  // LIVE: every command, selector, WS broadcast and UI read goes through `doc.timeline`, so
  // pointing it at the compound's timeline instantly retargets the whole tool surface — no
  // per-command compoundId plumbing. NOT part of Project: undo snapshots must not close/open views.
  private _activeCompoundId: string | null = null;

  constructor(project?: Project) {
    this.project = project ?? makeProject();
  }

  get timeline(): Timeline {
    // Resolve on every read (not cached): undo can remove the compound entry from under an open
    // view — falling back to the main timeline keeps every reader consistent instead of crashing.
    if (this._activeCompoundId) {
      const comp = this.project.compounds?.find((c) => c.id === this._activeCompoundId);
      if (comp) return comp.timeline;
    }
    return this.project.timeline;
  }

  /** ALWAYS the main timeline, whatever view is open — export/bake paths must never render the
   * active compound view in place of the real program. */
  get mainTimeline(): Timeline {
    return this.project.timeline;
  }

  /** The open compound sequence ({id, name}) or null. Null also when the id went stale (undone). */
  get activeCompound(): { id: string; name: string } | null {
    if (!this._activeCompoundId) return null;
    const comp = this.project.compounds?.find((c) => c.id === this._activeCompoundId);
    return comp ? { id: comp.id, name: comp.name } : null;
  }

  /** Switch the editing context to a compound sequence (by compound id, or by the id of a clip
   * that references one). Returns the opened {id, name} or null when nothing matched. */
  openCompound(idOrClipId: string): { id: string; name: string } | null {
    const compounds = this.project.compounds ?? [];
    let comp = compounds.find((c) => c.id === idOrClipId);
    if (!comp) {
      // Search the MAIN timeline (compound clips only live there — depth is 1).
      for (const t of this.project.timeline.tracks) {
        const hit = t.clips.find((c) => c.id === idOrClipId && c.compoundId);
        if (hit) {
          comp = compounds.find((c) => c.id === hit.compoundId);
          break;
        }
      }
    }
    if (!comp) return null;
    this._activeCompoundId = comp.id;
    this.emit();
    return { id: comp.id, name: comp.name };
  }

  /** Return to the main timeline. Returns the compound that was open, or null. */
  closeCompound(): { id: string; name: string } | null {
    const was = this.activeCompound;
    this._activeCompoundId = null;
    if (was) this.emit();
    return was;
  }

  // ── observation ──
  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(): void {
    for (const fn of this.listeners) fn();
  }

  /** Notify subscribers after a non-undoable change (e.g. a generation/import filling an asset). */
  notifyChanged(): void {
    this.emit();
  }

  /** Replace the entire project (used when switching projects) — clears undo history and notifies. */
  reset(project: Project): void {
    this.project = project;
    this._activeCompoundId = null; // a compound view must not survive into another project
    this.history = [];
    this.redoStack = [];
    this.emit();
  }

  /** Run `work` as one undoable step. Records a snapshot only if the project actually changed. */
  mutate<T>(actionName: string, source: EditSource, work: () => T): T {
    const before = structuredClone(this.project);
    const result = work();
    if (JSON.stringify(before) !== JSON.stringify(this.project)) {
      this.history.push({ before, actionName, source });
      if (this.history.length > this.historyLimit) this.history.shift();
      this.redoStack = []; // a new edit discards the redo branch
      this.emit();
    }
    return result;
  }

  /** Name + source of the edit `undo` would revert, or null if history is empty. */
  get lastEdit(): { actionName: string; source: EditSource } | null {
    const e = this.history[this.history.length - 1];
    return e ? { actionName: e.actionName, source: e.source } : null;
  }

  /** Name + source of the edit `redo` would re-apply, or null if nothing was undone. */
  get nextRedo(): { actionName: string; source: EditSource } | null {
    const e = this.redoStack[this.redoStack.length - 1];
    return e ? { actionName: e.actionName, source: e.source } : null;
  }

  /** Reverts the most recent edit unconditionally. Commands gate on `lastEdit.source`. */
  undo(): { actionName: string; source: EditSource } | null {
    const entry = this.history.pop();
    if (!entry) return null;
    this.redoStack.push({ before: structuredClone(this.project), actionName: entry.actionName, source: entry.source });
    this.project = entry.before;
    this.emit();
    return { actionName: entry.actionName, source: entry.source };
  }

  /** Re-applies the most recently undone edit (inverse of undo). */
  redo(): { actionName: string; source: EditSource } | null {
    const entry = this.redoStack.pop();
    if (!entry) return null;
    // Push straight onto history (not via mutate) so this redo itself stays undoable without
    // clearing the remaining redo chain.
    this.history.push({ before: structuredClone(this.project), actionName: entry.actionName, source: entry.source });
    if (this.history.length > this.historyLimit) this.history.shift();
    this.project = entry.before;
    this.emit();
    return { actionName: entry.actionName, source: entry.source };
  }

  // ── lookups ──
  findClip(id: string): ClipLocation | null {
    const tracks = this.timeline.tracks;
    for (let ti = 0; ti < tracks.length; ti++) {
      const ci = tracks[ti]!.clips.findIndex((c) => c.id === id);
      if (ci >= 0) return { trackIndex: ti, clipIndex: ci };
    }
    return null;
  }

  getClip(id: string): Clip | null {
    const loc = this.findClip(id);
    return loc ? this.timeline.tracks[loc.trackIndex]!.clips[loc.clipIndex]! : null;
  }

  asset(id: string): MediaAsset | null {
    return this.project.media.find((a) => a.id === id) ?? null;
  }

  folder(id: string): MediaFolder | null {
    return this.project.folders.find((f) => f.id === id) ?? null;
  }

  trackDisplayLabel(index: number): string {
    const t = this.timeline.tracks[index];
    if (!t) return `track ${index}`;
    if (t.name) return t.name; // stable creation-time name (new tracks)
    // Legacy tracks without a name: positional numbering among same-type tracks.
    const sameType = this.timeline.tracks.filter((x) => x.type === t.type);
    const n = sameType.indexOf(t) + 1;
    const base = t.type.charAt(0).toUpperCase() + t.type.slice(1);
    return `${base} ${n}`;
  }

  /** Stable, never-reused display name for a NEW track of `type` (max existing suffix + 1) — adding
   * a text track must not silently rename the user's "Video 1" to "Video 2". */
  private nextTrackName(type: ClipType): string {
    const base = type.charAt(0).toUpperCase() + type.slice(1);
    let max = 0;
    this.timeline.tracks.forEach((t, i) => {
      if (t.type !== type) return;
      const label = t.name ?? this.trackDisplayLabel(i);
      const m = new RegExp(`^${base} (\\d+)$`).exec(label);
      if (m) max = Math.max(max, Number(m[1]));
    });
    return `${base} ${max + 1}`;
  }

  // ── tracks ──
  insertTrack(at: number, type: ClipType): number {
    const idx = Math.max(0, Math.min(at, this.timeline.tracks.length));
    this.timeline.tracks.splice(idx, 0, makeTrack(type, { name: this.nextTrackName(type) }));
    return idx;
  }

  /** Audio-track index for a new linked audio clip spanning [start, end).
   * WHY not simply the first audio track: placeClip clears the destination span, and stacked
   * multicam angles all carry sound over the SAME span — reusing the first track would silently
   * destroy the previously placed angle's audio. A track is reusable only when every clip it has
   * in the span is orphaned linked audio (its video partner is gone, e.g. after the picture was
   * overwritten — clearing that preserves the old replace semantics); otherwise open a new track. */
  private pickAudioTrackFor(start: number, end: number): number {
    const liveGroups = new Set<string>();
    for (const t of this.timeline.tracks) {
      if (t.type === "audio") continue;
      for (const c of t.clips) if (c.linkGroupId) liveGroups.add(c.linkGroupId);
    }
    for (let ti = 0; ti < this.timeline.tracks.length; ti++) {
      const t = this.timeline.tracks[ti]!;
      if (t.type !== "audio") continue;
      const blocked = t.clips.some(
        (c) => c.startFrame < end && clipEndFrame(c) > start && (c.linkGroupId === undefined || liveGroups.has(c.linkGroupId)),
      );
      if (!blocked) return ti;
    }
    this.timeline.tracks.push(makeTrack("audio", { name: this.nextTrackName("audio") }));
    return this.timeline.tracks.length - 1;
  }

  /** Move a track to a new index (clips ride along — only the stacking order changes). */
  moveTrack(from: number, to: number): boolean {
    const tracks = this.timeline.tracks;
    const dest = Math.max(0, Math.min(to, tracks.length - 1));
    if (from < 0 || from >= tracks.length || dest === from) return false;
    const [moved] = tracks.splice(from, 1);
    if (!moved) return false;
    tracks.splice(dest, 0, moved);
    return true;
  }

  removeTracksByIndexes(indexes: number[]): { id: string; label: string; clipCount: number; index: number }[] {
    const removed = indexes
      .filter((i, k) => indexes.indexOf(i) === k && this.timeline.tracks[i])
      .sort((a, b) => b - a)
      .map((i) => {
        const t = this.timeline.tracks[i]!;
        return { id: t.id, label: this.trackDisplayLabel(i), clipCount: t.clips.length, index: i };
      });
    for (const r of removed) {
      const idx = this.timeline.tracks.findIndex((t) => t.id === r.id);
      if (idx >= 0) this.timeline.tracks.splice(idx, 1);
    }
    return removed.sort((a, b) => a.index - b.index);
  }

  removeEmptyTracks(previouslyNonEmpty: Set<string>): number {
    let pruned = 0;
    for (let i = this.timeline.tracks.length - 1; i >= 0; i--) {
      const t = this.timeline.tracks[i]!;
      if (t.clips.length === 0 && previouslyNonEmpty.has(t.id)) {
        this.timeline.tracks.splice(i, 1);
        pruned++;
      }
    }
    return pruned;
  }

  // ── overwrite placement ──
  /** Trim/split/remove clips overlapping [start, end) on a track to open a clean region. */
  clearRegion(trackIndex: number, start: number, end: number, exceptClipId?: string): void {
    const track = this.timeline.tracks[trackIndex];
    if (!track || end <= start) return;
    const next: Clip[] = [];
    for (const c of track.clips) {
      if (c.id === exceptClipId || clipEndFrame(c) <= start || c.startFrame >= end) {
        next.push(c);
        continue;
      }
      const cs = c.startFrame;
      const ce = clipEndFrame(c);
      if (cs >= start && ce <= end) {
        // fully covered → drop
        continue;
      }
      if (cs < start && ce > end) {
        // region splits the clip: keep left [cs,start), spawn right [end,ce)
        const orig = structuredClone(c);
        const right = structuredClone(orig);
        right.id = newId("clip");
        trimRight(c, ce - start); // c → [cs, start)
        right.startFrame = end;
        right.durationFrames = ce - end;
        if (right.mediaType !== "text") {
          right.trimStartFrame = orig.trimStartFrame + Math.round((end - cs) * clampedSpeed(orig));
        }
        right.linkGroupId = derivedLinkGroup(orig.linkGroupId, end);
        shiftKeyframes(right, -(end - cs));
        clampKeyframesToDuration(right);
        next.push(c, right);
        continue;
      }
      if (cs < start) {
        // overlaps region head → trim clip's tail to start
        trimRight(c, ce - start);
        next.push(c);
        continue;
      }
      // cs >= start && ce > end → region cuts clip head → advance start to end
      trimLeft(c, end - cs);
      next.push(c);
    }
    track.clips = next.filter((c) => c.durationFrames > 0).sort((a, b) => a.startFrame - b.startFrame);
  }

  /** Place a clip; auto-creates a linked audio clip for a video-with-audio on a video track. */
  placeClip(spec: PlaceSpec, trackIndex: number): string[] {
    const track = this.timeline.tracks[trackIndex];
    if (!track) return [];
    const ids: string[] = [];
    const linkGroupId =
      spec.asset.type === "video" && spec.asset.hasAudio && track.type !== "audio" ? newId("link") : undefined;

    const clip = makeClip({
      mediaRef: spec.asset.id,
      mediaType: spec.asset.type,
      sourceClipType: spec.asset.type,
      startFrame: spec.startFrame,
      durationFrames: spec.durationFrames,
      trimStartFrame: spec.trimStartFrame ?? 0,
      trimEndFrame: spec.trimEndFrame ?? 0,
      linkGroupId,
    });
    track.clips.push(clip);
    track.clips.sort((a, b) => a.startFrame - b.startFrame);
    ids.push(clip.id);

    if (linkGroupId) {
      const audioIdx = this.pickAudioTrackFor(spec.startFrame, spec.startFrame + spec.durationFrames);
      this.clearRegion(audioIdx, spec.startFrame, spec.startFrame + spec.durationFrames);
      const audio = makeClip({
        mediaRef: spec.asset.id,
        mediaType: "audio",
        sourceClipType: spec.asset.type,
        startFrame: spec.startFrame,
        durationFrames: spec.durationFrames,
        trimStartFrame: spec.trimStartFrame ?? 0,
        trimEndFrame: spec.trimEndFrame ?? 0,
        linkGroupId,
      });
      this.timeline.tracks[audioIdx]!.clips.push(audio);
      this.timeline.tracks[audioIdx]!.clips.sort((a, b) => a.startFrame - b.startFrame);
      ids.push(audio.id);
    }
    return ids;
  }

  // ── link groups ──
  expandToLinkGroup(ids: Set<string>): Set<string> {
    const groups = new Set<string>();
    for (const id of ids) {
      const c = this.getClip(id);
      if (c?.linkGroupId) groups.add(c.linkGroupId);
    }
    if (groups.size === 0) return new Set(ids);
    const out = new Set(ids);
    for (const t of this.timeline.tracks) {
      for (const c of t.clips) if (c.linkGroupId && groups.has(c.linkGroupId)) out.add(c.id);
    }
    return out;
  }

  /** Linked partners that follow timing changes (same group, excluding the seeds). */
  /** Like expandToLinkGroup, but only pulls in linked partners that overlap in time with one of the
   * given clips. Deleting one piece of a split/rippled clip then removes its time-aligned audio —
   * not distant siblings that merely share the link group (which would wipe the whole timeline). */
  expandToLinkGroupOverlapping(ids: Set<string>): Set<string> {
    const sources = [...ids].map((id) => this.getClip(id)).filter((c): c is Clip => !!c);
    const groups = new Set(sources.map((c) => c.linkGroupId).filter((g): g is string => !!g));
    const out = new Set(ids);
    if (groups.size === 0) return out;
    for (const t of this.timeline.tracks) {
      for (const c of t.clips) {
        if (!c.linkGroupId || !groups.has(c.linkGroupId) || out.has(c.id)) continue;
        if (sources.some((s) => s.startFrame < clipEndFrame(c) && c.startFrame < clipEndFrame(s))) out.add(c.id);
      }
    }
    return out;
  }

  timingPartners(ids: Set<string>): Set<string> {
    const expanded = this.expandToLinkGroup(ids);
    for (const id of ids) expanded.delete(id);
    return expanded;
  }

  removeClipsByIds(ids: Set<string>): void {
    for (const t of this.timeline.tracks) {
      t.clips = t.clips.filter((c) => !ids.has(c.id));
    }
  }

  // ── move ──
  moveClips(moves: { clipId: string; toTrack: number; toFrame: number }[]): void {
    for (const m of moves) {
      const loc = this.findClip(m.clipId);
      if (!loc) continue;
      const fromTrack = this.timeline.tracks[loc.trackIndex]!;
      const [clip] = fromTrack.clips.splice(loc.clipIndex, 1);
      if (!clip) continue;
      clip.startFrame = Math.max(0, m.toFrame);
      const dest = this.timeline.tracks[m.toTrack] ?? fromTrack;
      this.clearRegion(this.timeline.tracks.indexOf(dest), clip.startFrame, clipEndFrame(clip), clip.id);
      dest.clips.push(clip);
      dest.clips.sort((a, b) => a.startFrame - b.startFrame);
    }
  }

  partnerMoves(clipId: string, toFrame: number): { clipId: string; toFrame: number }[] {
    const clip = this.getClip(clipId);
    if (!clip?.linkGroupId) return [];
    const delta = toFrame - clip.startFrame;
    const out: { clipId: string; toFrame: number }[] = [];
    for (const t of this.timeline.tracks) {
      for (const c of t.clips) {
        if (c.id !== clipId && c.linkGroupId === clip.linkGroupId) {
          out.push({ clipId: c.id, toFrame: c.startFrame + delta });
        }
      }
    }
    return out;
  }

  // ── split ──
  private splitOneClip(trackIndex: number, clipIndex: number, atFrame: number): string | null {
    const track = this.timeline.tracks[trackIndex]!;
    const c = track.clips[clipIndex]!;
    if (atFrame <= c.startFrame || atFrame >= clipEndFrame(c)) return null;
    const orig = structuredClone(c);
    const rightDur = clipEndFrame(c) - atFrame;
    const leftSpan = atFrame - orig.startFrame;
    trimRight(c, rightDur); // c → [start, atFrame)

    const right = structuredClone(orig);
    right.id = newId("clip");
    right.startFrame = atFrame;
    right.durationFrames = rightDur;
    if (right.mediaType !== "text") {
      right.trimStartFrame = orig.trimStartFrame + Math.round(leftSpan * clampedSpeed(orig));
    }
    right.linkGroupId = derivedLinkGroup(orig.linkGroupId, atFrame);
    // Karaoke word times are relative to the clip start: partition them at the cut so each half
    // highlights only the words spoken during its own window.
    if (orig.karaokeWords?.length) {
      c.karaokeWords = orig.karaokeWords.filter((w) => w.startFrame < leftSpan);
      right.karaokeWords = orig.karaokeWords
        .filter((w) => w.endFrame > leftSpan)
        .map((w) => ({ word: w.word, startFrame: Math.max(0, w.startFrame - leftSpan), endFrame: w.endFrame - leftSpan }));
      if (typeof c.textContent === "string") c.textContent = c.karaokeWords.map((w) => w.word).join(" ") || c.textContent;
      if (typeof right.textContent === "string") right.textContent = right.karaokeWords.map((w) => w.word).join(" ") || right.textContent;
    }
    shiftKeyframes(right, -leftSpan);
    clampKeyframesToDuration(right);
    track.clips.push(right);
    track.clips.sort((a, b) => a.startFrame - b.startFrame);
    return right.id;
  }

  splitClip(clipId: string, atFrame: number): string[] {
    const loc = this.findClip(clipId);
    if (!loc) return [];
    const linkGroupId = this.timeline.tracks[loc.trackIndex]!.clips[loc.clipIndex]!.linkGroupId;
    const primary = this.splitOneClip(loc.trackIndex, loc.clipIndex, atFrame);
    if (!primary) return [];
    const created = [primary];
    // A video's detached audio (or any linked partner) shares a linkGroupId — split it too at the
    // same point, or the cut desyncs picture and sound (the video becomes two clips, the audio stays one).
    // The right-side pieces detach into their own pair automatically: splitOneClip derives their new
    // group from (original group, cut frame), so both rights land in the same fresh group.
    if (linkGroupId) {
      for (let ti = 0; ti < this.timeline.tracks.length; ti++) {
        if (ti === loc.trackIndex) continue;
        const ci = this.timeline.tracks[ti]!.clips.findIndex((p) => p.linkGroupId === linkGroupId && atFrame > p.startFrame && atFrame < clipEndFrame(p));
        if (ci < 0) continue;
        const rightId = this.splitOneClip(ti, ci, atFrame);
        if (rightId) created.push(rightId);
      }
    }
    return created;
  }

  // ── ripple insert ──
  rippleInsert(specs: RippleInsertSpec[], trackIndex: number, atFrame: number): string[] {
    const track = this.timeline.tracks[trackIndex];
    if (!track) return [];
    const totalPush = specs.reduce((sum, s) => sum + s.durationFrames, 0);
    // Push the target track + every sync-locked track to preserve alignment.
    for (let ti = 0; ti < this.timeline.tracks.length; ti++) {
      const t = this.timeline.tracks[ti]!;
      if (ti !== trackIndex && !t.syncLocked) continue;
      for (const c of t.clips) if (c.startFrame >= atFrame) c.startFrame += totalPush;
    }
    let cursor = atFrame;
    const ids: string[] = [];
    for (const s of specs) {
      const placed = this.placeClip(
        {
          asset: s.asset,
          startFrame: cursor,
          durationFrames: s.durationFrames,
          trimStartFrame: s.trimStartFrame,
          trimEndFrame: s.trimEndFrame,
        },
        trackIndex,
      );
      ids.push(...placed);
      cursor += s.durationFrames;
    }
    return ids;
  }

  // ── ripple delete ──
  rippleDelete(
    trackIndex: number,
    ranges: FrameRange[],
    opts: { ignoreSyncLock?: boolean } = {},
  ): RippleReport | { refused: string } {
    const track = this.timeline.tracks[trackIndex];
    if (!track) return { refused: `Track index out of range: ${trackIndex}` };
    const merged = mergeRanges(ranges);
    const removedFrames = merged.reduce((s, r) => s + (r.end - r.start), 0);
    const removedBefore = (f: number): number => {
      let total = 0;
      for (const r of merged) {
        if (f <= r.start) break;
        total += Math.min(f, r.end) - r.start;
      }
      return total;
    };

    // A video's detached audio lives on its own track but shares a linkGroupId with the picture.
    // Ripple must cut AND shift those partner tracks in lockstep, or picture and sound desync
    // (the classic "remove dead air" failure). Precompute the affected tracks before any mutation.
    const anchorGroups = new Set<string>();
    for (const c of track.clips) if (c.linkGroupId) anchorGroups.add(c.linkGroupId);
    const cutTracks = new Set<number>([trackIndex]); // content removed here
    const shiftTracks = new Set<number>([trackIndex]); // gaps closed here
    for (let ti = 0; ti < this.timeline.tracks.length; ti++) {
      if (ti === trackIndex) continue;
      const t = this.timeline.tracks[ti]!;
      const linked =
        anchorGroups.size > 0 && t.clips.some((c) => c.linkGroupId !== undefined && anchorGroups.has(c.linkGroupId));
      if (linked) {
        cutTracks.add(ti);
        shiftTracks.add(ti);
      } else if (t.syncLocked && !opts.ignoreSyncLock) {
        shiftTracks.add(ti);
      }
    }

    // Pre-flight: nothing that shifts may cross frame 0.
    for (const ti of shiftTracks) {
      for (const c of this.timeline.tracks[ti]!.clips) {
        if (c.startFrame - removedBefore(c.startFrame) < 0) {
          return {
            refused: `Refusing: a clip on ${this.trackDisplayLabel(ti)} would shift past frame 0. Adjust the ranges.`,
          };
        }
      }
    }

    const idsBefore = new Set([...cutTracks].flatMap((ti) => this.timeline.tracks[ti]!.clips.map((c) => c.id)));
    // Cut content on the anchor + every linked-partner track.
    for (const ti of cutTracks) for (const r of merged) this.clearRegion(ti, r.start, r.end);
    const surviving = new Set(this.timeline.tracks.flatMap((t) => t.clips.map((c) => c.id)));
    const removedClipIds = [...idsBefore].filter((id) => !surviving.has(id));

    // Close gaps on the anchor + linked-partner + sync-locked tracks.
    let shiftedClips = 0;
    let clearedTracks = 0;
    for (const ti of shiftTracks) {
      const t = this.timeline.tracks[ti]!;
      const had = t.clips.length;
      for (const c of t.clips) {
        const ns = c.startFrame - removedBefore(c.startFrame);
        if (ns !== c.startFrame) {
          c.startFrame = ns;
          shiftedClips++;
        }
      }
      t.clips.sort((a, b) => a.startFrame - b.startFrame);
      if (had > 0 && t.clips.length === 0) clearedTracks++;
    }

    // Close any 1–2 frame rounding gaps the shift can leave between adjacent clips on a cut track —
    // such a hole renders as a black microframe (video drops out for one frame, then resumes).
    for (const ti of cutTracks) {
      const clips = this.timeline.tracks[ti]!.clips;
      for (let i = 1; i < clips.length; i++) {
        const gap = clips[i]!.startFrame - clipEndFrame(clips[i - 1]!);
        if (gap > 0 && gap <= 2) clips[i]!.startFrame -= gap;
      }
    }

    return {
      removedFrames,
      clearedTracks,
      shiftedClips,
      anchorTrackIndex: trackIndex,
      resultingClips: track.clips.map((c) => ({
        clipId: c.id,
        startFrame: c.startFrame,
        durationFrames: c.durationFrames,
      })),
      removedClipIds,
    };
  }

  // ── clip property commit ──
  commitClipProperty(clipId: string, fn: (clip: Clip) => void): void {
    const c = this.getClip(clipId);
    if (c) fn(c);
  }

  // ── media library ──
  addAsset(asset: MediaAsset): void {
    this.project.media.push(asset);
  }

  removeAssets(ids: Set<string>): { removedClipIds: string[] } {
    this.project.media = this.project.media.filter((a) => !ids.has(a.id));
    const removedClipIds: string[] = [];
    for (const t of this.timeline.tracks) {
      const keep: Clip[] = [];
      for (const c of t.clips) {
        if (c.mediaRef && ids.has(c.mediaRef)) removedClipIds.push(c.id);
        else keep.push(c);
      }
      t.clips = keep;
    }
    return { removedClipIds };
  }

  clipDurationFor(asset: MediaAsset): number {
    return defaultClipDuration(asset, this.timeline.fps);
  }
}

// ── module helpers ──

function mergeRanges(ranges: FrameRange[]): FrameRange[] {
  const sorted = ranges
    .filter((r) => r.end > r.start)
    .map((r) => ({ start: r.start, end: r.end }))
    .sort((a, b) => a.start - b.start);
  const out: FrameRange[] = [];
  for (const r of sorted) {
    const last = out[out.length - 1];
    if (last && r.start <= last.end) last.end = Math.max(last.end, r.end);
    else out.push({ ...r });
  }
  return out;
}

export { isCompatible, clipSourceFramesConsumed };
