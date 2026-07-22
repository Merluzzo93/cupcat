// Intros and outros: a short block dropped at the head or the tail of the timeline.
//
// They are built out of pieces CupCat already has — a colour matte, text, an image — rather than
// being video files, so they inherit the project's resolution, stay editable afterwards, and cost
// nothing to store. The starters ship WITH the app so an update refreshes them; anything the user
// saves lives in the brand kit, outside the install folder, so an update cannot touch it.

export type OpenerKind = "intro" | "outro";

export interface OpenerDef {
  id: string;
  kind: OpenerKind;
  /** Shown in the picker. Kept plain: it is a description, not a brand name to decode. */
  label: string;
  defaultSeconds: number;
  /** Needs a logo in the brand kit; offered but flagged when there isn't one. */
  wantsLogo: boolean;
}

export const OPENERS: OpenerDef[] = [
  { id: "title-card", kind: "intro", label: "Title card", defaultSeconds: 3, wantsLogo: false },
  { id: "logo-open", kind: "intro", label: "Logo open", defaultSeconds: 2.5, wantsLogo: true },
  { id: "title-over", kind: "intro", label: "Title over the first shot", defaultSeconds: 3, wantsLogo: false },
  { id: "end-card", kind: "outro", label: "End card", defaultSeconds: 4, wantsLogo: true },
  { id: "credits", kind: "outro", label: "Credits", defaultSeconds: 5, wantsLogo: false },
];

export interface BrandKit {
  /** Background for full-frame cards. */
  background: string;
  /** Text and rules. */
  accent: string;
  /** Library asset id of the logo, when one has been chosen. */
  logoRef?: string;
  fontName?: string;
}

export const DEFAULT_BRAND: BrandKit = { background: "#0B0B0C", accent: "#FFFFFF" };

/** One piece of the block, in the order it should be created (back to front). */
export type Layer =
  | { type: "matte"; color: string }
  | { type: "text"; content: string; fontSize: number; color: string; alignment: string; yFraction: number }
  | { type: "image"; mediaRef: string; scale: number };

export interface OpenerOptions {
  title?: string;
  subtitle?: string;
  brand: BrandKit;
}

/**
 * What to put on the timeline for a given starter.
 *
 * Returns layers rather than performing edits so the arithmetic (which layer, what size, what
 * colour) can be checked without a document — and so a starter that asks for a logo the user has
 * not set degrades to its text instead of failing or drawing a broken image.
 */
export function planOpener(def: OpenerDef, opts: OpenerOptions): Layer[] {
  const { brand } = opts;
  const title = opts.title?.trim() || (def.kind === "intro" ? "Your title" : "Thanks for watching");
  const layers: Layer[] = [];
  const full = def.id !== "title-over"; // "title over" sits on top of the picture, so no backdrop

  if (full) layers.push({ type: "matte", color: brand.background });
  if (def.wantsLogo && brand.logoRef) layers.push({ type: "image", mediaRef: brand.logoRef, scale: 0.3 });

  const heading = def.wantsLogo && brand.logoRef ? 0.68 : 0.44;
  layers.push({ type: "text", content: title, fontSize: full ? 84 : 64, color: brand.accent, alignment: "center", yFraction: heading });
  if (opts.subtitle?.trim()) {
    layers.push({ type: "text", content: opts.subtitle.trim(), fontSize: 38, color: brand.accent, alignment: "center", yFraction: heading + 0.12 });
  }
  return layers;
}

/**
 * Moving everything right to make room for an intro.
 *
 * An intro that overlaps the first shot is not an intro, so the whole timeline shifts — every track,
 * including audio, by the same amount. Moving in descending start order matters: shifting a clip
 * onto ground still occupied by its neighbour is what the placement logic treats as an overwrite.
 */
export function rippleRight(
  clips: { id: string; trackIndex: number; startFrame: number }[],
  byFrames: number,
): { clipId: string; toTrack: number; toFrame: number }[] {
  if (byFrames <= 0) return [];
  return [...clips]
    .sort((a, b) => b.startFrame - a.startFrame)
    .map((c) => ({ clipId: c.id, toTrack: c.trackIndex, toFrame: c.startFrame + byFrames }));
}

/** Starters of one kind, for the picker. */
export function openersOfKind(kind: OpenerKind): OpenerDef[] {
  return OPENERS.filter((o) => o.kind === kind);
}
