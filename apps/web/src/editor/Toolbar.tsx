import { useEffect, useState } from "react";
import { timelineTotalFrames } from "@cupcat/editor-core";
import { frameToTimecode } from "./format";
import { ShortcutsEditor } from "./ShortcutsEditor";
import {
  BRIDGE_HTTP,
  downloadFile,
  higgsfieldLogin,
  listProjects,
  mcpCall,
  mediaUrl,
  openProject,
  pickFolder,
  type ProjectEntry,
  recheckConnections,
  sendCommand,
  sendCommandWithAck,
  sendFeedback,
  ui,
  useEditor,
} from "./store";

function PanelBtn({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={`Toggle ${label} panel`}
      className={`rounded px-2 py-1 text-xs transition ${
        active ? "bg-neutral-600 text-neutral-100" : "text-neutral-500 hover:bg-neutral-800 hover:text-neutral-300"
      }`}
    >
      {label}
    </button>
  );
}

const EXPORT_FORMATS = [
  { id: "mp4_h264", label: "MP4 · H.264", ext: "mp4" },
  { id: "mp4_h265", label: "MP4 · H.265", ext: "mp4" },
  { id: "mp4_av1", label: "MP4 · AV1 10-bit (smallest)", ext: "mp4" },
  { id: "hdr_hevc", label: "HDR · HEVC 10-bit (HLG)", ext: "mp4" },
  { id: "prores", label: "ProRes (.mov)", ext: "mov" },
  { id: "nle_xml", label: "NLE XML (Premiere / Resolve)", ext: "xml" },
  { id: "fcpxml", label: "FCPXML (Resolve / Final Cut)", ext: "fcpxml" },
  { id: "lossless", label: "Lossless (no re-encode — cuts only)", ext: "mp4" },
];

export function Toolbar() {
  const { connected, project, playhead, pxPerFrame, selectedClipIds, panels, maximized, agentHasKey, canGenerate } =
    useEditor();
  const fps = project?.timeline.fps ?? 30;
  const total = project ? timelineTotalFrames(project.timeline) : 0;
  const [showExport, setShowExport] = useState(false);
  const [showHelp, setShowHelp] = useState(false);
  // Canvas format presets (preview + export). Clip transforms are normalized so they reframe.
  const formatPresets = [
    { label: "16:9 · 1920×1080", value: "1920x1080" },
    { label: "16:9 4K · 3840×2160", value: "3840x2160" },
    { label: "9:16 · 1080×1920", value: "1080x1920" },
    { label: "9:16 4K · 2160×3840", value: "2160x3840" },
    { label: "1:1 · 1080×1080", value: "1080x1080" },
    { label: "4:5 · 1080×1350", value: "1080x1350" },
    { label: "4:3 · 1440×1080", value: "1440x1080" },
    { label: "21:9 · 2560×1080", value: "2560x1080" },
  ];
  const curFormat = project ? `${project.timeline.width}x${project.timeline.height}` : "";
  const [showConn, setShowConn] = useState(false);
  const [showProjects, setShowProjects] = useState(false);
  const [showClips, setShowClips] = useState(false);
  const [showBeatSync, setShowBeatSync] = useState(false);
  const [showFeedback, setShowFeedback] = useState(false);

  const findClip = (id: string) => project?.timeline.tracks.flatMap((t) => t.clips).find((c) => c.id === id);

  // Split is only meaningful with the playhead strictly INSIDE the selected clip — expose that as a
  // disabled state + tooltip instead of a silent no-op (a first-time user's first attempt is usually
  // with the playhead still at 0).
  const splitTarget = selectedClipIds[0] ? findClip(selectedClipIds[0]) : undefined;
  const canSplit = !!splitTarget && playhead > splitTarget.startFrame && playhead < splitTarget.startFrame + splitTarget.durationFrames;
  const splitSelected = () => {
    if (canSplit && splitTarget) sendCommand("split_clip", { clipId: splitTarget.id, atFrame: playhead });
  };
  const deleteSelected = () => {
    if (selectedClipIds.length) {
      sendCommand("remove_clips", { clipIds: selectedClipIds });
      ui.select([]);
    }
  };
  const addText = async () => {
    // Add a default text clip at the playhead, then select it right away so the Inspector opens
    // on it and the user can type the real content without hunting for the clip first.
    const ack = await sendCommandWithAck("add_texts", { entries: [{ content: "Text", startFrame: playhead, durationFrames: fps * 2 }] });
    // Ack text: "Added 1 text clip: clip_xxxxxxxx ('Text') on track 0 @ 90 for 60" — the state
    // broadcast carrying the clip arrives before the ack, so selecting here is safe.
    const id = ack && !ack.isError ? /\bclip_[0-9a-z]+\b/.exec(ack.text)?.[0] : undefined;
    if (id) ui.select([id]);
  };
  // + Matte adds IMMEDIATELY with the swatch color — the previous flow (hidden color picker, add on
  // its change event) silently did nothing when the user confirmed the default color, because
  // <input type=color> only fires "change" when the value differs. The swatch now just picks the
  // color for the next matte.
  const [matteColor, setMatteColor] = useState("#000000");
  const addMatte = () => {
    void mcpCall("add_matte", { color: matteColor, startFrame: playhead, durationFrames: fps * 2 });
  };
  // Immediate feedback for library-bound captures (the asset appears seconds later — without this
  // users re-click and create duplicates).
  const [frameSaved, setFrameSaved] = useState(false);
  const captureFrame = () => {
    void mcpCall("capture_frame", { atFrame: playhead });
    setFrameSaved(true);
    window.setTimeout(() => setFrameSaved(false), 2500);
  };

  return (
    <>
    {/* flex-wrap: on narrow windows the toolbar folds to a second row instead of pushing
      * Export/AI Clips off-screen (they were unreachable below ~1530px). */}
    <header className="flex flex-wrap items-center gap-1.5 border-b border-neutral-800 bg-neutral-900 px-2 py-2 text-sm">
      <span className="flex items-center gap-2 font-semibold tracking-tight">
        <img src="/logo.png" alt="CupCat" className="h-5 w-5 rounded-[5px]" />
        CupCat
      </span>
      <button
        onClick={() => setShowProjects(true)}
        className="truncate rounded px-1.5 py-0.5 text-xs text-neutral-400 hover:bg-neutral-800 hover:text-neutral-200"
        title="Switch or create a project"
      >
        {project?.name ?? "—"} ▾
      </button>
      <span
        className={`inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px] ${
          connected ? "bg-emerald-500/15 text-emerald-300" : "bg-red-500/15 text-red-300"
        }`}
      >
        <span className={`h-1.5 w-1.5 rounded-full ${connected ? "bg-emerald-400" : "bg-red-400"}`} />
        {connected ? "bridge" : "offline"}
      </span>

      {/* Claude + Higgsfield connection status — click to manage / re-login */}
      <button
        type="button"
        onClick={() => setShowConn(true)}
        title="Connections — Claude & Higgsfield"
        className="inline-flex items-center gap-2 rounded-full border border-neutral-700 px-2 py-0.5 text-[11px] text-neutral-300 hover:bg-neutral-800"
      >
        <span className={`h-1.5 w-1.5 rounded-full ${agentHasKey ? "bg-emerald-400" : "bg-red-400"}`} />
        Claude
        <span className={`h-1.5 w-1.5 rounded-full ${canGenerate ? "bg-emerald-400" : "bg-red-400"}`} />
        Higgsfield
      </button>

      <div className="mx-1 h-5 w-px bg-neutral-800" />

      {/* Icon-only with tooltips: ↺/↻ are universal, and the saved width is what lets the whole
        * toolbar fit a single row at 1920 (it used to wrap even there). */}
      <button onClick={() => sendCommand("undo", {})} className="rounded px-2 py-1 text-xs hover:bg-neutral-800" title="Undo (Ctrl+Z)">
        ↺
      </button>
      <button onClick={() => sendCommand("redo", {})} className="rounded px-2 py-1 text-xs hover:bg-neutral-800" title="Redo (Ctrl+Shift+Z)">
        ↻
      </button>
      <button
        onClick={splitSelected}
        disabled={!canSplit}
        title={canSplit ? "Split the selected clip at the playhead" : "Select a clip and move the playhead inside it to split"}
        className="rounded px-2 py-1 text-xs hover:bg-neutral-800 disabled:opacity-40"
      >
        Split
      </button>
      <button onClick={deleteSelected} disabled={!selectedClipIds.length} className="rounded px-2 py-1 text-xs hover:bg-neutral-800 disabled:opacity-40">
        Delete
      </button>
      <button onClick={addText} className="rounded px-2 py-1 text-xs hover:bg-neutral-800">
        + Text
      </button>
      <span className="inline-flex items-center overflow-hidden rounded hover:bg-neutral-800">
        <button onClick={addMatte} className="px-2 py-1 text-xs" title="Add a solid-color background clip at the playhead (uses the swatch color)">
          + Matte
        </button>
        <input
          type="color"
          value={matteColor}
          onChange={(e) => setMatteColor(e.target.value)}
          className="h-4 w-4 cursor-pointer border-0 bg-transparent p-0"
          title="Matte color for the next + Matte"
        />
      </span>
      {/* Icon-only advanced actions (tooltips carry the words): the labelled versions were the
        * last ~120px that kept the toolbar from fitting one row at 1920. */}
      <button
        onClick={captureFrame}
        className={`rounded px-2 py-1 text-xs hover:bg-neutral-800 ${frameSaved ? "text-emerald-300" : ""}`}
        title="Frame — capture the current frame to the library"
      >
        {frameSaved ? "✓ Saved" : "⎙"}
      </button>
      <button
        onClick={() => {
          const name = window.prompt("Version name:", "checkpoint");
          if (name !== null) void mcpCall("save_version", { name: name.trim() || "checkpoint" });
        }}
        className="rounded px-2 py-1 text-xs hover:bg-neutral-800"
        title="Version — save a named snapshot of the whole project (restore it anytime from chat: 'ripristina la versione …')"
      >
        ⛨
      </button>
      <button
        onClick={() => selectedClipIds[0] && mcpCall("save_range_as_media", { clipId: selectedClipIds[0] })}
        disabled={!selectedClipIds.length}
        className="rounded px-2 py-1 text-xs hover:bg-neutral-800 disabled:opacity-40"
        title="Bake — flatten the selected clip into a new reusable library asset"
      >
        ⤓
      </button>

      <span className="ml-2 font-mono text-xs text-neutral-400" title="min:sec:frame — the last number counts FRAMES, not hundredths">
        {frameToTimecode(playhead, fps)} / {frameToTimecode(total, fps)}
      </span>

      {/* Two SEPARATE right-side groups (not one block): on narrow windows the view/dialog group
        * wraps to the second row as a unit while the zoom/panel group stays up with the edit
        * tools — one giant ml-auto block used to wrap whole even at 1920, leaving a dead row. */}
      <div className="ml-auto flex items-center gap-2">
        <button
          type="button"
          title="Timeline zoom out"
          onClick={() => ui.setZoom(Math.max(0.2, pxPerFrame / 1.4))}
          className="flex h-5 w-5 items-center justify-center rounded text-neutral-300 hover:bg-neutral-700"
        >
          −
        </button>
        <input
          type="range"
          min={0.2}
          max={10}
          step={0.1}
          value={pxPerFrame}
          onChange={(e) => ui.setZoom(Number(e.target.value))}
          title="Timeline zoom"
          className="w-16 accent-neutral-400"
        />
        <button
          type="button"
          title="Timeline zoom in"
          onClick={() => ui.setZoom(Math.min(10, pxPerFrame * 1.4))}
          className="flex h-5 w-5 items-center justify-center rounded text-neutral-300 hover:bg-neutral-700"
        >
          +
        </button>

        <div className="mx-1 h-5 w-px bg-neutral-800" />

        {/* Panel visibility toggles */}
        <PanelBtn label="Chat" active={panels.chat} onClick={() => ui.togglePanel("chat")} />
        <PanelBtn label="Library" active={panels.media} onClick={() => ui.togglePanel("media")} />
        <PanelBtn label="Inspector" active={panels.inspector} onClick={() => ui.togglePanel("inspector")} />

        {/* Maximize preview toggle */}
        <button
          type="button"
          onClick={() => ui.setMaximized("preview")}
          title={maximized === "preview" ? "Restore layout" : "Maximize preview"}
          className={`rounded px-2 py-1 text-xs transition ${
            maximized === "preview" ? "bg-neutral-600 text-neutral-100" : "text-neutral-500 hover:bg-neutral-800 hover:text-neutral-300"
          }`}
        >
          {maximized === "preview" ? "⊡" : "⊞"}
        </button>
      </div>

      <div className="ml-auto flex items-center gap-2">
        <button onClick={() => setShowHelp(true)} className="rounded px-2 py-1 text-xs hover:bg-neutral-800" title="Getting started, shortcuts, glossary, and how to connect an agent">
          Help
        </button>
        <button
          onClick={() => setShowFeedback(true)}
          className="rounded px-2 py-1 text-xs text-neutral-500 hover:bg-neutral-800 hover:text-neutral-300"
          title="Feedback — report a bug or send an idea to the developer"
        >
          💬
        </button>
        {project && (
          <select
            value={curFormat}
            onChange={(e) => {
              const [w, h] = e.target.value.split("x").map(Number);
              if (w && h) sendCommand("set_project_format", { width: w, height: h });
            }}
            title="Canvas format / aspect ratio — used by both the preview and the export"
            className="rounded border border-neutral-700 bg-neutral-900 px-1.5 py-1 text-xs text-neutral-300 outline-none hover:bg-neutral-800"
          >
            {!formatPresets.some((p) => p.value === curFormat) && <option value={curFormat}>{curFormat.replace("x", "×")}</option>}
            {formatPresets.map((p) => (
              <option key={p.value} value={p.value}>
                {p.label}
              </option>
            ))}
          </select>
        )}
        <button
          onClick={() => {
            if (
              window.confirm(
                "Merge the WHOLE timeline into one single clip?\n\nEverything (all tracks, segments and overlays) is rendered into a new clip that replaces the current timeline — handy after removing pauses, when you want one unbroken clip. Do any remaining edits first.",
              )
            )
              void mcpCall("merge_clips", {});
          }}
          disabled={!project}
          title="Flatten all clips/segments into a single continuous clip"
          className="rounded border border-neutral-700 px-3 py-1 text-xs font-medium text-neutral-200 hover:bg-neutral-800 disabled:opacity-40"
        >
          Merge
        </button>
        <button
          onClick={() => setShowBeatSync(true)}
          disabled={!project}
          title="Beat Sync: trim clips so every cut lands on a beat of a music track"
          className="rounded border border-neutral-700 px-3 py-1 text-xs font-medium text-neutral-200 hover:bg-neutral-800 disabled:opacity-40"
        >
          ♫ Beat Sync
        </button>
        <button
          onClick={() => setShowClips(true)}
          disabled={!project}
          title="AI Clips: automatically find the most viral moments of a long video and export them as vertical shorts with captions"
          className="rounded border border-violet-500/60 bg-violet-600/20 px-3 py-1 text-xs font-medium text-violet-200 hover:bg-violet-600/35 disabled:opacity-40"
        >
          AI Clips
        </button>
        <button
          onClick={() => setShowExport(true)}
          disabled={!project}
          className="rounded bg-neutral-200 px-3 py-1 text-xs font-medium text-neutral-900 hover:bg-white disabled:opacity-40"
        >
          Export
        </button>
      </div>

      {showClips && <AiClipsDialog onClose={() => setShowClips(false)} />}
      {showBeatSync && <BeatSyncDialog onClose={() => setShowBeatSync(false)} />}
      {showExport && <ExportDialog fps={fps} onClose={() => setShowExport(false)} />}
      {showHelp && <HelpDialog onClose={() => setShowHelp(false)} />}
      {showFeedback && <FeedbackDialog onClose={() => setShowFeedback(false)} />}
      {showConn && <ConnectionsDialog onClose={() => setShowConn(false)} />}
      {showProjects && <ProjectsDialog onClose={() => setShowProjects(false)} />}
    </header>
    {!connected && (
      // The tiny "offline" pill is easy to miss while every edit silently goes nowhere — make the
      // disconnected state unmistakable (the WS layer keeps retrying on its own).
      <div className="flex items-center justify-center gap-2 border-b border-red-900/60 bg-red-950/60 px-3 py-1 text-[11px] text-red-200">
        <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-red-400" />
        Connection to the editor engine lost — reconnecting… (edits won't apply until it's back)
      </div>
    )}
    </>
  );
}

function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={onClose}>
      <div
        className="w-[460px] max-w-[90vw] rounded-xl border border-neutral-700 bg-neutral-900 p-4 text-neutral-200 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-sm font-semibold">{title}</h2>
          <button onClick={onClose} className="text-neutral-500 hover:text-neutral-200">
            ✕
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

const EXPORT_RESOLUTIONS = [
  { label: "16:9 — 1920×1080", w: 1920, h: 1080 },
  { label: "16:9 4K — 3840×2160", w: 3840, h: 2160 },
  { label: "9:16 — 1080×1920", w: 1080, h: 1920 },
  { label: "9:16 4K — 2160×3840", w: 2160, h: 3840 },
  { label: "1:1 — 1080×1080", w: 1080, h: 1080 },
  { label: "1:1 4K — 2160×2160", w: 2160, h: 2160 },
  { label: "4:5 — 1080×1350", w: 1080, h: 1350 },
  { label: "4:5 4K — 2160×2700", w: 2160, h: 2700 },
  { label: "4:3 — 1440×1080", w: 1440, h: 1080 },
  { label: "21:9 — 2560×1080", w: 2560, h: 1080 },
];
// NTSC rates (23.976/29.97/59.94) are first-class: the bridge maps them to exact rationals.
const EXPORT_FPS = [23.976, 24, 25, 29.97, 30, 50, 59.94, 60];

function ExportDialog({ fps, onClose }: { fps: number; onClose: () => void }) {
  const { project } = useEditor();
  const [format, setFormat] = useState(EXPORT_FORMATS[0].id);
  const [quality, setQuality] = useState("high");
  const [name, setName] = useState("export");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ url?: string; text: string; error?: boolean } | null>(null);
  const curW = project?.timeline.width ?? 1920;
  const curH = project?.timeline.height ?? 1080;
  const [res, setRes] = useState(`${curW}x${curH}`);
  const [outFps, setOutFps] = useState(fps);
  // The export runs to the LONGEST track: when audio (music) outlasts the picture, everything after
  // the last visual clip is black — warn instead of silently producing a black tail.
  const total = project ? timelineTotalFrames(project.timeline) : 0;
  const visualEnd = Math.max(
    0,
    ...(project?.timeline.tracks ?? [])
      .filter((t) => t.type === "video" || t.type === "image" || t.type === "text")
      .flatMap((t) => t.clips.map((c) => c.startFrame + c.durationFrames)),
  );
  const blackTailSec = total > visualEnd && visualEnd > 0 ? (total - visualEnd) / fps : 0;

  const run = async () => {
    setBusy(true);
    setResult(null);
    // Resolution/fps drive both preview and export via the project format; apply changes first.
    const [w, h] = res.split("x").map(Number);
    if ((w && h && (w !== curW || h !== curH)) || outFps !== fps) {
      await mcpCall("set_project_format", { width: w || curW, height: h || curH, fps: outFps });
    }
    const ext = EXPORT_FORMATS.find((f) => f.id === format)?.ext ?? "mp4";
    const filename = `${name.replace(/\.[^.]+$/, "")}.${ext}`;
    // The USER export path: /export/run executes with source "user". The MCP route is reserved
    // for the agent and refuses export_video by design — routing the button through it was the
    // bug that showed users the agent-refusal message.
    let out: { ok: boolean; text: string };
    try {
      const r = await fetch(`${BRIDGE_HTTP}/export/run`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: filename, format, quality }),
      });
      out = (await r.json()) as { ok: boolean; text: string };
    } catch (e) {
      out = { ok: false, text: e instanceof Error ? e.message : String(e) };
    }
    const url = out.text.match(/https?:\/\/\S+/)?.[0];
    setResult({ url, text: out.text, error: !out.ok });
    setBusy(false);
  };

  const cancel = async () => {
    // Kill signal only — the awaited export_video call in run() unwinds with "Export cancelled."
    // and the bridge discards the partial file. Gate the optimistic note on `cancelled` so a
    // cancel that raced an already-finished export can't overwrite the real result.
    const r = await fetch(`${BRIDGE_HTTP}/export/cancel`, { method: "POST" });
    const { cancelled } = (await r.json()) as { cancelled: boolean };
    if (cancelled) {
      setBusy(false);
      setResult({ text: "Export cancelled" });
    }
  };

  return (
    <Modal title="Export" onClose={onClose}>
      <div className="space-y-3 text-xs">
        {blackTailSec > 0.5 && (
          <div className="rounded border border-amber-800 bg-amber-950/40 p-2 text-amber-200">
            ⚠ The picture ends at {(visualEnd / fps).toFixed(1)}s but the timeline lasts {(total / fps).toFixed(1)}s (audio runs longer) — the last{" "}
            {blackTailSec.toFixed(1)}s of the export will be black. Trim the audio if that's not intended.
          </div>
        )}
        <div className="grid grid-cols-2 gap-2">
          <label className="block">
            <span className="mb-1 block text-neutral-400">Resolution</span>
            <select
              value={EXPORT_RESOLUTIONS.some((r) => `${r.w}x${r.h}` === res) ? res : "__cur"}
              onChange={(e) => e.target.value !== "__cur" && setRes(e.target.value)}
              className="w-full rounded-md border border-neutral-700 bg-neutral-950 px-2 py-1.5 outline-none"
            >
              {!EXPORT_RESOLUTIONS.some((r) => `${r.w}x${r.h}` === res) && <option value="__cur">{res.replace("x", "×")} (current)</option>}
              {EXPORT_RESOLUTIONS.map((r) => (
                <option key={r.label} value={`${r.w}x${r.h}`}>
                  {r.label}
                </option>
              ))}
            </select>
          </label>
          <label className="block">
            <span className="mb-1 block text-neutral-400">Frame rate</span>
            <select
              value={outFps}
              onChange={(e) => setOutFps(Number(e.target.value))}
              className="w-full rounded-md border border-neutral-700 bg-neutral-950 px-2 py-1.5 outline-none"
            >
              {!EXPORT_FPS.includes(outFps) && <option value={outFps}>{outFps} fps</option>}
              {EXPORT_FPS.map((f) => (
                <option key={f} value={f}>
                  {f} fps
                </option>
              ))}
            </select>
          </label>
        </div>
        <label className="block">
          <span className="mb-1 block text-neutral-400">Format</span>
          <select
            value={format}
            onChange={(e) => setFormat(e.target.value)}
            className="w-full rounded-md border border-neutral-700 bg-neutral-950 px-2 py-1.5 outline-none"
          >
            {EXPORT_FORMATS.map((f) => (
              <option key={f.id} value={f.id}>
                {f.label}
              </option>
            ))}
          </select>
        </label>
        <label className="block">
          <span className="mb-1 block text-neutral-400">Quality</span>
          <select
            value={quality}
            onChange={(e) => setQuality(e.target.value)}
            className="w-full rounded-md border border-neutral-700 bg-neutral-950 px-2 py-1.5 outline-none"
          >
            <option value="draft">Draft — smallest file</option>
            <option value="standard">Standard</option>
            <option value="high">High (recommended)</option>
            <option value="max">Max — near-lossless</option>
          </select>
        </label>
        <label className="block">
          <span className="mb-1 block text-neutral-400">File name</span>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="w-full rounded-md border border-neutral-700 bg-neutral-950 px-2 py-1.5 outline-none"
          />
        </label>
        <p className="text-[11px] text-neutral-500">
          Timeline at {fps} fps. The file is saved in the project's <span className="font-mono">exports/</span> folder (a download link appears when done).
        </p>
        <button
          onClick={run}
          disabled={busy}
          className="w-full rounded-md bg-neutral-200 px-3 py-2 font-medium text-neutral-900 hover:bg-white disabled:opacity-50"
        >
          {busy ? "Exporting…" : "Export"}
        </button>
        {busy && (
          <button
            type="button"
            onClick={() => void cancel()}
            className="w-full rounded-md border border-neutral-700 px-3 py-1.5 text-neutral-300 hover:bg-neutral-800"
          >
            Cancel
          </button>
        )}
        {result && (
          <div className={result.error ? "text-red-400" : "text-neutral-300"}>
            {result.url ? (
              <>
                <button
                  type="button"
                  onClick={() => void downloadFile(result.url!)}
                  className="text-emerald-400 hover:underline"
                >
                  Download {result.url.split("/").pop()}
                </button>
                {/* Publish assist: local-only helper — opens the platform's upload page so the user
                  * drags the exported file in (no accounts/APIs are ever connected from here). */}
                <div className="mt-2 flex flex-wrap items-center gap-1.5 border-t border-neutral-800 pt-2 text-[11px] text-neutral-400">
                  <span>Post it:</span>
                  {[
                    { label: "YouTube", url: "https://studio.youtube.com/channel/upload" },
                    { label: "TikTok", url: "https://www.tiktok.com/tiktokstudio/upload" },
                    { label: "Instagram", url: "https://www.instagram.com/" },
                  ].map((p) => (
                    <a
                      key={p.label}
                      href={p.url}
                      target="_blank"
                      rel="noreferrer"
                      className="rounded border border-neutral-700 px-2 py-0.5 text-neutral-300 hover:bg-neutral-800"
                    >
                      {p.label} ↗
                    </a>
                  ))}
                  <span className="text-neutral-600">— download first, then drag the file into the upload page</span>
                </div>
              </>
            ) : (
              <span className="break-words">{result.text}</span>
            )}
          </div>
        )}
      </div>
    </Modal>
  );
}

interface AiClip {
  assetId: string;
  file: string;
  title: string;
  hook: string;
  score: number;
  startSeconds: number;
  endSeconds: number;
  reason: string;
}

function scoreColor(s: number): string {
  if (s >= 75) return "bg-emerald-500/20 text-emerald-300 border-emerald-500/50";
  if (s >= 50) return "bg-amber-500/20 text-amber-300 border-amber-500/50";
  return "bg-neutral-500/20 text-neutral-300 border-neutral-500/50";
}

// ── brand kit presets (AI Clips) — saved in localStorage, applied to the dialog fields ──────────

export interface BrandKit {
  name: string;
  captionStyle: string;
  titleOverlay: boolean;
  aspect: "9:16" | "original";
  watermarkPath: string;
  watermarkOpacity?: number;
}

const BRAND_KITS_KEY = "cupcat.brandkits";

/** Parse the persisted preset list; corrupt JSON / wrong shapes degrade to []. Pure — unit-tested. */
export function parseBrandKits(raw: string | null): BrandKit[] {
  if (!raw) return [];
  try {
    const arr = JSON.parse(raw) as unknown;
    if (!Array.isArray(arr)) return [];
    return arr.filter(
      (k): k is BrandKit =>
        !!k && typeof k === "object" && typeof (k as { name?: unknown }).name === "string" && (k as { name: string }).name.length > 0,
    );
  } catch {
    return [];
  }
}

function loadBrandKits(): BrandKit[] {
  try {
    return parseBrandKits(window.localStorage.getItem(BRAND_KITS_KEY));
  } catch {
    return [];
  }
}

function storeBrandKits(kits: BrandKit[]): void {
  try {
    window.localStorage.setItem(BRAND_KITS_KEY, JSON.stringify(kits));
  } catch {
    /* storage full/denied — presets just don't persist */
  }
}

const CAPTION_STYLES = ["karaoke", "clean", "boxed", "minimal"];

/** OpusClip-style auto clipping: pick a long video → Claude finds the best moments → each becomes a
 * vertical short (title + captions burned) exported to disk AND added to the library, presented as
 * rich result cards with virality score. */
function AiClipsDialog({ onClose }: { onClose: () => void }) {
  const { project } = useEditor();
  const videos = (project?.media ?? []).filter((m) => m.type === "video");
  const [media, setMedia] = useState(videos[0]?.id ?? "");
  const [count, setCount] = useState(3);
  const [minS, setMinS] = useState(15);
  const [maxS, setMaxS] = useState(60);
  const [aspect, setAspect] = useState<"9:16" | "original">("9:16");
  const [captions, setCaptions] = useState(true);
  const [capStyle, setCapStyle] = useState("karaoke");
  const [titleOverlay, setTitleOverlay] = useState(true);
  const [beep, setBeep] = useState("");
  const [prompt, setPrompt] = useState("");
  const [watermark, setWatermark] = useState("");
  const [busy, setBusy] = useState(false);
  const [clips, setClips] = useState<AiClip[] | null>(null);
  const [folder, setFolder] = useState("");
  const [error, setError] = useState<string | null>(null);
  const inputCls = "w-full rounded border border-neutral-700 bg-neutral-950 px-2 py-1.5 text-xs outline-none focus:border-neutral-500";

  // ── brand kit presets ────────────────────────────────────────────────────────
  const [kits, setKits] = useState<BrandKit[]>(() => loadBrandKits());
  const [kitName, setKitName] = useState("");
  // Opacity has no field of its own — an applied preset carries it straight into the auto_clips call.
  const [kitOpacity, setKitOpacity] = useState<number | undefined>(undefined);

  const applyKit = (name: string) => {
    setKitName(name);
    const k = kits.find((x) => x.name === name);
    if (!k) {
      setKitOpacity(undefined); // "None" — leave the fields as they are
      return;
    }
    setCapStyle(CAPTION_STYLES.includes(k.captionStyle) ? k.captionStyle : "karaoke");
    setTitleOverlay(!!k.titleOverlay);
    setAspect(k.aspect === "original" ? "original" : "9:16");
    setWatermark(typeof k.watermarkPath === "string" ? k.watermarkPath : "");
    setKitOpacity(typeof k.watermarkOpacity === "number" ? k.watermarkOpacity : undefined);
  };

  const saveKit = () => {
    const name = window.prompt("Preset name:", kitName || "My brand")?.trim();
    if (!name) return;
    const kit: BrandKit = {
      name,
      captionStyle: capStyle,
      titleOverlay,
      aspect,
      watermarkPath: watermark.trim(),
      ...(kitOpacity !== undefined ? { watermarkOpacity: kitOpacity } : {}),
    };
    const next = [...kits.filter((k) => k.name !== name), kit];
    setKits(next);
    storeBrandKits(next);
    setKitName(name);
  };

  const deleteKit = () => {
    if (!kitName) return;
    const next = kits.filter((k) => k.name !== kitName);
    setKits(next);
    storeBrandKits(next);
    setKitName("");
    setKitOpacity(undefined);
  };

  const runClips = async () => {
    if (!media || busy) return;
    setBusy(true);
    setError(null);
    setClips(null);
    const beepWords = beep
      .split(",")
      .map((w) => w.trim())
      .filter(Boolean);
    const out = await mcpCall("auto_clips", {
      media,
      count,
      minSeconds: minS,
      maxSeconds: maxS,
      aspect,
      captions,
      captionStyle: capStyle,
      titleOverlay,
      ...(beepWords.length ? { beepWords } : {}),
      ...(prompt.trim() ? { prompt: prompt.trim() } : {}),
      ...(watermark.trim() ? { watermarkPath: watermark.trim() } : {}),
      ...(watermark.trim() && kitOpacity !== undefined ? { watermarkOpacity: kitOpacity } : {}),
    });
    setBusy(false);
    if (out.isError) {
      setError(out.text || "Clip generation failed.");
      return;
    }
    // Rich result cards from the machine-readable block; plain text stays as a fallback.
    const jsonBlock = (out.content as { type: string; text?: string }[])
      .map((c) => c.text ?? "")
      .find((t) => t.startsWith("AUTO_CLIPS_JSON:"));
    if (jsonBlock) {
      try {
        const parsed = JSON.parse(jsonBlock.slice("AUTO_CLIPS_JSON:".length)) as { clips: AiClip[]; folder: string };
        setClips(parsed.clips);
        setFolder(parsed.folder);
        return;
      } catch {
        /* fall through to text */
      }
    }
    setError(null);
    setClips([]);
    setFolder(out.text);
  };
  return (
    <Modal title="AI Clips — auto shorts from a long video" onClose={onClose}>
      <div className="flex max-h-[78vh] flex-col gap-3 overflow-y-auto text-xs">
        {!clips && (
          <>
            <div className="flex items-end gap-2">
              <label className="flex min-w-0 flex-1 flex-col gap-1">
                <span className="text-neutral-400">Brand preset</span>
                <select value={kitName} onChange={(e) => applyKit(e.target.value)} className={inputCls} disabled={busy}>
                  <option value="">None</option>
                  {kits.map((k) => (
                    <option key={k.name} value={k.name}>
                      {k.name}
                    </option>
                  ))}
                </select>
              </label>
              <button
                onClick={saveKit}
                disabled={busy}
                title="Save the current caption style, title overlay, format and watermark as a reusable preset"
                className="shrink-0 rounded border border-neutral-700 px-2 py-1.5 text-neutral-300 hover:bg-neutral-800 disabled:opacity-40"
              >
                Save as preset…
              </button>
              <button
                onClick={deleteKit}
                disabled={busy || !kitName}
                title="Delete the selected preset"
                className="shrink-0 rounded border border-neutral-700 px-2 py-1.5 text-neutral-500 hover:bg-neutral-800 hover:text-red-400 disabled:opacity-40"
              >
                🗑
              </button>
            </div>
            <label className="flex flex-col gap-1">
              <span className="text-neutral-400">Video</span>
              <select value={media} onChange={(e) => setMedia(e.target.value)} className={inputCls} disabled={busy}>
                {videos.length === 0 && <option value="">(no videos in the library)</option>}
                {videos.map((v) => (
                  <option key={v.id} value={v.id}>
                    {v.name}
                  </option>
                ))}
              </select>
            </label>
            <div className="grid grid-cols-3 gap-2">
              <label className="flex flex-col gap-1">
                <span className="text-neutral-400">Clips</span>
                <input type="number" min={1} max={10} value={count} onChange={(e) => setCount(Number(e.target.value) || 3)} className={inputCls} disabled={busy} />
              </label>
              <label className="flex flex-col gap-1">
                <span className="text-neutral-400">Min (s)</span>
                <input type="number" min={3} value={minS} onChange={(e) => setMinS(Number(e.target.value) || 15)} className={inputCls} disabled={busy} />
              </label>
              <label className="flex flex-col gap-1">
                <span className="text-neutral-400">Max (s)</span>
                <input type="number" min={5} value={maxS} onChange={(e) => setMaxS(Number(e.target.value) || 60)} className={inputCls} disabled={busy} />
              </label>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <label className="flex flex-col gap-1">
                <span className="text-neutral-400">Format</span>
                <select value={aspect} onChange={(e) => setAspect(e.target.value as "9:16" | "original")} className={inputCls} disabled={busy}>
                  <option value="9:16">9:16 vertical (Shorts/Reels/TikTok)</option>
                  <option value="original">Original aspect</option>
                </select>
              </label>
              <label className="flex flex-col gap-1">
                <span className="text-neutral-400">Caption style</span>
                <select value={capStyle} onChange={(e) => setCapStyle(e.target.value)} className={inputCls} disabled={busy || !captions}>
                  <option value="karaoke">Karaoke — yellow active word</option>
                  <option value="clean">Clean — bold white</option>
                  <option value="boxed">Boxed — white on dark box</option>
                  <option value="minimal">Minimal — small subtitles</option>
                </select>
              </label>
            </div>
            <div className="flex items-center gap-5">
              <label className="flex items-center gap-2 text-neutral-300">
                <input type="checkbox" checked={captions} onChange={(e) => setCaptions(e.target.checked)} disabled={busy} />
                Captions
              </label>
              <label className="flex items-center gap-2 text-neutral-300" title="Burns the AI title at the top of the clip for the first seconds">
                <input type="checkbox" checked={titleOverlay} onChange={(e) => setTitleOverlay(e.target.checked)} disabled={busy} />
                Title overlay
              </label>
            </div>
            <label className="flex flex-col gap-1">
              <span className="text-neutral-400">Beep words (optional, comma-separated) — censored with a beep</span>
              <input value={beep} onChange={(e) => setBeep(e.target.value)} className={inputCls} disabled={busy} placeholder="e.g. brandname, competitor" />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-neutral-400">Guidance (optional) — e.g. "only the moments about pricing"</span>
              <input value={prompt} onChange={(e) => setPrompt(e.target.value)} className={inputCls} disabled={busy} placeholder="Leave empty for the most viral moments overall" />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-neutral-400">Watermark PNG (optional) — absolute path</span>
              <input value={watermark} onChange={(e) => setWatermark(e.target.value)} className={inputCls} disabled={busy} placeholder="D:\brand\logo.png" />
            </label>
          </>
        )}
        {error && <div className="whitespace-pre-wrap rounded border border-red-900 bg-red-950/40 p-2 text-red-300">{error}</div>}
        {clips && clips.length > 0 && (
          <div className="flex flex-col gap-2">
            {clips.map((c, i) => (
              <div key={c.assetId || i} className="flex gap-3 rounded-lg border border-neutral-800 bg-neutral-950/60 p-2">
                <div className="h-24 w-14 shrink-0 overflow-hidden rounded bg-neutral-900">
                  {c.assetId && <img src={mediaUrl(c.assetId) + "?thumb=1"} className="h-full w-full object-cover" alt="" />}
                </div>
                <div className="flex min-w-0 flex-1 flex-col gap-1">
                  <div className="flex items-center gap-2">
                    <span className={`shrink-0 rounded border px-1.5 py-0.5 text-[10px] font-semibold ${scoreColor(c.score)}`}>{c.score}</span>
                    <span className="truncate font-medium text-neutral-100" title={c.title}>
                      {c.title}
                    </span>
                  </div>
                  <div className="truncate text-neutral-400" title={c.hook}>
                    {c.hook}
                  </div>
                  <div className="text-[10px] text-neutral-500">
                    {c.startSeconds.toFixed(1)}s → {c.endSeconds.toFixed(1)}s · {(c.endSeconds - c.startSeconds).toFixed(0)}s
                  </div>
                </div>
              </div>
            ))}
            <div className="text-[10px] text-neutral-500">
              Saved in <span className="select-all text-neutral-400">{folder}</span> and added to the library — drag them to the timeline or export as-is.
            </div>
          </div>
        )}
        {clips && clips.length === 0 && folder && <div className="whitespace-pre-wrap rounded border border-emerald-900 bg-emerald-950/30 p-2 text-emerald-200">{folder}</div>}
        <div className="flex items-center justify-between">
          <span className="text-neutral-500">
            {busy ? "Working — transcribe → curate → export (≈1 min per clip)…" : clips ? "" : "Clips land in exports/ and in the library."}
          </span>
          {clips ? (
            <button onClick={() => setClips(null)} className="rounded border border-neutral-700 px-4 py-1.5 font-medium text-neutral-200 hover:bg-neutral-800">
              New batch
            </button>
          ) : (
            <button
              onClick={() => void runClips()}
              disabled={busy || !media}
              className="rounded bg-violet-600 px-4 py-1.5 font-medium text-white hover:bg-violet-500 disabled:opacity-40"
            >
              {busy ? "Creating…" : "Create clips"}
            </button>
          )}
        </div>
      </div>
    </Modal>
  );
}

// ── beat sync ───────────────────────────────────────────────────────────────────────────────────

export interface BeatDetection {
  bpm: number;
  confidence: number;
  beatCount: number;
}

/** Below this the beat grid is guesswork (quiet/beatless track) — syncing would cut at random. */
const MIN_BEAT_CONFIDENCE = 0.05;

/** Parse the detect_beats tool output (a JSON text payload). Pure — unit-tested. */
export function parseBeatDetection(text: string): BeatDetection | null {
  try {
    const j = JSON.parse(text) as { bpm?: unknown; confidence?: unknown; beatCount?: unknown };
    if (typeof j.bpm !== "number" || typeof j.confidence !== "number") return null;
    return { bpm: j.bpm, confidence: j.confidence, beatCount: typeof j.beatCount === "number" ? j.beatCount : 0 };
  } catch {
    return null;
  }
}

/** CapCut-style beat sync: pick a music track → detect its beats → ripple-trim the video track so
 * every cut lands on a beat. Manual counterpart of the chat "cut to the music" flow. */
function BeatSyncDialog({ onClose }: { onClose: () => void }) {
  const { project } = useEditor();
  const audios = (project?.media ?? []).filter((m) => m.type === "audio");
  const [media, setMedia] = useState(audios[0]?.id ?? "");
  const [beatEvery, setBeatEvery] = useState(1);
  const [minClip, setMinClip] = useState(1);
  const [busy, setBusy] = useState(false);
  const [detection, setDetection] = useState<BeatDetection | null>(null);
  const [detectError, setDetectError] = useState<string | null>(null);
  const [result, setResult] = useState<{ text: string; isError: boolean } | null>(null);
  const inputCls = "w-full rounded border border-neutral-700 bg-neutral-950 px-2 py-1.5 text-xs outline-none focus:border-neutral-500";

  const pickMedia = (id: string) => {
    setMedia(id);
    // stale analysis of another track must not gate (or un-gate) the Sync button
    setDetection(null);
    setDetectError(null);
    setResult(null);
  };

  const detect = async () => {
    if (!media || busy) return;
    setBusy(true);
    setDetection(null);
    setDetectError(null);
    setResult(null);
    const out = await mcpCall("detect_beats", { media });
    setBusy(false);
    if (out.isError) {
      setDetectError(out.text || "Beat detection failed.");
      return;
    }
    const d = parseBeatDetection(out.text);
    if (d) setDetection(d);
    else setDetectError(out.text || "Could not read the detection result.");
  };

  const sync = async () => {
    if (!media || busy) return;
    setBusy(true);
    setResult(null);
    const out = await mcpCall("sync_to_beats", { media, beatEvery, minClipSeconds: minClip });
    setBusy(false);
    setResult({ text: out.text || (out.isError ? "Beat sync failed." : "Done."), isError: out.isError });
  };

  const lowConfidence = detection !== null && detection.confidence < MIN_BEAT_CONFIDENCE;

  return (
    <Modal title="♫ Beat Sync — cut to the music" onClose={onClose}>
      <div className="flex max-h-[78vh] flex-col gap-3 overflow-y-auto text-xs">
        <label className="flex flex-col gap-1">
          <span className="text-neutral-400">Music</span>
          <select value={media} onChange={(e) => pickMedia(e.target.value)} className={inputCls} disabled={busy}>
            {audios.length === 0 && <option value="">(no audio in the library)</option>}
            {audios.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
        </label>
        <div className="grid grid-cols-2 gap-2">
          <label className="flex flex-col gap-1">
            <span className="text-neutral-400">Cut every</span>
            <select value={beatEvery} onChange={(e) => setBeatEvery(Number(e.target.value))} className={inputCls} disabled={busy}>
              <option value={1}>Every beat</option>
              <option value={2}>Every 2 beats</option>
              <option value={4}>Every 4 beats (bar)</option>
            </select>
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-neutral-400">Min clip (s)</span>
            <input
              type="number"
              min={0.2}
              step={0.1}
              value={minClip}
              onChange={(e) => setMinClip(Number(e.target.value) || 1)}
              className={inputCls}
              disabled={busy}
            />
          </label>
        </div>
        <p className="text-[11px] text-neutral-500">
          Trims the clips on the first video track so every cut lands on a beat. Clips only get shorter — run Detect first to check the track.
        </p>
        {detection && (
          <div
            className={`rounded border p-2 ${
              lowConfidence ? "border-amber-800 bg-amber-950/40 text-amber-200" : "border-emerald-900 bg-emerald-950/30 text-emerald-200"
            }`}
          >
            {Math.round(detection.bpm)} BPM · confidence {detection.confidence.toFixed(2)} · {detection.beatCount} beats
            {lowConfidence && (
              <div className="mt-1 text-[11px]">
                Confidence is below {MIN_BEAT_CONFIDENCE} — no reliable beat grid in this track (too quiet or beatless), so syncing would
                cut at random. Pick another track.
              </div>
            )}
          </div>
        )}
        {detectError && <div className="whitespace-pre-wrap rounded border border-red-900 bg-red-950/40 p-2 text-red-300">{detectError}</div>}
        {result && (
          <div
            className={`whitespace-pre-wrap rounded border p-2 ${
              result.isError ? "border-red-900 bg-red-950/40 text-red-300" : "border-emerald-900 bg-emerald-950/30 text-emerald-200"
            }`}
          >
            {result.text}
          </div>
        )}
        <div className="flex items-center justify-end gap-2">
          <button
            onClick={() => void detect()}
            disabled={busy || !media}
            className="rounded border border-neutral-700 px-4 py-1.5 font-medium text-neutral-200 hover:bg-neutral-800 disabled:opacity-40"
          >
            {busy ? "Working…" : "Detect"}
          </button>
          <button
            onClick={() => void sync()}
            disabled={busy || !media || lowConfidence}
            title={lowConfidence ? "Beat confidence is too low to sync — pick another track" : "Trim the video track so cuts land on the beats"}
            className="rounded bg-violet-600 px-4 py-1.5 font-medium text-white hover:bg-violet-500 disabled:opacity-40"
          >
            Sync cuts
          </button>
        </div>
      </div>
    </Modal>
  );
}

/** Real user help: first steps + shortcuts + glossary; the MCP connection command moved to its own
 * section at the bottom (this dialog used to be ONLY that, which is useless to a beginner). */
function HelpDialog({ onClose }: { onClose: () => void }) {
  const cmd = `claude mcp add --transport http cupcat ${BRIDGE_HTTP}/mcp`;
  const h = "mb-1 mt-3 block text-[11px] font-semibold uppercase tracking-wide text-neutral-400";
  return (
    <Modal title="Help" onClose={onClose}>
      <div className="max-h-[70vh] space-y-1 overflow-y-auto text-xs text-neutral-300">
        <span className={h}>Getting started</span>
        <ol className="list-decimal space-y-1 pl-4">
          <li>Drop video/audio/image files into the Library (left) — or just copy them into the project folder.</li>
          <li>Drag media onto the timeline. Click the ruler to move the playhead; Space plays/pauses.</li>
          <li>The fastest way to edit: ask the assistant in the chat panel — "remove the pauses", "make 3 vertical clips", "cut to the music beat".</li>
          <li>Export (top right) renders the timeline; files land in the project's <span className="font-mono">exports/</span> folder.</li>
        </ol>
        <span className={h}>Shortcuts</span>
        {/* Editable: click a key chip, press the new combo. Backed by the action registry. */}
        <ShortcutsEditor />
        <ul className="space-y-0.5 pl-1 pt-1">
          <li><span className="font-mono text-neutral-200">Click ruler</span> — seek · <span className="font-mono text-neutral-200">drag clip edges</span> — trim (<span className="font-mono">Shift</span> = ripple)</li>
          <li><span className="font-mono text-neutral-200">Double-click preview</span> — select that clip</li>
          <li>Markers: right-click a marker flag to edit its note or delete it</li>
        </ul>
        <span className={h}>Glossary</span>
        <ul className="space-y-0.5 pl-1">
          <li><b>Split</b> — cut the selected clip in two at the playhead (playhead must be inside it).</li>
          <li><b>Matte</b> — a solid-color background clip (use the swatch to pick the color).</li>
          <li><b>Bake</b> — flatten the selected clip (with effects/speed) into a new library asset.</li>
          <li><b>Merge</b> — render the whole timeline into ONE clip that replaces it.</li>
          <li><b>AI Clips</b> — auto-find the best moments of a long video and export them as vertical shorts.</li>
          <li><b>Timecode</b> — shown as min:sec:<i>frame</i> (the last number is frames, not hundredths).</li>
        </ul>
        <span className={h}>Connect an external agent (advanced)</span>
        <p>CupCat runs a local MCP server — Claude Code, Cursor or Claude Desktop can edit this project with full context:</p>
        <code className="block break-all rounded-md border border-neutral-700 bg-neutral-950 px-2 py-1.5 font-mono text-[11px] text-neutral-200">{cmd}</code>
        <p className="text-[11px] text-neutral-500">
          Other clients: add an HTTP MCP server pointing at <span className="font-mono">{BRIDGE_HTTP}/mcp</span>.
        </p>
      </div>
    </Modal>
  );
}

/** Feedback → the bridge builds a diagnostic package on disk (report + screenshot + project +
 * logs); nothing is uploaded — the user sends the resulting file to the developer manually. */
function FeedbackDialog({ onClose }: { onClose: () => void }) {
  const [type, setType] = useState("bug");
  const [description, setDescription] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [path, setPath] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const inputCls = "w-full rounded-md border border-neutral-700 bg-neutral-950 px-2 py-1.5 outline-none";

  const submit = async () => {
    if (!description.trim() || busy) return;
    setBusy(true);
    setError(null);
    const res = await sendFeedback(type, description.trim());
    setBusy(false);
    if (res.ok && res.path) setPath(res.path);
    else setError(res.error || "Creazione del pacchetto fallita — il bridge è raggiungibile?");
  };

  const copyPath = () => {
    if (!path) return;
    navigator.clipboard.writeText(path).then(
      () => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      },
      () => setError("Copia negli appunti non riuscita — seleziona e copia il percorso a mano."),
    );
  };

  return (
    <Modal title="Feedback" onClose={onClose}>
      <div className="space-y-3 text-xs">
        {!path ? (
          <>
            <label className="block">
              <span className="mb-1 block text-neutral-400">Tipo</span>
              <select value={type} onChange={(e) => setType(e.target.value)} className={inputCls} disabled={busy}>
                <option value="bug">Bug</option>
                <option value="idea">Idea</option>
                <option value="other">Altro</option>
              </select>
            </label>
            <label className="block">
              <span className="mb-1 block text-neutral-400">Descrizione</span>
              <textarea
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                rows={4}
                placeholder="Cosa è successo? Cosa ti aspettavi?"
                className={`${inputCls} resize-y`}
                disabled={busy}
              />
            </label>
            <p className="text-[11px] text-neutral-500">Il pacchetto include screenshot, progetto e log — controlla prima di inviarlo.</p>
            {error && <div className="rounded border border-red-900 bg-red-950/40 p-2 text-red-300">{error}</div>}
            <button
              onClick={() => void submit()}
              disabled={busy || !description.trim()}
              className="w-full rounded-md bg-neutral-200 px-3 py-2 font-medium text-neutral-900 hover:bg-white disabled:opacity-50"
            >
              {busy ? "Creazione pacchetto…" : "Crea pacchetto feedback"}
            </button>
          </>
        ) : (
          <>
            <div className="rounded border border-emerald-900 bg-emerald-950/30 p-2 text-emerald-200">
              Pacchetto creato: <span className="select-all break-all font-mono text-[11px]">{path}</span>
            </div>
            <p className="text-neutral-400">Invialo allo sviluppatore (mail, chat…) allegando il file.</p>
            <button onClick={copyPath} className="w-full rounded-md bg-neutral-200 px-3 py-2 font-medium text-neutral-900 hover:bg-white">
              {copied ? "Copiato ✓" : "Copia percorso"}
            </button>
            {error && <div className="rounded border border-red-900 bg-red-950/40 p-2 text-red-300">{error}</div>}
          </>
        )}
      </div>
    </Modal>
  );
}

function ConnectionsDialog({ onClose }: { onClose: () => void }) {
  const { agentHasKey, canGenerate, claudeExpiresAt, setupBusy } = useEditor();
  const claudeWhen =
    claudeExpiresAt && agentHasKey ? `valid until ${new Date(claudeExpiresAt).toLocaleString()}` : null;

  const Row = ({
    name,
    ok,
    detail,
    children,
  }: {
    name: string;
    ok: boolean;
    detail: string;
    children?: React.ReactNode;
  }) => (
    <div className="rounded-md border border-neutral-700 bg-neutral-950 p-3">
      <div className="flex items-center justify-between">
        <span className="flex items-center gap-2 font-medium">
          <span className={`h-2 w-2 rounded-full ${ok ? "bg-emerald-400" : "bg-red-400"}`} />
          {name}
        </span>
        <span className={ok ? "text-emerald-400" : "text-red-400"}>{ok ? "Connected" : "Not connected"}</span>
      </div>
      <p className="mt-1 text-[11px] text-neutral-500">{detail}</p>
      {children && <div className="mt-2 flex gap-2">{children}</div>}
    </div>
  );

  return (
    <Modal title="Connections" onClose={onClose}>
      <div className="space-y-3 text-xs">
        <Row
          name="Claude"
          ok={agentHasKey}
          detail={
            agentHasKey
              ? `Signed in with your Claude subscription${claudeWhen ? ` — ${claudeWhen}` : ""}. Opus, Fable, Sonnet and Haiku are available.`
              : "Not signed in. CupCat uses your Claude subscription via Claude Code — open Claude Code and sign in, then Re-check."
          }
        />
        <Row
          name="Higgsfield"
          ok={canGenerate}
          detail={
            canGenerate
              ? "Signed in. Image / video / audio generation is available."
              : "Not signed in. Click Sign in to open the Higgsfield login in your browser."
          }
        >
          {!canGenerate && (
            <button
              onClick={higgsfieldLogin}
              disabled={setupBusy}
              className="rounded-md bg-neutral-200 px-3 py-1 font-medium text-neutral-900 hover:bg-white disabled:opacity-50"
            >
              {setupBusy ? "Opening…" : "Sign in to Higgsfield"}
            </button>
          )}
        </Row>
        <button
          onClick={recheckConnections}
          disabled={setupBusy}
          className="w-full rounded-md border border-neutral-700 px-3 py-2 hover:bg-neutral-800 disabled:opacity-50"
        >
          {setupBusy ? "Checking…" : "Re-check connections"}
        </button>
        <p className="text-[11px] text-neutral-500">Status refreshes automatically every 25s while the app is open.</p>
      </div>
    </Modal>
  );
}

function ProjectsDialog({ onClose }: { onClose: () => void }) {
  const [projects, setProjects] = useState<ProjectEntry[]>([]);
  const [newName, setNewName] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    void listProjects().then(setProjects);
  }, []);
  const open = async (name: string, action: "switch" | "create") => {
    setBusy(true);
    await openProject(name, action);
    setBusy(false);
    onClose(); // the new project arrives via the WebSocket state broadcast
  };
  // Creating a project asks WHERE first: the native folder picker chooses the parent, and the
  // project becomes a new folder named after it in there. Cancelling the picker cancels creation.
  const createNew = async () => {
    const name = newName.trim();
    if (!name) return;
    const parent = await pickFolder();
    if (!parent) return;
    const safe = name.replace(/[<>:"/\\|?*]/g, "_");
    await open(`${parent.replace(/[\\/]+$/, "")}\\${safe}`, "create");
  };
  const del = async (path: string, name: string) => {
    if (!window.confirm(`Remove "${name}" from your projects? (Folders you opened from disk are only unlinked; their files stay.)`)) return;
    setBusy(true);
    const list = await openProject(path, "delete");
    setProjects(list);
    setBusy(false);
  };
  return (
    <Modal title="Projects" onClose={onClose}>
      <div className="space-y-3 text-xs">
        <div className="max-h-60 space-y-1 overflow-y-auto">
          {projects.length === 0 && <p className="text-neutral-500">No projects yet.</p>}
          {projects.map((p) => (
            <div
              key={p.path}
              className={`flex items-center gap-1 rounded-md border ${
                p.current ? "border-neutral-500 bg-neutral-800" : "border-neutral-700"
              }`}
            >
              <button
                disabled={busy || p.current}
                onClick={() => open(p.path, "switch")}
                className="flex flex-1 items-center justify-between px-3 py-2 text-left text-neutral-100 hover:bg-neutral-700/40 disabled:cursor-default"
                title={p.path}
              >
                <span className="truncate">{p.name}</span>
                {p.current && <span className="text-[10px] text-emerald-400">current</span>}
              </button>
              <button
                onClick={() => del(p.path, p.name)}
                disabled={busy}
                title="Delete project (removes its folder + media)"
                className="px-2 py-2 text-neutral-500 hover:text-red-400 disabled:opacity-40"
              >
                🗑
              </button>
            </div>
          ))}
        </div>
        <div className="border-t border-neutral-800 pt-3">
          <button
            onClick={async () => {
              const p = await pickFolder();
              if (p) await open(p, "switch");
            }}
            disabled={busy}
            className="w-full rounded-md border border-neutral-700 px-3 py-1.5 hover:bg-neutral-800 disabled:opacity-50"
          >
            Browse for a folder…
          </button>
        </div>
        <div className="flex gap-2">
          <input
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && newName.trim() && createNew()}
            placeholder="or new project name"
            className="min-w-0 flex-1 rounded-md border border-neutral-700 bg-neutral-950 px-2 py-1.5 outline-none"
          />
          <button
            onClick={() => createNew()}
            disabled={busy || !newName.trim()}
            title="Choose where to create the project folder"
            className="rounded-md bg-neutral-200 px-3 py-1 font-medium text-neutral-900 hover:bg-white disabled:opacity-50"
          >
            Create…
          </button>
        </div>
      </div>
    </Modal>
  );
}
