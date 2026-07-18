// Pure summarizer for project changes that arrive over the WebSocket "state" broadcast.
// Used by the activity toasts: when an update was NOT originated by this window (an AI agent
// editing over MCP, another window on the same bridge), the store shows a compact human summary
// of what changed instead of letting the timeline appear to change "by itself".
// Kept free of store/react imports so it can be unit-tested directly.

import type { Project } from "@cupcat/editor-core";

function n(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? "" : "s"}`;
}

/** Compact, human-readable diff between two project snapshots, e.g.
 * "Timeline updated: +2 clips, 1 clip changed · Library: +1 asset · Tracks: 2→3".
 * Returns null when the snapshots are identical. Changes that don't fit a known bucket
 * (track properties, renames, folders…) fall back to a generic "Project updated". */
export function summarizeProjectChange(prev: Project, next: Project): string | null {
  const parts: string[] = [];

  // Clips — compare by id across ALL tracks (a clip moving between tracks counts as changed,
  // not as removed+added, because its id survives the move).
  const prevClips = new Map(prev.timeline.tracks.flatMap((t) => t.clips).map((c) => [c.id, c]));
  const nextClips = new Map(next.timeline.tracks.flatMap((t) => t.clips).map((c) => [c.id, c]));
  let added = 0;
  let changed = 0;
  let removed = 0;
  for (const [id, clip] of nextClips) {
    const before = prevClips.get(id);
    if (!before) added += 1;
    else if (JSON.stringify(before) !== JSON.stringify(clip)) changed += 1;
  }
  for (const id of prevClips.keys()) if (!nextClips.has(id)) removed += 1;
  const clipBits: string[] = [];
  if (added) clipBits.push(`+${n(added, "clip")}`);
  if (removed) clipBits.push(`-${n(removed, "clip")}`);
  if (changed) clipBits.push(`${n(changed, "clip")} changed`);
  if (clipBits.length) parts.push(`Timeline updated: ${clipBits.join(", ")}`);

  // Track count.
  const pt = prev.timeline.tracks.length;
  const nt = next.timeline.tracks.length;
  if (pt !== nt) parts.push(`Tracks: ${pt}→${nt}`);

  // Media library — membership only (asset metadata churn isn't worth a toast).
  const prevMedia = new Set(prev.media.map((m) => m.id));
  const nextMedia = new Set(next.media.map((m) => m.id));
  let mediaAdded = 0;
  let mediaRemoved = 0;
  for (const id of nextMedia) if (!prevMedia.has(id)) mediaAdded += 1;
  for (const id of prevMedia) if (!nextMedia.has(id)) mediaRemoved += 1;
  const libBits: string[] = [];
  if (mediaAdded) libBits.push(`+${n(mediaAdded, "asset")}`);
  if (mediaRemoved) libBits.push(`-${n(mediaRemoved, "asset")}`);
  if (libBits.length) parts.push(`Library: ${libBits.join(", ")}`);

  // Canvas format / frame rate.
  if (prev.timeline.width !== next.timeline.width || prev.timeline.height !== next.timeline.height)
    parts.push(`Format: ${prev.timeline.width}×${prev.timeline.height} → ${next.timeline.width}×${next.timeline.height}`);
  if (prev.timeline.fps !== next.timeline.fps) parts.push(`FPS: ${prev.timeline.fps}→${next.timeline.fps}`);

  if (parts.length === 0) {
    // Anything not classified above (track mute/lock, renames, folders…) still deserves a heads-up.
    return JSON.stringify(prev) === JSON.stringify(next) ? null : "Project updated";
  }
  return parts.join(" · ");
}
