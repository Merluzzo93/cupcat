import { useCallback, useEffect, useRef, useState } from "react";
import { t } from "./i18n";
import type { CSSProperties, PointerEvent as ReactPointerEvent, WheelEvent as ReactWheelEvent } from "react";
import type { Clip, Crop, Effect, Project, Transform } from "@cupcat/editor-core";
import { lerpAnimPair, lerpNumber, sampleTrack, scaledLook, splitStyleSegments, timelineTotalFrames, transformTopLeft } from "@cupcat/editor-core";
import { BRIDGE_HTTP, mediaUrl, sendCommand, ui, useEditor } from "./store";
import { canvasToClip, clipToCanvas, maskImageCss } from "./maskPen";
import { ChromaKeyCanvas, hasWebGL2 } from "./ChromaKeyLayer";

/** Tiny stable hash of a JSON-able value (djb2). Used as the compound-bake cache-buster: the
 * <video> src changes exactly when the nested timeline changed, forcing a reload of the fresh bake. */
function hashJson(v: unknown): string {
  const json = JSON.stringify(v) ?? "";
  let h = 5381;
  for (let i = 0; i < json.length; i++) h = ((h * 33) ^ json.charCodeAt(i)) >>> 0;
  return h.toString(16);
}

// fontName (textStyle) → CSS family for the preview; matches the export's font-file map + the
// Inspector font picker.
const FONT_CSS: Record<string, string> = {
  "Helvetica-Bold": "Arial, Helvetica, sans-serif",
  Arial: "Arial, sans-serif",
  Georgia: "Georgia, serif",
  "Times New Roman": "'Times New Roman', Times, serif",
  Verdana: "Verdana, sans-serif",
  "Trebuchet MS": "'Trebuchet MS', sans-serif",
  "Courier New": "'Courier New', monospace",
  Impact: "Impact, sans-serif",
  "Comic Sans MS": "'Comic Sans MS', cursive",
  // Windows 10/11 system fonts (files verified in C:/Windows/Fonts — see bridge FONT_FILES).
  "Segoe UI": "'Segoe UI', sans-serif",
  "Segoe UI Semibold": "'Segoe UI Semibold', 'Segoe UI', sans-serif",
  Bahnschrift: "Bahnschrift, sans-serif",
  Candara: "Candara, sans-serif",
  Consolas: "Consolas, monospace",
  Constantia: "Constantia, serif",
  Corbel: "Corbel, sans-serif",
};
import { frameToTimecode } from "./format";

// ─── useFit ──────────────────────────────────────────────────────────────────

function useFit(W: number, H: number) {
  const ref = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState({ w: 0, h: 0 });
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const compute = () => {
      const cw = el.clientWidth - 32;
      const ch = el.clientHeight - 32;
      if (cw <= 0 || ch <= 0) return;
      const scale = Math.min(cw / W, ch / H);
      setBox({ w: Math.round(W * scale), h: Math.round(H * scale) });
    };
    compute();
    const ro = new ResizeObserver(compute);
    ro.observe(el);
    return () => ro.disconnect();
  }, [W, H]);
  return { ref, box };
}

// ─── boxStyle (keyframe sampling) ────────────────────────────────────────────

/** Approximate a clip's color grade + simple effects as a CSS filter so the live preview reflects
 * adjustments (the exact look is rendered by ffmpeg on export). vignette/grain/shake get overlay/
 * animation stand-ins (see the FX section below); chromakey renders live through a WebGL2 canvas
 * (ChromaKeyLayer.tsx); glow gets a drop-shadow/brightness stand-in here — a soft bloom feel, not
 * the export's thresholded screen-blend, so the canvas badge marks it "approximate". */
function cssFilter(c: Clip): string | undefined {
  const parts: string[] = [];
  const g = c.color;
  if (g) {
    if (g.exposure) parts.push(`brightness(${Math.pow(2, g.exposure).toFixed(3)})`);
    if (g.gamma && g.gamma !== 1) parts.push(`brightness(${(1 / g.gamma).toFixed(3)})`);
    if (g.contrast != null && g.contrast !== 1) parts.push(`contrast(${g.contrast})`);
    if (g.saturation != null && g.saturation !== 1) parts.push(`saturate(${g.saturation})`);
    if (g.vibrance) parts.push(`saturate(${(1 + g.vibrance * 0.5).toFixed(3)})`);
    if (g.temperature && g.temperature !== 6500) {
      const d = (g.temperature - 6500) / 4500;
      parts.push(d > 0 ? `sepia(${Math.min(0.6, d * 0.6).toFixed(3)})` : `hue-rotate(${Math.round(d * 20)}deg)`);
    }
    if (g.tint) parts.push(`hue-rotate(${Math.round(g.tint * 0.3)}deg)`);
  }
  for (const e of c.effects ?? []) {
    if (e.enabled === false) continue;
    if (e.type === "blur") {
      const amt = typeof e.params?.amount === "number" ? e.params.amount : 8;
      parts.push(`blur(${(amt * 0.4).toFixed(1)}px)`);
    }
    if (e.type === "glow") {
      // Soft-bloom approximation: a white halo the size of the export's blur radius + a slight
      // brightness lift. The real render (curves threshold + gblur + screen blend) is export-only.
      const radius = typeof e.params?.radius === "number" ? e.params.radius : 18;
      parts.push(`drop-shadow(0 0 ${radius.toFixed(0)}px rgba(255,255,255,0.6))`, "brightness(1.05)");
    }
    if (e.type === "look") {
      const name = typeof e.params?.name === "string" ? e.params.name : "";
      const amount = typeof e.params?.amount === "number" ? e.params.amount : 1;
      const rec = scaledLook(name, amount);
      if (rec) {
        parts.push(`contrast(${rec.contrast.toFixed(3)})`);
        parts.push(rec.grayscale ? "grayscale(1)" : `saturate(${rec.saturation.toFixed(3)})`);
        parts.push(`brightness(${rec.brightness.toFixed(3)})`);
        if (rec.sepia) parts.push(`sepia(${rec.sepia.toFixed(3)})`);
        if (rec.hueDeg) parts.push(`hue-rotate(${rec.hueDeg.toFixed(1)}deg)`);
        // rec.fade (black lift) has no CSS filter equivalent — export-only.
      }
    }
  }
  return parts.length ? parts.join(" ") : undefined;
}

// Opacity multiplier from the clip's fade-in/out (the basis of fade & cross transitions). The export
// applies these in ffmpeg; the preview must mirror them or transitions are invisible on the canvas.
function fadeFactor(c: Clip, rel: number): number {
  let f = 1;
  const dur = c.durationFrames;
  if (c.fadeInFrames > 0 && rel < c.fadeInFrames) {
    const t = Math.max(0, Math.min(1, rel / c.fadeInFrames));
    f *= c.fadeInInterpolation === "smooth" ? t * t * (3 - 2 * t) : t;
  }
  if (c.fadeOutFrames > 0 && rel > dur - c.fadeOutFrames) {
    const t = Math.max(0, Math.min(1, (dur - rel) / c.fadeOutFrames));
    f *= c.fadeOutInterpolation === "smooth" ? t * t * (3 - 2 * t) : t;
  }
  return f;
}

function boxStyle(c: Clip, playhead: number): CSSProperties {
  const rel = playhead - c.startFrame;
  const tl = transformTopLeft(c.transform);
  const pos = sampleTrack(c.positionTrack, rel, { a: tl.x, b: tl.y }, lerpAnimPair);
  const size = sampleTrack(c.scaleTrack, rel, { a: c.transform.width, b: c.transform.height }, lerpAnimPair);
  const opacity = sampleTrack(c.opacityTrack, rel, c.opacity, lerpNumber) * fadeFactor(c, rel);
  const rotation = sampleTrack(c.rotationTrack, rel, c.transform.rotation, lerpNumber);
  // Shape masks (pen cutouts, magnifier lens, spotlights) as CSS mask-image in CLIP space —
  // gradients for rect/ellipse, an SVG data-URI for pen paths — so feather AND invert are
  // visible live, matching the export's geq/matte alpha (see maskPen.ts for the math).
  const mask = c.mask ? maskImageCss(c.mask) : null;
  return {
    position: "absolute",
    left: `${pos.a * 100}%`,
    top: `${pos.b * 100}%`,
    width: `${size.a * 100}%`,
    height: `${size.b * 100}%`,
    opacity,
    transform: rotation ? `rotate(${rotation}deg)` : undefined,
    maskImage: mask?.maskImage,
    WebkitMaskImage: mask?.maskImage,
    // "intersect" only exists for the soft-rect two-gradient stack; -webkit- spells it source-in.
    maskComposite: mask?.composite,
    WebkitMaskComposite: mask?.composite ? "source-in" : undefined,
    maskRepeat: mask ? "no-repeat" : undefined,
    WebkitMaskRepeat: mask ? "no-repeat" : undefined,
    // The SVG mask uses preserveAspectRatio=none — 100% 100% stretches its unit viewBox over the box.
    maskSize: mask ? "100% 100%" : undefined,
    WebkitMaskSize: mask ? "100% 100%" : undefined,
    filter: cssFilter(c),
    // Tailwind's base reset applies `max-width:100%` to img/video, which would clamp a zoomed
    // (scale>1) layer back to the canvas width — breaking push-in/Ken Burns. Unclamp it.
    maxWidth: "none",
    maxHeight: "none",
  };
}

// ─── FX preview approximations (vignette / grain / shake) ───────────────────
// ffmpeg renders the real effect on export; these cheap CSS stand-ins exist so applying one visibly
// does something on the canvas instead of silently doing nothing until export. Overlays mount ONLY
// when the effect is present, live INSIDE the layer's positioned wrapper (so they inherit its
// placement/rotation/opacity/fades) and are pointer-events:none so click-to-select keeps working.
// chromakey previews live via WebGL2 (ChromaKeyLayer.tsx); glow's CSS stand-in lives in cssFilter —
// the canvas badge marks it approximate (and chromakey export-only where WebGL2 is unavailable).

function activeFx(c: Clip, type: string): Effect | undefined {
  return c.effects?.find((e) => e.type === type && e.enabled !== false);
}

function fxAmount(e: Effect, dflt: number): number {
  const v = e.params?.amount;
  return typeof v === "number" ? Math.max(0, Math.min(1, v)) : dflt;
}

/** Overlay-approximable FX present on a clip (amounts 0..1; defaults match the effect registry). */
function fxOverlays(c: Clip): { vignette?: number; grain?: number; shake?: number } {
  if (!c.effects?.length) return {}; // hot path — most clips have no effect stack
  const v = activeFx(c, "vignette");
  const g = activeFx(c, "grain");
  const s = activeFx(c, "shake");
  return {
    vignette: v && fxAmount(v, 0.4),
    grain: g && fxAmount(g, 0.25),
    shake: s && fxAmount(s, 0.5),
  };
}

// Static monochrome fractal-noise tile (SVG feTurbulence) as a data URI — no canvas work, no
// animation, desaturated in the SVG itself so the grain is luma-only like ffmpeg's noise filter.
const GRAIN_URL = `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='128' height='128'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='2' stitchTiles='stitch'/%3E%3CfeColorMatrix type='saturate' values='0'/%3E%3C/filter%3E%3Crect width='128' height='128' filter='url(%23n)'/%3E%3C/svg%3E")`;

// Shake: a small looping pseudo-random jitter. It animates the independent `translate` property so
// it COMPOSES with the wrapper's `transform: rotate(...)` instead of overriding it; the amplitude
// comes from the per-layer --cc-shake custom property. Keyframes are injected once, lazily.
let shakeKfInjected = false;
function ensureShakeKeyframes() {
  if (shakeKfInjected || typeof document === "undefined") return;
  shakeKfInjected = true;
  const A = "var(--cc-shake, 4px)";
  const st = document.createElement("style");
  st.textContent =
    "@keyframes cupcat-shake{" +
    "0%,100%{translate:0px 0px}" +
    `12%{translate:calc(${A} * -0.62) calc(${A} * 0.4)}` +
    `24%{translate:calc(${A} * 0.55) calc(${A} * -0.34)}` +
    `37%{translate:calc(${A} * -0.3) calc(${A} * -0.6)}` +
    `50%{translate:calc(${A} * 0.66) calc(${A} * 0.24)}` +
    `62%{translate:calc(${A} * -0.47) calc(${A} * 0.58)}` +
    `75%{translate:calc(${A} * 0.38) calc(${A} * -0.66)}` +
    `88%{translate:calc(${A} * -0.58) calc(${A} * -0.25)}` +
    "}";
  document.head.appendChild(st);
}

/** Add the shake animation (amplitude ∝ amount, ~8px at 1) to a layer style. Call only while playing. */
function shakeStyle(base: CSSProperties, amount: number): CSSProperties {
  ensureShakeKeyframes();
  const out: CSSProperties = { ...base, animation: "cupcat-shake 0.35s linear infinite" };
  (out as unknown as Record<string, string>)["--cc-shake"] = `${(amount * 8).toFixed(2)}px`;
  return out;
}

/** Vignette / grain overlays — rendered inside the layer wrapper, above the media. */
function FxOverlays({ vignette, grain }: { vignette?: number; grain?: number }) {
  return (
    <>
      {vignette != null && (
        <div
          style={{
            position: "absolute",
            inset: 0,
            pointerEvents: "none",
            background: `radial-gradient(ellipse at center, transparent 55%, rgba(0,0,0,${Math.min(1, vignette * 0.9).toFixed(3)}) 100%)`,
          }}
        />
      )}
      {grain != null && (
        <div
          style={{
            position: "absolute",
            inset: 0,
            pointerEvents: "none",
            backgroundImage: GRAIN_URL,
            opacity: Math.min(1, grain * 0.35),
            mixBlendMode: "overlay",
          }}
        />
      )}
    </>
  );
}

/** Split a layer's boxStyle for overlay FX: the wrapper keeps placement/opacity/rotation (+ shake
 * while playing) so overlay children inherit them; the media fills it and keeps the color filter so
 * the overlays aren't blurred/graded by it. `isolation` keeps the grain's blend inside this layer. */
function mediaFxStyles(style: CSSProperties, shake: number | undefined, animate: boolean) {
  const { filter, ...rest } = style;
  const wrapper: CSSProperties = { ...rest, isolation: "isolate" };
  const fill: CSSProperties = { position: "absolute", inset: 0, width: "100%", height: "100%", maxWidth: "none", maxHeight: "none", filter };
  return { wrapper: shake && animate ? shakeStyle(wrapper, shake) : wrapper, fill };
}

// ─── VideoLayer ───────────────────────────────────────────────────────────────

function VideoLayer({
  assetId,
  sourceSeconds,
  playing,
  speed,
  style,
  srcBase,
  videoElRef,
}: {
  assetId: string;
  sourceSeconds: number;
  playing: boolean;
  speed: number;
  style: CSSProperties;
  /** Override the media URL (compound clips point at /media/compound/<id> instead of an asset). */
  srcBase?: string;
  /** Hands the underlying <video> element to the parent (chromakey draws it onto a GL canvas). */
  videoElRef?: (el: HTMLVideoElement | null) => void;
}) {
  const ref = useRef<HTMLVideoElement>(null);
  // Heavy/non-mp4 sources (a 100 MB .mov) block on the bridge while their playable proxy is being
  // generated — without feedback that reads as "broken". Show a loading veil until data arrives.
  // A decode/load ERROR (failed proxy → the raw source got served) is retried with backoff — the
  // proxy may just not be ready yet — then surfaced, so the veil can never spin forever.
  const [loading, setLoading] = useState(true);
  const [attempt, setAttempt] = useState(0);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    setFailed(false);
    setAttempt(0);
  }, [assetId]);
  useEffect(() => {
    const v = ref.current;
    if (!v) return;
    if (v.readyState >= 2) setLoading(false);
    const ready = () => setLoading(false);
    const again = () => setLoading(true);
    v.addEventListener("loadeddata", ready);
    v.addEventListener("loadstart", again);
    return () => {
      v.removeEventListener("loadeddata", ready);
      v.removeEventListener("loadstart", again);
    };
  }, [assetId]);
  useEffect(() => {
    const v = ref.current;
    if (!v) return;
    let timer = 0;
    const onErr = () => {
      if (attempt < 3) timer = window.setTimeout(() => setAttempt(attempt + 1), 2000 * (attempt + 1));
      else {
        setLoading(false);
        setFailed(true);
      }
    };
    v.addEventListener("error", onErr);
    return () => {
      window.clearTimeout(timer);
      v.removeEventListener("error", onErr);
    };
  }, [attempt, assetId]);
  // Without this, the element decodes at its native 1x pace regardless of the clip's speed, so
  // sourceSeconds (which advances at speed×) drifts away from currentTime until the "jump" correction
  // below kicks in and snaps it back — repeatedly, which looks like a stutter/loop instead of smooth
  // slow/fast motion. Matching playbackRate to speed makes native decoding track the target directly.
  useEffect(() => {
    const v = ref.current;
    if (v) v.playbackRate = Math.max(0.0625, Math.min(16, speed || 1));
  }, [speed]);
  useEffect(() => {
    const v = ref.current;
    if (!v) return;
    const jump = Math.abs(v.currentTime - sourceSeconds) > 0.3; // a source discontinuity (a cut) on
    // this persistent element, not ordinary per-frame drift during continuous playback.
    if (playing) {
      if (jump) {
        // Calling play() right after setting currentTime can race the seek — some engines resume
        // decoding before the target frame is ready and get stuck showing the pre-seek frame
        // (looks like a frozen still image). Wait for the seek to actually land first.
        v.pause();
        const onSeeked = () => {
          v.removeEventListener("seeked", onSeeked);
          void v.play().catch(() => {});
        };
        v.addEventListener("seeked", onSeeked);
        v.currentTime = sourceSeconds;
        const safety = window.setTimeout(() => {
          v.removeEventListener("seeked", onSeeked);
          void v.play().catch(() => {});
        }, 250); // in case 'seeked' never fires (e.g. a same-value seek is a no-op event-wise)
        return () => {
          window.clearTimeout(safety);
          v.removeEventListener("seeked", onSeeked);
        };
      }
      void v.play().catch(() => {});
    } else {
      v.pause();
      if (Math.abs(v.currentTime - sourceSeconds) > 0.02) v.currentTime = sourceSeconds;
    }
  }, [sourceSeconds, playing]);
  return (
    <>
      <video
        ref={(el) => {
          ref.current = el;
          videoElRef?.(el);
        }}
        src={`${srcBase ?? `${mediaUrl(assetId)}?scrub=1`}&r=${attempt}`}
        muted
        playsInline
        preload="auto"
        className="object-cover"
        style={style}
      />
      {failed && (
        <div style={style} className="pointer-events-none flex items-center justify-center bg-neutral-900/85">
          <div className="px-3 text-center text-[11px] leading-snug text-amber-300">
            Preview unavailable for this clip — the source file is fine and exports correctly.
          </div>
        </div>
      )}
      {loading && !failed && (
        <div style={style} className="pointer-events-none flex items-center justify-center bg-neutral-900/85">
          <div className="flex items-center gap-2 text-[11px] text-neutral-300">
            <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-neutral-500 border-t-white" />
            Preparing preview…
          </div>
        </div>
      )}
    </>
  );
}

// ─── Layer ────────────────────────────────────────────────────────────────────

function Layer({
  clip,
  project,
  fps,
  scale,
  playing,
  playhead,
  active = true,
}: {
  clip: Clip;
  project: Project;
  fps: number;
  scale: number;
  playing: boolean;
  playhead: number;
  active?: boolean;
}) {
  // A lookahead clip (mounted just before its turn so its <video> is loaded + seeked, killing the
  // black flash at a cut) renders invisibly until it's actually on the playhead.
  const style = active ? boxStyle(clip, playhead) : { ...boxStyle(clip, playhead), opacity: 0, pointerEvents: "none" as const };
  const fx = fxOverlays(clip);
  const hasFx = fx.vignette != null || fx.grain != null || fx.shake != null;

  // Chromakey preview (video clips): the keyed clip's hidden <video> is captured into state here so
  // the GL canvas can sample it. Declared unconditionally — hooks can't live after the branches.
  const [ckVideo, setCkVideo] = useState<HTMLVideoElement | null>(null);
  const ckFx = activeFx(clip, "chromakey");
  const chromaOn = !!ckFx && hasWebGL2();

  if (clip.mediaType === "text") {
    const ts = clip.textStyle;
    const align = ts?.alignment ?? "center";
    // The text div is already the layer's positioned wrapper — overlays go straight inside it.
    let divStyle: CSSProperties = {
      ...style,
      color: ts?.color ?? "#ffffff",
      fontFamily: FONT_CSS[ts?.fontName ?? ""] ?? "Arial, Helvetica, sans-serif",
      fontSize: `${(ts?.fontSize ?? 96) * scale}px`,
      fontWeight: 700,
      lineHeight: 1.1,
      display: "flex",
      alignItems: "center",
      justifyContent: align === "left" ? "flex-start" : align === "right" ? "flex-end" : "center",
      textAlign: align,
      whiteSpace: "pre-wrap",
      textShadow: "0 2px 8px rgba(0,0,0,.55)",
      isolation: hasFx ? "isolate" : undefined,
    };
    if (fx.shake && playing && active) divStyle = shakeStyle(divStyle, fx.shake);
    // Karaoke captions: tint every word from the moment it's spoken (matches the burned-in \k
    // render, where spoken words stay lit). Word times are frames relative to the clip start.
    const kw = clip.karaokeWords;
    return (
      <div style={divStyle}>
        {kw?.length ? (
          <span>
            {kw.map((w, i) => (
              <span key={i} style={playhead - clip.startFrame >= w.startFrame ? { color: ts?.highlightColor ?? "#FFD400" } : undefined}>
                {i > 0 ? " " : ""}
                {w.word}
              </span>
            ))}
          </span>
        ) : clip.styleRanges?.length ? (
          // Rich-text title: split at range boundaries and style each run — mirrors the export's
          // per-segment ASS override tags. (Karaoke wins above; ranges are for plain titles.)
          <span>
            {splitStyleSegments(clip.textContent ?? "", clip.styleRanges).map((seg, i) => (
              <span
                key={i}
                style={{
                  color: seg.color,
                  fontWeight: seg.bold === undefined ? undefined : seg.bold ? 900 : 400,
                  fontStyle: seg.italic ? "italic" : undefined,
                  fontSize: seg.fontSizeScale ? `${seg.fontSizeScale}em` : undefined,
                }}
              >
                {seg.text}
              </span>
            ))}
          </span>
        ) : (
          clip.textContent
        )}
        {(fx.vignette != null || fx.grain != null) && <FxOverlays vignette={fx.vignette} grain={fx.grain} />}
      </div>
    );
  }

  if (clip.mediaType === "adjustment") {
    // An adjustment layer draws NO box of its own: approximate its look on everything below with a
    // full-canvas backdrop-filter (CSS's "filter what's behind me" — the ffmpeg export applies the
    // exact chain to the composite). vignette/grain ride along as full-canvas overlays; whatever
    // has no CSS stand-in stays export-only (same policy as per-clip FX).
    const f = cssFilter(clip);
    return (
      <div
        style={{
          position: "absolute",
          inset: 0,
          pointerEvents: "none",
          backdropFilter: f,
          WebkitBackdropFilter: f,
        }}
      >
        {(fx.vignette != null || fx.grain != null) && <FxOverlays vignette={fx.vignette} grain={fx.grain} />}
      </div>
    );
  }

  if (clip.compoundId) {
    // Compound clip: its "media" is the bridge-side bake of its nested timeline. The content hash
    // in the URL changes when the sub-timeline is edited, remounting the <video> onto the fresh
    // bake (the route blocks until it's rendered — VideoLayer's "Preparing preview…" veil covers
    // the wait). Trim/speed map through sourceSeconds exactly like ordinary footage.
    const comp = project.compounds?.find((cs) => cs.id === clip.compoundId);
    const hash = comp ? hashJson(comp.timeline) : "0";
    const rel = Math.max(0, playhead - clip.startFrame);
    const sourceSeconds = (clip.trimStartFrame + rel * clip.speed) / fps;
    const fxw = hasFx ? mediaFxStyles(style, fx.shake, playing && active) : null;
    const video = (
      <VideoLayer
        assetId={`comp:${clip.compoundId}:${hash}`}
        srcBase={`${BRIDGE_HTTP}/media/compound/${encodeURIComponent(clip.compoundId)}?h=${hash}`}
        sourceSeconds={sourceSeconds}
        playing={playing && active}
        speed={clip.speed || 1}
        style={fxw ? fxw.fill : style}
      />
    );
    if (!fxw) return video;
    return (
      <div style={fxw.wrapper}>
        {video}
        <FxOverlays vignette={fx.vignette} grain={fx.grain} />
      </div>
    );
  }

  const asset = project.media.find((m) => m.id === clip.mediaRef);
  if (!asset || asset.generationStatus.kind !== "none") {
    return (
      <div style={style} className="flex items-center justify-center bg-neutral-800 text-[10px] text-neutral-400">
        {asset ? `${asset.generationStatus.kind}…` : "missing media"}
      </div>
    );
  }
  // Overlay FX (vignette/grain/shake) need a positioned wrapper around the media so the overlays
  // inherit the layer's transform/opacity — built only when such an effect is present.
  const fxWrap = hasFx ? mediaFxStyles(style, fx.shake, playing && active) : null;

  if (clip.mediaType === "image") {
    const img = <img src={mediaUrl(asset.id)} alt="" className="object-cover" style={fxWrap ? fxWrap.fill : style} />;
    if (!fxWrap) return img;
    return (
      <div style={fxWrap.wrapper}>
        {img}
        <FxOverlays vignette={fx.vignette} grain={fx.grain} />
      </div>
    );
  }
  if (clip.mediaType === "audio") return null; // audio has no visual layer
  // Render video for "video" or any clip whose mediaType defaulted/wasn't set (mirrors the export,
  // which treats every non-image/non-audio clip as video — avoids a silent black frame).
  // Clamp the in-clip offset to ≥0 so a lookahead clip (playhead still before it) is seeked to its
  // first frame and ready to show the instant the playhead arrives.
  const rel = Math.max(0, playhead - clip.startFrame);
  const sourceSeconds = (clip.trimStartFrame + rel * clip.speed) / fps;
  const mediaStyle = fxWrap ? fxWrap.fill : style;
  const video = (
    <VideoLayer
      assetId={asset.id}
      sourceSeconds={sourceSeconds}
      playing={playing && active}
      speed={clip.speed || 1}
      // When chroma-keyed, the <video> keeps decoding invisibly; the GL canvas is what shows.
      style={chromaOn ? { ...mediaStyle, visibility: "hidden" } : mediaStyle}
      videoElRef={chromaOn ? setCkVideo : undefined}
    />
  );
  const media = chromaOn ? (
    <>
      {video}
      <ChromaKeyCanvas
        video={ckVideo}
        style={mediaStyle}
        colorHex={typeof ckFx?.params?.color === "string" ? ckFx.params.color : "0x00ff00"}
        similarity={typeof ckFx?.params?.similarity === "number" ? ckFx.params.similarity : 0.3}
        blend={typeof ckFx?.params?.blend === "number" ? ckFx.params.blend : 0.1}
      />
    </>
  ) : (
    video
  );
  if (!fxWrap) return media;
  return (
    <div style={fxWrap.wrapper}>
      {media}
      <FxOverlays vignette={fx.vignette} grain={fx.grain} />
    </div>
  );
}

// ─── Feature 1: Audio Playback ────────────────────────────────────────────────
// Hidden audio elements for audio clips + video clips with audio on non-muted tracks.

interface AudioSlot {
  key: string; // clipId
  src: string;
  targetTime: number;
  volume: number;
  playing: boolean;
  duck: boolean; // clip.audioDuck — this slot is a music bed to dip under the other (voice) slots
}

// Mounted <audio> elements. WebView2 (Chromium) blocks UNMUTED audio unless play() is called from a
// real user gesture — calling it later from an effect is silently rejected (the muted preview <video>
// is exempt, which is why the picture plays but the sound doesn't). So the Play button kicks these
// synchronously inside its click handler. Module-level so the transport can reach them.
const PLAYBACK_AUDIO = new Set<HTMLAudioElement>();
export function kickAudio() {
  // Resume the ducking graph's context inside the same gesture — a suspended AudioContext would
  // otherwise silence every element that has been routed through it.
  if (audioCtx && audioCtx.state === "suspended") void audioCtx.resume().catch(() => {});
  for (const el of PLAYBACK_AUDIO) void el.play().catch(() => {});
}

// ── Ducking preview (WebAudio) ────────────────────────────────────────────────
// Approximates the export's sidechaincompress: when a clip flagged audioDuck (music bed) plays
// together with normal audio (voice), a 60 ms poll measures the voice elements' level and dips the
// bed's gain to DUCK_LEVEL while speech is present, swelling back in the gaps.
//
// Node graph (per <audio> element, built lazily and only when a duck slot exists):
//   MediaElementSource → AnalyserNode (level metering) → GainNode (bed ducking) → destination
// createMediaElementSource is once-per-element and REROUTES the element's output, so EVERY element
// goes through the same chain — voices keep gain 1 and are only metered; beds get gain-modulated
// via setTargetAtTime (τ = 150 ms) for a compressor-like attack/release feel.
// Any failure (autoplay policy, WebView quirk) flips audioGraphBroken and playback silently falls
// back to the plain un-ducked element pipeline.
const DUCK_PREVIEW = true; // feature flag — set false to force the old export-only behavior
const DUCK_LEVEL = 0.25; // bed gain under speech (matches the export's compression depth feel)
const DUCK_THRESHOLD = 0.04; // RMS above this counts as "voice present"
const DUCK_SMOOTHING = 0.15; // setTargetAtTime time constant, seconds
const ANALYSER_FFT = 256;

let audioCtx: AudioContext | null = null;
let audioGraphBroken = false;
interface RoutedNodes {
  gain: GainNode;
  analyser: AnalyserNode;
}
const routedEls = new WeakMap<HTMLAudioElement, RoutedNodes>();

function ensureRouted(el: HTMLAudioElement): RoutedNodes | null {
  if (audioGraphBroken) return null;
  const existing = routedEls.get(el);
  if (existing) return existing;
  try {
    audioCtx ??= new AudioContext();
    if (audioCtx.state === "suspended") void audioCtx.resume().catch(() => {}); // no-op outside a gesture
    const source = audioCtx.createMediaElementSource(el); // once per element — reroutes its output
    const analyser = audioCtx.createAnalyser();
    analyser.fftSize = ANALYSER_FFT;
    const gain = audioCtx.createGain();
    source.connect(analyser);
    analyser.connect(gain);
    gain.connect(audioCtx.destination);
    const nodes: RoutedNodes = { gain, analyser };
    routedEls.set(el, nodes);
    return nodes;
  } catch {
    audioGraphBroken = true; // e.g. a second source on a reused element — never retry, keep plain audio
    return null;
  }
}

function AudioEngine({ slots }: { slots: AudioSlot[] }) {
  const refs = useRef<Map<string, HTMLAudioElement>>(new Map());

  // Route elements into the WebAudio graph only when a duck slot exists — projects that never use
  // audioDuck keep the plain element pipeline and can't be affected by graph/autoplay quirks.
  const duckActive = DUCK_PREVIEW && slots.some((s) => s.duck);

  // Sync each <audio> to its slot every render (the playhead, hence targetTime, moves continuously).
  useEffect(() => {
    for (const slot of slots) {
      const el = refs.current.get(slot.key);
      if (!el) continue;
      if (duckActive) ensureRouted(el);
      el.volume = Math.max(0, Math.min(1, slot.volume));
      if (slot.playing) {
        if (Math.abs(el.currentTime - slot.targetTime) > 0.3) el.currentTime = slot.targetTime;
        void el.play().catch(() => {});
      } else {
        el.pause();
        if (Math.abs(el.currentTime - slot.targetTime) > 0.05) el.currentTime = slot.targetTime;
      }
    }
  });

  // Ducking poll. Signature strings keep the effect stable across the per-frame re-renders of
  // playback — recreating a 60 ms interval every ~33 ms would mean it never fires.
  const bedSig = slots.filter((s) => s.duck).map((s) => s.key).sort().join("|");
  const voiceSig = slots.filter((s) => !s.duck).map((s) => s.key).sort().join("|");
  const anyPlaying = slots.some((s) => s.playing);

  useEffect(() => {
    if (!duckActive || !anyPlaying || !bedSig) return;
    const nodesOf = (key: string): RoutedNodes | null => {
      const el = refs.current.get(key);
      return el ? (routedEls.get(el) ?? null) : null;
    };
    const bedKeys = bedSig.split("|");
    const voiceKeys = voiceSig ? voiceSig.split("|") : [];
    const buf = new Uint8Array(ANALYSER_FFT);
    const id = window.setInterval(() => {
      if (!audioCtx) return;
      // Voice bus level = the loudest element's instantaneous RMS.
      let voice = 0;
      for (const k of voiceKeys) {
        const nodes = nodesOf(k);
        if (!nodes) continue;
        nodes.analyser.getByteTimeDomainData(buf);
        let sum = 0;
        for (let i = 0; i < buf.length; i++) {
          const d = (buf[i]! - 128) / 128;
          sum += d * d;
        }
        voice = Math.max(voice, Math.sqrt(sum / buf.length));
      }
      const target = voice > DUCK_THRESHOLD ? DUCK_LEVEL : 1;
      for (const k of bedKeys) {
        nodesOf(k)?.gain.gain.setTargetAtTime(target, audioCtx.currentTime, DUCK_SMOOTHING);
      }
    }, 60);
    return () => {
      window.clearInterval(id);
      // Ducking stopped mattering (pause / voice or bed left the playhead) — let the bed swell back.
      if (audioCtx) {
        for (const k of bedSig.split("|")) {
          nodesOf(k)?.gain.gain.setTargetAtTime(1, audioCtx.currentTime, DUCK_SMOOTHING);
        }
      }
    };
  }, [duckActive, anyPlaying, bedSig, voiceSig]);

  // Render DOM-attached <audio> elements (not detached `new Audio()`): they play far more reliably
  // in the packaged WebView2 shell, and React handles mount/unmount cleanly.
  return (
    <div style={{ display: "none" }} aria-hidden>
      {slots.map((s) => (
        <audio
          key={s.key}
          ref={(el) => {
            if (!el) return;
            refs.current.set(s.key, el);
            PLAYBACK_AUDIO.add(el);
            return () => {
              refs.current.delete(s.key);
              PLAYBACK_AUDIO.delete(el);
            };
          }}
          src={s.src}
          preload="auto"
        />
      ))}
    </div>
  );
}

function buildAudioSlots(
  project: Project | null,
  playhead: number,
  playing: boolean,
  fps: number,
): AudioSlot[] {
  if (!project) return [];
  const slots: AudioSlot[] = [];

  for (const track of project.timeline.tracks) {
    if (track.muted) continue;
    for (const clip of track.clips) {
      // Only active clips
      if (playhead < clip.startFrame || playhead >= clip.startFrame + clip.durationFrames) continue;

      // Compound clip: its bake carries the nested timeline's mixed audio — play it like a
      // video's own sound (mp4/aac decodes fine in the <audio> element).
      if (clip.compoundId) {
        const key = `comp:${clip.compoundId}`;
        if (slots.some((s) => s.key === key)) continue;
        slots.push({
          key,
          src: `${BRIDGE_HTTP}/media/compound/${encodeURIComponent(clip.compoundId)}`,
          targetTime: Math.max(0, (clip.trimStartFrame + (playhead - clip.startFrame) * (clip.speed ?? 1)) / fps),
          volume: clip.volume ?? 1,
          playing,
          duck: !!clip.audioDuck,
        });
        continue;
      }

      const isAudioClip = clip.mediaType === "audio";
      // A video whose audio was detached onto a linked audio clip must NOT also play here, or the
      // sound doubles/phases. Only play a video's own audio when it has no separate linked audio clip.
      const isVideoWithAudio =
        clip.mediaType === "video" &&
        !clip.linkGroupId &&
        project.media.find((m) => m.id === clip.mediaRef)?.hasAudio === true;

      if (!isAudioClip && !isVideoWithAudio) continue;
      if (!clip.mediaRef) continue;
      // Key the slot by ASSET, not clip: when "remove pauses" splits a clip into segments, the same
      // <audio> element then persists across them (React reuses it on the shared key) and merely seeks
      // at each cut. It mounts and is unlocked ONCE — so WebView2 never has to start a fresh, ungestured
      // element mid-playback (which it silently refuses). First-wins if the same asset overlaps itself.
      if (slots.some((s) => s.key === clip.mediaRef)) continue;

      const asset = project.media.find((m) => m.id === clip.mediaRef);
      if (!asset || asset.generationStatus.kind !== "none") continue;

      const targetTime = Math.max(
        0,
        (clip.trimStartFrame + (playhead - clip.startFrame) * (clip.speed ?? 1)) / fps,
      );

      slots.push({
        key: clip.mediaRef,
        // ?audio=1 → a standalone Opus/AAC proxy the WebView2 <audio> can always decode (playing the
        // source video container's audio directly is silent there even though the picture shows).
        src: `${mediaUrl(clip.mediaRef)}?audio=1`,
        targetTime,
        volume: clip.volume ?? 1,
        playing,
        duck: !!clip.audioDuck,
      });
    }
  }

  return slots;
}

// ─── Feature 2: Transform Overlay ────────────────────────────────────────────
// Drawn over the canvas when exactly one non-text clip is selected & visible.

const HANDLE_SIZE = 10; // px, half-size of corner handle hit areas

interface DragState {
  kind: "move" | "resize" | "rotate";
  corner?: "tl" | "tr" | "bl" | "br";
  startNX: number; // normalized pointer start
  startNY: number;
  origTransform: Transform;
  lastSent: number; // timestamp for throttle
}

function TransformOverlay({
  clip,
  canvasW: cw,
  canvasH: ch,
  zoom = 1,
}: {
  clip: Clip;
  canvasW: number;
  canvasH: number;
  zoom?: number;
}) {
  // Handles render at logical canvas coords (the stage CSS-scales them); pointer deltas, however,
  // are screen px, so they map through the on-screen size cw*zoom / ch*zoom.
  const sw = cw * zoom;
  const sh = ch * zoom;
  const dragRef = useRef<DragState | null>(null);
  const [liveTransform, setLiveTransform] = useState<Transform | null>(null);

  // Use live transform during drag, otherwise clip.transform
  const t = liveTransform ?? clip.transform;

  const left = t.centerX - t.width / 2;
  const top = t.centerY - t.height / 2;

  const pxLeft = left * cw;
  const pxTop = top * ch;
  const pxW = t.width * cw;
  const pxH = t.height * ch;

  // Rotate-handle position: 20px above center-top
  const rotHandleX = t.centerX * cw;
  const rotHandleY = pxTop - 20;

  // Commit final transform to bridge
  const commit = useCallback(
    (tx: Transform) => {
      sendCommand("set_clip_properties", {
        clipIds: [clip.id],
        transform: {
          centerX: tx.centerX,
          centerY: tx.centerY,
          width: tx.width,
          height: tx.height,
          rotation: tx.rotation,
          flipHorizontal: tx.flipHorizontal,
          flipVertical: tx.flipVertical,
        },
      });
    },
    [clip.id],
  );

  const onPointerDown = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>, kind: DragState["kind"], corner?: DragState["corner"]) => {
      e.preventDefault();
      e.stopPropagation();
      (e.target as HTMLElement).setPointerCapture(e.pointerId);
      dragRef.current = {
        kind,
        corner,
        startNX: e.clientX / sw,
        startNY: e.clientY / sh,
        origTransform: { ...clip.transform },
        lastSent: 0,
      };
    },
    [clip.transform, sw, sh],
  );

  const onPointerMove = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      const drag = dragRef.current;
      if (!drag) return;

      const nx = e.clientX / sw;
      const ny = e.clientY / sh;
      const dx = nx - drag.startNX;
      const dy = ny - drag.startNY;
      const orig = drag.origTransform;

      let next: Transform = { ...orig };

      if (drag.kind === "move") {
        next = {
          ...orig,
          centerX: Math.max(0, Math.min(1, orig.centerX + dx)),
          centerY: Math.max(0, Math.min(1, orig.centerY + dy)),
        };
      } else if (drag.kind === "resize" && drag.corner) {
        // Corner resize — keep opposite corner fixed
        const c = drag.corner;
        const newCenterX =
          c === "tl" || c === "bl"
            ? orig.centerX + dx / 2
            : orig.centerX + dx / 2;
        const newCenterY =
          c === "tl" || c === "tr"
            ? orig.centerY + dy / 2
            : orig.centerY + dy / 2;
        const dw = c === "tl" || c === "bl" ? -dx : dx;
        const dh = c === "tl" || c === "tr" ? -dy : dy;
        next = {
          ...orig,
          centerX: newCenterX,
          centerY: newCenterY,
          width: Math.max(0.02, Math.min(2, orig.width + dw)),
          height: Math.max(0.02, Math.min(2, orig.height + dh)),
        };
      } else if (drag.kind === "rotate") {
        // Angle from canvas center-top of box to current pointer
        const cx = orig.centerX * sw;
        const cy = orig.centerY * sh;
        const startAngle = Math.atan2(drag.startNY * sh - cy, drag.startNX * sw - cx);
        const curAngle = Math.atan2(e.clientY - cy, e.clientX - cx);
        const delta = ((curAngle - startAngle) * 180) / Math.PI;
        next = { ...orig, rotation: orig.rotation + delta };
      }

      setLiveTransform(next);

      // Throttle live sends to ~30 fps
      const now = Date.now();
      if (now - drag.lastSent > 33) {
        drag.lastSent = now;
        commit(next);
      }
    },
    [sw, sh, commit],
  );

  const onPointerUp = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      const drag = dragRef.current;
      if (!drag) return;
      dragRef.current = null;
      // Final commit with the live value
      if (liveTransform) {
        commit(liveTransform);
        setLiveTransform(null);
      }
      e.stopPropagation();
    },
    [liveTransform, commit],
  );

  // Reset live transform when clip changes externally
  useEffect(() => {
    setLiveTransform(null);
    dragRef.current = null;
  }, [clip.id]);

  const hs = HANDLE_SIZE;

  const handleStyle = (hLeft: number, hTop: number): CSSProperties => ({
    position: "absolute",
    left: hLeft - hs / 2,
    top: hTop - hs / 2,
    width: hs,
    height: hs,
    background: "#ffffff",
    border: "1.5px solid #0ea5e9",
    borderRadius: 2,
    cursor: "nwse-resize",
    zIndex: 10,
    touchAction: "none",
  });

  // Line from center-top to rotate handle
  const lineStyle: CSSProperties = {
    position: "absolute",
    left: rotHandleX,
    top: rotHandleY,
    width: 1,
    height: 20,
    background: "#0ea5e9",
    transformOrigin: "top",
    pointerEvents: "none",
  };

  return (
    <div
      style={{ position: "absolute", inset: 0, pointerEvents: "none" }}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
    >
      {/* Selection box */}
      <div
        style={{
          position: "absolute",
          left: pxLeft,
          top: pxTop,
          width: pxW,
          height: pxH,
          border: "1.5px solid #0ea5e9",
          boxSizing: "border-box",
          cursor: "move",
          pointerEvents: "auto",
          touchAction: "none",
          transform: t.rotation ? `rotate(${t.rotation}deg)` : undefined,
          transformOrigin: "center",
        }}
        onPointerDown={(e) => onPointerDown(e, "move")}
      />

      {/* Corner handles (in unrotated space for simplicity) */}
      {/* TL */}
      <div
        style={{ ...handleStyle(pxLeft, pxTop), pointerEvents: "auto", cursor: "nw-resize" }}
        onPointerDown={(e) => onPointerDown(e, "resize", "tl")}
      />
      {/* TR */}
      <div
        style={{ ...handleStyle(pxLeft + pxW, pxTop), pointerEvents: "auto", cursor: "ne-resize" }}
        onPointerDown={(e) => onPointerDown(e, "resize", "tr")}
      />
      {/* BL */}
      <div
        style={{ ...handleStyle(pxLeft, pxTop + pxH), pointerEvents: "auto", cursor: "sw-resize" }}
        onPointerDown={(e) => onPointerDown(e, "resize", "bl")}
      />
      {/* BR */}
      <div
        style={{ ...handleStyle(pxLeft + pxW, pxTop + pxH), pointerEvents: "auto", cursor: "se-resize" }}
        onPointerDown={(e) => onPointerDown(e, "resize", "br")}
      />

      {/* Rotate connector line */}
      <div style={lineStyle} />

      {/* Rotate handle */}
      <div
        style={{
          position: "absolute",
          left: rotHandleX - hs / 2,
          top: rotHandleY - hs / 2,
          width: hs,
          height: hs,
          background: "#0ea5e9",
          borderRadius: "50%",
          border: "1.5px solid #fff",
          cursor: "crosshair",
          pointerEvents: "auto",
          zIndex: 10,
          touchAction: "none",
        }}
        onPointerDown={(e) => onPointerDown(e, "rotate")}
      />
    </div>
  );
}

// ─── Feature 3: Source Viewer ─────────────────────────────────────────────────

function SourceViewer({ assetId }: { assetId: string }) {
  const { project } = useEditor();
  const asset = project?.media.find((m) => m.id === assetId);

  return (
    <div className="absolute inset-0 flex flex-col bg-neutral-950">
      {/* No internal header: the tab strip above the monitor names this source and closes it. */}
      {/* Content */}
      <div className="relative grid min-h-0 flex-1 place-items-center p-4">
        {!asset || asset.generationStatus.kind !== "none" ? (
          <span className="text-xs text-neutral-500">
            {asset ? `${asset.generationStatus.kind}…` : "Asset not found"}
          </span>
        ) : asset.type === "video" ? (
          <video
            src={mediaUrl(assetId)}
            controls
            className="max-h-full max-w-full rounded shadow-lg shadow-black/50"
          />
        ) : asset.type === "image" ? (
          <img
            src={mediaUrl(assetId)}
            alt={asset.name}
            className="max-h-full max-w-full rounded shadow-lg shadow-black/50"
          />
        ) : asset.type === "audio" ? (
          <div className="flex flex-col items-center gap-3">
            <div className="flex h-16 w-16 items-center justify-center rounded-full bg-neutral-800 text-2xl">
              ♪
            </div>
            <audio src={mediaUrl(assetId)} controls className="w-64" />
            <span className="text-xs text-neutral-400">{asset.name}</span>
          </div>
        ) : (
          <span className="text-xs text-neutral-500">{t("prev.unsupported")}</span>
        )}
      </div>
    </div>
  );
}

// ─── Transport bar button styles ──────────────────────────────────────────────

const btnBase =
  "flex h-6 w-6 items-center justify-center rounded text-xs transition-colors hover:bg-neutral-700 text-neutral-400 hover:text-neutral-200";
const btnActive = "bg-neutral-700 text-neutral-100";

// ─── Preview (main export) ────────────────────────────────────────────────────

/** Interactive crop: draggable edges/corners over the selected clip set its crop insets (0..1).
 * Mirrors the transform overlay — handles render at logical coords, pointer math uses cw*zoom. */
function CropOverlay({
  clip,
  canvasW: cw,
  canvasH: ch,
  zoom = 1,
}: {
  clip: Clip;
  canvasW: number;
  canvasH: number;
  zoom?: number;
}) {
  const sw = cw * zoom;
  const sh = ch * zoom;
  const dragRef = useRef<{ edge: string; startNX: number; startNY: number; orig: Crop; lastSent: number } | null>(null);
  const [live, setLive] = useState<Crop | null>(null);
  const crop = live ?? clip.crop ?? { left: 0, top: 0, right: 0, bottom: 0 };

  const x0 = crop.left * cw;
  const y0 = crop.top * ch;
  const x1 = (1 - crop.right) * cw;
  const y1 = (1 - crop.bottom) * ch;

  const commit = useCallback(
    (c: Crop) => {
      sendCommand("set_clip_properties", { clipIds: [clip.id], crop: c });
    },
    [clip.id],
  );

  const onDown = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>, edge: string) => {
      e.preventDefault();
      e.stopPropagation();
      (e.target as HTMLElement).setPointerCapture(e.pointerId);
      dragRef.current = { edge, startNX: e.clientX / sw, startNY: e.clientY / sh, orig: { ...crop }, lastSent: 0 };
    },
    [crop, sw, sh],
  );

  const onMove = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      const d = dragRef.current;
      if (!d) return;
      const dx = e.clientX / sw - d.startNX;
      const dy = e.clientY / sh - d.startNY;
      const o = d.orig;
      const next: Crop = { ...o };
      const clamp = (v: number, max: number) => Math.max(0, Math.min(max, v));
      if (d.edge.includes("l")) next.left = clamp(o.left + dx, 1 - o.right - 0.02);
      if (d.edge.includes("r")) next.right = clamp(o.right - dx, 1 - o.left - 0.02);
      if (d.edge.includes("t")) next.top = clamp(o.top + dy, 1 - o.bottom - 0.02);
      if (d.edge.includes("b")) next.bottom = clamp(o.bottom - dy, 1 - o.top - 0.02);
      setLive(next);
      const now = Date.now();
      if (now - d.lastSent > 33) {
        d.lastSent = now;
        commit(next);
      }
    },
    [sw, sh, commit],
  );

  const onUp = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      if (!dragRef.current) return;
      dragRef.current = null;
      if (live) {
        commit(live);
        setLive(null);
      }
      e.stopPropagation();
    },
    [live, commit],
  );

  useEffect(() => {
    setLive(null);
    dragRef.current = null;
  }, [clip.id]);

  const hs = 12;
  const handle = (left: number, top: number, cursor: string): CSSProperties => ({
    position: "absolute",
    left: left - hs / 2,
    top: top - hs / 2,
    width: hs,
    height: hs,
    background: "#fff",
    border: "1.5px solid #f59e0b",
    borderRadius: 2,
    cursor,
    zIndex: 10,
    touchAction: "none",
    pointerEvents: "auto",
  });
  const midX = (x0 + x1) / 2;
  const midY = (y0 + y1) / 2;

  return (
    <div style={{ position: "absolute", inset: 0, pointerEvents: "none" }} onPointerMove={onMove} onPointerUp={onUp}>
      {/* crop frame + dimmed area outside it */}
      <div
        style={{
          position: "absolute",
          left: x0,
          top: y0,
          width: x1 - x0,
          height: y1 - y0,
          outline: "1px solid #f59e0b",
          boxShadow: "0 0 0 9999px rgba(0,0,0,0.5)",
          pointerEvents: "none",
        }}
      />
      <div onPointerDown={(e) => onDown(e, "tl")} style={handle(x0, y0, "nwse-resize")} />
      <div onPointerDown={(e) => onDown(e, "tr")} style={handle(x1, y0, "nesw-resize")} />
      <div onPointerDown={(e) => onDown(e, "bl")} style={handle(x0, y1, "nesw-resize")} />
      <div onPointerDown={(e) => onDown(e, "br")} style={handle(x1, y1, "nwse-resize")} />
      <div onPointerDown={(e) => onDown(e, "t")} style={handle(midX, y0, "ns-resize")} />
      <div onPointerDown={(e) => onDown(e, "b")} style={handle(midX, y1, "ns-resize")} />
      <div onPointerDown={(e) => onDown(e, "l")} style={handle(x0, midY, "ew-resize")} />
      <div onPointerDown={(e) => onDown(e, "r")} style={handle(x1, midY, "ew-resize")} />
    </div>
  );
}

// ─── Pen mask overlay ─────────────────────────────────────────────────────────
// Freeform mask drawing over the selected clip: click adds vertices, dragging a dot moves it,
// double-click or Enter closes (≥3 points → set_mask shape "path"), Esc exits, Backspace removes
// the last vertex. An existing path mask seeds the points so ✎ re-opens it for editing. All
// pointer/keyboard handling is contained here — nothing leaks into the other overlays.
// Points are stored in CLIP space via canvasToClip/clipToCanvas (maskPen.ts), using the clip's
// STATIC transform box: the mask applies pre-rotation in export and CSS alike, so the pen draws
// on the unrotated box (position keyframes are likewise ignored while drawing).

function MaskPenOverlay({
  clip,
  canvasW: cw,
  canvasH: ch,
  onExit,
}: {
  clip: Clip;
  canvasW: number;
  canvasH: number;
  onExit: () => void;
}) {
  const t = clip.transform;
  const surfRef = useRef<HTMLDivElement>(null);
  const [points, setPoints] = useState<[number, number][]>(() =>
    clip.mask?.shape === "path" ? (clip.mask.points ?? []).map((p) => [p[0], p[1]] as [number, number]) : [],
  );
  // Latest points for the window key handler (avoids committing from inside a state updater).
  const pointsRef = useRef(points);
  pointsRef.current = points;
  const dragRef = useRef<number | null>(null);

  // Pointer → canvas-normalized coords via the overlay's own rect: unlike the transform/crop
  // overlays (delta-only math), the pen needs ABSOLUTE canvas positions, and the stage may be
  // CSS-zoomed — the bounding rect already reflects that scale.
  const toCanvasNorm = (e: { clientX: number; clientY: number }): [number, number] | null => {
    const r = surfRef.current?.getBoundingClientRect();
    if (!r || r.width === 0 || r.height === 0) return null;
    return [(e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height];
  };

  const commit = useCallback(
    (pts: [number, number][]): boolean => {
      if (pts.length < 3) return false;
      // Preserve the existing mask's feather/invert/smooth: redrawing the outline must not reset
      // knobs already tuned in the Inspector's Mask section.
      const prev = clip.mask;
      sendCommand("set_mask", {
        clipIds: [clip.id],
        shape: "path",
        points: pts,
        smooth: prev?.shape === "path" ? !!prev.smooth : false,
        feather: prev?.feather ?? 0.05,
        invert: prev?.invert ?? false,
      });
      return true;
    },
    [clip.id, clip.mask],
  );

  // Capture-phase listener so the app-wide shortcuts (Backspace/Delete = remove CLIP!) can never
  // fire while the pen is active.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Enter") {
        e.preventDefault();
        e.stopPropagation();
        if (commit(pointsRef.current)) onExit();
      } else if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        onExit();
      } else if (e.key === "Backspace" || e.key === "Delete") {
        e.preventDefault();
        e.stopPropagation();
        setPoints((pts) => pts.slice(0, -1));
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [commit, onExit]);

  const onSurfaceDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    const cn = toCanvasNorm(e);
    if (!cn) return;
    e.stopPropagation(); // keep the stage's pan/deselect handlers out of pen clicks
    setPoints((pts) => [...pts, canvasToClip(cn[0], cn[1], t)]);
  };

  const onSurfaceDblClick = () => {
    // A double-click's two single clicks each appended a near-duplicate vertex — drop one
    // before closing so the polygon doesn't get a degenerate edge.
    let pts = pointsRef.current;
    if (pts.length >= 2) {
      const a = pts[pts.length - 1]!;
      const b = pts[pts.length - 2]!;
      if (Math.hypot(a[0] - b[0], a[1] - b[1]) < 0.02) pts = pts.slice(0, -1);
    }
    setPoints(pts);
    if (commit(pts)) onExit();
  };

  const onDotDown = (e: ReactPointerEvent<HTMLDivElement>, idx: number) => {
    e.preventDefault();
    e.stopPropagation(); // a dot press must not also add a new vertex on the surface
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    dragRef.current = idx;
  };
  const onDotMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const idx = dragRef.current;
    if (idx == null) return;
    const cn = toCanvasNorm(e);
    if (!cn) return;
    setPoints((pts) => pts.map((p, i) => (i === idx ? canvasToClip(cn[0], cn[1], t) : p)));
  };
  const onDotUp = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (dragRef.current == null) return;
    dragRef.current = null;
    e.stopPropagation();
    // Live re-commit while editing an ALREADY-applied path mask, so the preview's soft cutout
    // follows the drag; a still-open new polygon waits for the explicit close.
    if (clip.mask?.shape === "path") commit(pointsRef.current);
  };

  const canvasPts = points.map((p) => {
    const [nx, ny] = clipToCanvas(p[0], p[1], t);
    return [nx * cw, ny * ch] as [number, number];
  });
  const closed = clip.mask?.shape === "path";

  return (
    <div
      ref={surfRef}
      style={{ position: "absolute", inset: 0, cursor: "crosshair", touchAction: "none" }}
      onPointerDown={onSurfaceDown}
      onDoubleClick={onSurfaceDblClick}
    >
      {/* outline: drawn edges solid, the implicit closing edge dashed until the mask is applied */}
      <svg width={cw} height={ch} viewBox={`0 0 ${cw} ${ch}`} style={{ position: "absolute", inset: 0, pointerEvents: "none", overflow: "visible" }}>
        {canvasPts.length >= 3 && (
          <polygon points={canvasPts.map((p) => p.join(",")).join(" ")} fill="rgba(168,85,247,0.12)" stroke="none" />
        )}
        {canvasPts.length >= 2 && (
          <polyline points={canvasPts.map((p) => p.join(",")).join(" ")} fill="none" stroke="#a855f7" strokeWidth={1.5} />
        )}
        {canvasPts.length >= 3 && (
          <line
            x1={canvasPts[canvasPts.length - 1]![0]}
            y1={canvasPts[canvasPts.length - 1]![1]}
            x2={canvasPts[0]![0]}
            y2={canvasPts[0]![1]}
            stroke="#a855f7"
            strokeWidth={1.5}
            strokeDasharray={closed ? undefined : "4 3"}
          />
        )}
      </svg>
      {canvasPts.map(([x, y], i) => (
        <div
          key={i}
          onPointerDown={(e) => onDotDown(e, i)}
          onPointerMove={onDotMove}
          onPointerUp={onDotUp}
          style={{
            position: "absolute",
            left: x - 4,
            top: y - 4,
            width: 8,
            height: 8,
            borderRadius: "50%",
            background: i === 0 ? "#a855f7" : "#ffffff",
            border: "1.5px solid #a855f7",
            cursor: "grab",
            touchAction: "none",
            zIndex: 10,
          }}
        />
      ))}
      <div className="pointer-events-none absolute bottom-1 left-1/2 -translate-x-1/2 rounded bg-neutral-900/85 px-2 py-0.5 text-[10px] text-neutral-300">
        click: add point · drag: move · double-click/Enter: apply · Backspace: undo · Esc: exit
      </div>
    </div>
  );
}

export function Preview() {
  const { project, playhead, playing, tool, selectedClipIds, sourceAssetId, openSourceIds } = useEditor();
  const fps = project?.timeline.fps ?? 30;
  const W = project?.timeline.width ?? 1920;
  const H = project?.timeline.height ?? 1080;
  const tracks = project?.timeline.tracks ?? [];
  const total = Math.max(1, project ? timelineTotalFrames(project.timeline) : 1);
  const { ref, box } = useFit(W, H);
  const scale = H > 0 ? box.h / H : 0;

  // Canvas viewport zoom/pan (inspect detail) — distinct from a clip's transform.
  const [view, setView] = useState({ zoom: 1, x: 0, y: 0 });
  const panRef = useRef<{ sx: number; sy: number; ox: number; oy: number } | null>(null);
  const onWheelView = (e: ReactWheelEvent<HTMLDivElement>) => {
    e.preventDefault();
    const r = ref.current?.getBoundingClientRect();
    if (!r) return;
    const cx = e.clientX - r.left - r.width / 2;
    const cy = e.clientY - r.top - r.height / 2;
    setView((v) => {
      const z = Math.min(8, Math.max(1, v.zoom * (e.deltaY < 0 ? 1.12 : 1 / 1.12)));
      if (z === v.zoom) return v;
      if (z === 1) return { zoom: 1, x: 0, y: 0 };
      const k = z / v.zoom;
      return { zoom: z, x: cx - k * (cx - v.x), y: cy - k * (cy - v.y) };
    });
  };
  const onPanDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 1 && !(e.button === 0 && e.altKey)) return; // middle-mouse, or Alt+left-drag
    e.preventDefault();
    panRef.current = { sx: e.clientX, sy: e.clientY, ox: view.x, oy: view.y };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  };
  const onPanMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const p = panRef.current;
    if (!p) return;
    setView((v) => ({ ...v, x: p.ox + (e.clientX - p.sx), y: p.oy + (e.clientY - p.sy) }));
  };
  const onPanUp = () => {
    panRef.current = null;
  };

  // Interactive crop mode — shows the crop overlay (draggable edges) over the selected clip.
  const [cropMode, setCropMode] = useState(false);
  // Pen-mask mode — click vertices on the canvas to cut a freeform mask (MaskPenOverlay).
  const [maskMode, setMaskMode] = useState(false);

  // The active view derives from the tab strip above the monitor: a source tab → source view,
  // the Timeline tab → program view. No separate toggle state to keep in sync.
  const viewMode: "program" | "source" = sourceAssetId ? "source" : "program";

  // Real-time playback advance. The last visible frame is total-1 (clip ranges are end-exclusive);
  // stopping there keeps the final frame on screen instead of parking the playhead one frame past
  // the content (which left the preview blank and the playhead pinned to the timeline's edge).
  const lastFrame = Math.max(0, total - 1);
  useEffect(() => {
    if (!playing) return;
    const tick = window.setInterval(() => ui.advance(1, lastFrame), Math.max(16, 1000 / fps));
    return () => window.clearInterval(tick);
  }, [playing, fps, lastFrame]);

  // Stop at end of timeline
  useEffect(() => {
    if (playing && total > 0 && playhead >= lastFrame) ui.setPlaying(false);
  }, [playing, playhead, total, lastFrame]);

  const inFrame = (c: Clip) => playhead >= c.startFrame && playhead < c.startFrame + c.durationFrames;

  // ── Feature 1: Audio slots ─────────────────────────────────────────────────
  const audioSlots = buildAudioSlots(project, playhead, playing, fps);

  // ── Feature 2: Transform overlay selection ─────────────────────────────────
  // Only show when exactly 1 non-text clip is selected AND visible at playhead
  const selectedClip = (() => {
    if (selectedClipIds.length !== 1) return null;
    const id = selectedClipIds[0];
    for (const track of tracks) {
      // No transform overlay for adjustment layers: they have no geometry — dragging a resize box
      // on one would change nothing.
      const clip = track.clips.find((c) => c.id === id);
      if (clip && clip.mediaType !== "text" && clip.mediaType !== "adjustment" && inFrame(clip)) return clip;
    }
    return null;
  })();

  // ── FX preview notice badge ─────────────────────────────────────────────────
  // glow previews as a drop-shadow bloom (an approximation of the export's thresholded screen
  // blend), and chromakey stays export-only where WebGL2 is unavailable. If a clip under the
  // playhead is affected, say so ONCE at canvas level — never silently.
  const fxNotices = (() => {
    let glow = false;
    let chromaExportOnly = false;
    for (const track of tracks) {
      for (const c of track.clips) {
        if (!inFrame(c)) continue;
        // The GL keyer only stands in for plain video clips — images/adjustments/compounds with a
        // chromakey (or any clip when WebGL2 is missing) still key at export time only.
        const chromaPreviewable = hasWebGL2() && !c.compoundId && c.mediaType === "video";
        for (const e of c.effects ?? []) {
          if (e.enabled === false) continue;
          if (e.type === "glow") glow = true;
          if (e.type === "chromakey" && !chromaPreviewable) chromaExportOnly = true;
        }
      }
    }
    const notes: string[] = [];
    if (chromaExportOnly) notes.push("chromakey renders on export only");
    if (glow) notes.push("glow preview is approximate");
    return notes;
  })();

  // ── Double-click the preview SELECTS the clip you clicked ──────────────────
  // (the top-most clip visible at the playhead). It no longer auto-opens the Source viewer — that was
  // confusing and could blank the canvas; Source is still reachable via the explicit Source toggle.
  const handleCanvasDblClick = useCallback(() => {
    const reversedTracks = [...tracks].reverse();
    for (const track of reversedTracks) {
      const clip = track.clips.find(inFrame);
      if (clip) {
        ui.select([clip.id]);
        return;
      }
    }
  }, [tracks, inFrame]);

  const currentTc = frameToTimecode(playhead, fps);
  const totalTc = frameToTimecode(Math.max(0, total - 1), fps);

  // Format chips (Palmier's "16:9 · 24 · FHD" readout). Odd sizes fall back to a decimal ratio.
  const gcd = (a: number, b: number): number => (b ? gcd(b, a % b) : a);
  const g = W > 0 && H > 0 ? gcd(W, H) : 1;
  const aspectLabel =
    W > 0 && H > 0 ? (W / g <= 32 && H / g <= 32 ? `${W / g}:${H / g}` : `${(W / H).toFixed(2)}:1`) : "";
  const resLabel = H >= 2160 ? "4K" : H >= 1440 ? "QHD" : H >= 1080 ? "FHD" : H >= 720 ? "HD" : `${H}p`;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* Audio engine (hidden) */}
      <AudioEngine slots={audioSlots} />

      {/* Palmier-style view tabs: Timeline first, then one tab per open source asset */}
      <div className="flex h-8 shrink-0 items-stretch gap-0.5 overflow-x-auto border-b border-neutral-800 bg-neutral-900/60 px-2 [scrollbar-width:none]">
        <ViewTab active={!sourceAssetId} label={t("timeline.title")} onClick={() => ui.showTimelineTab()} />
        {openSourceIds.map((id) => {
          const a = project?.media.find((m) => m.id === id);
          return (
            <ViewTab
              key={id}
              active={sourceAssetId === id}
              label={a?.name ?? id}
              onClick={() => ui.openSource(id)}
              onClose={() => ui.closeSource(id)}
            />
          );
        })}
      </div>

      {/* Canvas area */}
      <div
        ref={ref}
        className="relative grid min-h-0 flex-1 place-items-center overflow-hidden bg-neutral-950 p-4"
        onWheel={onWheelView}
        onPointerDown={onPanDown}
        onPointerMove={onPanMove}
        onPointerUp={onPanUp}
        onPointerCancel={onPanUp}
        style={{ cursor: panRef.current ? "grabbing" : undefined }}
      >
        {/* Viewport zoom indicator + Fit (scroll to zoom, middle/Alt-drag to pan) */}
        {view.zoom !== 1 && (
          <div className="absolute right-3 top-3 z-20 flex items-center gap-1 rounded bg-neutral-800/90 px-1.5 py-0.5 text-xs text-neutral-300">
            <span>{Math.round(view.zoom * 100)}%</span>
            <button onClick={() => setView({ zoom: 1, x: 0, y: 0 })} className="rounded px-1 hover:bg-neutral-700">
              {t("prev.fitLabel")}
            </button>
          </div>
        )}

        {/* FX preview notice — one badge for the whole canvas, not per-layer */}
        {viewMode === "program" && fxNotices.length > 0 && (
          <div className="pointer-events-none absolute bottom-2 left-3 z-20 rounded bg-neutral-900/85 px-1.5 py-0.5 text-[10px] text-amber-300/90">
            ⚠ {fxNotices.join(" · ")}
          </div>
        )}

        <div
          className="relative overflow-hidden bg-black shadow-lg shadow-black/50"
          style={{
            width: box.w || "100%",
            height: box.h || "auto",
            aspectRatio: box.w ? undefined : `${W}/${H}`,
            transform: `translate(${view.x}px, ${view.y}px) scale(${view.zoom})`,
          }}
          onDoubleClick={viewMode === "program" ? handleCanvasDblClick : undefined}
        >
          {/* Source viewer overlay */}
          {sourceAssetId && viewMode === "source" ? (
            <SourceViewer assetId={sourceAssetId} />
          ) : (
            <>
              {project &&
                tracks
                  .slice()
                  .reverse()
                  .map((track) =>
                    track.clips.filter(inFrame).map((c) => {
                      const isVideo = c.mediaType !== "text" && c.mediaType !== "image" && c.mediaType !== "audio";
                      // Key a video by (track, asset), NOT clip id: consecutive segments of the SAME source
                      // (e.g. after "remove pauses") then reuse ONE persistent <video> element across the
                      // cut — React just re-seeks it instead of mounting a fresh element, whose first frame
                      // is black in WebView2 until it decodes. The seek holds the last frame, so no flash.
                      const key = isVideo && c.mediaRef ? `vid-${track.id}-${c.mediaRef}` : c.id;
                      return (
                        <Layer key={key} clip={c} project={project} fps={fps} scale={scale} playing={playing} playhead={playhead} />
                      );
                    }),
                  )}

              {/* Transform / Crop / Pen-mask overlay */}
              {selectedClip &&
                box.w > 0 &&
                box.h > 0 &&
                (maskMode ? (
                  // Keyed by clip id: switching selection while in pen mode restarts the pen on
                  // the new clip's (possibly existing) path points.
                  <MaskPenOverlay key={selectedClip.id} clip={selectedClip} canvasW={box.w} canvasH={box.h} onExit={() => setMaskMode(false)} />
                ) : cropMode ? (
                  <CropOverlay clip={selectedClip} canvasW={box.w} canvasH={box.h} zoom={view.zoom} />
                ) : (
                  <TransformOverlay clip={selectedClip} canvasW={box.w} canvasH={box.h} zoom={view.zoom} />
                ))}
            </>
          )}
        </div>
      </div>

      {/* Transport bar — Palmier layout: timecode left (current in amber), transport center,
        * edit tools + format chips right */}
      <div className="flex flex-wrap items-center justify-between gap-y-1 border-t border-neutral-800 px-3 py-1.5">
        {/* LEFT: timecode readout */}
        <span className="font-mono text-xs" style={{ fontVariantNumeric: "tabular-nums" }}>
          <span className="text-amber-400/90">{currentTc}</span>
          <span className="text-neutral-500"> / {totalTc}</span>
        </span>

        {/* CENTER: transport controls */}
        <div className="flex items-center gap-0.5">
          <button title={t("prev.skipStart")} onClick={() => ui.setPlayhead(0)} className={btnBase}>
            ⏮
          </button>
          {/* Step buttons use bar-glyph variants so they can't be mistaken for Play (two identical
            * ▶ side by side guaranteed wrong clicks). */}
          <button title={t("prev.stepBack")} onClick={() => ui.advance(-1, total)} className={btnBase}>
            ◁▏
          </button>
          <button
            title={playing ? "Pause" : "Play"}
            onClick={() => {
              if (!playing) kickAudio(); // start audio inside the gesture (WebView2 autoplay rule)
              ui.setPlaying(!playing);
            }}
            className={`${btnBase} w-7`}
          >
            {playing ? "⏸" : "▶"}
          </button>
          <button title={t("prev.stepFwd")} onClick={() => ui.advance(1, total)} className={btnBase}>
            ▕▷
          </button>
          <button title={t("prev.skipEnd")} onClick={() => ui.setPlayhead(total - 1)} className={btnBase}>
            ⏭
          </button>
        </div>

        {/* RIGHT: edit-mode tools + format chips */}
        <div className="flex items-center gap-1">
          <button
            title={t("prev.select")}
            onClick={() => ui.setTool("select")}
            className={`${btnBase} ${tool === "select" ? btnActive : ""}`}
          >
            ↖
          </button>
          <button
            title={t("prev.blade")}
            onClick={() => ui.setTool("blade")}
            className={`${btnBase} ${tool === "blade" ? btnActive : ""}`}
          >
            ✂
          </button>
          <button
            title={t("prev.crop")}
            onClick={() => setCropMode((v) => !v)}
            disabled={!selectedClip}
            className={`${btnBase} ${cropMode ? btnActive : ""} disabled:opacity-40`}
          >
            ⌗
          </button>
          <button
            title={t("prev.penMask")}
            onClick={() => setMaskMode((v) => !v)}
            disabled={!selectedClip}
            className={`${btnBase} ${maskMode ? btnActive : ""} disabled:opacity-40`}
          >
            ✎
          </button>
          <span className="mx-1 h-4 w-px bg-neutral-800" />
          <span className="text-[10px] tabular-nums text-neutral-500" title={t("prev.aspect")}>
            {aspectLabel}
          </span>
          <span className="text-[10px] tabular-nums text-neutral-500" title={t("prev.fps")}>
            {Number.isInteger(fps) ? fps : fps.toFixed(2)}
          </span>
          <span className="text-[10px] text-neutral-500" title={`${W}×${H}`}>
            {resLabel}
          </span>
          <button
            onClick={() => setView({ zoom: 1, x: 0, y: 0 })}
            className="rounded px-1.5 py-0.5 text-[10px] text-neutral-400 transition-colors hover:bg-neutral-800 hover:text-neutral-200"
            title={t("prev.fit")}
          >
            {t("prev.fitLabel")}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── ViewTab (monitor tab strip) ───────────────────────────────────────────────

function ViewTab({
  active,
  label,
  onClick,
  onClose,
}: {
  active: boolean;
  label: string;
  onClick: () => void;
  onClose?: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={label}
      className={`group flex max-w-[190px] shrink-0 items-center gap-1 border-b-2 px-2 pb-1.5 pt-1.5 text-xs transition-colors ${
        active ? "border-violet-400 text-neutral-100" : "border-transparent text-neutral-400 hover:text-neutral-200"
      }`}
    >
      <span className="truncate">{label}</span>
      {onClose && (
        <span
          role="button"
          tabIndex={-1}
          onClick={(e) => {
            e.stopPropagation();
            onClose();
          }}
          className={`rounded p-0.5 leading-none text-neutral-500 transition-opacity hover:bg-neutral-700 hover:text-neutral-200 ${
            active ? "opacity-100" : "opacity-0 group-hover:opacity-100"
          }`}
          title={t("common.close")}
        >
          <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round">
            <path d="M6 6l12 12M18 6 6 18" />
          </svg>
        </span>
      )}
    </button>
  );
}
