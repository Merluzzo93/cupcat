// auto_pan — the pass that finds where everybody is and renders the placed mix.
//
// panplan.ts holds the decisions and their tests; this holds the two expensive parts: looking at the
// picture to find each speaker's face, and the ffmpeg graph that applies the result.
//
// The output is a NEW file with the picture stream copied and only the sound rebuilt, the same
// contract as the other repair tools. Copying the picture matters: re-encoding an hour of video to
// change its stereo image would be an absurd price, and it would also cost a generation of quality
// for a change that never touched a pixel.

import { join } from "node:path";
import { mkdir } from "node:fs/promises";
import { exportsDir, FFMPEG_BIN } from "./config";
import { probeMedia, withTranscodeSlot } from "./ffmpeg";
import { gainExpression, gainPoints, panForX, type PanSegment, planPan, positionsFrom, reliablePositions, type ScreenPosition } from "./panplan";
import { run } from "./proc";
import { whoIsSpeaking } from "./speaking";

export interface AutoPanOptions {
  strength?: number;
  deadZone?: number;
  rampSeconds?: number;
  minTurnSeconds?: number;
  minSilenceSeconds?: number;
  /** How many turns per speaker to look at (default 5). More is steadier and slower. */
  looksPerSpeaker?: number;
  /** Usable looks a position must rest on before it is acted on (default 3). */
  minLooks?: number;
  /** How far the looks may disagree, as a fraction of frame width (default 0.12). */
  maxSpread?: number;
  onProgress?: (text: string) => void;
}

export interface AutoPanResult {
  file: string;
  positions: ScreenPosition[];
  /** Speakers whose position was not solid enough to act on — left centred, and named. */
  leftCentred: { speaker: string; why: string }[];
  segments: PanSegment[];
  /** Turns where the picture could not say who was talking, and why. */
  unresolved: string[];
}

const stamp = () => new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
const baseName = (p: string) => p.replace(/\\/g, "/").split("/").pop()?.replace(/\.[^.]+$/, "") ?? "clip";

/**
 * Where each speaker stands, by looking at a few of their turns.
 *
 * Their LONGEST turns, spread across the recording: a long turn gives the mouth-motion pass enough
 * movement to be sure, and spreading the looks means somebody who changes seat halfway through is
 * measured on both halves rather than only on the first.
 */
export async function findPositions(
  src: string,
  turns: { speaker: string; startSeconds: number; endSeconds: number }[],
  looksPerSpeaker: number,
  onProgress?: (t: string) => void,
): Promise<{ positions: ScreenPosition[]; unresolved: string[] }> {
  const bySpeaker = new Map<string, typeof turns>();
  for (const t of turns) {
    if (!bySpeaker.has(t.speaker)) bySpeaker.set(t.speaker, []);
    bySpeaker.get(t.speaker)!.push(t);
  }
  const samples: { speaker: string; x: number }[] = [];
  const unresolved: string[] = [];
  for (const [speaker, list] of bySpeaker) {
    const longest = [...list].sort((a, b) => b.endSeconds - b.startSeconds - (a.endSeconds - a.startSeconds)).slice(0, Math.max(1, looksPerSpeaker * 2));
    const spread = [...longest].sort((a, b) => a.startSeconds - b.startSeconds);
    const step = Math.max(1, Math.floor(spread.length / Math.max(1, looksPerSpeaker)));
    const chosen = spread.filter((_, i) => i % step === 0).slice(0, Math.max(1, looksPerSpeaker));
    for (const t of chosen) {
      const dur = Math.min(6, t.endSeconds - t.startSeconds);
      if (dur < 0.5) continue;
      onProgress?.(`Looking for ${speaker} at ${t.startSeconds.toFixed(1)}s…`);
      const who = await whoIsSpeaking(src, t.startSeconds, dur);
      if (who.ok) samples.push({ speaker, x: who.face.x + who.face.w / 2 });
      else unresolved.push(`${speaker} at ${t.startSeconds.toFixed(1)}s: ${who.why}`);
    }
  }
  return { positions: positionsFrom(samples), unresolved };
}

/**
 * Render the placed mix.
 *
 * The source is folded to mono first and then re-spread. Panning a stereo recording by turning its
 * existing channels down would fight whatever image it already has — a camera's built-in stereo mic
 * has one, and it is not the one being asked for. Starting from mono means the result has exactly
 * the placement that was asked for and nothing else.
 */
export async function renderPan(src: string, segments: PanSegment[], rampSeconds: number, hasVideo: boolean, onProgress?: (t: string) => void): Promise<string> {
  await mkdir(exportsDir, { recursive: true });
  const out = join(exportsDir, `${baseName(src)}-panned-${stamp()}.${hasVideo ? "mp4" : "m4a"}`);
  const left = gainExpression(gainPoints(segments, "left", rampSeconds));
  const right = gainExpression(gainPoints(segments, "right", rampSeconds));
  // eval=frame: without it `volume` reads its expression once at startup and the whole render comes
  // out at the opening pan — a silent failure that produces a perfectly valid, perfectly wrong file.
  const filter = [
    `[0:a]aformat=channel_layouts=mono,asplit=2[ml][mr]`,
    `[ml]volume=volume='${left}':eval=frame[l]`,
    `[mr]volume=volume='${right}':eval=frame[r]`,
    `[l][r]amerge=inputs=2,aformat=channel_layouts=stereo[a]`,
  ].join(";");
  const args = ["-y", "-v", "error", "-i", src, "-filter_complex", filter, "-map", "[a]"];
  if (hasVideo) args.push("-map", "0:v:0", "-c:v", "copy");
  args.push("-c:a", "aac", "-b:a", "256k", "-movflags", "+faststart", out);
  onProgress?.("Rendering the placed mix…");
  const r = await withTranscodeSlot(() => run(FFMPEG_BIN, args));
  if (r.code !== 0 || !(await Bun.file(out).exists())) {
    throw new Error(`ffmpeg could not render the panned audio: ${r.stderr.split("\n").slice(-4).join(" ")}`);
  }
  return out;
}

export async function autoPan(
  src: string,
  turns: { speaker: string; startSeconds: number; endSeconds: number }[],
  opts: AutoPanOptions = {},
): Promise<AutoPanResult> {
  const probe = await probeMedia(src);
  const dur = probe.durationSeconds || 0;
  if (dur <= 0) throw new Error("Could not read the file's duration.");
  if (turns.length === 0) throw new Error("There are no speaker turns to place — run identify_speakers first.");

  const { positions, unresolved } = await findPositions(src, turns, Math.max(1, Math.round(opts.looksPerSpeaker ?? 5)), opts.onProgress);
  if (positions.length === 0) {
    throw new Error(
      `The picture never said who was talking, so there is nothing to place. ${unresolved.slice(0, 3).join("; ")}. This needs faces visible on screen — for an off-camera voice or a screen recording there is no position to pan to.`,
    );
  }
  const { kept, rejected } = reliablePositions(positions, { minLooks: opts.minLooks, maxSpread: opts.maxSpread });
  if (kept.length === 0) {
    throw new Error(
      `Nobody could be placed with confidence. ${rejected.map((r) => `${r.speaker}: ${r.why}`).join("; ")}. ` +
        "This usually means a crowded or moving shot, where the face detector finds bystanders and the mouth-motion pass cannot pick a winner. Raise looksPerSpeaker, or place the sound by hand.",
    );
  }

  const segments = planPan(turns, kept, {
    startSeconds: 0,
    endSeconds: dur,
    strength: opts.strength,
    deadZone: opts.deadZone,
    minTurnSeconds: opts.minTurnSeconds,
    minSilenceSeconds: opts.minSilenceSeconds,
  });
  // Refuse a placement too small to hear. A pan of a few percent is a fraction of a decibel of
  // imbalance; rendering a copy of an hour-long file for that wastes the user's disk and their time
  // and leaves them wondering whether it worked.
  const strongest = Math.max(...segments.map((s) => Math.abs(s.pan)));
  if (strongest < 0.05) {
    throw new Error(
      `Everybody placed sits too near the centre of frame for the difference to be audible (the widest placement is ${(strongest * 100).toFixed(0)}%). ` +
        `Positions: ${kept.map((p) => `${p.speaker} at ${(p.x * 100).toFixed(0)}% across the frame`).join(", ")}. ` +
        "Raise strength, or accept that in this shot everyone is standing in the middle.",
    );
  }

  const file = await renderPan(src, segments, Math.max(0.01, opts.rampSeconds ?? 0.12), (probe.width ?? 0) > 0, opts.onProgress);
  return { file, positions: kept, leftCentred: rejected, segments, unresolved };
}

/** For reporting: what each measured position became, before any of it is rendered. */
export function describePositions(positions: ScreenPosition[], strength: number, deadZone: number): string {
  return positions
    .map((p) => {
      const pan = panForX(p.x, strength, deadZone);
      const side = pan === 0 ? "centre" : pan < 0 ? `${Math.round(-pan * 100)}% left` : `${Math.round(pan * 100)}% right`;
      return `${p.speaker}: ${(p.x * 100).toFixed(0)}% across the frame → ${side} (from ${p.samples} look${p.samples === 1 ? "" : "s"})`;
    })
    .join("; ");
}
