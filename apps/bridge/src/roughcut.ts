// auto_rough_cut — "folder → editable draft" (A1). The mechanical assembly a first cut always
// needs, done locally and deterministically so the agent (or the First-Cut button) gets a "70%
// done" timeline to refine instead of a blank one:
//   1. gather the videos (a folder, an explicit list, or all root videos)
//   2. analyze each locally (ffmpeg): trim dead black heads/tails, honor a per-clip cap
//   3. lay them end-to-end on V1 (linked audio follows automatically)
//   4. drop the first audio asset in scope onto A1 as a bed, ducked-ready
// Everything here is offline ffmpeg + the editor-core timeline commands — no cloud, no credits.

import { TIMELINE_COMMANDS, type EditorDocument, type MediaAsset } from "@cupcat/editor-core";
import { analyzeVideo, probeMedia } from "./ffmpeg";

export interface RoughCutOptions {
  folder?: string; // folder name or id; assets in it are used (recursively by name match)
  mediaRefs?: string[]; // explicit ordered asset ids/names (overrides folder)
  maxClipSeconds?: number; // cap each clip's on-timeline length (default: no cap)
  music?: boolean; // add first audio asset as a bed on A1 (default true)
  order?: "name" | "as-is"; // clip order (default name)
}

export interface RoughCutClip {
  assetId: string;
  name: string;
  trimStartFrames: number;
  trimEndFrames: number;
  timelineFrames: number;
}

export interface RoughCutResult {
  clips: RoughCutClip[];
  musicAsset?: string;
  totalSeconds: number;
  notes: string[];
}

/** Resolve a media reference (id or exact name) against the project. */
function resolve(doc: EditorDocument, ref: string): MediaAsset | null {
  return doc.asset(ref) ?? doc.project.media.find((m) => m.name === ref) ?? null;
}

export async function autoRoughCut(doc: EditorDocument, opts: RoughCutOptions): Promise<RoughCutResult> {
  const fps = doc.project.timeline.fps || 30;
  const notes: string[] = [];

  // ── 1. select the source videos ─────────────────────────────────────────────
  let videos: MediaAsset[];
  if (opts.mediaRefs && opts.mediaRefs.length > 0) {
    videos = opts.mediaRefs.map((r) => resolve(doc, r)).filter((a): a is MediaAsset => !!a && a.type === "video" && !!a.url);
  } else {
    let pool = doc.project.media.filter((m) => m.type === "video" && m.url && m.generationStatus.kind === "none");
    if (opts.folder) {
      const folder =
        doc.project.folders.find((f) => f.id === opts.folder) ?? doc.project.folders.find((f) => f.name === opts.folder);
      if (!folder) throw new Error(`Folder not found: ${opts.folder}`);
      // Include the folder and any descendant folders (by parent chain).
      const ids = new Set<string>([folder.id]);
      let grew = true;
      while (grew) {
        grew = false;
        for (const f of doc.project.folders) {
          if (f.parentFolderId && ids.has(f.parentFolderId) && !ids.has(f.id)) {
            ids.add(f.id);
            grew = true;
          }
        }
      }
      pool = pool.filter((m) => m.folderId && ids.has(m.folderId));
    }
    videos = pool;
  }

  if ((opts.order ?? "name") === "name") {
    videos = [...videos].sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  }
  if (videos.length === 0) throw new Error("No usable video assets found for the rough cut.");

  const maxFrames = opts.maxClipSeconds && opts.maxClipSeconds > 0 ? Math.round(opts.maxClipSeconds * fps) : 0;

  // ── 2. analyze each clip → trimmed head/tail ─────────────────────────────────
  const entries: { mediaRef: string; startFrame: number; durationFrames: number; trimStartFrame: number; trimEndFrame: number }[] = [];
  const clips: RoughCutClip[] = [];
  let cursor = 0;

  for (const v of videos) {
    const probe = await probeMedia(v.url!);
    const durSec = probe.durationSeconds || v.durationSeconds || 0;
    if (durSec <= 0) {
      notes.push(`Skipped ${v.name}: zero duration.`);
      continue;
    }
    let headSec = 0;
    let tailSec = 0;
    try {
      const an = await analyzeVideo(v.url!);
      // Leading black: a blackRange that starts within the first 0.2s.
      const lead = an.blackRanges.find((r) => r.startSeconds <= 0.2);
      if (lead && lead.endSeconds < durSec - 0.5) headSec = lead.endSeconds;
      // Trailing black: a blackRange that runs to (near) the end.
      const tail = an.blackRanges.find((r) => r.endSeconds >= durSec - 0.2 && r.startSeconds > headSec + 0.5);
      if (tail) tailSec = durSec - tail.startSeconds;
    } catch {
      // analysis best-effort; a clip with no black just isn't trimmed
    }
    const trimStartFrame = Math.max(0, Math.round(headSec * fps));
    let trimEndFrame = Math.max(0, Math.round(tailSec * fps));
    const fullFrames = Math.round(durSec * fps);
    let bodyFrames = fullFrames - trimStartFrame - trimEndFrame;
    if (bodyFrames < fps * 0.5) {
      // Trimming ate the whole clip (all-black or misdetection) — keep the raw clip instead.
      notes.push(`${v.name}: trim skipped (would remove almost everything).`);
      bodyFrames = fullFrames;
      trimEndFrame = 0;
    }
    if (maxFrames > 0 && bodyFrames > maxFrames) {
      trimEndFrame = fullFrames - trimStartFrame - maxFrames;
      bodyFrames = maxFrames;
    }
    entries.push({ mediaRef: v.id, startFrame: cursor, durationFrames: bodyFrames, trimStartFrame, trimEndFrame });
    clips.push({ assetId: v.id, name: v.name, trimStartFrames: trimStartFrame, trimEndFrames: trimEndFrame, timelineFrames: bodyFrames });
    cursor += bodyFrames;
  }

  if (entries.length === 0) throw new Error("Every candidate clip was skipped — nothing to assemble.");

  // ── 3. lay the video down (linked audio follows) ─────────────────────────────
  TIMELINE_COMMANDS.add_clips!(doc, { entries }, "user");

  // ── 4. optional music bed on its own audio track ─────────────────────────────
  let musicAsset: string | undefined;
  if (opts.music !== false) {
    let pool = doc.project.media.filter((m) => m.type === "audio" && m.url && m.generationStatus.kind === "none");
    if (opts.folder) {
      const folder =
        doc.project.folders.find((f) => f.id === opts.folder) ?? doc.project.folders.find((f) => f.name === opts.folder);
      if (folder) pool = pool.filter((m) => m.folderId === folder.id);
    }
    const bed = pool[0];
    if (bed) {
      const bedProbe = await probeMedia(bed.url!);
      const bedFrames = Math.max(1, Math.round((bedProbe.durationSeconds || bed.durationSeconds || 0) * fps));
      // One bed clip; if the montage is longer than the track, it simply plays once (the agent can
      // loop it on request). Omit trackIndex so it lands on a fresh audio track, not over the voice.
      TIMELINE_COMMANDS.add_clips!(
        doc,
        { entries: [{ mediaRef: bed.id, startFrame: 0, durationFrames: Math.min(bedFrames, cursor || bedFrames) }] },
        "user",
      );
      musicAsset = bed.id;
    }
  }

  return { clips, musicAsset, totalSeconds: cursor / fps, notes };
}
