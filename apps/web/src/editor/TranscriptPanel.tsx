// Transcript panel — text-based editing (Descript/OpusClip style): the timeline's speech rendered
// as clickable prose. Click a word to seek there, shift-click or drag to select a span, Delete (or
// the button) ripple-cuts that span out of the video and closes the gap (ripple_delete_ranges).
// The transcript is loaded lazily (on-device whisper can be slow the first time; the bridge caches
// per source file, so reloads after a cut are fast).
// Rendered as a self-collapsing right-side column with its own toggle strip — the Toolbar's panel
// buttons are off-limits for this feature.

import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent, MouseEvent as ReactMouseEvent, ReactNode } from "react";
import { mcpCall, ui, useEditor } from "./store";
import type { CutRange, TranscriptParagraph, TranscriptWord } from "./transcriptModel";
import { fillersToCuts, findFillerIndices, groupTranscript, parseTranscript, selectionToCut, wordIndexAtFrame } from "./transcriptModel";

/** Cuts longer than this ask for an inline confirmation before deleting. */
const CONFIRM_SECONDS = 3;

interface Selection {
  anchor: number; // word index where the selection started
  focus: number; // word index it currently extends to (may precede anchor)
}

function fmtSeconds(frames: number, fps: number): string {
  return `${(frames / (fps > 0 ? fps : 30)).toFixed(1)}s`;
}

const ICON_BTN = "flex h-5 w-5 items-center justify-center rounded text-neutral-400 hover:bg-neutral-800 hover:text-neutral-200";

// ── prose rendering ───────────────────────────────────────────────────────────
// One memoized block per paragraph: selection/playhead props are pre-clipped to the paragraph by
// the parent, so during playback (the store playhead changes every frame) only the paragraph that
// contains the spoken word re-renders.

interface ParagraphRowProps {
  para: TranscriptParagraph;
  words: TranscriptWord[];
  selLo: number; // selection clipped to this paragraph; -1 when none of it falls here
  selHi: number;
  playIdx: number; // word under the playhead, -1 when outside this paragraph
  fillers: Set<number>; // filler-word indices to highlight (stable identity across playback ticks)
  onWordDown: (e: ReactMouseEvent, idx: number) => void;
  onWordEnter: (idx: number) => void;
}

const ParagraphRow = memo(function ParagraphRow({ para, words, selLo, selHi, playIdx, fillers, onWordDown, onWordEnter }: ParagraphRowProps) {
  const nodes: ReactNode[] = [];
  for (const s of para.sentences) {
    if (s.timestamp) {
      nodes.push(
        <span key={`ts-${s.from}`} className="mr-1.5 select-none rounded bg-neutral-800/70 px-1 py-px font-mono text-[9px] text-neutral-500">
          {s.timestamp}
        </span>,
      );
    }
    for (let i = s.from; i <= s.to; i++) {
      const selected = i >= selLo && i <= selHi;
      const isFiller = !selected && fillers.has(i);
      nodes.push(
        <span
          key={i}
          data-widx={i}
          onMouseDown={(e) => onWordDown(e, i)}
          onMouseEnter={() => onWordEnter(i)}
          className={`cursor-pointer rounded-sm ${
            selected
              ? "bg-sky-500/40 text-sky-50"
              : isFiller
                ? "bg-amber-500/15 text-amber-300/90 hover:bg-amber-500/30"
                : "hover:bg-neutral-700/60"
          } ${i === playIdx ? "underline decoration-sky-300/80 decoration-2 underline-offset-2" : ""}`}
        >
          {words[i].text + " "}
        </span>,
      );
    }
  }
  return <p className="mb-3 leading-6">{nodes}</p>;
});

// ── panel ─────────────────────────────────────────────────────────────────────

export function TranscriptPanel() {
  const { project, playhead, playing, connected } = useEditor();

  const [open, setOpen] = useState(false);
  const [words, setWords] = useState<TranscriptWord[] | null>(null); // null = never loaded
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sel, setSel] = useState<Selection | null>(null);
  const [pendingCut, setPendingCut] = useState<CutRange | null>(null); // awaiting inline confirm
  const [deleting, setDeleting] = useState(false);
  const [undoHint, setUndoHint] = useState<string | null>(null);
  const [loadedTracksJson, setLoadedTracksJson] = useState<string | null>(null);

  const asideRef = useRef<HTMLElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);
  const undoTimer = useRef<number | null>(null);
  const lastScrolled = useRef(-1);

  const fps = project?.timeline.fps ?? 30;

  // Word frames go stale whenever the timeline's shape changes (undo, an agent edit, a manual
  // trim…). Compare content, not identity: our own delete's WS echo carries the same tracks the
  // reload was computed from, so it must NOT re-flag. Memoized on the project object so playback
  // re-renders (playhead ticks at fps) never re-stringify.
  const tracksJson = useMemo(() => (project ? JSON.stringify(project.timeline.tracks) : null), [project]);
  const tracksJsonRef = useRef<string | null>(null);
  tracksJsonRef.current = tracksJson;
  const stale = words !== null && loadedTracksJson !== null && tracksJson !== loadedTracksJson;

  // Switching projects drops everything — the words belong to the old timeline.
  const projectId = project?.id ?? null;
  useEffect(() => {
    setWords(null);
    setSel(null);
    setPendingCut(null);
    setError(null);
    setLoadedTracksJson(null);
  }, [projectId]);

  // A drag selection ends wherever the mouse is released.
  useEffect(() => {
    const up = () => {
      dragging.current = false;
    };
    window.addEventListener("mouseup", up);
    return () => window.removeEventListener("mouseup", up);
  }, []);

  useEffect(
    () => () => {
      if (undoTimer.current) window.clearTimeout(undoTimer.current);
    },
    [],
  );

  const paragraphs = useMemo(() => (words ? groupTranscript(words, fps) : []), [words, fps]);
  const playIdx = words && words.length > 0 ? wordIndexAtFrame(words, playhead) : -1;

  // Filler disfluencies (um/uh/cioè/…): highlighted amber, removable in one click. Stable Set
  // identity so the memoized paragraphs don't re-render on every playback tick.
  const fillerIdxs = useMemo(() => (words ? findFillerIndices(words) : []), [words]);
  const fillerSet = useMemo(() => new Set(fillerIdxs), [fillerIdxs]);

  // Follow the speech while playing: keep the current word in view (scroll only when it changes).
  useEffect(() => {
    if (!playing || playIdx < 0 || playIdx === lastScrolled.current) return;
    lastScrolled.current = playIdx;
    scrollRef.current?.querySelector(`[data-widx="${playIdx}"]`)?.scrollIntoView({ block: "nearest" });
  }, [playing, playIdx]);

  async function load(): Promise<void> {
    if (loading) return;
    setLoading(true);
    setError(null);
    setSel(null);
    setPendingCut(null);
    const res = await mcpCall("get_transcript", {});
    if (res.isError) {
      setError(res.text || "Transcription failed.");
    } else {
      const parsed = parseTranscript(res.text);
      if (parsed) {
        setWords(parsed);
        setLoadedTracksJson(tracksJsonRef.current); // the timeline shape these frames belong to
        lastScrolled.current = -1;
      } else {
        setError("Unexpected transcript data from the bridge.");
      }
    }
    setLoading(false);
  }

  async function doDelete(cut: CutRange): Promise<void> {
    if (deleting) return;
    setDeleting(true);
    setPendingCut(null);
    const res = await mcpCall("ripple_delete_ranges", {
      trackIndex: cut.trackIndex,
      ranges: [[cut.startFrame, cut.endFrame]],
      units: "frames",
    });
    setDeleting(false);
    if (res.isError) {
      setError(res.text || "Cut failed.");
      return;
    }
    setError(null);
    setSel(null);
    ui.setPlayhead(cut.startFrame); // the cut closed here — the playhead lands on the join
    setUndoHint(`Cut ${fmtSeconds(cut.durationFrames, fps)} — Ctrl+Z undoes it.`);
    if (undoTimer.current) window.clearTimeout(undoTimer.current);
    undoTimer.current = window.setTimeout(() => setUndoHint(null), 8000);
    await load(); // every word frame shifted; transcription itself is cached on the bridge
  }

  // Remove every filler on the track that has the most, in one ripple_delete_ranges call, then
  // reload (frames shifted). If fillers remain on other tracks the button count updates — clicking
  // again clears them on freshly-reloaded frames, so no stale-frame miscut.
  async function removeFillers(): Promise<void> {
    if (deleting || loading || !words || fillerIdxs.length === 0) return;
    const byTrack = new Map<number, number[]>();
    for (const i of fillerIdxs) {
      const t = words[i].trackIndex;
      (byTrack.get(t) ?? byTrack.set(t, []).get(t)!).push(i);
    }
    let bestTrack = -1;
    let bestCount = 0;
    for (const [t, idxs] of byTrack) if (idxs.length > bestCount) [bestTrack, bestCount] = [t, idxs.length];
    if (bestTrack < 0) return;
    const cuts = fillersToCuts(words, byTrack.get(bestTrack)!);
    if (cuts.length === 0) return;
    setDeleting(true);
    setPendingCut(null);
    setSel(null);
    const res = await mcpCall("ripple_delete_ranges", {
      trackIndex: bestTrack,
      ranges: cuts.map((c) => [c.startFrame, c.endFrame]),
      units: "frames",
    });
    setDeleting(false);
    if (res.isError) {
      setError(res.text || "Filler removal failed.");
      return;
    }
    setError(null);
    const removed = cuts.reduce((n, c) => n + c.wordCount, 0);
    setUndoHint(`Removed ${removed} filler word${removed === 1 ? "" : "s"} — Ctrl+Z undoes it.`);
    if (undoTimer.current) window.clearTimeout(undoTimer.current);
    undoTimer.current = window.setTimeout(() => setUndoHint(null), 8000);
    await load();
  }

  const selLo = sel ? Math.min(sel.anchor, sel.focus) : -1;
  const selHi = sel ? Math.max(sel.anchor, sel.focus) : -1;
  const selCut = words && sel ? selectionToCut(words, sel.anchor, sel.focus) : null;

  function requestDelete(): void {
    if (deleting || loading) return;
    if (pendingCut) {
      void doDelete(pendingCut); // Delete pressed again while confirming = confirm
      return;
    }
    if (!selCut) return;
    if (selCut.durationFrames > CONFIRM_SECONDS * fps) setPendingCut(selCut);
    else void doDelete(selCut);
  }

  // Stable handlers so the memoized paragraphs never re-render from a new function identity.
  const wordsLive = useRef<TranscriptWord[] | null>(null);
  wordsLive.current = words;
  const selLive = useRef<Selection | null>(null);
  selLive.current = sel;

  const onWordDown = useCallback((e: ReactMouseEvent, idx: number) => {
    e.preventDefault(); // our own selection model — suppress native text selection
    const w = wordsLive.current;
    if (!w) return;
    const prev = selLive.current;
    if (e.shiftKey && prev) {
      setSel({ anchor: prev.anchor, focus: idx });
    } else {
      setSel({ anchor: idx, focus: idx });
      dragging.current = true;
      const word = w[idx];
      if (word) ui.setPlayhead(word.startFrame); // click = seek to the word
    }
    setPendingCut(null);
    asideRef.current?.focus(); // so Delete works right away
  }, []);

  const onWordEnter = useCallback((idx: number) => {
    if (dragging.current) setSel((s) => (s ? { anchor: s.anchor, focus: idx } : { anchor: idx, focus: idx }));
  }, []);

  function onKeyDown(e: ReactKeyboardEvent<HTMLElement>): void {
    if (e.key === "Delete" || e.key === "Backspace") {
      // Scoped to the panel: never let the global shortcut delete timeline clips from here.
      e.preventDefault();
      e.stopPropagation();
      requestDelete();
    } else if (e.key === "Escape" && (sel || pendingCut)) {
      e.preventDefault();
      e.stopPropagation();
      setSel(null);
      setPendingCut(null);
    }
  }

  function onProseMouseDown(e: ReactMouseEvent<HTMLDivElement>): void {
    // Clicking empty space (not a word) clears the selection.
    if (!(e.target as HTMLElement).closest("[data-widx]")) {
      setSel(null);
      setPendingCut(null);
    }
  }

  // ── collapsed: a thin strip with its own toggle ────────────────────────────
  if (!open) {
    return (
      <aside className="flex w-8 shrink-0 flex-col border-l border-neutral-800 bg-neutral-950">
        <button
          type="button"
          onClick={() => setOpen(true)}
          title="Transcript — edit the video as text"
          className="flex flex-1 flex-col items-center gap-2 pt-3 text-neutral-500 transition hover:bg-neutral-900 hover:text-neutral-300"
        >
          <span aria-hidden className="text-[13px] leading-none">
            ¶
          </span>
          <span className="text-[10px] font-semibold uppercase tracking-widest" style={{ writingMode: "vertical-rl" }}>
            Transcript
          </span>
        </button>
      </aside>
    );
  }

  // ── body variants ───────────────────────────────────────────────────────────
  let body: ReactNode;
  if (!project) {
    body = <p className="px-2 pt-10 text-center text-[11px] text-neutral-500">Open a project to see its transcript.</p>;
  } else if (words === null && loading) {
    body = (
      <div className="flex h-full flex-col items-center justify-center gap-3 px-4 text-center">
        <span className="h-5 w-5 animate-spin rounded-full border-2 border-neutral-700 border-t-neutral-200" />
        <p className="text-[11px] text-neutral-400">Transcribing the timeline…</p>
        <p className="text-[10px] leading-4 text-neutral-600">Speech recognition runs on your machine — the first pass over long footage can take a few minutes.</p>
      </div>
    );
  } else if (words === null && error) {
    body = (
      <div className="flex h-full flex-col items-center justify-center gap-3 px-4 text-center">
        <p className="text-[11px] leading-4 text-red-400">{error}</p>
        <button
          type="button"
          onClick={() => void load()}
          className="rounded border border-neutral-700 px-3 py-1 text-[11px] text-neutral-300 hover:bg-neutral-800"
        >
          Try again
        </button>
      </div>
    );
  } else if (words === null) {
    body = (
      <div className="flex h-full flex-col items-center justify-center gap-3 px-4 text-center">
        <span aria-hidden className="text-2xl text-neutral-600">
          ¶
        </span>
        <p className="text-xs font-medium text-neutral-300">Edit the video as text</p>
        <p className="text-[11px] leading-4 text-neutral-500">
          Load the transcript, click a word to jump there, then select words and delete them to cut those moments out of the video.
        </p>
        <button
          type="button"
          onClick={() => void load()}
          disabled={!connected}
          className="rounded bg-sky-700 px-3 py-1.5 text-xs font-medium text-white transition hover:bg-sky-600 disabled:cursor-not-allowed disabled:opacity-50"
        >
          Load transcript
        </button>
        <p className="text-[10px] text-neutral-600">The first load can take a while — it listens to your footage on-device.</p>
      </div>
    );
  } else if (words.length === 0) {
    body = (
      <div className="flex h-full flex-col items-center justify-center gap-3 px-4 text-center">
        <p className="text-xs font-medium text-neutral-300">No speech found</p>
        <p className="text-[11px] leading-4 text-neutral-500">
          Nothing spoken was detected in the timeline's video or audio clips (or speech recognition isn't available on this machine).
        </p>
        <button
          type="button"
          onClick={() => void load()}
          className="rounded border border-neutral-700 px-3 py-1 text-[11px] text-neutral-300 hover:bg-neutral-800"
        >
          Reload
        </button>
      </div>
    );
  } else {
    body = paragraphs.map((p) => {
      const clippedLo = selLo >= 0 && selHi >= p.from && selLo <= p.to ? Math.max(selLo, p.from) : -1;
      const clippedHi = clippedLo >= 0 ? Math.min(selHi, p.to) : -1;
      const clippedPlay = playIdx >= p.from && playIdx <= p.to ? playIdx : -1;
      return (
        <ParagraphRow
          key={p.from}
          para={p}
          words={words}
          selLo={clippedLo}
          selHi={clippedHi}
          playIdx={clippedPlay}
          fillers={fillerSet}
          onWordDown={onWordDown}
          onWordEnter={onWordEnter}
        />
      );
    });
  }

  const hasProse = words !== null && words.length > 0;

  return (
    <aside
      ref={asideRef}
      tabIndex={-1}
      onKeyDown={onKeyDown}
      className="flex w-80 shrink-0 flex-col border-l border-neutral-800 bg-neutral-950 outline-none"
    >
      {/* header */}
      <div className="flex items-center justify-between border-b border-neutral-800 px-3 py-2">
        <span className="text-[11px] font-semibold uppercase tracking-widest text-neutral-400">Transcript</span>
        <div className="flex items-center gap-1">
          {loading && words !== null && <span className="h-3 w-3 animate-spin rounded-full border-2 border-neutral-700 border-t-neutral-300" />}
          {words !== null && !loading && (
            <button type="button" onClick={() => void load()} title="Reload the transcript (fast — transcription is cached)" className={ICON_BTN}>
              ↻
            </button>
          )}
          <button type="button" onClick={() => setOpen(false)} title="Collapse the transcript panel" className={ICON_BTN}>
            »
          </button>
        </div>
      </div>

      {/* stale warning: the timeline changed under the loaded words */}
      {stale && !loading && (
        <button
          type="button"
          onClick={() => void load()}
          className="border-b border-amber-900/50 bg-amber-950/40 px-3 py-1.5 text-left text-[10px] leading-4 text-amber-300 hover:bg-amber-950/70"
        >
          ⚠ Timeline changed — click to reload the transcript before editing here.
        </button>
      )}

      {/* prose */}
      <div
        ref={scrollRef}
        onMouseDown={onProseMouseDown}
        className={`flex-1 select-none overflow-y-auto px-3 py-3 text-[13px] text-neutral-300 ${loading && hasProse ? "pointer-events-none opacity-50" : ""}`}
      >
        {body}
      </div>

      {/* delete-failure strip (load failures show in the body instead) */}
      {error && words !== null && <div className="border-t border-red-900/50 bg-red-950/40 px-3 py-1.5 text-[10px] text-red-300">{error}</div>}

      {/* footer: selection actions / hints */}
      {hasProse && (
        <div className="border-t border-neutral-800 px-3 py-2">
          {pendingCut ? (
            <div className="flex items-center gap-2">
              <span className="flex-1 text-[11px] text-amber-300">Delete {fmtSeconds(pendingCut.durationFrames, fps)} of video?</span>
              <button
                type="button"
                onClick={() => void doDelete(pendingCut)}
                className="rounded bg-red-800 px-2 py-1 text-[11px] font-medium text-red-50 hover:bg-red-700"
              >
                Delete
              </button>
              <button
                type="button"
                onClick={() => setPendingCut(null)}
                className="rounded border border-neutral-700 px-2 py-1 text-[11px] text-neutral-300 hover:bg-neutral-800"
              >
                Cancel
              </button>
            </div>
          ) : selCut ? (
            <div className="flex flex-col gap-1">
              <button
                type="button"
                onClick={requestDelete}
                disabled={deleting || loading}
                className="w-full rounded bg-red-800/90 py-1.5 text-[11px] font-medium text-red-50 transition hover:bg-red-700 disabled:opacity-50"
              >
                {deleting
                  ? "Cutting…"
                  : `Delete selection — ${selCut.wordCount} word${selCut.wordCount === 1 ? "" : "s"} · ${fmtSeconds(selCut.durationFrames, fps)}`}
              </button>
              <span className="text-center text-[10px] text-neutral-500">…or press Delete. The video closes the gap automatically.</span>
            </div>
          ) : (
            <div className="flex flex-col gap-1.5">
              {fillerIdxs.length > 0 && (
                <button
                  type="button"
                  onClick={() => void removeFillers()}
                  disabled={deleting || loading}
                  title="Cut every “um / uh / cioè / like …” and close the gaps"
                  className="w-full rounded bg-amber-600/90 py-1.5 text-[11px] font-medium text-amber-50 transition hover:bg-amber-500 disabled:opacity-50"
                >
                  {deleting ? "Removing…" : `Remove ${fillerIdxs.length} filler word${fillerIdxs.length === 1 ? "" : "s"}`}
                </button>
              )}
              <p className="text-[10px] leading-4 text-neutral-500">
                Click a word to jump there. Shift-click or drag to select — then Delete cuts that part out of the video.
              </p>
            </div>
          )}
          {undoHint && !pendingCut && !selCut && <p className="mt-1 text-[10px] text-emerald-400">{undoHint}</p>}
        </div>
      )}
    </aside>
  );
}
