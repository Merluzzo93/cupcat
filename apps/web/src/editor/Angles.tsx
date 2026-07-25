// Angles — the multicam view.
//
// Two cameras of the same moment end up stacked on two video tracks, and the program monitor can
// only ever show the top one. That is correct compositing and useless editing: you cannot see what
// the other camera was doing, you cannot tell the two clips are the same moment, and cutting
// between them means hand-splitting both tracks and juggling opacity.
//
// This is the view every editor grew for that: all angles side by side, all showing the same
// instant, the live one marked. Clicking an angle cuts to it from the playhead — press 1/2/3 for
// the same thing. It needs no multicam "object": angles are simply the clips that overlap the
// playhead on different video tracks, so it works whether they were lined up by Sync cameras or
// dropped on by hand.

import { useEffect, useMemo, useRef } from "react";
import type { Clip, Project } from "@cupcat/editor-core";
import { t } from "./i18n";
import { afterStateChange, mediaUrl, sendCommand, ui, useEditor } from "./store";

export interface Angle {
  clip: Clip;
  trackIndex: number;
  assetName: string;
  /** What is actually on screen at the playhead — the top-most angle that is not transparent. */
  live: boolean;
}

/**
 * The angles at a given frame: one per video track that has a clip there, top track first (which is
 * the order they cover each other in). Fewer than two means there is nothing to choose between, and
 * the view stays out of the way.
 */
export function anglesAt(project: Project | null, frame: number): Angle[] {
  if (!project) return [];
  const out: Angle[] = [];
  project.timeline.tracks.forEach((track, trackIndex) => {
    if (track.type !== "video" || track.hidden) return;
    const clip = track.clips.find((c) => frame >= c.startFrame && frame < c.startFrame + c.durationFrames);
    if (!clip) return;
    if (clip.mediaType !== "video" && clip.mediaType !== "image") return; // text/adjustment are not angles
    const assetName = project.media.find((m) => m.id === clip.mediaRef)?.name ?? clip.name ?? "clip";
    out.push({ clip, trackIndex, assetName, live: false });
  });
  const liveIdx = out.findIndex((a) => (a.clip.opacity ?? 1) > 0.01);
  if (liveIdx >= 0) out[liveIdx]!.live = true;
  return out;
}

/**
 * Cut to one angle from `atFrame` onwards.
 *
 * Split every angle at the playhead first, so the choice applies from here on and everything before
 * it is left exactly as it was — then show the chosen one and hide the rest. Hiding rather than
 * reordering keeps each camera on its own track, which is what makes a later change of mind (or a
 * different cut on the same footage) a single click instead of an untangling job.
 */
export function cutToAngle(angles: Angle[], chosenClipId: string, atFrame: number): void {
  const chosenTrack = angles.find((a) => a.clip.id === chosenClipId)?.trackIndex;
  if (chosenTrack === undefined) return;
  const splits = angles.filter((a) => a.clip.startFrame < atFrame);
  for (const a of splits) sendCommand("split_clip", { clipId: a.clip.id, atFrame });

  // The right-hand piece of a split is a NEW clip, so the clips to restyle can only be read from
  // the state the ENGINE sends back. Waiting for that state — rather than guessing a delay —
  // matters: restyling too early would set the opacity on the clip as it was BEFORE the split,
  // hiding the part of the shot that comes before the cut along with it.
  const applyWhenSplit = (): boolean => {
    const after = anglesAt(ui.snapshot().project, atFrame);
    const splitTracks = new Set(splits.map((sp) => sp.trackIndex));
    const landed = after.length === angles.length && after.every((a) => !splitTracks.has(a.trackIndex) || a.clip.startFrame === atFrame);
    if (!landed) return false;
    for (const a of after) sendCommand("set_clip_properties", { clipIds: [a.clip.id], opacity: a.trackIndex === chosenTrack ? 1 : 0 });
    return true;
  };
  if (splits.length) afterStateChange(applyWhenSplit);
  else applyWhenSplit();
}

export function AnglesPanel() {
  const { project, playhead, previewStatus } = useEditor();
  const angles = useMemo(() => anglesAt(project, playhead), [project, playhead]);
  const fps = project?.timeline.fps ?? 30;

  // 1..9 cut to that angle, the way every editor does it.
  useEffect(() => {
    if (angles.length < 2) return;
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable)) return;
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const n = Number(e.key);
      if (!Number.isInteger(n) || n < 1 || n > angles.length) return;
      e.preventDefault();
      cutToAngle(angles, angles[n - 1]!.clip.id, playhead);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [angles, playhead]);

  if (angles.length < 2) {
    return <div className="flex h-full items-center justify-center px-6 text-center text-[11px] text-neutral-500">{t("angles.none")}</div>;
  }

  return (
    <div className="flex h-full flex-col gap-2 overflow-auto p-2">
      <div className="text-[10px] uppercase tracking-wide text-neutral-500">{t("angles.hint")}</div>
      <div
        className="grid gap-2"
        style={{ gridTemplateColumns: `repeat(${Math.min(3, Math.ceil(Math.sqrt(angles.length)))}, minmax(0, 1fr))` }}
      >
        {angles.map((a, i) => {
          const prep = previewStatus[a.clip.mediaRef];
          // Where this angle is in ITS OWN footage at the playhead — the whole point of syncing.
          const src = (playhead - a.clip.startFrame + a.clip.trimStartFrame) / fps;
          return (
            <button
              key={a.clip.id}
              type="button"
              onClick={() => cutToAngle(angles, a.clip.id, playhead)}
              title={t("angles.cutTo").replace("{name}", a.assetName)}
              className={`group relative aspect-video overflow-hidden rounded-md border bg-black text-left transition ${
                a.live ? "border-teal-400 ring-1 ring-teal-400/40" : "border-neutral-700 hover:border-neutral-500"
              }`}
            >
              {prep ? (
                <div className="flex h-full w-full items-center justify-center bg-neutral-900 text-[10px] text-neutral-400">
                  {Math.round(prep.percent * 100)}%
                </div>
              ) : (
                <AngleFrame assetId={a.clip.mediaRef} atSeconds={src} />
              )}
              <div className="absolute inset-x-0 bottom-0 flex items-center justify-between bg-black/70 px-1.5 py-0.5">
                <span className="truncate text-[10px] text-neutral-200">
                  {i + 1}. {a.assetName}
                </span>
                {a.live && <span className="ml-1 shrink-0 rounded bg-teal-400/20 px-1 text-[9px] text-teal-300">{t("angles.live")}</span>}
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}

/** One angle's picture at a given instant. A seeking <video>, not a stream: the tiles follow the
 * playhead rather than playing on their own, which is what keeps N angles cheap. */
function AngleFrame({ assetId, atSeconds }: { assetId: string; atSeconds: number }) {
  const ref = useRef<HTMLVideoElement>(null);
  // Follow the playhead. This has to be an effect, not a ref callback: a ref callback runs when the
  // element mounts, so each tile would show the instant it was created and then never move again.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const want = Math.max(0, atSeconds);
    const seek = () => {
      if (Math.abs(el.currentTime - want) > 0.05) el.currentTime = want;
    };
    if (el.readyState >= 1) {
      seek();
      return;
    }
    el.addEventListener("loadedmetadata", seek, { once: true });
    return () => el.removeEventListener("loadedmetadata", seek);
  }, [atSeconds]);
  return <video ref={ref} src={`${mediaUrl(assetId)}?scrub=1`} muted playsInline preload="metadata" className="h-full w-full object-cover" />;
}
