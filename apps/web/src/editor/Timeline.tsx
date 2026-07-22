import type React from "react";
import { t } from "./i18n";
import { useCallback, useEffect, useRef, useState } from "react";
import type { Clip } from "@cupcat/editor-core";
import { isCompatible, timelineTotalFrames } from "@cupcat/editor-core";
import { TRACK_COLORS } from "./format";
import { marqueeHitIds, nextClipSelection } from "./timelineSelection";
import {
  BRIDGE_HTTP,
  copyClips,
  cutClips,
  deleteSelected,
  duplicateSelected,
  mcpCall,
  mediaUrl,
  pasteClips,
  sendCommand,
  setTrackProps,
  soloTrack,
  trimClipEdge,
  ui,
  useEditor,
} from "./store";

const RULER_H = 26;
const TRACK_H = 48;
const HEADER_W = 96; // fits the color strip + label row + button row

/** HH:MM:SS:FF ruler label (frames always :00 at whole-second ticks). */
function tcLabel(sec: number): string {
  const p = (n: number) => String(n).padStart(2, "0");
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  return `${p(h)}:${p(m)}:${p(s)}:00`;
}

type DragMode = "move" | "trim-r" | "trim-l";

interface DragState {
  clipId: string;
  mode: DragMode;
  deltaFrames: number;
  targetTrackIndex: number | null; // cross-track target (null = same track)
}

interface MarqueeState {
  startX: number; // clientX at start
  startY: number; // clientY relative to tracks-area top
  currentX: number;
  currentY: number;
}

interface ContextMenu {
  x: number;
  y: number;
  clipId: string | null; // null = empty area
}

// ── Speaker turns ────────────────────────────────────────────────────────────
export interface SpeakerTurn {
  speaker: string;
  startSeconds: number;
  endSeconds: number;
}
type SpeakerMap = Record<string, { speakerCount: number; turns: SpeakerTurn[] }>;

/** A stable colour per speaker label, so S2 is the same colour on every clip and in every session.
 * Hand-picked rather than hashed: hashing gave neighbouring speakers near-identical hues, which is
 * precisely the thing this lane exists to make distinguishable at a glance. */
const SPEAKER_COLOURS = ["#38bdf8", "#f472b6", "#facc15", "#4ade80", "#c084fc", "#fb923c", "#2dd4bf", "#f87171"];
export function speakerColour(label: string, order: string[]): string {
  const i = order.indexOf(label);
  return SPEAKER_COLOURS[(i < 0 ? 0 : i) % SPEAKER_COLOURS.length]!;
}

/**
 * Turn source-time speaker turns into bars positioned INSIDE a clip, as fractions of its width.
 *
 * A clip shows a window of its source (trimStart..trimStart+visible) and can be sped up, so a turn
 * at source second 90 is not at timeline second 90. Turns outside the window are dropped and ones
 * straddling an edge are clipped, otherwise a trimmed clip would paint speaker bars for words that
 * were cut out of it.
 */
export function turnsToBars(
  turns: SpeakerTurn[],
  opts: { trimStartFrames: number; durationFrames: number; speed: number; fps: number },
): { speaker: string; left: number; width: number }[] {
  const { fps } = opts;
  const speed = opts.speed > 0 ? opts.speed : 1;
  const srcStart = opts.trimStartFrames / fps;
  const srcSpan = (opts.durationFrames * speed) / fps;
  if (srcSpan <= 0) return [];
  const out: { speaker: string; left: number; width: number }[] = [];
  for (const t of turns) {
    const a = Math.max(t.startSeconds, srcStart);
    const b = Math.min(t.endSeconds, srcStart + srcSpan);
    if (b <= a) continue;
    const left = (a - srcStart) / srcSpan;
    const width = (b - a) / srcSpan;
    if (width > 0.0005) out.push({ speaker: t.speaker, left, width });
  }
  return out;
}

// ── Deterministic waveform bars (visual affordance, not sample-accurate) ─────
function waveformBars(clipId: string, count: number): number[] {
  let seed = 0;
  for (let i = 0; i < clipId.length; i++) seed = (seed * 31 + clipId.charCodeAt(i)) >>> 0;
  const bars: number[] = [];
  for (let i = 0; i < count; i++) {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    bars.push(0.15 + ((seed >>> 16) / 65535) * 0.85);
  }
  return bars;
}

// ─────────────────────────────────────────────────────────────────────────────
// Timeline
// ─────────────────────────────────────────────────────────────────────────────

export function Timeline() {
  const { project, activeCompound, playhead, pxPerFrame, selectedClipIds, tool, snapping, rangeIn, rangeOut } = useEditor();

  const [drag, setDrag] = useState<DragState | null>(null);
  const [marquee, setMarquee] = useState<MarqueeState | null>(null);
  const headerColRef = useRef<HTMLDivElement>(null);
  const [trackDrag, setTrackDrag] = useState<{ from: number; over: number } | null>(null);
  const trackIndexAtY = (clientY: number): number => {
    const el = headerColRef.current;
    if (!el) return 0;
    const rel = clientY - el.getBoundingClientRect().top - RULER_H;
    return Math.max(0, Math.min(tracks.length - 1, Math.floor(rel / TRACK_H)));
  };
  const [contextMenu, setContextMenu] = useState<ContextMenu | null>(null);
  const [snapLineX, setSnapLineX] = useState<number | null>(null); // px from left edge
  const [waves, setWaves] = useState<Record<string, number[]>>({}); // real audio peaks by mediaRef
  const [speakers, setSpeakers] = useState<SpeakerMap>({}); // diarized turns by mediaRef

  const tracksAreaRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  const fps = project?.timeline.fps ?? 30;
  const tracks = project?.timeline.tracks ?? [];
  const total = project ? timelineTotalFrames(project.timeline) : 0;
  const contentFrames = Math.max(total + fps * 3, fps * 12);
  const width = contentFrames * pxPerFrame;
  const selected = new Set(selectedClipIds);
  const seconds = Math.ceil(contentFrames / fps);

  // Ruler tick spacing adapts to zoom: the smallest interval whose HH:MM:SS:FF labels stay
  // ≥76px apart gets labels + full-height lines; a finer interval gets short minor ticks.
  const secPx = fps * pxPerFrame;
  const labelEvery = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600].find((s) => s * secPx >= 76) ?? 900;
  const MINOR_STEP: Record<number, number> = { 1: 0, 2: 1, 5: 1, 10: 2, 15: 5, 30: 10, 60: 15, 120: 30, 300: 60, 600: 120, 900: 300 };
  const minorStep = MINOR_STEP[labelEvery] ?? 0;
  const majorTicks: number[] = [];
  for (let s = 0; s <= seconds; s += labelEvery) majorTicks.push(s);
  const minorTicks: number[] = [];
  if (minorStep > 0) for (let s = minorStep; s <= seconds; s += minorStep) if (s % labelEvery !== 0) minorTicks.push(s);

  // ── V1/V2… A1/A2… labels ─────────────────────────────────────────────────
  // NLE convention: video numbers grow UPWARD (bottom video track = V1, overlays V2+ above),
  // audio numbers grow downward (first audio row = A1).
  const videoIdxs = tracks.map((t, i) => (t.type === "video" ? i : -1)).filter((i) => i >= 0);
  const audioIdxs = tracks.map((t, i) => (t.type !== "video" ? i : -1)).filter((i) => i >= 0);
  const videoCounter: number[] = Array(tracks.length).fill(-1);
  const audioCounter: number[] = Array(tracks.length).fill(-1);
  videoIdxs.forEach((ti, k) => {
    videoCounter[ti] = videoIdxs.length - k;
  });
  audioIdxs.forEach((ti, k) => {
    audioCounter[ti] = k + 1;
  });

  // ── snapping ──────────────────────────────────────────────────────────────
  const trySnap = useCallback(
    // excludeIds: every clip taking part in the gesture — a group move must not snap
    // against edges that are themselves moving.
    (rawFrame: number, excludeIds?: ReadonlySet<string>): { frame: number; lineX: number | null } => {
      if (!snapping) return { frame: rawFrame, lineX: null };
      const SNAP_F = 8 / pxPerFrame;
      let best: number | null = null;
      let bestDist = SNAP_F + 1;

      const check = (f: number) => {
        const d = Math.abs(rawFrame - f);
        if (d < bestDist) { bestDist = d; best = f; }
      };

      check(playhead);
      for (const track of tracks) {
        for (const c of track.clips) {
          if (excludeIds?.has(c.id)) continue;
          check(c.startFrame);
          check(c.startFrame + c.durationFrames);
        }
      }

      if (best !== null) return { frame: best, lineX: best * pxPerFrame };
      return { frame: rawFrame, lineX: null };
    },
    [snapping, pxPerFrame, playhead, tracks]
  );

  // ── drag a library asset onto the timeline → add_clips at the dropped track + frame ──
  const dropAsset = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    const id = e.dataTransfer.getData("application/x-cupcat-asset") || e.dataTransfer.getData("text/plain");
    const asset = project?.media.find((m) => m.id === id);
    if (!asset || asset.generationStatus.kind !== "none") return;
    const area = tracksAreaRef.current?.getBoundingClientRect();
    if (!area) return;
    const raw = Math.max(0, Math.round((e.clientX - area.left) / pxPerFrame));
    const startFrame = Math.max(0, trySnap(raw).frame);
    const tIdx = Math.floor((e.clientY - area.top) / TRACK_H);
    const durationFrames = asset.type === "image" ? fps * 5 : Math.max(1, Math.round((asset.durationSeconds || 5) * fps));
    const entry: Record<string, unknown> = { mediaRef: asset.id, startFrame, durationFrames };
    const target = tracks[tIdx];
    if (target && isCompatible(asset.type, target.type)) entry.trackIndex = tIdx;
    sendCommand("add_clips", { entries: [entry] });
  };

  // Speaker turns for every asset that has been through Find speakers. One request for the whole
  // project (the endpoint reads a cache and never starts a run), refreshed whenever the media list
  // changes — which is also when a diarization that just finished becomes visible.
  useEffect(() => {
    fetch(`${BRIDGE_HTTP}/speakers`)
      .then((r) => r.json())
      .then((j) => setSpeakers(j?.assets && typeof j.assets === "object" ? (j.assets as SpeakerMap) : {}))
      .catch(() => {});
  }, [project?.media]);

  // Fetch real sample-derived waveform peaks for each audio clip's asset (cached by mediaRef).
  useEffect(() => {
    for (const t of tracks) {
      for (const c of t.clips) {
        if (c.mediaType !== "audio" || !c.mediaRef || waves[c.mediaRef] !== undefined) continue;
        const ref = c.mediaRef;
        setWaves((p) => ({ ...p, [ref]: [] })); // mark in-flight to avoid duplicate fetches
        fetch(`${BRIDGE_HTTP}/waveform/${encodeURIComponent(ref)}?n=140`)
          .then((r) => r.json())
          .then((j) => setWaves((p) => ({ ...p, [ref]: Array.isArray(j.peaks) ? j.peaks : [] })))
          .catch(() => {});
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tracks]);

  // ── ruler scrub ───────────────────────────────────────────────────────────
  const scrub = (e: React.PointerEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const toFrame = (clientX: number) => Math.max(0, (clientX - rect.left) / pxPerFrame);
    ui.setPlayhead(toFrame(e.clientX));
    const onMove = (ev: PointerEvent) => ui.setPlayhead(toFrame(ev.clientX));
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

  const nameFor = (c: Clip) =>
    c.compoundId
      ? `▣ ${(c.name ?? "Compound").slice(0, 18)}` // nested sequence — double-click to open it
      : c.mediaType === "text"
        ? `"${(c.textContent ?? "").slice(0, 18)}"`
        : c.mediaType === "adjustment"
          ? `ADJ${c.name ? ` · ${c.name.slice(0, 16)}` : ""}` // no media asset to name it — badge it instead
          : project?.media.find((m) => m.id === c.mediaRef)?.name ?? c.mediaType;

  // ── drag (move / trim-l / trim-r) ────────────────────────────────────────
  const beginDrag = (mode: DragMode, c: Clip, trackIndex: number, e: React.PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();

    const additive = e.metaKey || e.ctrlKey;
    const range = e.shiftKey && !additive;
    const wasSelected = selectedClipIds.includes(c.id);

    // The selection this gesture acts on, computed synchronously — the store update only lands
    // on the next render, so the drag closures must not read selectedClipIds back from state.
    let dragSelection: string[];
    if (mode === "move") {
      dragSelection = nextClipSelection({
        current: selectedClipIds,
        clickedId: c.id,
        additive,
        range,
        trackClips: tracks[trackIndex]?.clips ?? [],
      });
      ui.selectClips(dragSelection);
      // A Ctrl/Cmd-click that DEselected the clip is a pure selection edit — nothing to drag.
      if (!dragSelection.includes(c.id)) return;
    } else {
      dragSelection = [c.id];
      ui.select([c.id]);
    }

    const startX = e.clientX;
    const ppf = pxPerFrame;
    const origDur = c.durationFrames;

    // Snapshot the selected clips for the group move. Locked tracks never move, even when their
    // clips end up in the selection (e.g. via marquee) — matching the per-clip drag guard.
    const buildMulti = (): { id: string; startFrame: number; trackIndex: number }[] => {
      const ids = new Set(dragSelection);
      const result: { id: string; startFrame: number; trackIndex: number }[] = [];
      tracks.forEach((tr, ti) => {
        if (tr.locked) return;
        for (const clip of tr.clips) {
          if (ids.has(clip.id)) result.push({ id: clip.id, startFrame: clip.startFrame, trackIndex: ti });
        }
      });
      return result;
    };
    const multiClips = mode === "move" ? buildMulti() : [];
    // Snap reference = the clip under the pointer; exclusions = everything that moves with it.
    const excludeIds = new Set(mode === "move" ? multiClips.map((m) => m.id) : [c.id]);

    const resolveTargetTrack = (clientY: number): number | null => {
      if (!tracksAreaRef.current) return null;
      const areaRect = tracksAreaRef.current.getBoundingClientRect();
      const relY = clientY - areaRect.top;
      const hovTi = Math.floor(relY / TRACK_H);
      if (hovTi >= 0 && hovTi < tracks.length && hovTi !== trackIndex) {
        if (isCompatible(tracks[hovTi].type, tracks[trackIndex].type)) return hovTi;
      }
      return null;
    };

    const onMove = (ev: PointerEvent) => {
      const rawDf = Math.round((ev.clientX - startX) / ppf);

      if (mode === "move") {
        // Snap the DRAGGED clip's start; the same delta then applies to the whole group.
        const { frame: snapped, lineX } = trySnap(c.startFrame + rawDf, excludeIds);
        const snappedDf = snapped - c.startFrame;
        setSnapLineX(lineX);
        setDrag({ clipId: c.id, mode, deltaFrames: snappedDf, targetTrackIndex: resolveTargetTrack(ev.clientY) });
      } else if (mode === "trim-r") {
        const rawEnd = c.startFrame + origDur + rawDf;
        const { frame: snapped, lineX } = trySnap(rawEnd, excludeIds);
        const snappedDf = snapped - (c.startFrame + origDur);
        setSnapLineX(lineX);
        setDrag({ clipId: c.id, mode, deltaFrames: snappedDf, targetTrackIndex: null });
      } else {
        // trim-l
        const { frame: snapped, lineX } = trySnap(c.startFrame + rawDf, excludeIds);
        const snappedDf = snapped - c.startFrame;
        setSnapLineX(lineX);
        setDrag({ clipId: c.id, mode, deltaFrames: snappedDf, targetTrackIndex: null });
      }
    };

    const onUp = (ev: PointerEvent) => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      setDrag(null);
      setSnapLineX(null);

      const rawDf = Math.round((ev.clientX - startX) / ppf);

      if (mode === "move") {
        const { frame: snapped } = trySnap(c.startFrame + rawDf, excludeIds);
        const snappedDf = snapped - c.startFrame;
        const targetTi = resolveTargetTrack(ev.clientY);

        // GROUP MOVE: one move_clips call with the same frame delta for every selected clip.
        // Only the clip under the pointer changes track — shifting a whole selection across
        // heterogeneous tracks has no well-defined mapping.
        const moves = multiClips.map((mc) => {
          const toFrame = Math.max(0, mc.startFrame + snappedDf);
          const entry: Record<string, unknown> = { clipId: mc.id, toFrame };
          if (targetTi !== null && mc.id === c.id) entry.toTrack = targetTi;
          return entry;
        });
        const hasChange = moves.some((m, idx) => {
          const mc = multiClips[idx];
          return (m.toFrame as number) !== mc.startFrame || m.toTrack !== undefined;
        });
        if (hasChange) {
          sendCommand("move_clips", { moves });
        } else if (!additive && !range && wasSelected && dragSelection.length > 1) {
          // A plain click (no movement) on a clip inside a multi-selection collapses to that
          // clip — the standard way out of a group selection (kept until now so the drag could
          // move the whole group).
          ui.select([c.id]);
        }
      } else if (mode === "trim-r") {
        const { frame: snapped } = trySnap(c.startFrame + origDur + rawDf, excludeIds);
        const snappedDf = snapped - (c.startFrame + origDur);
        // drag right = extend = negative deltaFrames for trimClipEdge "right". Shift = ripple trim.
        if (snappedDf !== 0) trimClipEdge(c.id, "right", -snappedDf, ev.shiftKey);
      } else {
        // trim-l: drag right = positive = trim into clip from left. Shift = ripple trim.
        const { frame: snapped } = trySnap(c.startFrame + rawDf, excludeIds);
        const snappedDf = snapped - c.startFrame;
        if (snappedDf !== 0) trimClipEdge(c.id, "left", snappedDf, ev.shiftKey);
      }
    };

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

  // ── blade ─────────────────────────────────────────────────────────────────
  const bladeClick = (c: Clip, e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    const rect = e.currentTarget.getBoundingClientRect();
    const relFrame = Math.round((e.clientX - rect.left) / pxPerFrame);
    const atFrame = Math.max(c.startFrame + 1, Math.min(c.startFrame + relFrame, c.startFrame + c.durationFrames - 1));
    sendCommand("split_clip", { clipId: c.id, atFrame });
  };

  // ── marquee ───────────────────────────────────────────────────────────────
  const beginMarquee = (e: React.PointerEvent<HTMLDivElement>) => {
    if (tool !== "select") return;
    e.preventDefault();
    const areaTop = tracksAreaRef.current?.getBoundingClientRect().top ?? 0;
    const startX = e.clientX;
    const startY = e.clientY - areaTop;
    setMarquee({ startX, startY, currentX: startX, currentY: startY });

    const onMove = (ev: PointerEvent) => {
      setMarquee({ startX, startY, currentX: ev.clientX, currentY: ev.clientY - areaTop });
    };

    const onUp = (ev: PointerEvent) => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      setMarquee(null);

      // getBoundingClientRect().left already reflects the container's horizontal scroll, so
      // clientX − areaLeft IS the content-relative x. The old formula added scrollLeft on top,
      // shifting both the band and the hit-test right by exactly the scrolled amount.
      const areaLeft = tracksAreaRef.current?.getBoundingClientRect().left ?? 0;

      // Convert the pixel rect to frames (x) + tracks-area px (y); the hit-test itself is pure
      // and unit-tested (timelineSelection.ts). An empty rect selects nothing → click-empty clears.
      const x1 = (Math.min(startX, ev.clientX) - areaLeft) / pxPerFrame;
      const x2 = (Math.max(startX, ev.clientX) - areaLeft) / pxPerFrame;
      const y1 = Math.min(startY, ev.clientY - areaTop);
      const y2 = Math.max(startY, ev.clientY - areaTop);
      ui.selectClips(marqueeHitIds(tracks, { x1, x2, y1, y2 }, TRACK_H));
    };

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

  // ── context menu ──────────────────────────────────────────────────────────
  const openCtx = (e: React.MouseEvent, clipId: string | null) => {
    e.preventDefault();
    e.stopPropagation();
    setContextMenu({ x: e.clientX, y: e.clientY, clipId });
  };
  const closeCtx = useCallback(() => setContextMenu(null), []);

  useEffect(() => {
    if (!contextMenu) return;
    const dismiss = (e: Event) => {
      if (e instanceof KeyboardEvent && e.key !== "Escape") return;
      closeCtx();
    };
    window.addEventListener("mousedown", dismiss);
    window.addEventListener("keydown", dismiss);
    return () => {
      window.removeEventListener("mousedown", dismiss);
      window.removeEventListener("keydown", dismiss);
    };
  }, [contextMenu, closeCtx]);

  const findClip = (clipId: string): Clip | null => {
    for (const tr of tracks) {
      const c = tr.clips.find((x) => x.id === clipId);
      if (c) return c;
    }
    return null;
  };

  // ── display frames during drag ────────────────────────────────────────────
  const getDisplay = (c: Clip, onLockedTrack: boolean): { startF: number; durF: number; active: boolean } => {
    if (!drag) return { startF: c.startFrame, durF: c.durationFrames, active: false };

    // Selected clips on locked tracks are excluded from the group move — don't preview them moving.
    if (drag.mode === "move" && selected.has(c.id) && !onLockedTrack) {
      return { startF: Math.max(0, c.startFrame + drag.deltaFrames), durF: c.durationFrames, active: true };
    }
    if (drag.clipId === c.id) {
      if (drag.mode === "trim-r") {
        return { startF: c.startFrame, durF: Math.max(1, c.durationFrames + drag.deltaFrames), active: true };
      }
      if (drag.mode === "trim-l") {
        return {
          startF: c.startFrame + drag.deltaFrames,
          durF: Math.max(1, c.durationFrames - drag.deltaFrames),
          active: true,
        };
      }
    }
    return { startF: c.startFrame, durF: c.durationFrames, active: false };
  };

  // ── marquee rect style ────────────────────────────────────────────────────
  const getMarqueeStyle = (): React.CSSProperties | null => {
    if (!marquee || !tracksAreaRef.current) return null;
    // clientX − rect.left is already content-relative (the rect moves with the scroll) — adding
    // scrollLeft drew the band exactly scrollLeft px right of the pointer when scrolled.
    const areaRect = tracksAreaRef.current.getBoundingClientRect();
    const x1 = Math.min(marquee.startX, marquee.currentX) - areaRect.left;
    const x2 = Math.max(marquee.startX, marquee.currentX) - areaRect.left;
    const y1 = Math.min(marquee.startY, marquee.currentY);
    const y2 = Math.max(marquee.startY, marquee.currentY);
    return { left: x1, top: y1, width: x2 - x1, height: y2 - y1, position: "absolute", pointerEvents: "none", zIndex: 30 };
  };

  const marqueeStyle = getMarqueeStyle();
  const targetLane = drag?.mode === "move" ? drag.targetTrackIndex : null;

  return (
    <div className="flex h-64 shrink-0 flex-col border-t border-neutral-800 bg-neutral-900/40">
      {/* Breadcrumb while a nested sequence is open — the tracks below ARE its sub-timeline. */}
      {activeCompound && (
        <div className="flex items-center gap-2 border-b border-indigo-500/40 bg-indigo-950/60 px-2 py-1 text-[11px] text-indigo-200">
          <button
            type="button"
            onClick={() => sendCommand("close_compound", {})}
            className="rounded px-1.5 py-0.5 font-medium hover:bg-indigo-500/20"
            title={t("tl.closeCompound")}
          >
            ◀ Torna alla timeline principale
          </button>
          <span className="text-indigo-400">·</span>
          <span className="truncate font-medium">▣ {activeCompound.name}</span>
        </div>
      )}
      {/* Palmier-style timeline toolbar: undo/redo · tools · snapping — zoom slider at the right */}
      <div className="flex h-8 shrink-0 items-center gap-0.5 border-b border-neutral-800 bg-neutral-900/80 px-2">
        <TbBtn title={t("tl.undo")} onClick={() => sendCommand("undo", {})}>
          <svg {...iconProps} width={13} height={13}>
            <path d="M9 14 4 9l5-5" />
            <path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11" />
          </svg>
        </TbBtn>
        <TbBtn title={t("tl.redo")} onClick={() => sendCommand("redo", {})}>
          <svg {...iconProps} width={13} height={13}>
            <path d="m15 14 5-5-5-5" />
            <path d="M20 9H9.5a5.5 5.5 0 0 0 0 11H13" />
          </svg>
        </TbBtn>
        <span className="mx-1 h-4 w-px bg-neutral-800" />
        <TbBtn title={t("tl.selectTool")} active={tool === "select"} onClick={() => ui.setTool("select")}>
          <svg {...iconProps} width={13} height={13} fill="currentColor" strokeWidth={1}>
            <path d="M5 3l7.5 13 2-5.5L20 8.5 5 3Z" />
          </svg>
        </TbBtn>
        <TbBtn title={t("tl.bladeTool")} active={tool === "blade"} onClick={() => ui.setTool("blade")}>
          <svg {...iconProps} width={13} height={13}>
            <circle cx="6" cy="6" r="2.6" />
            <circle cx="6" cy="18" r="2.6" />
            <path d="M8.2 7.6 20 19M8.2 16.4 20 5" />
          </svg>
        </TbBtn>
        <TbBtn title={snapping ? "Snapping on" : "Snapping off"} active={snapping} onClick={() => ui.setSnapping(!snapping)}>
          <svg {...iconProps} width={13} height={13}>
            <path d="M6 3v8a6 6 0 0 0 12 0V3" />
            <path d="M6 3h4M14 3h4" />
          </svg>
        </TbBtn>
        <div className="ml-auto flex min-w-0 items-center gap-1.5">
          <svg {...iconProps} width={11} height={11} className="shrink-0 text-neutral-500">
            <circle cx="11" cy="11" r="7" />
            <path d="m21 21-4.3-4.3M8 11h6" />
          </svg>
          <input
            type="range"
            min={0}
            max={100}
            value={Math.round(((Math.log(pxPerFrame) - Math.log(0.1)) / (Math.log(20) - Math.log(0.1))) * 100)}
            onChange={(e) =>
              ui.setZoom(Math.exp(Math.log(0.1) + (Number(e.target.value) / 100) * (Math.log(20) - Math.log(0.1))))
            }
            title={t("tl.zoom")}
            className="h-1 w-28 min-w-10 shrink cursor-pointer appearance-none rounded bg-neutral-700 accent-neutral-200"
          />
          <svg {...iconProps} width={11} height={11} className="text-neutral-500">
            <circle cx="11" cy="11" r="7" />
            <path d="m21 21-4.3-4.3M8 11h6M11 8v6" />
          </svg>
        </div>
      </div>
      {/* ONE scroll container for BOTH axes: with 6+ tracks the content (26px ruler + 46px per
        * track) exceeds the fixed h-64 — before, the extra tracks were simply unreachable (and
        * wheel-scrolling the lanes desynced them from the header column). Headers and lanes live
        * in the same scroller so they always stay aligned; the header column is sticky-left, the
        * ruler sticky-top, and the corner spacer sticky on both, NLE-style. */}
      <div ref={scrollRef} className="min-h-0 flex-1 overflow-auto">
        <div className="flex min-w-full" style={{ width: HEADER_W + width }}>
        {/* ── Track header column ── */}
        <div ref={headerColRef} className="sticky left-0 z-50 shrink-0 border-r border-neutral-800 bg-neutral-900" style={{ width: HEADER_W }}>
          <div className="sticky top-0 z-30 border-b border-neutral-800 bg-neutral-900" style={{ height: RULER_H }} />
          {tracks.map((track, i) => {
            const isVideo = track.type === "video";
            const label = isVideo ? `V${videoCounter[i]}` : `A${audioCounter[i]}`;
            return (
              <div
                key={track.id}
                style={{ height: TRACK_H }}
                className={`relative flex flex-col items-center justify-center gap-0.5 border-track border-neutral-800/60 px-1 pl-2 select-none ${
                  trackDrag && trackDrag.from !== i && trackDrag.over === i ? "bg-emerald-500/15 ring-1 ring-inset ring-emerald-500/50" : ""
                }`}
              >
                {/* Palmier-style per-kind color strip: video = sky, audio = teal */}
                <span
                  className={`absolute left-0 top-[3px] bottom-[3px] w-[3px] rounded-r ${isVideo ? "bg-sky-400/90" : "bg-teal-400/90"}`}
                />
                <div className="flex items-center gap-1">
                  <span
                    title={t("tl.reorderTrack")}
                    onPointerDown={(e) => {
                      e.preventDefault();
                      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
                      setTrackDrag({ from: i, over: i });
                    }}
                    onPointerMove={(e) => {
                      const over = trackIndexAtY(e.clientY);
                      setTrackDrag((d) => (d ? { ...d, over } : d));
                    }}
                    onPointerUp={() => {
                      setTrackDrag((d) => {
                        if (d && d.over !== d.from) sendCommand("reorder_tracks", { from: d.from, to: d.over });
                        return null;
                      });
                    }}
                    className="cursor-grab text-[10px] leading-none text-neutral-600 hover:text-neutral-300"
                  >
                    ⠿
                  </span>
                  <span className="text-[11px] font-semibold text-neutral-200">{label}</span>
                </div>
                <div className="flex items-center gap-0.5 mt-0.5">
                  {isVideo ? (
                    <>
                      <TrackBtn
                        active={track.hidden}
                        title={track.hidden ? "Show" : "Hide"}
                        onClick={() => setTrackProps(i, { hidden: !track.hidden })}
                      >
                        {track.hidden ? <IconEyeOff /> : <IconEye />}
                      </TrackBtn>
                      <TrackBtn
                        active={track.locked}
                        title={track.locked ? "Unlock" : "Lock"}
                        onClick={() => setTrackProps(i, { locked: !track.locked })}
                      >
                        {track.locked ? <IconLock /> : <IconUnlock />}
                      </TrackBtn>
                    </>
                  ) : (
                    <>
                      <TrackBtn
                        active={track.muted}
                        title={track.muted ? "Unmute" : "Mute"}
                        onClick={() => setTrackProps(i, { muted: !track.muted })}
                      >
                        M
                      </TrackBtn>
                      <TrackBtn active={false} title={t("tl.solo")} onClick={() => soloTrack(i)}>
                        S
                      </TrackBtn>
                      <TrackBtn
                        active={track.locked}
                        title={track.locked ? "Unlock" : "Lock"}
                        onClick={() => setTrackProps(i, { locked: !track.locked })}
                      >
                        {track.locked ? <IconLock /> : <IconUnlock />}
                      </TrackBtn>
                    </>
                  )}
                </div>
              </div>
            );
          })}
          {tracks.length === 0 && <div className="p-2 text-[10px] text-neutral-600">{t("timeline.noTracks")}</div>}
        </div>

        {/* ── Timeline content (scrolls with the shared container above) ── */}
        <div className="relative" style={{ width }}>
            {/* Ruler */}
            <div
              onPointerDown={scrub}
              // sticky + OPAQUE bg: pinned while the tracks scroll vertically (clips must not show
              // through it). z-30 keeps it over clips; the playhead (z-40) still crosses it.
              className="sticky top-0 z-30 cursor-ew-resize select-none border-b border-neutral-800 bg-neutral-900"
              style={{ height: RULER_H }}
            >
              {majorTicks.map((sec) => (
                <div
                  key={`M${sec}`}
                  className="pointer-events-none absolute top-0 h-full border-l border-neutral-700/50"
                  style={{ left: sec * fps * pxPerFrame }}
                >
                  <span className="absolute left-1 top-[7px] text-[9px] leading-none tracking-tight tabular-nums text-neutral-500">
                    {tcLabel(sec)}
                  </span>
                </div>
              ))}
              {minorTicks.map((sec) => (
                <div
                  key={`m${sec}`}
                  className="pointer-events-none absolute bottom-0 h-[7px] border-l border-neutral-700/40"
                  style={{ left: sec * fps * pxPerFrame }}
                />
              ))}
              {/* Range in/out shade */}
              {rangeIn !== null && rangeOut !== null && (
                <div
                  className="pointer-events-none absolute top-0 h-full bg-sky-400/15 border-l border-r border-sky-500/60"
                  style={{ left: rangeIn * pxPerFrame, width: (rangeOut - rangeIn) * pxPerFrame }}
                />
              )}
              {/* Markers — cheap absolutely-positioned flags (▼); tooltip carries the note. */}
              {(project?.timeline.markers ?? []).map((m) => (
                <span
                  key={m.id}
                  title={m.note || "Marker"}
                  // A pointerdown on the ruler scrubs; the marker itself must not (right-click included).
                  onPointerDown={(e) => e.stopPropagation()}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    // window.prompt keeps this dependency-free: edit the note, empty text deletes.
                    const next = window.prompt("Marker note (leave empty to delete):", m.note ?? "");
                    if (next === null) return;
                    if (next.trim() === "") sendCommand("remove_marker", { markerId: m.id });
                    else sendCommand("update_marker", { markerId: m.id, note: next.trim() });
                  }}
                  className="absolute top-0 z-10 -translate-x-1/2 cursor-context-menu select-none text-[10px] leading-none"
                  style={{ left: m.frame * pxPerFrame, color: m.color }}
                >
                  ▼
                </span>
              ))}
            </div>

            {/* Track lanes + marquee container */}
            <div
              ref={tracksAreaRef}
              className="relative"
              onPointerDown={(e) => {
                // Start marquee only when click lands on an empty lane (clips call stopPropagation)
                if ((e.target as HTMLElement).dataset.lane === "1") beginMarquee(e);
              }}
              onContextMenu={(e) => openCtx(e, null)}
              onDragOver={(e) => {
                e.preventDefault();
                e.dataTransfer.dropEffect = "copy";
              }}
              onDrop={dropAsset}
            >
              {tracks.map((track, ti) => (
                <div
                  key={track.id}
                  data-lane="1"
                  style={{ height: TRACK_H }}
                  className={`relative border-t border-neutral-800/60 ${
                    targetLane === ti ? "bg-sky-500/10" : ""
                  } ${track.hidden ? "opacity-40" : ""}`}
                >
                  {track.clips.map((c) => {
                    const isLocked = track.locked;
                    const isBlade = tool === "blade";
                    const { startF, durF, active } = getDisplay(c, !!isLocked);
                    const isSelected = selected.has(c.id);
                    const clipAsset = c.mediaRef ? project?.media.find((m) => m.id === c.mediaRef) : undefined;
                    const genKind = clipAsset?.generationStatus.kind;
                    const isGenerating = genKind !== undefined && genKind !== "none";
                    // Video needs the static-frame endpoint (?thumb=1): a raw video URL renders
                    // NOTHING as a CSS background-image, which left video clips visually blank.
                    const thumbUrl =
                      (c.mediaType === "video" || c.mediaType === "image") && c.mediaRef && !isGenerating
                        ? mediaUrl(c.mediaRef) + (c.mediaType === "video" ? "?thumb=1" : "")
                        : null;
                    const realPeaks = c.mediaType === "audio" ? waves[c.mediaRef] : undefined;
                    const bars =
                      c.mediaType === "audio" ? (realPeaks && realPeaks.length ? realPeaks : waveformBars(c.id, 22)) : null;
                    // Who is talking, drawn as a strip along the bottom of the clip. It rides the
                    // clip rather than taking a track of its own so trimming, moving and splitting
                    // carry it along for free — and so it cannot drift out of step with the audio.
                    const spk = c.mediaRef ? speakers[c.mediaRef] : undefined;
                    const speakerBars =
                      spk && spk.turns.length
                        ? turnsToBars(spk.turns, {
                            trimStartFrames: c.trimStartFrame,
                            durationFrames: durF,
                            speed: c.speed,
                            fps,
                          })
                        : null;
                    const speakerOrder = spk ? [...new Set(spk.turns.map((t) => t.speaker))] : [];

                    return (
                      <div
                        key={c.id}
                        role="button"
                        tabIndex={0}
                        onPointerDown={(e) => {
                          if (isLocked) return;
                          if (isBlade) {
                            bladeClick(c, e);
                          } else {
                            e.stopPropagation(); // prevent marquee
                            beginDrag("move", c, ti, e);
                          }
                        }}
                        onContextMenu={(e) => {
                          e.stopPropagation();
                          if (!selected.has(c.id)) ui.select([c.id]);
                          openCtx(e, c.id);
                        }}
                        onDoubleClick={(e) => {
                          // Double-click a compound clip = enter its nested timeline (the bridge
                          // flips the broadcast view; the breadcrumb above leads back out).
                          if (!c.compoundId) return;
                          e.stopPropagation();
                          sendCommand("open_compound", { clipId: c.id });
                        }}
                        title={c.compoundId ? `${nameFor(c)} — double-click to open` : nameFor(c)}
                        style={{
                          left: Math.max(0, startF) * pxPerFrame,
                          width: Math.max(3, durF) * pxPerFrame,
                          ...(thumbUrl
                            ? {
                                // repeat-x at full lane height = Palmier's filmstrip look without
                                // fetching per-segment frames
                                backgroundImage: `url("${thumbUrl}")`,
                                backgroundSize: "auto 100%",
                                backgroundRepeat: "repeat-x",
                                backgroundPosition: "left center",
                              }
                            : {}),
                        }}
                        className={[
                          "absolute bottom-1 top-1 flex items-start overflow-hidden rounded border px-1.5 text-left text-[10px] text-white/90",
                          isBlade
                            ? "cursor-crosshair"
                            : isLocked
                              ? "cursor-not-allowed"
                              : "cursor-grab active:cursor-grabbing",
                          // Compound clips get their own indigo identity + a double border so a
                          // nested sequence never passes for plain footage.
                          c.compoundId
                            ? "border-2 border-indigo-300/80 bg-indigo-700/80"
                            : TRACK_COLORS[c.mediaType] ?? "border-neutral-500 bg-neutral-700",
                          isSelected ? "ring-2 ring-white" : "",
                          active ? "opacity-80" : "",
                          isLocked ? "brightness-50" : "",
                        ]
                          .filter(Boolean)
                          .join(" ")}
                      >
                        {/* Scrim so the top-left label stays readable over the filmstrip */}
                        {thumbUrl && (
                          <div className="pointer-events-none absolute inset-0 rounded bg-gradient-to-b from-black/55 via-black/10 to-black/25" />
                        )}

                        {/* Still generating: a clear label instead of a blank/broken-looking thumbnail */}
                        {isGenerating && (
                          <div className="pointer-events-none absolute inset-0 flex items-center justify-center gap-1 rounded bg-neutral-800/70">
                            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-amber-400" />
                            <span className="truncate text-[9px] font-medium text-amber-300">
                              {genKind === "failed" ? "Failed" : "Generating…"}
                            </span>
                          </div>
                        )}

                        {/* Stylized audio waveform */}
                        {bars && (
                          <div className="pointer-events-none absolute inset-0 flex items-center justify-between px-1 opacity-55">
                            {bars.map((h, bi) => (
                              <div
                                key={bi}
                                className="w-px flex-shrink-0 rounded-full bg-white/75"
                                style={{ height: `${Math.round(h * 100)}%` }}
                              />
                            ))}
                          </div>
                        )}

                        {/* Speaker lane. Each bar carries its label as a tooltip and, when there is
                            room, printed on the bar — a colour alone tells you SOMETHING changed
                            but not who, and "who" is the whole point. */}
                        {speakerBars && speakerBars.length > 0 && (
                          <div className="pointer-events-none absolute inset-x-0 bottom-0 h-[9px] overflow-hidden rounded-b bg-black/35">
                            {speakerBars.map((b, bi) => (
                              <div
                                key={`${b.speaker}-${bi}`}
                                className="absolute inset-y-0 flex items-center justify-center overflow-hidden text-[7px] font-semibold leading-none text-black/80"
                                style={{
                                  left: `${b.left * 100}%`,
                                  width: `${b.width * 100}%`,
                                  backgroundColor: speakerColour(b.speaker, speakerOrder),
                                }}
                                title={b.speaker}
                              >
                                {b.width * durF * pxPerFrame > 26 ? b.speaker : ""}
                              </div>
                            ))}
                          </div>
                        )}

                        <span
                          className={`pointer-events-none relative z-10 mt-[3px] truncate leading-none drop-shadow ${
                            isSelected ? "underline underline-offset-2" : ""
                          }`}
                        >
                          {nameFor(c)}
                        </span>

                        {/* Left-trim handle */}
                        {!isBlade && !isLocked && (
                          <span
                            onPointerDown={(e) => {
                              e.stopPropagation();
                              beginDrag("trim-l", c, ti, e);
                            }}
                            className="absolute bottom-0 left-0 top-0 z-20 w-1.5 cursor-ew-resize bg-white/0 hover:bg-white/40"
                          />
                        )}

                        {/* Right-trim handle */}
                        {!isBlade && !isLocked && (
                          <span
                            onPointerDown={(e) => {
                              e.stopPropagation();
                              beginDrag("trim-r", c, ti, e);
                            }}
                            className="absolute bottom-0 right-0 top-0 z-20 w-1.5 cursor-ew-resize bg-white/0 hover:bg-white/40"
                          />
                        )}
                      </div>
                    );
                  })}
                </div>
              ))}

              {/* Marquee rubber-band */}
              {marquee && marqueeStyle && (
                <div
                  className="pointer-events-none border border-sky-400/80 bg-sky-400/10"
                  style={marqueeStyle}
                />
              )}
            </div>

            {/* Snap line */}
            {snapLineX !== null && (
              <div
                className="pointer-events-none absolute top-0 z-20 w-px bg-yellow-400/80"
                style={{ left: snapLineX, height: RULER_H + tracks.length * TRACK_H }}
              />
            )}

            {/* Playhead — z-40: must stay visible across the sticky ruler (z-30) */}
            <div
              className="pointer-events-none absolute top-0 z-40 w-px bg-red-500"
              style={{ left: playhead * pxPerFrame, height: RULER_H + tracks.length * TRACK_H }}
            >
              {/* Palmier-style head: downward triangle sitting in the ruler */}
              <div className="absolute -left-[5px] top-0 h-0 w-0 border-l-[5px] border-r-[5px] border-t-[7px] border-l-transparent border-r-transparent border-t-red-500" />
            </div>
          </div>
        </div>
      </div>

      {/* Context menu — clamped so a right-click near the window edge can't push items off-screen */}
      {contextMenu && (
        <div
          className="fixed z-50 min-w-[152px] rounded border border-neutral-700 bg-neutral-900 py-1 shadow-2xl text-[11px] text-neutral-200"
          style={{
            left: Math.max(0, Math.min(contextMenu.x, window.innerWidth - 170)),
            top: Math.max(0, Math.min(contextMenu.y, window.innerHeight - (contextMenu.clipId ? 208 : 64))),
          }}
          onMouseDown={(e) => e.stopPropagation()}
        >
          {contextMenu.clipId ? (
            <>
              <CtxItem
                label={t("lb.copy")}
                onAction={() => {
                  if (!selected.has(contextMenu.clipId!)) ui.select([contextMenu.clipId!]);
                  copyClips();
                  closeCtx();
                }}
              />
              <CtxItem
                label={t("lb.cut")}
                onAction={() => {
                  if (!selected.has(contextMenu.clipId!)) ui.select([contextMenu.clipId!]);
                  cutClips();
                  closeCtx();
                }}
              />
              <CtxItem
                label={t("lb.duplicate")}
                onAction={() => {
                  if (!selected.has(contextMenu.clipId!)) ui.select([contextMenu.clipId!]);
                  duplicateSelected();
                  closeCtx();
                }}
              />
              <CtxItem
                label={t("lb.delete")}
                onAction={() => {
                  if (!selected.has(contextMenu.clipId!)) ui.select([contextMenu.clipId!]);
                  deleteSelected();
                  closeCtx();
                }}
              />
              <div className="my-1 border-t border-neutral-800" />
              <CtxItem
                label={t("lb.selectForward")}
                onAction={() => {
                  const ids = tracks.flatMap((t) => t.clips.filter((cl) => cl.startFrame + cl.durationFrames > playhead).map((cl) => cl.id));
                  if (ids.length) ui.select(ids);
                  closeCtx();
                }}
              />
              <CtxItem
                label={t("lb.splitAtPlayhead")}
                onAction={() => {
                  const clip = findClip(contextMenu.clipId!);
                  if (clip && playhead > clip.startFrame && playhead < clip.startFrame + clip.durationFrames) {
                    sendCommand("split_clip", { clipId: clip.id, atFrame: playhead });
                  }
                  closeCtx();
                }}
              />
              <CtxItem
                label={t("lb.addCrossfade")}
                onAction={() => {
                  sendCommand("add_transition", { clipId: contextMenu.clipId!, type: "cross", durationFrames: 15 });
                  closeCtx();
                }}
              />
              {/* People & cameras. These appear only once the clip can actually take them: Find
                  speakers needs sound, and the two that follow need turns to work from — offering
                  them before that would just be a menu full of things that error. */}
              {(() => {
                const c = findClip(contextMenu.clipId!);
                if (!c) return null;
                const asset = c.mediaRef ? project?.media.find((m) => m.id === c.mediaRef) : undefined;
                const hasSound = c.mediaType === "audio" || (c.mediaType === "video" && asset?.hasAudio !== false);
                if (!hasSound) return null;
                const known = c.mediaRef ? speakers[c.mediaRef] : undefined;
                const many = (known?.speakerCount ?? 0) > 1;
                return (
                  <>
                    <div className="my-1 border-t border-neutral-800" />
                    <div className="px-3 pb-0.5 pt-0.5 text-[9px] font-medium uppercase tracking-wide text-neutral-500">
                      {t("lb.grpPeople")}
                    </div>
                    {!known && (
                      <CtxItem
                        label={t("lb.findSpeakers")}
                        onAction={() => {
                          void mcpCall("identify_speakers", { media: c.mediaRef });
                          closeCtx();
                        }}
                      />
                    )}
                    {known && c.mediaType === "audio" && many && (
                      <CtxItem
                        label={t("lb.splitBySpeaker")}
                        onAction={() => {
                          void mcpCall("split_audio_by_speaker", { clipId: c.id });
                          closeCtx();
                        }}
                      />
                    )}
                    {known && c.mediaType === "video" && (
                      <CtxItem
                        label={t("lb.emphasize")}
                        onAction={() => {
                          void mcpCall("emphasize_speaker", { clipId: c.id, speaker: [...new Set(known.turns.map((x) => x.speaker))][0] });
                          closeCtx();
                        }}
                      />
                    )}
                    {known && (
                      <div className="px-3 pb-1 pt-0.5 text-[9px] text-neutral-500">
                        {t("lb.speakersFound", { n: known.speakerCount })}
                      </div>
                    )}
                  </>
                );
              })()}
            </>
          ) : (
            <>
              <CtxItem label={t("lb.paste")} onAction={() => { pasteClips(); closeCtx(); }} />
              <CtxItem
                label={t("lb.selectForward")}
                onAction={() => {
                  const ids = tracks.flatMap((t) => t.clips.filter((cl) => cl.startFrame + cl.durationFrames > playhead).map((cl) => cl.id));
                  if (ids.length) ui.select(ids);
                  closeCtx();
                }}
              />
            </>
          )}
        </div>
      )}
    </div>
  );
}

// ── Sub-components ────────────────────────────────────────────────────────────

const iconProps = {
  width: 10,
  height: 10,
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 2,
  strokeLinecap: "round",
  strokeLinejoin: "round",
} as const;

function IconEye() {
  return (
    <svg {...iconProps}>
      <path d="M2 12s3.5-6.5 10-6.5S22 12 22 12s-3.5 6.5-10 6.5S2 12 2 12Z" />
      <circle cx="12" cy="12" r="2.6" />
    </svg>
  );
}
function IconEyeOff() {
  return (
    <svg {...iconProps}>
      <path d="M3 3l18 18M10.6 5.8A10 10 0 0 1 12 5.5c6.5 0 10 6.5 10 6.5a17.6 17.6 0 0 1-3.1 3.9M6.6 6.9A16.7 16.7 0 0 0 2 12s3.5 6.5 10 6.5a10.5 10.5 0 0 0 4.4-.96" />
    </svg>
  );
}
function IconLock() {
  return (
    <svg {...iconProps}>
      <rect x="5" y="11" width="14" height="9" rx="2" />
      <path d="M8 11V7a4 4 0 0 1 8 0v4" />
    </svg>
  );
}
function IconUnlock() {
  return (
    <svg {...iconProps}>
      <rect x="5" y="11" width="14" height="9" rx="2" />
      <path d="M8 11V7a4 4 0 0 1 7.8-1" />
    </svg>
  );
}

function TbBtn({
  children,
  active,
  title,
  onClick,
}: {
  children: React.ReactNode;
  active?: boolean;
  title: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      title={title}
      onClick={onClick}
      className={`flex h-6 w-6 items-center justify-center rounded transition-colors ${
        active ? "bg-neutral-700/80 text-neutral-100" : "text-neutral-400 hover:bg-neutral-800 hover:text-neutral-200"
      }`}
    >
      {children}
    </button>
  );
}

function TrackBtn({
  children,
  active,
  title,
  onClick,
}: {
  children: React.ReactNode;
  active: boolean;
  title: string;
  onClick: () => void;
}) {
  return (
    <button
      title={title}
      onPointerDown={(e) => { e.stopPropagation(); onClick(); }}
      className={[
        "flex h-4 w-4 items-center justify-center rounded text-[9px] font-bold transition-colors select-none",
        active ? "bg-amber-500/80 text-white" : "text-neutral-500 hover:text-neutral-300",
      ].join(" ")}
    >
      {children}
    </button>
  );
}

function CtxItem({ label, onAction }: { label: string; onAction: () => void }) {
  return (
    <button
      className="w-full px-3 py-1 text-left hover:bg-neutral-700/60 transition-colors"
      onMouseDown={(e) => { e.stopPropagation(); onAction(); }}
    >
      {label}
    </button>
  );
}
