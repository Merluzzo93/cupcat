// Project templates (A4): capture the shape of the current timeline — track layout, clip timing,
// text clips, transitions, project format — as a reusable JSON, then re-apply it with new media
// dropped into the slots. This is the counter-move to CapCut's template MARKETPLACE: not a fixed
// catalog, but a save/re-apply mechanism (and, via the agent, a "make a template like this reel"
// generator). Templates are global (shared across projects) so a look built once is reusable.

import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { type Clip, type EditorDocument, type MediaAsset, makeClip, makeTrack, newId } from "@cupcat/editor-core";
import { projectsBase } from "./config";

const TEMPLATES_DIR = join(projectsBase, "_templates");

/** A media clip in a template is a typed SLOT (filled at apply-time), not a hard asset reference. */
interface TemplateClip {
  slot?: number; // index into the ordered fill list of this clip's media kind (video/image share)
  mediaType: string;
  startFrame: number;
  durationFrames: number;
  trimStartFrame: number;
  trimEndFrame: number;
  speed: number;
  volume: number;
  opacity: number;
  name?: string;
  textContent?: string;
  textStyle?: unknown;
  styleRanges?: unknown;
  transform?: unknown;
}

interface TemplateTrack {
  type: string;
  muted: boolean;
  hidden: boolean;
  clips: TemplateClip[];
}

interface Template {
  name: string;
  format: { fps: number; width: number; height: number };
  tracks: TemplateTrack[];
  visualSlots: number; // how many video/image assets it expects
  audioSlots: number; // how many audio assets it expects
}

function safeName(name: string): string {
  return name.replace(/[^\p{L}\p{N} _-]/gu, "").trim().replace(/\s+/g, "-").slice(0, 60) || "template";
}

export async function saveTemplate(doc: EditorDocument, rawName: string): Promise<{ name: string; path: string; visualSlots: number; audioSlots: number }> {
  await mkdir(TEMPLATES_DIR, { recursive: true });
  const tl = doc.timeline;
  let visual = 0;
  let audio = 0;
  const tracks: TemplateTrack[] = tl.tracks.map((t) => ({
    type: t.type,
    muted: t.muted,
    hidden: t.hidden,
    clips: t.clips.map((c): TemplateClip => {
      const base: TemplateClip = {
        mediaType: c.mediaType,
        startFrame: c.startFrame,
        durationFrames: c.durationFrames,
        trimStartFrame: c.trimStartFrame,
        trimEndFrame: c.trimEndFrame,
        speed: c.speed,
        volume: c.volume,
        opacity: c.opacity,
        name: c.name,
        textContent: c.textContent,
        textStyle: c.textStyle,
        styleRanges: c.styleRanges,
        transform: c.transform,
      };
      // Media clips (not pure text/adjustment) become fillable slots, numbered per kind.
      if (c.mediaRef && c.mediaType !== "text" && c.mediaType !== "adjustment") {
        if (c.mediaType === "audio") base.slot = audio++;
        else base.slot = visual++;
      }
      return base;
    }),
  }));
  const tpl: Template = {
    name: rawName,
    format: { fps: tl.fps, width: tl.width, height: tl.height },
    tracks,
    visualSlots: visual,
    audioSlots: audio,
  };
  const file = join(TEMPLATES_DIR, `${safeName(rawName)}.json`);
  await writeFile(file, JSON.stringify(tpl, null, 2), "utf8");
  return { name: rawName, path: file, visualSlots: visual, audioSlots: audio };
}

export async function listTemplates(): Promise<{ name: string; visualSlots: number; audioSlots: number }[]> {
  try {
    const files = (await readdir(TEMPLATES_DIR)).filter((f) => f.endsWith(".json"));
    const out: { name: string; visualSlots: number; audioSlots: number }[] = [];
    for (const f of files) {
      try {
        const tpl = JSON.parse(await readFile(join(TEMPLATES_DIR, f), "utf8")) as Template;
        out.push({ name: tpl.name, visualSlots: tpl.visualSlots ?? 0, audioSlots: tpl.audioSlots ?? 0 });
      } catch {
        /* skip malformed */
      }
    }
    return out;
  } catch {
    return [];
  }
}

async function readTemplate(name: string): Promise<Template | null> {
  const direct = join(TEMPLATES_DIR, `${safeName(name)}.json`);
  try {
    return JSON.parse(await readFile(direct, "utf8")) as Template;
  } catch {
    // fall back to a case-insensitive name match
    try {
      const files = (await readdir(TEMPLATES_DIR)).filter((f) => f.endsWith(".json"));
      for (const f of files) {
        const tpl = JSON.parse(await readFile(join(TEMPLATES_DIR, f), "utf8")) as Template;
        if (tpl.name.toLowerCase() === name.toLowerCase()) return tpl;
      }
    } catch {
      /* none */
    }
    return null;
  }
}

export interface ApplyResult {
  name: string;
  visualUsed: number;
  audioUsed: number;
  visualSlots: number;
  audioSlots: number;
  emptySlots: number;
}

/** Rebuild the timeline from a template, filling slots from ordered media (or the library by type).
 * Missing fills leave a placeholder clip (empty mediaRef of the right type) so the layout stays intact. */
export async function applyTemplate(
  doc: EditorDocument,
  name: string,
  fill: { visual: string[]; audio: string[] },
  source: "user" | "agent",
): Promise<ApplyResult> {
  const tpl = await readTemplate(name);
  if (!tpl) throw new Error(`Template not found: ${name}`);

  const resolve = (ref: string): MediaAsset | null => doc.asset(ref) ?? doc.project.media.find((m) => m.name === ref) ?? null;
  const visualIds = fill.visual.map(resolve).filter((a): a is MediaAsset => !!a).map((a) => a.id);
  const audioIds = fill.audio.map(resolve).filter((a): a is MediaAsset => !!a).map((a) => a.id);

  let visualUsed = 0;
  let audioUsed = 0;
  let emptySlots = 0;

  doc.mutate("Apply Template", source, () => {
    doc.timeline.fps = tpl.format.fps;
    doc.timeline.width = tpl.format.width;
    doc.timeline.height = tpl.format.height;
    doc.timeline.settingsConfigured = true;
    doc.timeline.tracks = tpl.tracks.map((tt) => {
      const track = makeTrack(tt.type as Clip["mediaType"], { muted: tt.muted, hidden: tt.hidden });
      track.clips = tt.clips.map((tc) => {
        let mediaRef = "";
        if (tc.slot !== undefined) {
          if (tc.mediaType === "audio") mediaRef = audioIds[tc.slot] ?? "";
          else mediaRef = visualIds[tc.slot] ?? "";
          if (mediaRef) {
            if (tc.mediaType === "audio") audioUsed++;
            else visualUsed++;
          } else {
            emptySlots++;
          }
        }
        return makeClip({
          mediaRef,
          mediaType: tc.mediaType as Clip["mediaType"],
          startFrame: tc.startFrame,
          durationFrames: tc.durationFrames,
          trimStartFrame: tc.trimStartFrame,
          trimEndFrame: tc.trimEndFrame,
          speed: tc.speed,
          volume: tc.volume,
          opacity: tc.opacity,
          name: tc.name,
          textContent: tc.textContent,
          textStyle: tc.textStyle as Clip["textStyle"],
          styleRanges: tc.styleRanges as Clip["styleRanges"],
          transform: tc.transform as Clip["transform"],
          id: newId("clip"),
        });
      });
      return track;
    });
  });

  return {
    name: tpl.name,
    visualUsed,
    audioUsed,
    visualSlots: tpl.visualSlots,
    audioSlots: tpl.audioSlots,
    emptySlots,
  };
}
