import { useEffect, useState } from "react";
import { LOOKS } from "@cupcat/editor-core";
import type { Clip, ColorGrade, Effect, Interpolation, MediaAsset, Project } from "@cupcat/editor-core";
import { computeReframeKeyframes, fitHeightWidth, positionRows, waitForVideoMetadata } from "./autoReframe";
import { KeyframeCurveEditor } from "./KeyframeCurveEditor";
import { mergeKfRows, pairRows, scalarRows, trackEasing } from "./kfRows";
import { NumberField } from "./NumberField";
import { mcpCall, mediaUrl, sendCommand, ui, useEditor } from "./store";

// Default font set for text/caption clips. Values are the fontName stored in textStyle; the export
// maps each to a Windows system font file. CSS uses the family directly in the preview.
const FONT_OPTIONS: { value: string; label: string; css: string }[] = [
  { value: "Helvetica-Bold", label: "Helvetica Bold (default)", css: "Arial, Helvetica, sans-serif" },
  { value: "Arial", label: "Arial", css: "Arial, sans-serif" },
  { value: "Georgia", label: "Georgia", css: "Georgia, serif" },
  { value: "Times New Roman", label: "Times New Roman", css: "'Times New Roman', Times, serif" },
  { value: "Verdana", label: "Verdana", css: "Verdana, sans-serif" },
  { value: "Trebuchet MS", label: "Trebuchet MS", css: "'Trebuchet MS', sans-serif" },
  { value: "Courier New", label: "Courier New", css: "'Courier New', monospace" },
  { value: "Impact", label: "Impact", css: "Impact, sans-serif" },
  { value: "Comic Sans MS", label: "Comic Sans MS", css: "'Comic Sans MS', cursive" },
  // Windows 10/11 system fonts — each verified to exist as a .ttf in C:/Windows/Fonts so the
  // export's drawtext mapping (bridge FONT_FILES) can never point at a missing file.
  { value: "Segoe UI", label: "Segoe UI", css: "'Segoe UI', sans-serif" },
  { value: "Segoe UI Semibold", label: "Segoe UI Semibold", css: "'Segoe UI Semibold', 'Segoe UI', sans-serif" },
  { value: "Bahnschrift", label: "Bahnschrift", css: "Bahnschrift, sans-serif" },
  { value: "Candara", label: "Candara", css: "Candara, sans-serif" },
  { value: "Consolas", label: "Consolas", css: "Consolas, monospace" },
  { value: "Constantia", label: "Constantia", css: "Constantia, serif" },
  { value: "Corbel", label: "Corbel", css: "Corbel, sans-serif" },
];

// ─── tool payload builders (pure — unit-tested in fxPayloads.test.ts) ────────
// The bridge expects these EXACT shapes; keep them free of component state.

export type VoiceFxType = "none" | "pitch" | "robot" | "echo" | "radio";

/** apply_effect payload that sets/updates the clip's look filter. */
export function lookApplyPayload(clipId: string, name: string, amount: number): Record<string, unknown> {
  return { clipIds: [clipId], effects: [{ type: "look", params: { name, amount } }] };
}

/** apply_effect payload that removes the look filter. */
export function lookRemovePayload(clipId: string): Record<string, unknown> {
  return { clipIds: [clipId], remove: ["look"] };
}

/** set_clip_properties payload for a voice effect. pitch → amount in semitones, echo → amount in
 * seconds of delay, robot/radio → no amount, none → audioFx: null (removes the effect). */
export function voiceFxPayload(clipId: string, type: VoiceFxType, amount?: number): Record<string, unknown> {
  if (type === "none") return { clipIds: [clipId], audioFx: null };
  if (type === "pitch" || type === "echo") return { clipIds: [clipId], audioFx: { type, amount } };
  return { clipIds: [clipId], audioFx: { type } };
}

// ─── top-level export ────────────────────────────────────────────────────────

export function Inspector() {
  const { project, playhead, selectedClipIds, selectedAssetIds, canGenerate } = useEditor();

  // resolve active target
  let activeClip: Clip | undefined;
  let clipAsset: MediaAsset | undefined;
  let activeAsset: MediaAsset | undefined;
  let activeClipTrackIndex = 0;

  if (project && selectedClipIds[0]) {
    const id = selectedClipIds[0];
    for (let ti = 0; ti < project.timeline.tracks.length; ti++) {
      const c = project.timeline.tracks[ti].clips.find((x) => x.id === id);
      if (c) {
        activeClip = c;
        activeClipTrackIndex = ti;
        break;
      }
    }
    if (activeClip) {
      clipAsset = project.media.find((m) => m.id === activeClip!.mediaRef);
    }
  } else if (project && selectedAssetIds[0]) {
    const id = selectedAssetIds[0];
    activeAsset = project.media.find((m) => m.id === id);
  }

  return (
    <aside className="flex w-64 shrink-0 flex-col border-l border-neutral-800 bg-neutral-950">
      {/* header bar */}
      <div className="border-b border-neutral-800 px-3 py-2 text-[11px] font-semibold uppercase tracking-widest text-neutral-400">
        Details
      </div>

      <div className="flex-1 overflow-y-auto">
        {activeClip ? (
          <ClipInspector
            clip={activeClip}
            asset={clipAsset}
            playhead={playhead}
            canGenerate={canGenerate}
            trackIndex={activeClipTrackIndex}
            projectMedia={project?.media ?? []}
          />
        ) : activeAsset ? (
          <AssetInspector
            asset={activeAsset}
            playhead={playhead}
            canGenerate={canGenerate}
          />
        ) : project ? (
          <ProjectInspector project={project} />
        ) : (
          <div className="flex h-full items-center justify-center p-6 text-center text-[11px] text-neutral-500">
            Select a clip or asset
          </div>
        )}
      </div>
    </aside>
  );
}

// ─── Project inspector (shown when nothing is selected) ─────────────────────────

const FORMAT_PRESETS = [
  { label: "16:9 — 1920×1080", value: "1920x1080" },
  { label: "9:16 — 1080×1920", value: "1080x1920" },
  { label: "1:1 — 1080×1080", value: "1080x1080" },
  { label: "4:5 — 1080×1350", value: "1080x1350" },
  { label: "4K 16:9 — 3840×2160", value: "3840x2160" },
];

function ProjectInspector({ project }: { project: Project }) {
  const tl = project.timeline;
  const cur = `${tl.width}x${tl.height}`;
  const known = FORMAT_PRESETS.some((p) => p.value === cur);
  // NTSC rates (23.976/29.97/59.94) are first-class: the bridge maps them to exact rationals.
  const fpsList = [23.976, 24, 25, 29.97, 30, 50, 59.94, 60];
  return (
    <div className="space-y-4 p-3 text-[11px]">
      <h3 className="text-[10px] font-semibold uppercase tracking-wide text-neutral-400">Project settings</h3>
      <div>
        <label className="mb-1 block text-neutral-500">Resolution</label>
        <select
          value={known ? cur : "__custom"}
          onChange={(e) => {
            const [w, h] = e.target.value.split("x").map(Number);
            if (w && h) sendCommand("set_project_format", { width: w, height: h });
          }}
          className="w-full rounded border border-neutral-700 bg-neutral-800 px-2 py-1 text-neutral-100"
        >
          {!known && (
            <option value="__custom">
              {tl.width}×{tl.height} (custom)
            </option>
          )}
          {FORMAT_PRESETS.map((p) => (
            <option key={p.value} value={p.value}>
              {p.label}
            </option>
          ))}
        </select>
      </div>
      <div>
        <label className="mb-1 block text-neutral-500">Frame rate</label>
        <select
          value={tl.fps}
          onChange={(e) => sendCommand("set_project_format", { width: tl.width, height: tl.height, fps: Number(e.target.value) })}
          className="w-full rounded border border-neutral-700 bg-neutral-800 px-2 py-1 text-neutral-100"
        >
          {!fpsList.includes(tl.fps) && <option value={tl.fps}>{tl.fps} fps</option>}
          {fpsList.map((f) => (
            <option key={f} value={f}>
              {f} fps
            </option>
          ))}
        </select>
      </div>
      <p className="border-t border-neutral-800 pt-3 text-neutral-600">Select a clip or asset to edit it.</p>
    </div>
  );
}

// ─── Clip inspector ───────────────────────────────────────────────────────────

interface ClipInspectorProps {
  clip: Clip;
  asset: MediaAsset | undefined;
  playhead: number;
  canGenerate: boolean;
  trackIndex: number;
  projectMedia: MediaAsset[];
}

function ClipInspector({ clip, asset, playhead, canGenerate, trackIndex, projectMedia }: ClipInspectorProps) {
  // local state seeded from clip, re-seeded when clip.id changes
  const [duration, setDuration] = useState(clip.durationFrames);
  const [speed, setSpeed] = useState(clip.speed);
  const [opacity, setOpacity] = useState(clip.opacity);
  const [volume, setVolume] = useState(clip.volume);
  const [textContent, setTextContent] = useState(clip.textContent ?? "");
  const [fontName, setFontName] = useState(clip.textStyle?.fontName ?? "Helvetica-Bold");
  const [fontSize, setFontSize] = useState(clip.textStyle?.fontSize ?? 96);
  const [color, setColor] = useState(clip.textStyle?.color ?? "#ffffff");
  const [alignment, setAlignment] = useState<"left" | "center" | "right">(
    (clip.textStyle?.alignment as "left" | "center" | "right") ?? "left",
  );
  const [status, setStatus] = useState<{ text: string; isError: boolean } | null>(null);

  // ── color grade local state (seeded from clip.color) ────────────────────────
  const [cgExposure,    setCgExposure]    = useState(clip.color?.exposure    ?? 0);
  const [cgContrast,    setCgContrast]    = useState(clip.color?.contrast    ?? 1);
  const [cgSaturation,  setCgSaturation]  = useState(clip.color?.saturation  ?? 1);
  const [cgTemperature, setCgTemperature] = useState(clip.color?.temperature ?? 6500);
  const [cgTint,        setCgTint]        = useState(clip.color?.tint        ?? 0);
  const [cgHighlights,  setCgHighlights]  = useState(clip.color?.highlights  ?? 0);
  const [cgShadows,     setCgShadows]     = useState(clip.color?.shadows     ?? 0);
  const [cgGamma,       setCgGamma]       = useState(clip.color?.gamma       ?? 1);

  // ── transform local state ───────────────────────────────────────────────────
  const [txCenterX,  setTxCenterX]  = useState(clip.transform?.centerX        ?? 0.5);
  const [txCenterY,  setTxCenterY]  = useState(clip.transform?.centerY        ?? 0.5);
  const [txWidth,    setTxWidth]    = useState(clip.transform?.width           ?? 1);
  const [txHeight,   setTxHeight]   = useState(clip.transform?.height          ?? 1);
  const [txRotation, setTxRotation] = useState(clip.transform?.rotation        ?? 0);
  const [txFlipH,    setTxFlipH]    = useState(clip.transform?.flipHorizontal  ?? false);
  const [txFlipV,    setTxFlipV]    = useState(clip.transform?.flipVertical    ?? false);

  // ── crop local state ────────────────────────────────────────────────────────
  const [cropLeft,   setCropLeft]   = useState(clip.crop?.left   ?? 0);
  const [cropTop,    setCropTop]    = useState(clip.crop?.top    ?? 0);
  const [cropRight,  setCropRight]  = useState(clip.crop?.right  ?? 0);
  const [cropBottom, setCropBottom] = useState(clip.crop?.bottom ?? 0);

  // ── mask local state ────────────────────────────────────────────────────────
  const [maskFeather, setMaskFeather] = useState(clip.mask?.feather ?? 0.05);
  // The pen overlay or the agent can (re)create the mask while this clip stays selected, so the
  // slider follows the server value — not just the clip.id reseed like the other fields.
  useEffect(() => { setMaskFeather(clip.mask?.feather ?? 0.05); }, [clip.id, clip.mask?.feather]);

  // ── fades local state ────────────────────────────────────────────────────────
  const [fadeIn,  setFadeIn]  = useState(clip.fadeInFrames  ?? 0);
  const [fadeOut, setFadeOut] = useState(clip.fadeOutFrames ?? 0);

  // ── swap media local state ──────────────────────────────────────────────────
  const [swapArmed, setSwapArmed] = useState(false);

  // ── collapsible section open state ─────────────────────────────────────────
  const [transformOpen, setTransformOpen] = useState(true);
  const [cropOpen,      setCropOpen]      = useState(false);
  const [maskOpen,      setMaskOpen]      = useState(true);
  const [fadesOpen,     setFadesOpen]     = useState(false);
  const [keyframesOpen, setKeyframesOpen] = useState(false);
  // Per-property "Curve" panel (SVG bezier editor) toggles inside the Keyframes section.
  const [curveOpen, setCurveOpen] = useState<Record<string, boolean>>({});
  const [swapOpen,      setSwapOpen]      = useState(false);

  // re-seed when the selected clip changes
  useEffect(() => {
    setDuration(clip.durationFrames);
    setSpeed(clip.speed);
    setOpacity(clip.opacity);
    setVolume(clip.volume);
    setTextContent(clip.textContent ?? "");
    setFontName(clip.textStyle?.fontName ?? "Helvetica-Bold");
    setFontSize(clip.textStyle?.fontSize ?? 96);
    setColor(clip.textStyle?.color ?? "#ffffff");
    setAlignment((clip.textStyle?.alignment as "left" | "center" | "right") ?? "left");
    setStatus(null);
    // re-seed color grade
    setCgExposure(clip.color?.exposure       ?? 0);
    setCgContrast(clip.color?.contrast       ?? 1);
    setCgSaturation(clip.color?.saturation   ?? 1);
    setCgTemperature(clip.color?.temperature ?? 6500);
    setCgTint(clip.color?.tint               ?? 0);
    setCgHighlights(clip.color?.highlights   ?? 0);
    setCgShadows(clip.color?.shadows         ?? 0);
    setCgGamma(clip.color?.gamma             ?? 1);
    // re-seed transform
    setTxCenterX(clip.transform?.centerX        ?? 0.5);
    setTxCenterY(clip.transform?.centerY        ?? 0.5);
    setTxWidth(clip.transform?.width            ?? 1);
    setTxHeight(clip.transform?.height          ?? 1);
    setTxRotation(clip.transform?.rotation      ?? 0);
    setTxFlipH(clip.transform?.flipHorizontal   ?? false);
    setTxFlipV(clip.transform?.flipVertical     ?? false);
    // re-seed crop
    setCropLeft(clip.crop?.left     ?? 0);
    setCropTop(clip.crop?.top       ?? 0);
    setCropRight(clip.crop?.right   ?? 0);
    setCropBottom(clip.crop?.bottom ?? 0);
    // re-seed fades
    setFadeIn(clip.fadeInFrames  ?? 0);
    setFadeOut(clip.fadeOutFrames ?? 0);
    // reset swap
    setSwapArmed(false);
  }, [clip.id]);

  const set = (patch: Record<string, unknown>) =>
    sendCommand("set_clip_properties", { clipIds: [clip.id], ...patch });

  const showStatus = (text: string, isError: boolean) => {
    setStatus({ text, isError });
    window.setTimeout(() => setStatus(null), 4000);
  };

  const callTool = async (name: string, args: Record<string, unknown>) => {
    setStatus(null);
    const result = await mcpCall(name, args);
    showStatus(result.text || (result.isError ? "Error" : "Done"), result.isError);
  };

  const isVideo = clip.mediaType === "video";
  const isImage = clip.mediaType === "image";
  const isAudio = clip.mediaType === "audio";
  const isText = clip.mediaType === "text";
  // Adjustment layers ARE a grade/FX holder — the Look + Adjust sections are their whole surface;
  // transform/volume make no sense on them (no pixels, no audio of their own).
  const isAdjustment = clip.mediaType === "adjustment";
  const showVolume = isAudio || (isVideo && !!asset?.hasAudio);
  const showAdjust = isVideo || isImage || isAdjustment;
  const showTransformSections = isVideo || isImage;

  const applyColor = (field: keyof ColorGrade | "reset", value?: number | boolean) => {
    const args: Record<string, unknown> = { clipIds: [clip.id] };
    if (field === "reset") args.reset = true;
    else args[field] = value;
    callTool("apply_color", args);
  };

  const applyEffect = (type: string, active: boolean) => {
    if (active) {
      callTool("apply_effect", { clipIds: [clip.id], remove: [type] });
    } else {
      callTool("apply_effect", { clipIds: [clip.id], effects: [{ type }] });
    }
  };

  const isEffectActive = (type: string) =>
    !!(clip.effects?.some((e: Effect) => e.type === type && e.enabled !== false));

  // ── look (one-tap color filter) ──────────────────────────────────────────────
  const lookEffect = clip.effects?.find((e: Effect) => e.type === "look" && e.enabled !== false);
  const rawLookName = lookEffect?.params?.name;
  const activeLook = typeof rawLookName === "string" ? rawLookName : null;
  const rawLookAmount = lookEffect?.params?.amount;
  const [lookAmount, setLookAmount] = useState(typeof rawLookAmount === "number" ? rawLookAmount : 1);
  useEffect(() => {
    // re-seed on clip/look change only — NOT on every state broadcast, or it would fight the drag
    setLookAmount(typeof rawLookAmount === "number" ? rawLookAmount : 1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clip.id, activeLook]);

  const applyLook = (name: string | null) => {
    if (name === null) callTool("apply_effect", lookRemovePayload(clip.id));
    else callTool("apply_effect", lookApplyPayload(clip.id, name, lookAmount));
  };

  // ── voice fx (applied to the clip's audio on export) ─────────────────────────
  const voiceType: VoiceFxType = clip.audioFx?.type ?? "none";
  const [pitchSemitones, setPitchSemitones] = useState(
    clip.audioFx?.type === "pitch" && typeof clip.audioFx.amount === "number" ? clip.audioFx.amount : 4,
  );
  const [echoSeconds, setEchoSeconds] = useState(
    clip.audioFx?.type === "echo" && typeof clip.audioFx.amount === "number" ? clip.audioFx.amount : 0.25,
  );
  useEffect(() => {
    setPitchSemitones(clip.audioFx?.type === "pitch" && typeof clip.audioFx.amount === "number" ? clip.audioFx.amount : 4);
    setEchoSeconds(clip.audioFx?.type === "echo" && typeof clip.audioFx.amount === "number" ? clip.audioFx.amount : 0.25);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clip.id]);

  const setVoiceFx = (type: VoiceFxType) => {
    const amount = type === "pitch" ? pitchSemitones : type === "echo" ? echoSeconds : undefined;
    callTool("set_clip_properties", voiceFxPayload(clip.id, type, amount));
  };

  // split is only available when playhead is strictly inside the clip
  const clipEnd = clip.startFrame + clip.durationFrames;
  const canSplit = playhead > clip.startFrame && playhead < clipEnd;

  const mediaName = isText
    ? "Text"
    : isAdjustment
      ? clip.name
        ? `Adjustment · ${clip.name}`
        : "Adjustment layer"
      : (asset?.name ?? clip.mediaRef);

  // ── transform commit helpers ─────────────────────────────────────────────────
  const commitTransform = (patch: Partial<{
    centerX: number; centerY: number; width: number; height: number;
    rotation: number; flipHorizontal: boolean; flipVertical: boolean;
  }>) => {
    const current = {
      centerX: txCenterX, centerY: txCenterY, width: txWidth, height: txHeight,
      rotation: txRotation, flipHorizontal: txFlipH, flipVertical: txFlipV,
    };
    set({ transform: { ...current, ...patch } });
  };

  // ── crop commit helper ───────────────────────────────────────────────────────
  const commitCrop = (patch: Partial<{ left: number; top: number; right: number; bottom: number }>) => {
    const current = { left: cropLeft, top: cropTop, right: cropRight, bottom: cropBottom };
    set({ crop: { ...current, ...patch } });
  };

  // Re-send the FULL mask spec with one field changed: set_mask replaces the whole mask, so a
  // feather/invert/smooth tweak must carry the shape geometry (incl. pen points) back unchanged.
  const setMaskField = (patch: Record<string, unknown>) => {
    const m = clip.mask;
    if (!m) return;
    const base: Record<string, unknown> =
      m.shape === "path"
        ? { clipIds: [clip.id], shape: "path", points: m.points, smooth: !!m.smooth, feather: m.feather, invert: m.invert }
        : { clipIds: [clip.id], shape: m.shape, cx: m.cx, cy: m.cy, rw: m.rw, rh: m.rh, feather: m.feather, invert: m.invert };
    sendCommand("set_mask", { ...base, ...patch });
  };

  // ── keyframe helpers ─────────────────────────────────────────────────────────
  const relativeFrame = Math.max(0, playhead - clip.startFrame);

  type KfProp = "opacity" | "scale" | "position" | "rotation";
  const kfTrackOf = (property: KfProp) =>
    property === "opacity" ? clip.opacityTrack
    : property === "rotation" ? clip.rotationTrack
    : property === "scale" ? clip.scaleTrack
    : clip.positionTrack;

  const addKeyframe = (property: KfProp) => {
    const kfs = kfTrackOf(property)?.keyframes;
    // New keyframe inherits the track's uniform easing so adding one never turns a deliberately
    // all-linear/all-hold track into a mixed one; rebuilt rows keep each row's own easing.
    const interp: Interpolation = trackEasing(kfs) ?? "smooth";
    const merged =
      property === "opacity"
        ? mergeKfRows(scalarRows(clip.opacityTrack?.keyframes ?? []), [relativeFrame, clip.opacity ?? 1, interp])
        : property === "rotation"
          ? mergeKfRows(scalarRows(clip.rotationTrack?.keyframes ?? []), [relativeFrame, clip.transform?.rotation ?? 0, interp])
          : property === "scale"
            ? mergeKfRows(pairRows(clip.scaleTrack?.keyframes ?? []), [relativeFrame, clip.transform?.width ?? 1, clip.transform?.height ?? 1, interp])
            : mergeKfRows(pairRows(clip.positionTrack?.keyframes ?? []), [relativeFrame, clip.transform?.centerX ?? 0.5, clip.transform?.centerY ?? 0.5, interp]);
    callTool("set_keyframes", { clipId: clip.id, property, keyframes: merged });
  };

  // Easing preset: rewrite ALL of the property's rows with the chosen interp (set_keyframes is a
  // whole-track replace, so this is the cheapest correct way to change the curve style).
  const setEasing = (property: KfProp, interp: Interpolation) => {
    const rows =
      property === "opacity"
        ? scalarRows(clip.opacityTrack?.keyframes ?? [], interp)
        : property === "rotation"
          ? scalarRows(clip.rotationTrack?.keyframes ?? [], interp)
          : property === "scale"
            ? pairRows(clip.scaleTrack?.keyframes ?? [], interp)
            : pairRows(clip.positionTrack?.keyframes ?? [], interp);
    if (rows.length) callTool("set_keyframes", { clipId: clip.id, property, keyframes: rows });
  };

  const clearKeyframes = (property: "opacity" | "scale" | "position" | "rotation") => {
    callTool("set_keyframes", { clipId: clip.id, property, keyframes: [] });
  };

  const kfCount = (property: "opacity" | "scale" | "position" | "rotation") => {
    switch (property) {
      case "opacity":  return clip.opacityTrack?.keyframes.length  ?? 0;
      case "scale":    return clip.scaleTrack?.keyframes.length    ?? 0;
      case "position": return clip.positionTrack?.keyframes.length ?? 0;
      case "rotation": return clip.rotationTrack?.keyframes.length ?? 0;
    }
  };

  // ── auto-reframe (local face tracking → pan keyframes) ─────────────────────
  // Only meaningful on a 9:16 canvas: the flow keeps the clip full-height and pans it, which needs
  // the project already in portrait. We deliberately do NOT switch the project format ourselves.
  const { project } = useEditor();
  const [reframeBusy, setReframeBusy] = useState<string | null>(null);
  const is916 =
    !!project && Math.abs(project.timeline.width / project.timeline.height - 9 / 16) < 0.01;

  const runAutoReframe = async () => {
    if (!project || reframeBusy) return;
    setStatus(null);
    setReframeBusy("preparing video…");
    // Offscreen probe on the scrub proxy (all-intra → instant seeks), never the preview element.
    const video = document.createElement("video");
    video.muted = true;
    video.playsInline = true;
    video.preload = "auto";
    video.src = `${mediaUrl(clip.mediaRef)}?scrub=1`;
    try {
      const tl = project.timeline;
      await waitForVideoMetadata(video);
      // Asset metadata when present; the probe's own dimensions as fallback (proxies keep aspect).
      const sourceW = asset?.sourceWidth ?? video.videoWidth;
      const sourceH = asset?.sourceHeight ?? video.videoHeight;
      if (!sourceW || !sourceH) throw new Error("could not read the video dimensions");
      const targetAspect = tl.width / tl.height;
      // Fit-height box width in canvas units — e.g. 16:9 on 9:16 → (16/9)/(9/16) ≈ 3.16.
      const w = fitHeightWidth(sourceW, sourceH, targetAspect, clip.crop);
      if (w <= 1.001) throw new Error("this clip is not wider than the canvas — nothing to reframe");
      const kfs = await computeReframeKeyframes(video, {
        clipStartFrame: clip.startFrame,
        clipDurationFrames: clip.durationFrames,
        trimStartFrame: clip.trimStartFrame,
        speed: clip.speed,
        fps: tl.fps,
        targetAspect,
        sourceW,
        sourceH,
        crop: clip.crop,
        onProgress: (done, total) => setReframeBusy(`analyzing ${done}/${total}…`),
      });
      setReframeBusy("applying…");
      // 1) Fit-height transform (merges: rotation/flips survive). centerY 0.5 + height 1 puts the
      //    top edge at 0, matching the keyframes' fixed topLeftY = 0.
      const propsRes = await mcpCall("set_clip_properties", {
        clipIds: [clip.id],
        transform: { centerX: kfs[0]?.cx ?? 0.5, centerY: 0.5, width: w, height: 1 },
      });
      if (propsRes.isError) throw new Error(propsRes.text || "set_clip_properties failed");
      // 2) Position keyframes, centerX→topLeft: a = cx − w/2, b = 0 (see autoReframe.ts geometry).
      const kfRes = await mcpCall("set_keyframes", {
        clipId: clip.id,
        property: "position",
        keyframes: positionRows(kfs, w),
      });
      if (kfRes.isError) throw new Error(kfRes.text || "set_keyframes failed");
      showStatus(`Auto-reframe: ${kfs.length} keyframes, face tracked locally`, false);
    } catch (e) {
      const msg =
        e instanceof DOMException && e.name === "SecurityError"
          ? "cross-origin video blocks face detection — open the app from the bridge (http://127.0.0.1:19789)"
          : e instanceof Error
            ? e.message
            : String(e);
      showStatus(`Auto-reframe failed: ${msg}`, true);
    } finally {
      video.removeAttribute("src");
      video.load(); // detach the network/decoder resources of the offscreen element
      setReframeBusy(null);
    }
  };

  // ── swap helpers ─────────────────────────────────────────────────────────────
  const handleSwap = async (pickedId: string) => {
    setSwapArmed(false);
    await callTool("remove_clips", { clipIds: [clip.id] });
    await callTool("add_clips", {
      entries: [{ mediaRef: pickedId, startFrame: clip.startFrame, durationFrames: clip.durationFrames, trackIndex }],
    });
  };

  // same media-type assets available for swap
  const swapCandidates = projectMedia.filter(
    (m) => m.id !== clip.mediaRef && m.type === (asset?.type ?? clip.mediaType),
  );

  return (
    <div className="flex flex-col gap-0">
      {/* ── header ── */}
      <div className="border-b border-neutral-800 px-3 py-2.5">
        <div className="flex items-center gap-2">
          <span className="truncate text-[11px] font-medium text-neutral-200">{mediaName}</span>
          <TypeChip type={clip.mediaType} />
        </div>
        <div className="mt-0.5 text-[10px] text-neutral-500">
          {clip.startFrame}f – {clipEnd}f
        </div>
      </div>

      {/* ── thumbnail ── */}
      {!isText && asset && (
        <div className="border-b border-neutral-800 px-3 py-2">
          <ClipPreview asset={asset} />
        </div>
      )}

      {/* ── editable properties ── */}
      <div className="flex flex-col gap-3 border-b border-neutral-800 px-3 py-3">
        {/* Duration */}
        <NumberField label="Duration (frames)" value={duration} min={1} max={1000000} step={1}
          onCommit={(v) => { setDuration(v); set({ durationFrames: v }); }} />

        {/* Speed — meaningless on media-less clips (text/adjustment): there is no content to retime */}
        {!isText && !isAdjustment && (
          <NumberField label="Speed (×)" value={speed} min={0.25} max={4} step={0.05}
            onCommit={(v) => { setSpeed(v); set({ speed: v }); }} />
        )}

        {/* Opacity */}
        <NumberField label="Opacity (0–1)" value={opacity} min={0} max={1} step={0.05}
          onCommit={(v) => { setOpacity(v); set({ opacity: v }); }} />

        {/* Volume */}
        {showVolume && (
          <NumberField label="Volume (0–1.5)" value={volume} min={0} max={1.5} step={0.05}
            onCommit={(v) => { setVolume(v); set({ volume: v }); }} />
        )}

        {/* Text-specific controls */}
        {isText && (
          <>
            <label className="flex flex-col gap-1">
              <span className="text-[10px] text-neutral-400">Text content</span>
              <textarea
                rows={3}
                value={textContent}
                onChange={(e) => setTextContent(e.target.value)}
                onBlur={() => set({ content: textContent })}
                className="rounded-md border border-neutral-800 bg-neutral-900 px-2 py-1 text-[11px] text-neutral-200 outline-none focus:border-sky-600 resize-none"
              />
            </label>

            <div className="flex flex-col gap-1">
              <span className="text-[10px] text-neutral-400">Font</span>
              <FontPicker
                value={fontName}
                onChange={(v) => {
                  setFontName(v);
                  set({ fontName: v });
                }}
              />
            </div>

            <NumberField label="Font size" value={fontSize} min={6} max={400} step={1}
              onCommit={(v) => { setFontSize(v); set({ fontSize: v }); }} />

            <div className="flex gap-2">
              <label className="flex flex-1 flex-col gap-1">
                <span className="text-[10px] text-neutral-400">Color</span>
                <input
                  type="color"
                  value={color}
                  onChange={(e) => setColor(e.target.value)}
                  onBlur={() => set({ color })}
                  className="h-7 w-full cursor-pointer rounded-md border border-neutral-800 bg-neutral-900 p-0.5 outline-none"
                />
              </label>
              <label className="flex flex-1 flex-col gap-1">
                <span className="text-[10px] text-neutral-400">Align</span>
                <select
                  value={alignment}
                  onChange={(e) => {
                    const v = e.target.value as "left" | "center" | "right";
                    setAlignment(v);
                    set({ alignment: v });
                  }}
                  className="h-7 rounded-md border border-neutral-800 bg-neutral-900 px-1 text-[11px] text-neutral-200 outline-none focus:border-sky-600"
                >
                  <option value="left">Left</option>
                  <option value="center">Center</option>
                  <option value="right">Right</option>
                </select>
              </label>
            </div>
          </>
        )}
      </div>

      {/* ── TRANSFORM ── */}
      {showTransformSections && (
        <CollapsibleSection label="Transform" open={transformOpen} onToggle={() => setTransformOpen((v) => !v)}>
          <div className="flex gap-2">
            <NumberField compact label="Pos X" value={txCenterX} min={-1} max={2} step={0.01}
              onCommit={(v) => { setTxCenterX(v); commitTransform({ centerX: v }); }} />
            <NumberField compact label="Pos Y" value={txCenterY} min={-1} max={2} step={0.01}
              onCommit={(v) => { setTxCenterY(v); commitTransform({ centerY: v }); }} />
          </div>
          <div className="flex gap-2">
            <NumberField compact label="Scale W" value={txWidth} min={0} max={2} step={0.01}
              onCommit={(v) => { setTxWidth(v); commitTransform({ width: v }); }} />
            <NumberField compact label="Scale H" value={txHeight} min={0} max={2} step={0.01}
              onCommit={(v) => { setTxHeight(v); commitTransform({ height: v }); }} />
          </div>
          <NumberField compact label="Rotation (°)" value={txRotation} min={-180} max={180} step={1}
            onCommit={(v) => { setTxRotation(v); commitTransform({ rotation: v }); }} />
          <div className="flex gap-2 pt-0.5">
            <button
              onClick={() => { const n = !txFlipH; setTxFlipH(n); commitTransform({ flipHorizontal: n }); }}
              className={`flex-1 rounded border px-2 py-1 text-[10px] font-medium transition-colors ${
                txFlipH ? "border-sky-600 bg-sky-900/40 text-sky-300" : "border-neutral-700 bg-neutral-900 text-neutral-400 hover:bg-neutral-800"
              }`}
            >Flip H</button>
            <button
              onClick={() => { const n = !txFlipV; setTxFlipV(n); commitTransform({ flipVertical: n }); }}
              className={`flex-1 rounded border px-2 py-1 text-[10px] font-medium transition-colors ${
                txFlipV ? "border-sky-600 bg-sky-900/40 text-sky-300" : "border-neutral-700 bg-neutral-900 text-neutral-400 hover:bg-neutral-800"
              }`}
            >Flip V</button>
          </div>
        </CollapsibleSection>
      )}

      {/* ── CROP ── */}
      {showTransformSections && (
        <CollapsibleSection label="Crop" open={cropOpen} onToggle={() => setCropOpen((v) => !v)}>
          <div className="flex gap-2">
            <NumberField compact label="Left" value={cropLeft} min={0} max={0.9} step={0.01}
              onCommit={(v) => { setCropLeft(v); commitCrop({ left: v }); }} />
            <NumberField compact label="Right" value={cropRight} min={0} max={0.9} step={0.01}
              onCommit={(v) => { setCropRight(v); commitCrop({ right: v }); }} />
          </div>
          <div className="flex gap-2">
            <NumberField compact label="Top" value={cropTop} min={0} max={0.9} step={0.01}
              onCommit={(v) => { setCropTop(v); commitCrop({ top: v }); }} />
            <NumberField compact label="Bottom" value={cropBottom} min={0} max={0.9} step={0.01}
              onCommit={(v) => { setCropBottom(v); commitCrop({ bottom: v }); }} />
          </div>
        </CollapsibleSection>
      )}

      {/* ── MASK ── */}
      {showTransformSections && clip.mask && (
        <CollapsibleSection label="Mask" open={maskOpen} onToggle={() => setMaskOpen((v) => !v)}>
          <div className="flex items-center justify-between">
            <span className="text-[10px] text-neutral-400">
              {clip.mask.shape === "path" ? `pen path · ${clip.mask.points?.length ?? 0} points` : clip.mask.shape}
            </span>
            <button
              onClick={() => sendCommand("set_mask", { clipIds: [clip.id], clear: true })}
              className="rounded border border-neutral-700 bg-neutral-900 px-2 py-0.5 text-[10px] font-medium text-neutral-400 hover:bg-neutral-800 hover:text-neutral-200 transition-colors"
            >Clear</button>
          </div>
          <SliderField label="Feather" value={maskFeather} min={0} max={0.5} step={0.01} display={maskFeather.toFixed(2)}
            onChange={(v) => { setMaskFeather(v); setMaskField({ feather: v }); }} />
          <div className="flex gap-2 pt-0.5">
            <button
              onClick={() => setMaskField({ invert: !clip.mask!.invert })}
              className={`flex-1 rounded border px-2 py-1 text-[10px] font-medium transition-colors ${
                clip.mask.invert ? "border-sky-600 bg-sky-900/40 text-sky-300" : "border-neutral-700 bg-neutral-900 text-neutral-400 hover:bg-neutral-800"
              }`}
            >Invert</button>
            {clip.mask.shape === "path" && (
              <button
                onClick={() => setMaskField({ smooth: !clip.mask!.smooth })}
                className={`flex-1 rounded border px-2 py-1 text-[10px] font-medium transition-colors ${
                  clip.mask.smooth ? "border-sky-600 bg-sky-900/40 text-sky-300" : "border-neutral-700 bg-neutral-900 text-neutral-400 hover:bg-neutral-800"
                }`}
              >Smooth</button>
            )}
          </div>
        </CollapsibleSection>
      )}

      {/* ── FADES ── */}
      <CollapsibleSection label="Fades" open={fadesOpen} onToggle={() => setFadesOpen((v) => !v)}>
        <div className="flex gap-2">
          <NumberField compact label="Fade In (f)" value={fadeIn} min={0} max={clip.durationFrames} step={1}
            onCommit={(v) => { setFadeIn(v); set({ fadeInFrames: v }); }} />
          <NumberField compact label="Fade Out (f)" value={fadeOut} min={0} max={clip.durationFrames} step={1}
            onCommit={(v) => { setFadeOut(v); set({ fadeOutFrames: v }); }} />
        </div>
        <button
          onClick={() => callTool("add_transition", { clipId: clip.id, type: "cross", durationFrames: 15 })}
          className="mt-0.5 w-full rounded border border-neutral-700 bg-neutral-900 px-2 py-1 text-[10px] font-medium text-neutral-300 hover:bg-neutral-800 transition-colors"
        >
          Cross-dissolve 15f
        </button>
      </CollapsibleSection>

      {/* ── KEYFRAMES ── */}
      {showTransformSections && (
        <CollapsibleSection label="Keyframes" open={keyframesOpen} onToggle={() => setKeyframesOpen((v) => !v)}>
          {(["opacity", "scale", "position", "rotation"] as const).map((prop) => {
            // Active chip = the easing ALL keyframes share; a mixed track lights none.
            const easing = trackEasing(kfTrackOf(prop)?.keyframes);
            return (
              <div key={prop} className="flex flex-col gap-1">
                <div className="flex items-center gap-1.5">
                  <span className="w-14 shrink-0 capitalize text-[10px] text-neutral-400">{prop}</span>
                  <span className="font-mono text-[9px] text-neutral-600 w-5 shrink-0">{kfCount(prop)}k</span>
                  <button
                    onClick={() => addKeyframe(prop)}
                    className="flex-1 rounded border border-neutral-700 bg-neutral-900 px-1 py-0.5 text-[9px] font-medium text-neutral-300 hover:bg-neutral-800 transition-colors"
                    title={`Add keyframe at clip-relative frame ${relativeFrame}`}
                  >
                    ◆ @{relativeFrame}f
                  </button>
                  <button
                    onClick={() => clearKeyframes(prop)}
                    className="shrink-0 rounded border border-neutral-800 bg-neutral-900 px-1.5 py-0.5 text-[9px] text-neutral-600 hover:bg-neutral-800 hover:text-red-400 transition-colors"
                    title="Clear all keyframes for this property"
                  >
                    ✕
                  </button>
                </div>
                {/* Easing preset — applies to every keyframe of this property's track.
                  * Full width (no pl-14 nesting indent): indented, the 4 chips overflowed the
                  * 256px panel and the "custom" chip was clipped at the edge. */}
                {kfCount(prop) > 0 && (
                  <div className="flex items-center gap-1">
                    <span className="shrink-0 text-[9px] text-neutral-600">Easing</span>
                    {(["smooth", "linear", "hold", "bezier"] as const).map((mode) => (
                      <button
                        key={mode}
                        onClick={() => { if (mode !== easing) setEasing(prop, mode); }}
                        title={mode === "bezier" ? `Give every ${prop} segment a draggable custom curve (edit below)` : `Set every ${prop} keyframe to ${mode}`}
                        className={`flex-1 rounded border px-1 py-0.5 text-[9px] font-medium capitalize transition-colors ${
                          easing === mode
                            ? "border-sky-600 bg-sky-900/40 text-sky-300"
                            : "border-neutral-700 bg-neutral-900 text-neutral-400 hover:bg-neutral-800 hover:text-neutral-200"
                        }`}
                      >
                        {mode === "bezier" ? "custom" : mode}
                      </button>
                    ))}
                  </div>
                )}
                {/* Curve panel — SVG graph editor for this property's track (drag keyframes,
                    toggle segments to bezier, drag handles). Writes back via set_keyframes. */}
                {/* Full width too: the graph measures its container, and the old indent left the
                  * right-most keyframe dot/handles pinned against the panel edge. */}
                {kfCount(prop) > 0 && (
                  <div className="flex flex-col gap-1 pb-1">
                    <button
                      onClick={() => setCurveOpen((o) => ({ ...o, [prop]: !o[prop] }))}
                      className="self-start rounded border border-neutral-800 bg-neutral-900 px-1.5 py-0.5 text-[9px] text-neutral-500 hover:bg-neutral-800 hover:text-neutral-300 transition-colors"
                      title="Show the value-vs-frame curve for this property"
                    >
                      {curveOpen[prop] ? "▴ Curve" : "▾ Curve"}
                    </button>
                    {curveOpen[prop] && (
                      <KeyframeCurveEditor
                        clip={clip}
                        property={prop}
                        onCommit={(rows) => callTool("set_keyframes", { clipId: clip.id, property: prop, keyframes: rows })}
                      />
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </CollapsibleSection>
      )}

      {/* ── SWAP MEDIA ── */}
      {showTransformSections && (
        <CollapsibleSection label="Swap Media" open={swapOpen} onToggle={() => { setSwapOpen((v) => !v); setSwapArmed(false); }}>
          {!swapArmed ? (
            <button
              onClick={() => setSwapArmed(true)}
              className="w-full rounded border border-neutral-700 bg-neutral-900 px-2 py-1.5 text-[10px] font-medium text-neutral-300 hover:bg-neutral-800 transition-colors"
            >
              Swap media…
            </button>
          ) : (
            <div className="flex flex-col gap-1">
              <p className="text-[10px] text-neutral-500">Pick replacement ({asset?.type ?? clip.mediaType}):</p>
              {swapCandidates.length === 0 ? (
                <p className="text-[10px] italic text-neutral-600">No matching assets in library</p>
              ) : (
                <div className="flex max-h-36 flex-col gap-1 overflow-y-auto">
                  {swapCandidates.map((m) => (
                    <button
                      key={m.id}
                      onClick={() => handleSwap(m.id)}
                      className="truncate rounded border border-neutral-700 bg-neutral-900 px-2 py-1 text-left text-[10px] text-neutral-300 hover:bg-neutral-800 hover:text-neutral-100 transition-colors"
                    >
                      {m.name}
                    </button>
                  ))}
                </div>
              )}
              <button
                onClick={() => setSwapArmed(false)}
                className="text-[9px] text-neutral-600 hover:text-neutral-400 transition-colors"
              >
                Cancel
              </button>
            </div>
          )}
        </CollapsibleSection>
      )}

      {/* ── actions ── */}
      <div className="px-3 py-3">
        <div className="mb-2 text-[10px] font-semibold uppercase tracking-widest text-neutral-500">Actions</div>
        {/* Grid stays symmetric for every clip type: full-width rows span both columns and the
          * pair rows are ordered so no row is left with an orphan empty cell. */}
        <div className="grid grid-cols-2 gap-1.5">
          <ActionButton
            label="Split at playhead"
            disabled={!canSplit}
            onClick={() => callTool("split_clip", { clipId: clip.id, atFrame: playhead })}
            className={isText || isAudio || isAdjustment ? "col-span-2" : ""}
          />
          {/* AI media actions are hidden (not just disabled) on text/audio clips — offering
            * "Upscale" on a caption reads as broken to a first-time user. */}
          {!isText && !isAudio && !isAdjustment && (
            <ActionButton label="Upscale" disabled={!canGenerate} onClick={() => callTool("upscale_media", { mediaRef: clip.mediaRef })} />
          )}
          {isVideo && (
            <ActionButton
              label="Reframe"
              disabled={!canGenerate}
              onClick={() => callTool("reframe", { mediaRef: clip.mediaRef, aspectRatio: "9:16" })}
            />
          )}
          {!isText && !isAudio && !isAdjustment && (
            <ActionButton
              label="Remove BG"
              disabled={!canGenerate}
              onClick={() => callTool("remove_background", { mediaRef: clip.mediaRef })}
              className={isVideo ? "" : "col-span-2"}
            />
          )}
          {/* Local face-tracked reframe (no cloud): full-height clip + panning position keyframes.
            * Requires a 9:16 project — deliberately no silent format switch. */}
          {isVideo && (
            <ActionButton
              label={reframeBusy ? `🎯 ${reframeBusy}` : "🎯 Auto-reframe (9:16)"}
              disabled={!!reframeBusy || !is916 || !asset}
              title={
                !is916
                  ? "Switch the project to 9:16 first (format selector)"
                  : "Track the largest face and pan the clip to follow it — runs locally, free"
              }
              onClick={() => void runAutoReframe()}
              className="col-span-2"
            />
          )}
          {asset?.generationInput && (
            <ActionButton
              label="Regenerate"
              disabled={!canGenerate}
              onClick={() => regenerate(asset!, callTool)}
              className="col-span-2"
            />
          )}
        </div>
      </div>

      {/* ── look (one-tap color filter) — video / image only ── */}
      {showAdjust && (
        <div className="flex flex-col gap-2 border-b border-neutral-800 px-3 py-3">
          <span className="text-[10px] font-semibold uppercase tracking-widest text-neutral-500">Look</span>
          <div className="grid grid-cols-2 gap-1.5">
            <button
              onClick={() => { if (activeLook !== null) applyLook(null); }}
              title="No look filter"
              className={`truncate rounded border px-2 py-1 text-left text-[10px] font-medium transition-colors ${
                activeLook === null
                  ? "border-sky-600 bg-sky-900/40 text-sky-300"
                  : "border-neutral-700 bg-neutral-900 text-neutral-400 hover:bg-neutral-800 hover:text-neutral-200"
              }`}
            >
              None
            </button>
            {Object.entries(LOOKS).map(([name, recipe]) => (
              <button
                key={name}
                onClick={() => { if (name !== activeLook) applyLook(name); }}
                title={recipe.label}
                className={`truncate rounded border px-2 py-1 text-left text-[10px] font-medium transition-colors ${
                  activeLook === name
                    ? "border-sky-600 bg-sky-900/40 text-sky-300"
                    : "border-neutral-700 bg-neutral-900 text-neutral-400 hover:bg-neutral-800 hover:text-neutral-200"
                }`}
              >
                {recipe.label.split(" — ")[0]}
              </button>
            ))}
          </div>
          {activeLook !== null && (
            <SliderField
              label="Amount"
              value={lookAmount}
              min={0}
              max={1}
              step={0.05}
              display={`${Math.round(lookAmount * 100)}%`}
              onChange={(v) => {
                setLookAmount(v);
                callTool("apply_effect", lookApplyPayload(clip.id, activeLook, v));
              }}
            />
          )}
        </div>
      )}

      {/* ── adjust (color grade + effects) — video / image only ── */}
      {showAdjust && (
        <div className="flex flex-col gap-3 border-b border-neutral-800 px-3 py-3">
          {/* section header */}
          <div className="flex items-center justify-between">
            <span className="text-[10px] font-semibold uppercase tracking-widest text-neutral-500">
              Adjust
            </span>
            <button
              onClick={() => {
                setCgExposure(0);
                setCgContrast(1);
                setCgSaturation(1);
                setCgTemperature(6500);
                setCgTint(0);
                setCgHighlights(0);
                setCgShadows(0);
                setCgGamma(1);
                applyColor("reset");
              }}
              className="rounded px-1.5 py-0.5 text-[9px] font-medium text-neutral-500 hover:bg-neutral-800 hover:text-neutral-300 transition-colors"
            >
              Reset grade
            </button>
          </div>

          {/* color grade sliders */}
          <GradeSlider label="Exposure"   value={cgExposure}    min={-3}    max={3}     step={0.05} onChange={(v) => { setCgExposure(v);    applyColor("exposure",    v); }} />
          <GradeSlider label="Contrast"   value={cgContrast}    min={0.5}   max={1.5}   step={0.01} onChange={(v) => { setCgContrast(v);    applyColor("contrast",    v); }} />
          <GradeSlider label="Saturation" value={cgSaturation}  min={0}     max={2}     step={0.01} onChange={(v) => { setCgSaturation(v);  applyColor("saturation",  v); }} />
          <GradeSlider label="Temp (K)"   value={cgTemperature} min={2000}  max={11000} step={100}  onChange={(v) => { setCgTemperature(v); applyColor("temperature", v); }} decimals={0} />
          <GradeSlider label="Tint"       value={cgTint}        min={-100}  max={100}   step={1}    onChange={(v) => { setCgTint(v);        applyColor("tint",        v); }} decimals={0} />
          <GradeSlider label="Highlights" value={cgHighlights}  min={-1}    max={1}     step={0.02} onChange={(v) => { setCgHighlights(v);  applyColor("highlights",  v); }} />
          <GradeSlider label="Shadows"    value={cgShadows}     min={-1}    max={1}     step={0.02} onChange={(v) => { setCgShadows(v);     applyColor("shadows",     v); }} />
          <GradeSlider label="Gamma"      value={cgGamma}       min={0.5}   max={2}     step={0.01} onChange={(v) => { setCgGamma(v);       applyColor("gamma",       v); }} />

          {/* effects chips */}
          <div className="flex flex-col gap-1.5">
            <span className="text-[10px] text-neutral-500">Effects</span>
            <div className="flex flex-wrap gap-1.5">
              {/* glow renders in the per-clip tail, which adjustment layers bypass — hide its chip there */}
              {((isAdjustment ? ["vignette", "grain", "blur", "sharpen"] : ["vignette", "grain", "blur", "sharpen", "glow"]) as readonly string[]).map((type) => {
                const active = isEffectActive(type);
                return (
                  <button
                    key={type}
                    onClick={() => applyEffect(type, active)}
                    className={`rounded px-2 py-0.5 text-[10px] font-medium capitalize transition-colors ${
                      active
                        ? "bg-neutral-200 text-neutral-900"
                        : "bg-neutral-800 text-neutral-400 hover:bg-neutral-700 hover:text-neutral-200"
                    }`}
                  >
                    {type}
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      )}

      {/* ── voice fx — clips that carry audio ── */}
      {showVolume && (
        <div className="flex flex-col gap-2 border-b border-neutral-800 px-3 py-3">
          <span className="text-[10px] font-semibold uppercase tracking-widest text-neutral-500">Voice FX</span>
          <select
            value={voiceType}
            onChange={(e) => setVoiceFx(e.target.value as VoiceFxType)}
            className="rounded-md border border-neutral-800 bg-neutral-900 px-2 py-1 text-[11px] text-neutral-200 outline-none focus:border-sky-600"
          >
            <option value="none">None</option>
            <option value="pitch">Pitch</option>
            <option value="robot">Robot</option>
            <option value="echo">Echo</option>
            <option value="radio">Radio</option>
          </select>
          {voiceType === "pitch" && (
            <SliderField
              label="Pitch"
              value={pitchSemitones}
              min={-12}
              max={12}
              step={1}
              display={`${pitchSemitones >= 0 ? "+" : ""}${pitchSemitones} st`}
              onChange={(v) => {
                const n = Math.round(v);
                setPitchSemitones(n);
                callTool("set_clip_properties", voiceFxPayload(clip.id, "pitch", n));
              }}
            />
          )}
          {voiceType === "echo" && (
            <SliderField
              label="Delay"
              value={echoSeconds}
              min={0.05}
              max={1.5}
              step={0.05}
              display={`${echoSeconds.toFixed(2)} s`}
              onChange={(v) => {
                setEchoSeconds(v);
                callTool("set_clip_properties", voiceFxPayload(clip.id, "echo", v));
              }}
            />
          )}
          <p className="text-[10px] text-neutral-600">Applied on export.</p>
        </div>
      )}

      {/* ── status line ── */}
      {status && (
        <div
          className={`px-3 pb-3 text-[10px] leading-relaxed ${
            status.isError ? "text-red-400" : "text-neutral-400"
          }`}
        >
          {status.text}
        </div>
      )}
    </div>
  );
}

// ─── Asset inspector ──────────────────────────────────────────────────────────

interface AssetInspectorProps {
  asset: MediaAsset;
  playhead: number;
  canGenerate: boolean;
}

function AssetInspector({ asset, playhead, canGenerate }: AssetInspectorProps) {
  const [status, setStatus] = useState<{ text: string; isError: boolean } | null>(null);
  const [reframeAspect, setReframeAspect] = useState<"9:16" | "1:1" | "16:9" | "4:5">("9:16");

  useEffect(() => {
    setStatus(null);
  }, [asset.id]);

  const showStatus = (text: string, isError: boolean) => {
    setStatus({ text, isError });
    window.setTimeout(() => setStatus(null), 4000);
  };

  const callTool = async (name: string, args: Record<string, unknown>) => {
    setStatus(null);
    const result = await mcpCall(name, args);
    showStatus(result.text || (result.isError ? "Error" : "Done"), result.isError);
  };

  const isVideo = asset.type === "video";
  const isImage = asset.type === "image";
  const isAudio = asset.type === "audio";
  const genInput = asset.generationInput;
  const { project } = useEditor();

  const handleAddToTimeline = () => {
    const fps = project?.timeline.fps ?? 30;
    const durFrames = asset.durationSeconds ? Math.round(asset.durationSeconds * fps) : isImage ? fps * 5 : fps;
    // Empty timeline → drop the clip at the very start, not wherever the playhead happens to sit.
    const hasClips = project?.timeline.tracks.some((t) => t.clips.length > 0) ?? false;
    const startFrame = hasClips ? playhead : 0;
    sendCommand("add_clips", {
      entries: [{ mediaRef: asset.id, startFrame, durationFrames: durFrames }],
    });
    ui.setPlayhead(startFrame); // jump the playhead onto the new clip so the preview shows it at once
  };

  return (
    <div className="flex flex-col gap-0">
      {/* ── header ── */}
      <div className="border-b border-neutral-800 px-3 py-2.5">
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="truncate text-[11px] font-medium text-neutral-200">{asset.name}</span>
          <TypeChip type={asset.type} />
          {genInput && <AiChip />}
        </div>
        {asset.durationSeconds != null && (
          <div className="mt-0.5 text-[10px] text-neutral-500">
            {asset.durationSeconds.toFixed(1)} s
          </div>
        )}
      </div>

      {/* ── preview ── */}
      <div className="border-b border-neutral-800 px-3 py-2">
        {isAudio ? (
          <div className="flex h-14 items-center justify-center rounded-md bg-neutral-900 text-2xl">
            ♪
          </div>
        ) : (
          <AssetPreview asset={asset} />
        )}
      </div>

      {/* ── relink (for media whose file moved / is offline) ── */}
      <div className="border-b border-neutral-800 px-3 py-2">
        <button
          onClick={() => {
            const path = window.prompt("New file path for this media:");
            if (path) void callTool("relink_media", { mediaRef: asset.id, path });
          }}
          className="w-full rounded-md border border-neutral-700 px-2 py-1.5 text-[11px] text-neutral-300 hover:bg-neutral-800"
        >
          Relink file…
        </button>
      </div>

      {/* ── generation details ── */}
      {genInput && (
        <div className="flex flex-col gap-2 border-b border-neutral-800 px-3 py-3">
          <div className="text-[10px] font-semibold uppercase tracking-widest text-neutral-500">
            Generation
          </div>
          {genInput.model && (
            <DetailRow label="Model">
              <span className="font-mono text-[10px]">{genInput.model}</span>
            </DetailRow>
          )}
          {genInput.prompt && (
            <div className="flex flex-col gap-0.5">
              <span className="text-[10px] text-neutral-500">Prompt</span>
              <p className="text-[11px] leading-relaxed text-neutral-300 break-words whitespace-pre-wrap">
                {genInput.prompt}
              </p>
            </div>
          )}
          {asset.durationSeconds != null && (
            <DetailRow label="Duration">{asset.durationSeconds.toFixed(1)} s</DetailRow>
          )}
        </div>
      )}

      {/* ── add to timeline ── */}
      <div className="border-b border-neutral-800 px-3 py-3">
        <button
          onClick={handleAddToTimeline}
          className="w-full rounded-md bg-sky-700 py-1.5 text-[11px] font-medium text-white transition-colors hover:bg-sky-600 active:bg-sky-800 disabled:opacity-40"
        >
          Add to timeline
        </button>
      </div>

      {/* ── actions ── */}
      <div className="px-3 py-3">
        <div className="mb-2 text-[10px] font-semibold uppercase tracking-widest text-neutral-500">Actions</div>
        <div className="grid grid-cols-2 gap-1.5">
          <ActionButton
            label="Upscale"
            disabled={!canGenerate || isAudio}
            onClick={() => callTool("upscale_media", { mediaRef: asset.id })}
          />
          {/* Reframe with selectable aspect ratio — spans both cells when video */}
          {isVideo ? (
            <div className="flex flex-col gap-1">
              <select
                value={reframeAspect}
                onChange={(e) => setReframeAspect(e.target.value as typeof reframeAspect)}
                disabled={!canGenerate}
                className="rounded-md border border-neutral-700 bg-neutral-900 px-1 py-0.5 text-[10px] text-neutral-300 outline-none focus:border-sky-600 disabled:cursor-not-allowed disabled:opacity-30"
              >
                <option value="9:16">9:16</option>
                <option value="1:1">1:1</option>
                <option value="16:9">16:9</option>
                <option value="4:5">4:5</option>
              </select>
              <ActionButton
                label="Reframe"
                disabled={!canGenerate}
                onClick={() => callTool("reframe", { mediaRef: asset.id, aspectRatio: reframeAspect })}
              />
            </div>
          ) : (
            <ActionButton
              label="Reframe"
              disabled={true}
              onClick={() => {}}
            />
          )}
          <ActionButton
            label="Remove BG"
            disabled={!canGenerate || isAudio}
            onClick={() => callTool("remove_background", { mediaRef: asset.id })}
            className={isAudio ? "col-span-2" : ""}
          />
          {isImage && (
            <ActionButton
              label="Outpaint"
              disabled={!canGenerate}
              onClick={() => callTool("outpaint_image", { mediaRef: asset.id })}
            />
          )}
          {isVideo && (
            <ActionButton
              label="Analyze"
              disabled={!canGenerate}
              onClick={() => callTool("analyze_video", { mediaRef: asset.id })}
            />
          )}
          {genInput && (
            <ActionButton
              label="Regenerate"
              disabled={!canGenerate}
              onClick={() => regenerate(asset, callTool)}
              className="col-span-2"
            />
          )}
        </div>
      </div>

      {/* ── status line ── */}
      {status && (
        <div
          className={`px-3 pb-3 text-[10px] leading-relaxed ${
            status.isError ? "text-red-400" : "text-neutral-400"
          }`}
        >
          {status.text}
        </div>
      )}
    </div>
  );
}

// ─── Shared helpers ───────────────────────────────────────────────────────────

/** Re-fire the original generation call from generationInput metadata. */
async function regenerate(
  asset: MediaAsset,
  callTool: (name: string, args: Record<string, unknown>) => Promise<void>,
) {
  const gi = asset.generationInput;
  if (!gi) return;
  const kind = gi.kind ?? "video";
  const toolName =
    kind === "image" ? "generate_image" : kind === "audio" ? "generate_audio" : "generate_video";
  await callTool(toolName, {
    prompt: gi.prompt ?? "",
    model: gi.model,
    name: asset.name,
  });
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function ClipPreview({ asset }: { asset: MediaAsset }) {
  const url = mediaUrl(asset.id);
  if (asset.type === "video") {
    // ?scrub=1 serves the web-safe proxy: the webview can't decode ProRes/HEVC (.mov) directly,
    // which left this details preview gray while the library thumbnail (already proxied) worked.
    return (
      <video
        src={`${url}?scrub=1`}
        muted
        className="h-28 w-full rounded-md object-cover bg-neutral-900"
        preload="metadata"
      />
    );
  }
  if (asset.type === "image") {
    return (
      <img
        src={url}
        alt={asset.name}
        className="h-28 w-full rounded-md object-cover bg-neutral-900"
      />
    );
  }
  return null;
}

function AssetPreview({ asset }: { asset: MediaAsset }) {
  return <ClipPreview asset={asset} />;
}

function TypeChip({ type }: { type: string }) {
  const colors: Record<string, string> = {
    video: "bg-violet-900/60 text-violet-300",
    image: "bg-emerald-900/60 text-emerald-300",
    audio: "bg-amber-900/60 text-amber-300",
    text: "bg-sky-900/60 text-sky-300",
  };
  const cls = colors[type] ?? "bg-neutral-800 text-neutral-300";
  return (
    <span className={`shrink-0 rounded px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide ${cls}`}>
      {type}
    </span>
  );
}

function AiChip() {
  return (
    <span className="shrink-0 rounded bg-pink-900/60 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-pink-300">
      AI
    </span>
  );
}

function DetailRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-2">
      <span className="text-[10px] text-neutral-500">{label}</span>
      <span className="text-[11px] text-neutral-300">{children}</span>
    </div>
  );
}

/** Compact labeled range slider used in the Adjust / color-grade panel. */
function GradeSlider({
  label,
  value,
  min,
  max,
  step,
  decimals = 2,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  decimals?: number;
  onChange: (v: number) => void;
}) {
  return (
    <label className="flex flex-col gap-0.5">
      <div className="flex items-center justify-between">
        <span className="text-[10px] text-neutral-400">{label}</span>
        <span className="font-mono text-[10px] text-neutral-300">
          {value.toFixed(decimals)}
        </span>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="w-full accent-sky-500"
      />
    </label>
  );
}

function SliderField({
  label,
  value,
  min,
  max,
  step,
  display,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  display: string;
  onChange: (v: number) => void;
}) {
  return (
    <label className="flex flex-col gap-1">
      <div className="flex items-center justify-between">
        <span className="text-[10px] text-neutral-400">{label}</span>
        <span className="font-mono text-[10px] text-neutral-300">{display}</span>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="w-full accent-sky-500"
      />
    </label>
  );
}

function ActionButton({
  label,
  onClick,
  disabled,
  title,
  className = "",
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  title?: string;
  className?: string;
}) {
  return (
    <button
      disabled={disabled}
      onClick={onClick}
      title={title}
      className={`rounded-md border border-neutral-700 bg-neutral-900 px-2 py-1.5 text-[10px] font-medium text-neutral-300 transition-colors hover:border-neutral-600 hover:bg-neutral-800 hover:text-neutral-100 active:bg-neutral-700 disabled:cursor-not-allowed disabled:opacity-30 ${className}`}
    >
      {label}
    </button>
  );
}

/** Font picker that renders every option in its own family. A native <select> can't style its
 * <option>s reliably across platforms, so this is a tiny button+list dropdown instead. */
function FontPicker({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const [open, setOpen] = useState(false);
  const current = FONT_OPTIONS.find((f) => f.value === value);
  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        onBlur={() => setOpen(false)}
        onKeyDown={(e) => { if (e.key === "Escape") setOpen(false); }}
        style={{ fontFamily: current?.css }}
        className="flex w-full items-center justify-between gap-1 rounded-md border border-neutral-800 bg-neutral-900 px-2 py-1 text-left text-[11px] text-neutral-200 outline-none focus:border-sky-600"
      >
        <span className="truncate">{current?.label ?? value}</span>
        <span className="shrink-0 text-[9px] text-neutral-500">▾</span>
      </button>
      {open && (
        <div className="absolute left-0 right-0 top-full z-30 mt-1 max-h-56 overflow-y-auto rounded-md border border-neutral-700 bg-neutral-900 py-0.5 shadow-xl shadow-black/60">
          {FONT_OPTIONS.map((f) => (
            <button
              key={f.value}
              type="button"
              // Keep the trigger focused so its onBlur (close) doesn't swallow this row's click.
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => { onChange(f.value); setOpen(false); }}
              style={{ fontFamily: f.css }}
              className={`block w-full truncate px-2 py-1 text-left text-[11px] transition-colors ${
                f.value === value ? "bg-sky-900/40 text-sky-300" : "text-neutral-200 hover:bg-neutral-800"
              }`}
            >
              {f.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** Collapsible labeled section with chevron toggle. */
function CollapsibleSection({
  label,
  open,
  onToggle,
  children,
}: {
  label: string;
  open: boolean;
  onToggle: () => void;
  children: React.ReactNode;
}) {
  return (
    <div className="border-b border-neutral-800">
      <button
        onClick={onToggle}
        className="flex w-full items-center justify-between px-3 py-2 text-left"
      >
        <span className="text-[10px] font-semibold uppercase tracking-widest text-neutral-500">
          {label}
        </span>
        <span className="text-[10px] text-neutral-600">{open ? "▴" : "▾"}</span>
      </button>
      {open && (
        <div className="flex flex-col gap-2 px-3 pb-3">
          {children}
        </div>
      )}
    </div>
  );
}
