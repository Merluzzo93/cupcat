// Timeline compositing via ffmpeg filter_complex. Two consumers share one visual-graph builder:
//   exportTimeline → encodes the whole timeline to mp4 (with audio mix)
//   renderFrames   → renders single composited frames (for inspect_timeline)
//
// v1 scope: video/image layers (position, scale, opacity, trim, speed, time-gating), text
// overlays (drawtext), audio mixing. Deferred: keyframe animation, crop, fades, rotation.

import { join } from "node:path";
import {
  type Clip,
  type ColorGrade,
  type Crop,
  clipEndFrame,
  densifyTrack,
  type EditorDocument,
  type Effect,
  fpsRational,
  frameSecondsString,
  frameToSeconds,
  isIdentityCrop,
  isNeutralGrade,
  type MediaAsset,
  scaledLook,
  splitStyleSegments,
  type Timeline,
  timelineTotalFrames,
  transformTopLeft,
} from "@cupcat/editor-core";
import { existsSync } from "node:fs";
import { readdir, rename, rm } from "node:fs/promises";
import { exportsDir, FFMPEG_BIN, FFPROBE_BIN } from "./config";
import { channelBalanceFix, disablePlacebo, ensureDvSdrProxy, hasAlphaMode, hdrInputFix, imageScopes, inputColorFix, isHdrSource, isVulkanFailure, probeMedia } from "./ffmpeg";
import { ensurePathMaskPng } from "./pathmask";
import { consumeKilled, run } from "./proc";

const FONT = process.env.CUPCAT_FONT ?? "C:/Windows/Fonts/arialbd.ttf";

// Map a text clip's fontName (from the editor's font picker) to a Windows system font file.
// Every path below was verified to ship with Windows 10/11; fontFileFor still stats the file at
// first use so a stripped-down install degrades to the default font instead of failing drawtext.
const FONT_FILES: Record<string, string> = {
  "Helvetica-Bold": "C:/Windows/Fonts/arialbd.ttf",
  Arial: "C:/Windows/Fonts/arial.ttf",
  Georgia: "C:/Windows/Fonts/georgia.ttf",
  "Times New Roman": "C:/Windows/Fonts/times.ttf",
  Verdana: "C:/Windows/Fonts/verdana.ttf",
  "Trebuchet MS": "C:/Windows/Fonts/trebuc.ttf",
  "Courier New": "C:/Windows/Fonts/cour.ttf",
  Impact: "C:/Windows/Fonts/impact.ttf",
  "Comic Sans MS": "C:/Windows/Fonts/comic.ttf",
  "Segoe UI": "C:/Windows/Fonts/segoeui.ttf",
  "Segoe UI Semibold": "C:/Windows/Fonts/seguisb.ttf",
  Bahnschrift: "C:/Windows/Fonts/bahnschrift.ttf",
  Candara: "C:/Windows/Fonts/Candara.ttf",
  Consolas: "C:/Windows/Fonts/consola.ttf",
  Constantia: "C:/Windows/Fonts/constan.ttf",
  Corbel: "C:/Windows/Fonts/corbel.ttf",
};
// Existence cache: one stat per font file per process — the export must never hand ffmpeg a
// missing fontfile (drawtext aborts the whole render).
const fontFileSeen = new Map<string, boolean>();
function fontFileFor(name?: string): string {
  const mapped = name ? FONT_FILES[name] : undefined;
  if (!mapped) return FONT;
  let ok = fontFileSeen.get(mapped);
  if (ok === undefined) {
    try {
      ok = existsSync(mapped);
    } catch {
      ok = false;
    }
    fontFileSeen.set(mapped, ok);
  }
  return ok ? mapped : FONT;
}

export interface ExportResult {
  ok: boolean;
  path?: string;
  durationSeconds?: number;
  error?: string;
}

function s(n: number): string {
  return n.toFixed(3);
}
/** Frame-count → exact decimal-seconds string (≤7 decimals, from the fps rational — see
 * mediatime). EVERY frame-derived filter time goes through this instead of s(): 3-decimal
 * rounding of non-terminating boundaries (frame 68/30 = 2.2667) once excluded a boundary frame
 * from its enable window and produced a literal 1-frame black flash; at NTSC rates the same
 * rounding also drifts. s() stays for genuinely non-frame quantities (probe durations etc.). */
function sf(frames: number, fps: number): string {
  return frameSecondsString(frames, fps);
}
/** ffmpeg rate string: exact rational for NTSC ("30000/1001" — accepted by -r/-framerate and the
 * fps/zoompan filters), plain number otherwise. "29.97" would be parsed as 2997/100 ≠ 30000/1001. */
function fpsArg(fps: number): string {
  const r = fpsRational(fps);
  return r.den === 1 ? String(r.num) : `${r.num}/${r.den}`;
}
function clampTempo(speed: number): number {
  return Math.min(2, Math.max(0.5, speed));
}
function ffColor(hex: string): string {
  const h = hex.replace(/^#/, "");
  if (h.length === 8) return `0x${h.slice(0, 6)}@${(parseInt(h.slice(6, 8), 16) / 255).toFixed(3)}`;
  return `0x${h.slice(0, 6)}`;
}
/** Forward-slash a path and double-escape colons for an ffmpeg filtergraph value. */
function ffPath(p: string): string {
  return p.replace(/\\/g, "/").replace(/:/g, "\\\\:");
}

/** "#RRGGBB(AA)" → ASS &HAABBGGRR (ASS alpha is inverted: 00 = opaque). */
function assColor(hex: string): string {
  const h = hex.replace(/^#/, "");
  const a = h.length === 8 ? (255 - parseInt(h.slice(6, 8), 16)).toString(16).padStart(2, "0") : "00";
  return `&H${a}${h.slice(4, 6)}${h.slice(2, 4)}${h.slice(0, 2)}`.toUpperCase();
}
function assTimestamp(t: number): string {
  const cs = Math.max(0, Math.round(t * 100));
  const h = Math.floor(cs / 360000);
  const m = Math.floor((cs % 360000) / 6000);
  const sec = Math.floor((cs % 6000) / 100);
  return `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}.${String(cs % 100).padStart(2, "0")}`;
}
const assEscape = (t: string): string => t.replace(/[{}\\]/g, "").replace(/\r?\n/g, " ");

/** One ASS file for a group of karaoke caption clips: each clip is a Dialogue whose words carry
 * \k timing, so the word being spoken is tinted highlightColor (PrimaryColour) while the rest of
 * the line waits in the base color (SecondaryColour) — same mechanism the AI-clips burner uses.
 * drawtext cannot color part of a line, which is why karaoke captions go through libass. */
function karaokeAss(clips: Clip[], W: number, H: number, fps: number): string {
  const ts = clips[0]!.textStyle;
  const primary = assColor(ts?.highlightColor ?? "#FFD400");
  const secondary = assColor(ts?.color ?? "#FFFFFF");
  const size = Math.round(ts?.fontSize ?? 96);
  const outline = Math.max(2, Math.round(size / 14));
  const lines = [
    "[Script Info]",
    "ScriptType: v4.00+",
    `PlayResX: ${W}`,
    `PlayResY: ${H}`,
    "WrapStyle: 0",
    "ScaledBorderAndShadow: yes",
    "",
    "[V4+ Styles]",
    "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
    `Style: Cap,Arial,${size},${primary},${secondary},&H00000000,&H96000000,-1,0,0,0,100,100,0,0,1,${outline},0,5,20,20,20,1`,
    "",
    "[Events]",
    "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
  ];
  for (const c of clips) {
    const words = c.karaokeWords ?? [];
    if (!words.length) continue;
    const px = Math.round(c.transform.centerX * W);
    const py = Math.round(c.transform.centerY * H);
    const parts: string[] = [];
    let cursor = 0; // frames from clip start; \k durations are cumulative centiseconds
    for (let i = 0; i < words.length; i++) {
      const w = words[i]!;
      if (i === 0 && w.startFrame > 0) {
        parts.push(`{\\k${Math.round(frameToSeconds(w.startFrame, fps) * 100)}}`); // silent lead-in before the first word
        cursor = w.startFrame;
      }
      const next = words[i + 1];
      // hold the highlight through any gap to the next word (or the cue end) so it never blinks off
      const holdEnd = next ? Math.max(w.endFrame, next.startFrame) : Math.max(w.endFrame, c.durationFrames);
      const durCs = Math.max(1, Math.round(frameToSeconds(holdEnd - Math.max(cursor, w.startFrame), fps) * 100));
      parts.push(`{\\k${durCs}}${assEscape(w.word)}`);
      cursor = holdEnd;
    }
    lines.push(
      `Dialogue: 0,${assTimestamp(frameToSeconds(c.startFrame, fps))},${assTimestamp(frameToSeconds(clipEndFrame(c), fps))},Cap,,0,0,0,,{\\an5\\pos(${px},${py})}${parts.join(" ")}`,
    );
  }
  return lines.join("\n");
}

/** libass resolves system font FAMILY names (drawtext needs font FILES): map the editor's
 * fontName to an ASS family + bold flag; the default "Helvetica-Bold" becomes bold Arial,
 * matching drawtext's arialbd.ttf fallback. */
function assFontFor(name?: string): { family: string; bold: boolean } {
  if (!name || name === "Helvetica-Bold") return { family: "Arial", bold: true };
  return { family: name, bold: false };
}

/** One ASS file for ALL rich-text clips of an export (text clips with styleRanges): drawtext
 * cannot style part of a line, so these render through libass like karaoke captions. Each clip
 * is one Dialogue positioned via \an5\pos (same convention as karaokeAss) with its own
 * Default-derived Style; per-segment override tags ({\c&HBBGGRR&}{\b1}{\i1}{\fs<px>}) style the
 * ranged substrings and {\r} resets to the clip's style so overrides never leak across segments. */
function richTextAss(clips: Clip[], W: number, H: number, fps: number): string {
  const lines = [
    "[Script Info]",
    "ScriptType: v4.00+",
    `PlayResX: ${W}`,
    `PlayResY: ${H}`,
    "WrapStyle: 0",
    "ScaledBorderAndShadow: yes",
    "",
    "[V4+ Styles]",
    "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
  ];
  const events: string[] = [];
  clips.forEach((c, i) => {
    const ts = c.textStyle;
    const font = assFontFor(ts?.fontName);
    const size = Math.round(ts?.fontSize ?? 96);
    const primary = assColor(ts?.color ?? "#FFFFFF");
    // Shadow 2 / no outline ≈ the drawtext look (shadowcolor black@0.5, offset 2).
    lines.push(
      `Style: R${i},${font.family},${size},${primary},${primary},&H00000000,&H80000000,${font.bold ? -1 : 0},0,0,0,100,100,0,0,1,0,2,5,20,20,20,1`,
    );
    const px = Math.round(c.transform.centerX * W);
    const py = Math.round(c.transform.centerY * H);
    const parts = splitStyleSegments(c.textContent ?? "", c.styleRanges).map((seg) => {
      const tags: string[] = [];
      if (seg.color) tags.push(`\\c&H${assColor(seg.color).slice(4)}&`); // \c wants BBGGRR, no alpha byte
      if (seg.bold !== undefined) tags.push(`\\b${seg.bold ? 1 : 0}`);
      if (seg.italic !== undefined) tags.push(`\\i${seg.italic ? 1 : 0}`);
      if (seg.fontSizeScale) tags.push(`\\fs${Math.max(1, Math.round(size * seg.fontSizeScale))}`);
      return `{\\r${tags.join("")}}${assEscape(seg.text)}`;
    });
    events.push(
      `Dialogue: 0,${assTimestamp(frameToSeconds(c.startFrame, fps))},${assTimestamp(frameToSeconds(clipEndFrame(c), fps))},R${i},,0,0,0,,{\\an5\\pos(${px},${py})}${parts.join("")}`,
    );
  });
  lines.push("", "[Events]", "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text", ...events);
  return lines.join("\n");
}

function r3(n: number): string {
  return String(Math.round(n * 1000) / 1000);
}

/** crop filter from a clip's normalized edge insets (empty when identity). */
function cropChain(c: Clip, fps: number): string {
  // Animated crop (e.g. a wipe transition) takes over when keyframed — cropTrack was previously
  // tracked in the data model (split/shift logic already carries it along) but never actually
  // rendered anywhere, so any tool/transition that set it had silently no visual effect.
  const ck = c.cropTrack?.keyframes ?? [];
  if (ck.length >= 2) {
    // `n` (this filter's own sequential frame count, always 0-based) — NOT `t`, which after setpts
    // reflects the clip's GLOBAL timeline position (shifted by its startFrame), not clip-local time.
    const at = (pick: (v: Crop) => number) => pwlExpr(ck.map((k) => ({ frame: k.frame, value: pick(k.value), interp: k.interpolationOut })), "n");
    const L = at((v) => v.left);
    const T = at((v) => v.top);
    const R = at((v) => v.right);
    const B = at((v) => v.bottom);
    return `crop=w='iw*max(0.01\\,1-(${L})-(${R}))':h='ih*max(0.01\\,1-(${T})-(${B}))':x='iw*(${L})':y='ih*(${T})'`;
  }
  if (isIdentityCrop(c.crop)) return "";
  const { left, top, right, bottom } = c.crop;
  const w = Math.max(0.01, 1 - left - right);
  const h = Math.max(0.01, 1 - top - bottom);
  return `crop=iw*${r3(w)}:ih*${r3(h)}:iw*${r3(left)}:ih*${r3(top)}`;
}

/** Color grade → ffmpeg eq/colortemperature/colorbalance/curves/lut3d chain (empty when neutral). */
function colorChain(g?: ColorGrade): string {
  if (isNeutralGrade(g) || !g) return "";
  const parts: string[] = [];
  const clamp = (x: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, x));
  const brightness = clamp((g.exposure ?? 0) * 0.12, -1, 1);
  const contrast = g.contrast ?? 1;
  let sat = g.saturation ?? 1;
  if (g.vibrance) sat = Math.max(0, sat * (1 + g.vibrance * 0.6));
  const gamma = g.gamma ?? 1;
  if (brightness !== 0 || contrast !== 1 || sat !== 1 || gamma !== 1) {
    const eqp: string[] = [];
    if (brightness !== 0) eqp.push(`brightness=${r3(brightness)}`);
    if (contrast !== 1) eqp.push(`contrast=${r3(contrast)}`);
    if (sat !== 1) eqp.push(`saturation=${r3(sat)}`);
    if (gamma !== 1) eqp.push(`gamma=${r3(gamma)}`);
    parts.push(`eq=${eqp.join(":")}`);
  }
  const temp = g.temperature ?? 6500;
  // Photographic convention: higher K = WARMER. ffmpeg's colortemperature is inverted (higher = bluer),
  // so mirror around the 6500 K neutral point before passing it through.
  if (temp !== 6500) {
    const ffTemp = Math.max(1000, Math.min(40000, 13000 - temp));
    parts.push(`colortemperature=temperature=${Math.round(ffTemp)}:mix=1:pl=1`);
  }
  if (g.tint) parts.push(`colorbalance=gm=${r3(clamp(g.tint / 100, -1, 1))}`);
  const hi = g.highlights ?? 0;
  const sh = g.shadows ?? 0;
  const bl = g.blacks ?? 0;
  const wh = g.whites ?? 0;
  if (hi || sh || bl || wh) {
    const cl = (x: number) => clamp(x, 0, 1);
    const y0 = cl(bl > 0 ? bl * 0.4 : 0);
    const y25 = cl(0.25 + sh * 0.2);
    const y75 = cl(0.75 + hi * 0.2);
    const y1 = cl(1 + (wh < 0 ? wh * 0.3 : 0));
    parts.push(`curves=master='0/${r3(y0)} 0.25/${r3(y25)} 0.75/${r3(y75)} 1/${r3(y1)}'`);
  }
  if (g.lut) parts.push(`lut3d=file=${ffPath(g.lut)}`);
  return parts.join(",");
}

/** Non-color effect stack → ffmpeg chain (rendered in a fixed canonical order). */
function effectChain(effects?: Effect[]): string {
  if (!effects?.length) return "";
  const order = ["chromakey", "look", "blur", "sharpen", "grain", "vignette"];
  const sorted = effects
    .filter((e) => e.enabled !== false)
    .sort((a, b) => order.indexOf(a.type) - order.indexOf(b.type));
  const num = (e: Effect, k: string, d: number) => {
    const v = e.params?.[k];
    return typeof v === "number" ? v : d;
  };
  const out: string[] = [];
  for (const e of sorted) {
    switch (e.type) {
      case "vignette":
        out.push(`vignette=a=${r3(0.3 + num(e, "amount", 0.4) * 1.0)}`);
        break;
      case "grain":
        out.push(`noise=alls=${Math.round(num(e, "amount", 0.25) * 40)}:allf=t+u`);
        break;
      case "blur":
        out.push(`gblur=sigma=${r3(num(e, "amount", 8))}`);
        break;
      case "sharpen":
        out.push(`unsharp=5:5:${r3(num(e, "amount", 1))}:5:5:0`);
        break;
      case "chromakey": {
        const color = typeof e.params?.color === "string" ? (e.params.color as string) : "0x00ff00";
        out.push(`chromakey=${color}:${r3(num(e, "similarity", 0.3))}:${r3(num(e, "blend", 0.1))}`);
        break;
      }
      case "look": {
        // One-tap looks share their recipe table with the CSS preview (editor-core/looks.ts) so the
        // canvas and the export stay visually in sync. sepia via colorchannelmixer (the classic
        // matrix, mixed toward identity by strength); fade lifts the black point with curves.
        const name = typeof e.params?.name === "string" ? (e.params.name as string) : "cinematic";
        const rec = scaledLook(name, num(e, "amount", 1));
        if (!rec) break;
        if (rec.fade > 0.005) out.push(`curves=master='0/${r3(rec.fade * 0.35)} 1/1'`);
        if (rec.sepia > 0.005) {
          const s = rec.sepia;
          const m = (identity: number, sep: number) => r3(identity * (1 - s) + sep * s);
          out.push(
            `colorchannelmixer=rr=${m(1, 0.393)}:rg=${m(0, 0.769)}:rb=${m(0, 0.189)}:gr=${m(0, 0.349)}:gg=${m(1, 0.686)}:gb=${m(0, 0.168)}:br=${m(0, 0.272)}:bg=${m(0, 0.534)}:bb=${m(1, 0.131)}`,
          );
        }
        if (rec.hueDeg) out.push(`hue=h=${r3(rec.hueDeg)}`);
        const sat = rec.grayscale ? 0 : rec.saturation;
        if (Math.abs(rec.contrast - 1) > 0.005 || Math.abs(sat - 1) > 0.005 || Math.abs(rec.brightness - 1) > 0.005) {
          out.push(`eq=contrast=${r3(rec.contrast)}:saturation=${r3(sat)}:brightness=${r3(rec.brightness - 1)}`);
        }
        break;
      }
    }
  }
  return out.join(",");
}

/** A jittery, non-repeating handheld-camera wobble — several sine/cosine waves at non-harmonic
 * frequencies summed together (no true randomness needed; ffmpeg expressions can't seed one anyway).
 * Trims a small margin so the shake has room to move without ever exposing the frame edge. */
function shakeFilter(effects?: Effect[]): string {
  const e = effects?.find((x) => x.type === "shake" && x.enabled !== false);
  if (!e) return "";
  const amount = typeof e.params?.amount === "number" ? e.params.amount : 0.5; // 0..1
  const px = Math.max(2, Math.round(amount * 24)); // max jitter offset in source pixels
  const margin = px * 2; // room to move without exposing the edge
  const x = `(${margin}/2)+${px}*sin(9.1*t)+${Math.round(px * 0.4)}*sin(23.7*t)`;
  const y = `(${margin}/2)+${px}*cos(6.7*t)+${Math.round(px * 0.4)}*cos(19.3*t)`;
  return `crop=iw-${margin}:ih-${margin}:'${x}':'${y}'`;
}

/** crop fragment (pre-scale, trailing comma) + color/fx fragment (post-rgba, leading comma) for a clip. */
function clipLookFilters(c: Clip, fps: number): { pre: string; post: string } {
  const pre = [cropChain(c, fps), shakeFilter(c.effects)].filter(Boolean).join(",");
  const look = [colorChain(c.color), effectChain(c.effects)].filter(Boolean).join(",");
  return { pre: pre ? `${pre},` : "", post: look ? `,${look}` : "" };
}

/** Alpha fade in/out for a video/image clip (leading comma; timeline-time st, frame-exact). */
function videoFade(c: Clip, fps: number): string {
  const parts: string[] = [];
  if (c.fadeInFrames > 0) parts.push(`fade=t=in:st=${sf(c.startFrame, fps)}:d=${sf(c.fadeInFrames, fps)}:alpha=1`);
  if (c.fadeOutFrames > 0) parts.push(`fade=t=out:st=${sf(clipEndFrame(c) - c.fadeOutFrames, fps)}:d=${sf(c.fadeOutFrames, fps)}:alpha=1`);
  return parts.length ? `,${parts.join(",")}` : "";
}

/** Audio fade in/out for a clip, applied on the source-trimmed stream (st relative to 0).
 * srcDurFrames is the SOURCE-side duration in frames (durationFrames·speed — fractional when
 * speed-scaled; sf handles both). */
function audioFade(c: Clip, srcDurFrames: number, fps: number): string {
  const parts: string[] = [];
  if (c.fadeInFrames > 0) parts.push(`afade=t=in:st=0:d=${sf(c.fadeInFrames, fps)}`);
  if (c.fadeOutFrames > 0) parts.push(`afade=t=out:st=${sf(Math.max(0, srcDurFrames - c.fadeOutFrames), fps)}:d=${sf(c.fadeOutFrames, fps)}`);
  return parts.length ? `,${parts.join(",")}` : "";
}

/** Volume filter for a clip: a time-varying envelope (ducking) when the volume track moves — dB
 * keyframes → linear gain, evaluated per frame — otherwise the constant clip volume. */
/** Optional shape-mask alpha (leading comma): rect/ellipse, feathered, invertible. Sets the alpha
 * channel via geq so the compositor shows only the masked region. "path" masks are NOT handled
 * here — an arbitrary polygon has no geq expression, so buildVisualGraph feeds them as a
 * pre-rendered matte input + alphamerge (see pathmask.ts); returning "" keeps a failed matte
 * render as "unmasked" instead of silently degrading to a bounding-box rect. */
function maskFilter(c: Clip): string {
  const m = c.mask;
  if (!m || m.shape === "path") return "";
  const q = (n: number) => n.toFixed(4);
  const fn = q(Math.max(0.001, m.feather));
  const rw = q(Math.max(0.001, m.rw));
  const rh = q(Math.max(0.001, m.rh));
  let a: string;
  if (m.shape === "ellipse") {
    a = `clip((1-sqrt(pow((X/W-${q(m.cx)})/${rw},2)+pow((Y/H-${q(m.cy)})/${rh},2)))/${fn},0,1)`;
  } else {
    const ax = `clip(min(X/W-${q(m.cx - m.rw)},${q(m.cx + m.rw)}-X/W)/${fn},0,1)`;
    const ay = `clip(min(Y/H-${q(m.cy - m.rh)},${q(m.cy + m.rh)}-Y/H)/${fn},0,1)`;
    a = `${ax}*${ay}`;
  }
  if (m.invert) a = `(1-(${a}))`;
  return `,geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a='255*(${a})'`;
}

/** Optional audio-cleanup chain (leading comma): low-rumble highpass, FFT denoise, loudness normalize. */
function audioCleanupFilter(c: Clip): string {
  const parts: string[] = [];
  if (c.audioHighpass) parts.push("highpass=f=80");
  const dn = c.audioDenoise ?? 0;
  if (dn > 0) parts.push(`afftdn=nr=${(12 + dn * 24).toFixed(0)}:nf=-25`); // noise reduction 12..36 dB
  if (c.audioNormalize) parts.push("loudnorm=I=-16:TP=-1.5:LRA=11");
  return parts.length ? `,${parts.join(",")}` : "";
}

/** Optional voice-effect chain (leading comma), from the clip's audioFx. Sits after the
 * channel-balance fix and before cleanup/volume in BOTH audio paths (video-with-audio and
 * dedicated audio tracks). amount: pitch = semitones (clamped ±12, default +4 — rubberband
 * takes the frequency RATIO 2^(semi/12)); echo = delay in seconds (0.05..1.5, default 0.25);
 * robot/radio ignore it. Exported for tests. */
export function audioFxChain(c: Clip): string {
  const fx = c.audioFx;
  if (!fx) return "";
  switch (fx.type) {
    case "pitch": {
      const semi = Math.max(-12, Math.min(12, fx.amount ?? 4));
      return `,rubberband=pitch=${Math.pow(2, semi / 12).toFixed(6)}`;
    }
    case "robot":
      // Classic robot voice: FFT with the phase zeroed. The single quotes are for ffmpeg's
      // filtergraph parser (args go through argv, no shell), protecting the ',' inside hypot().
      return `,afftfilt=real='hypot(re,im)*cos(0)':imag='hypot(re,im)*sin(0)':win_size=512:overlap=0.75`;
    case "echo": {
      const delayMs = Math.round(Math.max(0.05, Math.min(1.5, fx.amount ?? 0.25)) * 1000);
      return `,aecho=0.8:0.85:${delayMs}:0.35`; // in_gain:out_gain:delays(ms):decays
    }
    case "radio":
      // Telephone/AM-radio band-limit + squash; volume makes up the level lost to the band-pass.
      return `,highpass=f=500,lowpass=f=2800,acompressor=ratio=6:threshold=-18dB,volume=1.2`;
  }
}

function audioVolumeFilter(c: Clip, fps: number): string {
  const vk = c.volumeTrack?.keyframes ?? [];
  const varying = vk.length >= 2 && vk.some((k) => k.value !== vk[0]!.value);
  if (!varying) return `volume=${c.volume}`;
  // interp must ride along: densified (bezier-derived) tracks are linear-only, and pwlExpr's
  // default is smooth — dropping it here would re-ease every densified sample.
  const lin = vk.map((k) => ({ frame: k.frame, value: Math.pow(10, k.value / 20), interp: k.interpolationOut }));
  // fpsArg: at NTSC rates "t*29.97" drifts off the true frame grid (~1 s over 10 h); the exact
  // rational "t*30000/1001" parses fine in ffmpeg expressions and never drifts.
  return `volume='${pwlExpr(lin, `t*${fpsArg(fps)}`)}':eval=frame`;
}

/** Ken Burns (animated zoom-in + pan) via zoompan, for a full-frame clip with scale/position
 * keyframes. Maps the editor's normalized scale→zoom and top-left→crop. Linear (first→last kf).
 * Returns null when it doesn't apply (non-full-frame, no kf, or zoom-out which zoompan can't do). */
function pwlExpr(kfs: { frame: number; value: number; interp?: string }[], v: string): string {
  const f = (n: number) => n.toFixed(4);
  const ks = [...kfs].sort((a, b) => a.frame - b.frame);
  if (ks.length === 0) return "0";
  if (ks.length === 1) return f(ks[0]!.value);
  let expr = f(ks[ks.length - 1]!.value);
  for (let i = ks.length - 2; i >= 0; i--) {
    const a = ks[i]!;
    const b = ks[i + 1]!;
    const span = Math.max(1, b.frame - a.frame);
    const d = b.value - a.value;
    const t = `((${v}-${a.frame})/${span})`;
    // Mirror the preview's interpolation (default "smooth" = ease-in-out via smoothstep) so the
    // exported motion accelerates/decelerates exactly like the live preview instead of moving
    // linearly (robotic). Keyframes explicitly set to linear/hold are honored.
    const interp = a.interp ?? "smooth";
    const seg =
      interp === "hold"
        ? f(a.value)
        : interp === "linear"
          ? `${f(a.value)}+(${f(d)})*${t}`
          : `${f(a.value)}+(${f(d)})*(${t}*${t}*(3-2*${t}))`;
    expr = `if(lt(${v},${b.frame}),${seg},${expr})`;
  }
  return expr;
}

/** Export front-door for bezier easing: rewrite any keyframe track that contains bezier segments
 * into its piecewise-linear equivalent (densifyTrack) BEFORE any ffmpeg expression is built, so
 * pwlExpr — which only knows hold/linear/smooth — renders the same curve the preview samples.
 * Tracks without bezier segments come back by reference, so the returned clip (and therefore the
 * whole filtergraph) is unchanged for non-bezier timelines. */
function densifyClipTracks(c: Clip, fps: number): Clip {
  const opacityTrack = c.opacityTrack && densifyTrack(c.opacityTrack, fps);
  const positionTrack = c.positionTrack && densifyTrack(c.positionTrack, fps);
  const scaleTrack = c.scaleTrack && densifyTrack(c.scaleTrack, fps);
  const rotationTrack = c.rotationTrack && densifyTrack(c.rotationTrack, fps);
  const cropTrack = c.cropTrack && densifyTrack(c.cropTrack, fps);
  const volumeTrack = c.volumeTrack && densifyTrack(c.volumeTrack, fps);
  if (
    opacityTrack === c.opacityTrack &&
    positionTrack === c.positionTrack &&
    scaleTrack === c.scaleTrack &&
    rotationTrack === c.rotationTrack &&
    cropTrack === c.cropTrack &&
    volumeTrack === c.volumeTrack
  )
    return c;
  return { ...c, opacityTrack, positionTrack, scaleTrack, rotationTrack, cropTrack, volumeTrack };
}

function kenBurnsZoompan(c: Clip, W: number, H: number, fps: number): string | null {
  if (Math.abs(c.transform.width - 1) > 0.02 || Math.abs(c.transform.height - 1) > 0.02) return null;
  const sk = c.scaleTrack?.keyframes ?? [];
  const pk = c.positionTrack?.keyframes ?? [];
  const hasZoom = sk.some((k) => k.value.a > 1.01);
  if (!hasZoom) return null; // no real zoom-in → overlay path renders position (pans/slides can go off-screen)
  if (sk.some((k) => k.value.a < 1)) return null; // zoompan cannot zoom below 1:1 (use static scale)
  const zKfs = sk.length ? sk.map((k) => ({ frame: k.frame, value: k.value.a, interp: k.interpolationOut })) : [{ frame: 0, value: 1 }];
  const pxKfs = pk.length ? pk.map((k) => ({ frame: k.frame, value: k.value.a, interp: k.interpolationOut })) : [{ frame: 0, value: 0 }];
  const pyKfs = pk.length ? pk.map((k) => ({ frame: k.frame, value: k.value.b, interp: k.interpolationOut })) : [{ frame: 0, value: 0 }];
  const z = pwlExpr(zKfs, "on");
  const x = `(0-(${pwlExpr(pxKfs, "on")}))*iw/zoom`;
  const y = `(0-(${pwlExpr(pyKfs, "on")}))*ih/zoom`;
  // zoompan rounds its crop to whole INPUT pixels every frame; on a slow push that makes the motion
  // advance in uneven jerks ("bouncing") instead of gliding like the CSS preview. Supersampling the
  // input first shrinks each rounding step to a fraction of an output pixel, so the pan reads smooth.
  // 4× for stills (one cheap upscale), 2× for video (per-frame, keep it affordable). Visual zoom is
  // unchanged: zoom still crops iw/zoom and the position formula stays proportional to iw.
  const ss = c.mediaType === "image" ? 4 : 2;
  const pre = `scale=${W * ss}:${H * ss}:flags=bicubic,`;
  // Normalize to project fps first: zoompan d=1 emits one frame per input frame, so a clip whose
  // source fps differs from the project would otherwise change duration.
  return `fps=${fpsArg(fps)},${pre}zoompan=z='${z}':x='${x}':y='${y}':d=1:s=${W}x${H}:fps=${fpsArg(fps)}`;
}

/** Static/animated geometry the base chain must apply: flips + rotation (degrees → radians).
 * Leading comma; "" when none. Animated rotation uses `n` (clip-local frame). */
function geomFilters(c: Clip): string {
  const parts: string[] = [];
  if (c.transform.flipHorizontal) parts.push("hflip");
  if (c.transform.flipVertical) parts.push("vflip");
  const rk = c.rotationTrack?.keyframes ?? [];
  if (rk.length >= 1) {
    const kfs = rk.map((k) => ({ frame: k.frame, value: (k.value * Math.PI) / 180, interp: k.interpolationOut }));
    parts.push(`rotate='${pwlExpr(kfs, "n")}':ow=iw:oh=ih:fillcolor=none`);
  } else if (Math.abs(c.transform.rotation) > 0.01) {
    parts.push(`rotate=${((c.transform.rotation * Math.PI) / 180).toFixed(5)}:ow=iw:oh=ih:fillcolor=none`);
  }
  return parts.length ? `,${parts.join(",")}` : "";
}

/** The clip's tail: opacity (constant, or time-varying via geq when the opacity track moves) +
 * fades + an optional glow/bloom subgraph. Returns one or more filter statements ending in [out]. */
function clipTail(base: string, c: Clip, fps: number, out: string): string[] {
  const ok = c.opacityTrack?.keyframes ?? [];
  const varying = ok.length >= 2 && ok.some((k) => k.value !== ok[0]!.value);
  const opa = varying
    ? `geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a='alpha(X,Y)*clip(${pwlExpr(
        ok.map((k) => ({ frame: k.frame, value: k.value, interp: k.interpolationOut })),
        "N",
      )},0,1)'`
    : `colorchannelmixer=aa=${c.opacity}`;
  const fade = videoFade(c, fps);
  const glow = c.effects?.find((e) => e.type === "glow" && e.enabled !== false);
  if (!glow) return [`[${base}]${opa}${fade}[${out}]`];
  const gn = (k: string, d: number) => (typeof glow.params?.[k] === "number" ? (glow.params[k] as number) : d);
  const intensity = r3(Math.min(1, Math.max(0, gn("amount", 0.5))));
  const sigma = r3(Math.max(1, gn("radius", 18)));
  const thr = r3(Math.min(0.99, Math.max(0, gn("threshold", 0.6))));
  const a = `${out}A`;
  const b = `${out}B`;
  const bl = `${out}L`;
  return [
    `[${base}]split[${a}][${b}]`,
    `[${b}]curves=all='0/0 ${thr}/0 1/1',gblur=sigma=${sigma}[${bl}]`,
    `[${a}][${bl}]blend=all_mode=screen:all_opacity=${intensity},${opa}${fade}[${out}]`,
  ];
}

/** ffmpeg `blend` filter mode names for each supported per-clip blend mode ("normal" = no entry, use
 * plain overlay compositing). */
const BLEND_FFMPEG: Partial<Record<string, string>> = {
  multiply: "multiply",
  screen: "screen",
  overlay: "overlay",
  darken: "darken",
  lighten: "lighten",
  difference: "difference",
  exclusion: "exclusion",
  softlight: "softlight",
  hardlight: "hardlight",
  add: "addition",
  subtract: "subtract",
};

/** Overlay x/y for a clip. Full-frame zoompan composites at 0,0. A non-full-frame clip with a
 * position track animates via overlay time-expressions; otherwise it's the static top-left. */
function overlayXY(c: Clip, W: number, H: number, fps: number, zoomed: boolean): { x: string; y: string } {
  if (zoomed) return { x: "0", y: "0" };
  const box = transformTopLeft(c.transform);
  const pk = c.positionTrack?.keyframes ?? [];
  if (pk.length >= 2) {
    const xk = pk.map((k) => ({ frame: c.startFrame + k.frame, value: Math.round(k.value.a * W), interp: k.interpolationOut }));
    const yk = pk.map((k) => ({ frame: c.startFrame + k.frame, value: Math.round(k.value.b * H), interp: k.interpolationOut }));
    return { x: `'${pwlExpr(xk, `t*${fpsArg(fps)}`)}'`, y: `'${pwlExpr(yk, `t*${fpsArg(fps)}`)}'` };
  }
  return { x: String(Math.round(box.x * W)), y: String(Math.round(box.y * H)) };
}

interface VisualGraph {
  inputs: string[];
  filters: string[]; // video-only filter statements
  audioFilters: string[]; // audio filter statements (kept separate so single-frame renders skip them)
  vlabel: string;
  audioLabels: string[];
  duckLabels: string[]; // audio clips flagged audioDuck: mixed separately and side-chain compressed under the rest
  fps: number;
  width: number;
  height: number;
  durSec: number;
  totalFrames: number; // durSec's exact source — format frame-derived times via sf(totalFrames, fps)
}

/** Build the final audio mix. Plain path: amix + limiter. When duck-flagged clips (a music bed) AND
 * normal audio (voice) both exist, the bed is side-chain compressed by the voice bus first — the
 * music automatically dips whenever speech is present and swells back in the gaps, no keyframes
 * needed (OpenMontage-style sidechaincompress). Returns the output label, or null if no audio. */
function buildAudioMix(g: VisualGraph, filters: string[], outLabel: string): string | null {
  const mixInto = (labels: string[], dest: string) => {
    if (labels.length === 1) filters.push(`[${labels[0]}]anull[${dest}]`);
    else filters.push(`${labels.map((l) => `[${l}]`).join("")}amix=inputs=${labels.length}:normalize=0[${dest}]`);
  };
  const hasVoice = g.audioLabels.length > 0;
  const hasDuck = g.duckLabels.length > 0;
  if (!hasVoice && !hasDuck) return null;
  if (hasVoice && hasDuck) {
    mixInto(g.audioLabels, `${outLabel}_voice`);
    mixInto(g.duckLabels, `${outLabel}_bed`);
    // The voice bus is needed twice: as the compressor's side-chain key and in the final mix.
    filters.push(`[${outLabel}_voice]asplit=2[${outLabel}_vkey][${outLabel}_vmix]`);
    filters.push(`[${outLabel}_bed][${outLabel}_vkey]sidechaincompress=threshold=0.02:ratio=9:attack=200:release=500[${outLabel}_ducked]`);
    filters.push(`[${outLabel}_ducked][${outLabel}_vmix]amix=inputs=2:normalize=0,alimiter=limit=0.97[${outLabel}]`);
    return outLabel;
  }
  const labels = hasVoice ? g.audioLabels : g.duckLabels;
  if (labels.length === 1) {
    filters.push(`[${labels[0]}]anull[${outLabel}]`);
  } else {
    filters.push(`${labels.map((l) => `[${l}]`).join("")}amix=inputs=${labels.length}:normalize=0,alimiter=limit=0.97[${outLabel}]`);
  }
  return outLabel;
}

/** Build the composited-video filtergraph (no encode). Returns null if the timeline is empty.
 * hdr=true (the hdr_hevc export) keeps HDR sources HDR: inputs are normalized to HLG/BT.2020
 * instead of tone-mapped to SDR, and the caller converts the composite to 10-bit BT.2020 at the
 * end. The RGBA compositing stage itself is unchanged — HLG-coded values ride through overlays,
 * masks and drawtext just like SDR ones (burned-in white text simply lands at HLG peak level). */
// Exported for tests/e2e: the returned filtergraph strings are the export's ground truth
// (libplacebo instance counts, frame-exact windows) and inspecting them beats re-deriving.
export async function buildVisualGraph(doc: EditorDocument, hdr = false, tlOverride?: Timeline): Promise<VisualGraph | null> {
  // Default = the MAIN timeline (never the open compound view — an export must always render the
  // real program). Overrides: the active view for the inspect/frame renders, or a compound's
  // sub-timeline when baking it. Compound timelines hold no compound clips (depth 1), so a bake's
  // graph never recurses back into the compound branch below.
  const tl = tlOverride ?? doc.mainTimeline;
  const { fps } = tl;
  const W = tl.width;
  const H = tl.height;
  const totalFrames = timelineTotalFrames(tl);
  if (totalFrames <= 0) return null;
  const durSec = totalFrames / fps;

  const inputs: string[] = ["-f", "lavfi", "-i", `color=c=black:s=${W}x${H}:r=${fpsArg(fps)}:d=${sf(totalFrames, fps)}`];
  const filters: string[] = [`[0:v]format=rgba,setsar=1[bg]`];
  let vlabel = "bg";
  let inputIdx = 1; // per-clip LABEL counter (v#/o#/b#/a#) — no longer always the input index
  let nextInput = 1; // next ffmpeg input index (0 = the lavfi background): decode-once clips share one input
  const audioLabels: string[] = [];
  const duckLabels: string[] = [];
  const audioFilters: string[] = [];

  // Every in-graph libplacebo instance = its own Vulkan device; drivers refuse device creation
  // beyond a handful, and the whole render dies with VK_ERROR_INITIALIZATION_FAILED — exactly
  // what a split-heavy timeline (many punch-in segments of one HDR source) produces. HDR sources
  // used by MULTIPLE clips therefore DECODE ONCE: ensureDvSdrProxy bakes the tone-mapped SDR
  // intermediate in a single sequential libplacebo pass (per-frame DolbyVision preserved) and
  // every clip reads the tagged BT.709 bake as an ordinary SDR input — zero in-graph instances
  // no matter how many segments. (An in-graph split=N was tried first and rejected: disjoint
  // per-branch trim windows starve the chained overlays' framesync, which buffered ~25 GB of 4K
  // RGBA composite before dying.) Single-use inputs keep the per-clip path; only when the
  // remaining per-clip tone-map inputs exceed the budget does the whole graph fall back to the
  // calibrated CPU chain.
  // (Irrelevant on the HDR path: hdrInputFix is zscale/setparams only, no libplacebo instances.)
  const MAX_PLACEBO_INPUTS = 4;
  let cpuColor = false;
  // url → SDR bake path for HDR sources shared by 2+ renderable clips. The pre-pass mirrors the
  // render loop's own skip conditions so the counts match what is actually rendered.
  const hdrBakes = new Map<string, string>();
  if (!hdr) {
    const hdrUse = new Map<string, number>();
    for (const track of tl.tracks) {
      if (track.hidden) continue;
      for (const c of track.clips) {
        if (c.mediaType !== "video" || c.compoundId) continue;
        const a = doc.asset(c.mediaRef);
        if (!a?.url || a.generationStatus.kind !== "none" || !(await isHdrSource(a.url))) continue;
        hdrUse.set(a.url, (hdrUse.get(a.url) ?? 0) + 1);
      }
    }
    let inGraph = 0;
    for (const [url, uses] of hdrUse) {
      const bake = uses > 1 ? await ensureDvSdrProxy(url) : null;
      if (bake) hdrBakes.set(url, bake);
      else inGraph += uses; // stays a per-clip tone-map input (libplacebo when available)
    }
    cpuColor = inGraph > MAX_PLACEBO_INPUTS;
    if (cpuColor) console.error(`[export] ${inGraph} HDR inputs > ${MAX_PLACEBO_INPUTS} — using the CPU tone-map chain for this graph`);
  }
  const bottomUp = [...tl.tracks].reverse();
  let adjIdx = 0; // adjustment layers push no input, so they need their own label counter

  for (const track of bottomUp) {
    if (track.hidden) continue; // hidden video track: skip its clips entirely
    for (const rawClip of track.clips) {
      // Bezier keyframe segments become piecewise-linear here, at the top of the animation path —
      // everything below (zoompan/overlay/crop/opacity expressions) only speaks hold/linear/smooth.
      const c = densifyClipTracks(rawClip, fps);
      if (c.mediaType === "text" || c.mediaType === "audio") continue; // audio handled below
      if (c.mediaType === "adjustment") {
        // Adjustment layer: no pixels of its own — its color grade + effect stack runs on the
        // composite built SO FAR (everything below it in stacking order), only inside its time
        // window. Time-gating is done by cutting the composite into [before][during][after] and
        // concatenating back, NOT by appending enable=... to each filter: the look chain is an
        // opaque comma-joined string whose filters carry quoted expression args (curves, geq-style
        // masters), so per-filter :enable injection is fragile, and any future chain filter without
        // timeline support would silently break it. trim's end bound is exclusive while start is
        // inclusive, so with identical cut values every frame lands in exactly one segment — no
        // duplicated or black frame at the seams. Glow/shake/crop are deliberately NOT applied
        // here: shake/crop change the frame size (concat would refuse) and glow lives in the
        // per-clip tail; the supported set is the color grade + look/blur/sharpen/grain/vignette/
        // chromakey. Each segment is forced back to rgba so the composite invariant (downstream
        // overlays/blends see alpha) survives concat's format negotiation.
        const look = [colorChain(c.color), effectChain(c.effects)].filter(Boolean).join(",");
        if (!look) continue; // an ungraded adjustment layer is a no-op
        const f0 = c.startFrame;
        const f1 = clipEndFrame(c);
        const out = `adj${adjIdx}`;
        const segs: { trim: string; chain: string }[] = [];
        if (f0 > 0) segs.push({ trim: `trim=end=${sf(f0, fps)}`, chain: "" });
        segs.push({ trim: `trim=start=${sf(f0, fps)}:end=${sf(Math.min(f1, totalFrames), fps)}`, chain: look });
        if (f1 < totalFrames) segs.push({ trim: `trim=start=${sf(f1, fps)}`, chain: "" });
        if (segs.length === 1) {
          // The window covers the whole timeline — no split needed, grade the composite directly.
          filters.push(`[${vlabel}]${look},format=rgba[${out}]`);
        } else {
          const names = segs.map((_, i) => `${out}s${i}`);
          filters.push(`[${vlabel}]split=${segs.length}${names.map((n) => `[${n}i]`).join("")}`);
          for (let i = 0; i < segs.length; i++) {
            const sg = segs[i]!;
            const chain = [sg.trim, "setpts=PTS-STARTPTS", sg.chain, "format=rgba"].filter(Boolean).join(",");
            filters.push(`[${names[i]}i]${chain}[${names[i]}]`);
          }
          // concat re-times the pieces contiguously from 0, so downstream enable=between(t,...)
          // windows (later clips, drawtext) still line up with timeline time.
          filters.push(`${names.map((n) => `[${n}]`).join("")}concat=n=${segs.length}:v=1:a=0[${out}]`);
        }
        vlabel = out;
        adjIdx++;
        continue;
      }
      // Compound clip: render its nested timeline by baking it to an mp4 (content-hash cached) and
      // treating the bake as ordinary video media — the clip's own trim/speed/effects/transform
      // then apply ON TOP of the composited sub-timeline, exactly like on real footage.
      let asset = doc.asset(c.mediaRef);
      if (c.compoundId) {
        const baked = await ensureCompoundBake(doc, c.compoundId);
        if (!baked) continue; // empty or dangling compound — nothing to draw
        asset = {
          id: `compound:${c.compoundId}`,
          type: "video",
          name: c.name ?? "Compound",
          url: baked.path,
          durationSeconds: baked.durationSeconds,
          hasAudio: baked.hasAudio,
          generationStatus: { kind: "none" },
        };
      }
      if (!asset?.url || asset.generationStatus.kind !== "none") continue;

      const t0s = sf(c.startFrame, fps); // frame-exact window bounds for enable/setpts (see sf)
      const t1s = sf(clipEndFrame(c), fps);
      const speed = c.speed > 0 ? c.speed : 1;
      const wpx = Math.max(2, Math.round(c.transform.width * W));
      const hpx = Math.max(2, Math.round(c.transform.height * H));
      const vout = `v${inputIdx}`;
      const oout = `o${inputIdx}`;
      const kb = kenBurnsZoompan(c, W, H, fps);
      const { pre, post } = clipLookFilters(c, fps); // crop (pre-scale) + color grade / effects (post-rgba)
      // Fit into the clip's box the way the preview does (CSS object-cover: fill without distorting,
      // cropping any overflow) — a plain scale stretches mismatched-aspect footage. Only when the user
      // hasn't already set an explicit manual crop (that already reshapes the frame before this point).
      const sizeFilter = kb ?? (pre ? `scale=${wpx}:${hpx}` : `scale=${wpx}:${hpx}:force_original_aspect_ratio=increase,crop=${wpx}:${hpx}`);
      const geom = geomFilters(c); // flips + rotation (static or animated)
      const base = `b${inputIdx}`; // clip color/fx/geometry, full opacity — clipTail adds opacity/fade/glow

      // Freeform pen mask ("path"): geq can't express an arbitrary (possibly smoothed) polygon,
      // so the mask is a pre-rendered grayscale matte PNG (feather blur + invert baked in — see
      // pathmask.ts) fed as an extra looped input and alphamerged onto the clip's box BEFORE
      // geometry, so the mask rotates/flips with the clip exactly like the CSS preview's
      // mask-image (which clips in the element's own box, pre-transform).
      const pathMaskPng = c.mask?.shape === "path" ? await ensurePathMaskPng(c.mask, wpx, hpx) : null;
      const pushPathMask = (chainToRgba: string): void => {
        inputs.push("-loop", "1", "-framerate", fpsArg(fps), "-t", sf(totalFrames, fps), "-i", pathMaskPng!);
        const mIdx = nextInput++; // matte input registered AFTER the clip's own input — index order matters
        filters.push(`${chainToRgba}[${base}pm]`);
        // alphamerge REPLACES alpha from the matte's gray plane — the same semantics as the geq
        // masks (which also overwrite alpha), so rect/ellipse and path behave identically.
        filters.push(`[${mIdx}:v]format=gray[${base}mk]`);
        filters.push(`[${base}pm][${base}mk]alphamerge${geom}[${base}]`);
      };

      if (c.mediaType === "image") {
        inputs.push("-loop", "1", "-framerate", fpsArg(fps), "-t", sf(totalFrames, fps), "-i", asset.url);
        const imgIdx = nextInput++;
        const imgChain = `[${imgIdx}:v]${pre}${sizeFilter},format=rgba${post}`;
        if (pathMaskPng) pushPathMask(imgChain);
        else filters.push(`${imgChain}${geom}${maskFilter(c)}[${base}]`);
      } else {
        const srcDurFrames = c.durationFrames * speed; // source-side frames (fractional when speed-scaled)
        const srcDur = srcDurFrames / fps;
        // A clip can run past the end of its source (e.g. its duration exceeds the media, or
        // source fps < project fps). Trim only what really exists and clone the last frame for the
        // rest — a frozen tail instead of a black hole, so split/zoom/etc. always have a picture.
        const assetDur = asset.durationSeconds ?? 0;
        const ssExact = frameToSeconds(c.trimStartFrame, fps);
        const ss = Math.min(ssExact, assetDur > 0 ? Math.max(0, assetDur - 1 / fps) : Infinity);
        const realDur = assetDur > 0 ? Math.max(1 / fps, Math.min(srcDur, assetDur - ss)) : srcDur;
        // Frame-exact strings when the frame math wins; the probe-float fallbacks keep s() (the
        // clone-padded tail below hides any sub-frame slack at the media's end).
        const ssStr = ss === ssExact ? sf(c.trimStartFrame, fps) : s(ss);
        const durStr = realDur === srcDur ? sf(srcDurFrames, fps) : s(realDur);
        // Always clone-pad the tail a couple of frames past the clip's window: float rounding in
        // trim/enable can leave the stream one frame short of its between() window, and with
        // eof_action=pass the composite background (black) would show through for that frame —
        // a 1-frame black flash at cut boundaries. A padded tail is gated off by enable, so the
        // extra frames are never visible beyond the window; at worst the boundary frame repeats.
        const freeze = `,tpad=stop_mode=clone:stop_duration=${s(Math.max(0, srcDur - realDur) + (2 * speed) / fps)}`;
        const pts = speed !== 1 ? `(PTS-STARTPTS)/${speed}+${t0s}/TB` : `PTS-STARTPTS+${t0s}/TB`;
        // Shared HDR sources read their SDR bake instead of the original (decode-once) — the
        // bake carries the source's audio too, so the audio path below stays identical.
        const srcUrl = hdrBakes.get(asset.url) ?? asset.url;
        if (await hasAlphaMode(srcUrl)) inputs.push("-c:v", "libvpx-vp9"); // keep VP9 alpha (motion graphics)
        inputs.push("-i", srcUrl);
        const idx = nextInput++;
        // Normalize the input's color BEFORE any RGB conversion: HDR sources get tone-mapped to SDR
        // BT.709; untagged SDR sources get converted with the matrix a player would assume. Without
        // this the composited output looks different from how players show the original footage.
        // On the HDR path the normalization target is HLG/BT.2020 instead (no tone-mapping).
        // (A bake probes as tagged BT.709 SDR, so inputColorFix correctly returns "" for it.)
        const colorFix = hdr ? await hdrInputFix(asset.url) : await inputColorFix(srcUrl, cpuColor);
        const cf = colorFix ? `${colorFix},` : "";
        const vidChain = `[${idx}:v]trim=start=${ssStr}:duration=${durStr}${freeze},setpts=${pts},${cf}${pre}${sizeFilter},format=rgba${post}`;
        if (pathMaskPng) pushPathMask(vidChain);
        else filters.push(`${vidChain}${geom}${maskFilter(c)}[${base}]`);
        if (asset.hasAudio && !track.muted) {
          const aout = `a${inputIdx}`;
          const delay = Math.round(frameToSeconds(c.startFrame, fps) * 1000);
          const balanceFix = await channelBalanceFix(asset.url);
          let af = `[${idx}:a]atrim=start=${ssStr}:duration=${sf(srcDurFrames, fps)},asetpts=PTS-STARTPTS${balanceFix}${audioFxChain(c)}${audioCleanupFilter(c)}${audioFade(c, srcDurFrames, fps)}`;
          if (speed !== 1) af += `,atempo=${clampTempo(speed)}`;
          af += `,${audioVolumeFilter(c, fps)},adelay=${delay}|${delay}[${aout}]`;
          audioFilters.push(af);
          (c.audioDuck ? duckLabels : audioLabels).push(aout);
        }
      }
      filters.push(...clipTail(base, c, fps, vout));
      const ov = overlayXY(c, W, H, fps, !!kb);
      // Position-keyframed x/y are ffmpeg time-expressions (need `t`), which the `pad` filter below
      // can't evaluate — blend modes are only supported for a clip whose position isn't animated.
      const posAnimated = (c.positionTrack?.keyframes.length ?? 0) >= 2;
      const blendFf = !posAnimated ? BLEND_FFMPEG[c.blendMode ?? ""] : undefined;
      if (blendFf) {
        const posOut = `pos${inputIdx}`;
        // Place the clip's layer onto a canvas-sized transparent frame at its position, THEN blend
        // that against the accumulated composite — ffmpeg's `overlay` filter only does plain alpha
        // compositing, so a custom blend mode needs the two inputs to be the same size first.
        filters.push(`[${vout}]pad=${W}:${H}:${ov.x}:${ov.y}:color=black@0.0[${posOut}]`);
        filters.push(`[${vlabel}][${posOut}]blend=all_mode=${blendFf}:enable='between(t\\,${t0s}\\,${t1s})'[${oout}]`);
      } else {
        filters.push(`[${vlabel}][${vout}]overlay=x=${ov.x}:y=${ov.y}:enable=between(t\\,${t0s}\\,${t1s}):eof_action=pass[${oout}]`);
      }
      vlabel = oout;
      inputIdx++;
    }
  }

  // Dedicated audio-track clips.
  for (const track of tl.tracks) {
    if (track.type !== "audio") continue;
    if (track.muted) continue; // muted audio track: skip
    for (const rawClip of track.clips) {
      const c = densifyClipTracks(rawClip, fps); // bezier volume envelopes → linear (see above)
      const asset = doc.asset(c.mediaRef);
      if (!asset?.url || asset.generationStatus.kind !== "none") continue;
      const speed = c.speed > 0 ? c.speed : 1;
      const srcDurFrames = c.durationFrames * speed;
      const delay = Math.round(frameToSeconds(c.startFrame, fps) * 1000);
      inputs.push("-i", asset.url);
      const idx = nextInput++;
      const aout = `a${inputIdx}`;
      const balanceFix = await channelBalanceFix(asset.url);
      let af = `[${idx}:a]atrim=start=${sf(c.trimStartFrame, fps)}:duration=${sf(srcDurFrames, fps)},asetpts=PTS-STARTPTS${balanceFix}${audioFxChain(c)}${audioCleanupFilter(c)}${audioFade(c, srcDurFrames, fps)}`;
      if (speed !== 1) af += `,atempo=${clampTempo(speed)}`;
      af += `,${audioVolumeFilter(c, fps)},adelay=${delay}|${delay}[${aout}]`;
      audioFilters.push(af);
      (c.audioDuck ? duckLabels : audioLabels).push(aout);
      inputIdx++;
    }
  }

  // Text overlays, top track last so it sits on top. Karaoke captions (clips with karaokeWords)
  // are collected per caption group and rendered through libass below — drawtext cannot tint the
  // word being spoken. Plain text keeps the drawtext path.
  let dt = 0;
  const karaokeGroups = new Map<string, Clip[]>();
  const richTextClips: Clip[] = []; // text clips with styleRanges — burned via one shared ASS file
  for (const track of bottomUp) {
    for (const c of track.clips) {
      if (c.mediaType !== "text" || !c.textContent) continue;
      if (c.karaokeWords?.length) {
        const key = c.captionGroupId ?? c.id;
        const group = karaokeGroups.get(key) ?? [];
        group.push(c);
        karaokeGroups.set(key, group);
        continue;
      }
      // Per-substring styling (styleRanges) needs libass override tags — drawtext is one style per
      // line. Karaoke wins when both are present (checked above); ranges are for plain titles.
      if (c.styleRanges?.length) {
        richTextClips.push(c);
        continue;
      }
      const ts = c.textStyle;
      const t0s = sf(c.startFrame, fps);
      const t1s = sf(clipEndFrame(c), fps);
      const fontsize = Math.round(ts?.fontSize ?? 96);
      const cx = Math.round(c.transform.centerX * W);
      const cy = Math.round(c.transform.centerY * H);
      const txtPath = join(exportsDir, `_text_${dt}.txt`);
      await Bun.write(txtPath, c.textContent.replace(/\r?\n/g, " "));
      const next = `t${dt}`;
      filters.push(
        `[${vlabel}]drawtext=fontfile=${ffPath(fontFileFor(ts?.fontName))}:textfile=${ffPath(txtPath)}:fontsize=${fontsize}:fontcolor=${ffColor(ts?.color ?? "#ffffff")}:x=${cx}-text_w/2:y=${cy}-text_h/2:shadowcolor=black@0.5:shadowx=2:shadowy=2:enable=between(t\\,${t0s}\\,${t1s})[${next}]`,
      );
      vlabel = next;
      dt++;
    }
  }

  let kg = 0;
  for (const group of karaokeGroups.values()) {
    const assPath = join(exportsDir, `_captions_${kg}_${Date.now()}.ass`);
    await Bun.write(assPath, karaokeAss(group, W, H, fps));
    const next = `kg${kg}`;
    // Same escaping the AI-clips burner uses (single \: inside quotes) — proven with this ffmpeg.
    const assArg = assPath.replace(/\\/g, "/").replace(/:/g, "\\:").replace(/'/g, "'\\\\\\''");
    filters.push(`[${vlabel}]subtitles=filename='${assArg}'[${next}]`);
    vlabel = next;
    kg++;
  }

  if (richTextClips.length) {
    const assPath = join(exportsDir, `_richtext_${Date.now()}.ass`);
    await Bun.write(assPath, richTextAss(richTextClips, W, H, fps));
    // Same escaping the AI-clips burner uses (single \: inside quotes) — proven with this ffmpeg.
    const assArg = assPath.replace(/\\/g, "/").replace(/:/g, "\\:").replace(/'/g, "'\\\\\\''");
    filters.push(`[${vlabel}]subtitles=filename='${assArg}'[rt]`);
    vlabel = "rt";
  }

  return { inputs, filters, audioFilters, vlabel, audioLabels, duckLabels, fps, width: W, height: H, durSec, totalFrames };
}

// ── compound bake (nested timelines) ─────────────────────────────────────────

/** Tiny stable content hash (djb2 over the timeline JSON) — the cache key for compound bakes, so
 * an unchanged compound bakes exactly once and a changed one gets a fresh file (and a fresh URL). */
export function timelineHash(tl: Timeline): string {
  const json = JSON.stringify(tl);
  let h = 5381;
  for (let i = 0; i < json.length; i++) h = ((h * 33) ^ json.charCodeAt(i)) >>> 0;
  return h.toString(16).padStart(8, "0");
}

export interface CompoundBake {
  path: string;
  durationSeconds: number;
  hasAudio: boolean;
}

const bakesInFlight = new Map<string, Promise<CompoundBake | null>>(); // by baked path — dedups concurrent requests
const bakesKnown = new Map<string, CompoundBake>(); // by baked path — skips re-probing a served bake

/** Bake a compound's sub-timeline to exports/_comp_<id>_<hash>.mp4 (visually lossless h264 crf 16
 * at the sub-timeline's own canvas/fps) and return it. Cached by content hash: an unchanged
 * compound returns the existing file instantly; a changed one renders once and older hashes are
 * swept. Both the export graph and the /media/compound/<id> preview route serve this file. */
export async function ensureCompoundBake(doc: EditorDocument, compoundId: string): Promise<CompoundBake | null> {
  const comp = doc.project.compounds?.find((c) => c.id === compoundId);
  if (!comp) return null;
  const path = join(exportsDir, `_comp_${compoundId}_${timelineHash(comp.timeline)}.mp4`);
  const known = bakesKnown.get(path);
  if (known) return known;
  const inflight = bakesInFlight.get(path);
  if (inflight) return inflight;

  const job = (async (): Promise<CompoundBake | null> => {
    const register = async (): Promise<CompoundBake> => {
      const probe = await probeMedia(path);
      const out: CompoundBake = { path, durationSeconds: probe.durationSeconds || 0, hasAudio: probe.hasAudio };
      bakesKnown.set(path, out);
      return out;
    };
    const existing = Bun.file(path);
    if ((await existing.exists()) && existing.size > 1024) return register(); // bake from an earlier session

    const tmp = `${path}.tmp`;
    const encode = async (): Promise<{ code: number; stderr: string } | null> => {
      const g = await buildVisualGraph(doc, false, comp.timeline);
      if (!g) return null; // the compound's timeline is empty
      const filters = [
        ...g.filters,
        ...g.audioFilters,
        // Same explicit BT.709 RGB→YUV as exportTimeline, so the bake re-enters the main graph as
        // a correctly-tagged SDR input (inputColorFix then leaves it alone).
        `[${g.vlabel}]scale=out_color_matrix=bt709:out_range=tv:flags=accurate_rnd,format=yuv420p[vout]`,
      ];
      let aMap: string[] = [];
      if (buildAudioMix(g, filters, "aout")) aMap = ["-map", "[aout]"];
      const args = [
        "-y", ...g.inputs, "-filter_complex", filters.join(";"), "-map", "[vout]", ...aMap,
        "-r", fpsArg(g.fps), "-t", sf(g.totalFrames, g.fps),
        // crf 16 = visually lossless intermediate; the final export re-encodes on top anyway.
        "-c:v", "libx264", "-preset", "veryfast", "-crf", "16", "-pix_fmt", "yuv420p",
        "-colorspace", "bt709", "-color_primaries", "bt709", "-color_trc", "bt709", "-color_range", "tv",
        ...(aMap.length ? ["-c:a", "aac", "-b:a", "192k"] : ["-an"]),
        // Encode to .tmp and rename only on success — a half-written bake must never be served.
        // -f mp4 is mandatory: the muxer can't be inferred from the ".tmp" extension.
        "-movflags", "+faststart", "-f", "mp4", tmp,
      ];
      return run(FFMPEG_BIN, args);
    };
    let r = await encode();
    if (r && r.code !== 0 && isVulkanFailure(r.stderr)) {
      // Same one-shot CPU fallback as every other render path in this file.
      disablePlacebo("compound bake failed on the Vulkan path");
      r = await encode();
    }
    if (!r) return null;
    if (r.code !== 0) {
      console.error(`[compound] bake failed for ${compoundId}: ${r.stderr.split("\n").slice(-4).join(" | ")}`);
      void rm(tmp, { force: true }).catch(() => {});
      return null;
    }
    await rename(tmp, path);
    // Sweep superseded bakes of this compound (older hashes are never read again).
    void (async () => {
      try {
        for (const f of await readdir(exportsDir)) {
          if (!f.startsWith(`_comp_${compoundId}_`) || !f.endsWith(".mp4")) continue;
          const full = join(exportsDir, f);
          if (full === path) continue;
          await rm(full, { force: true });
          bakesKnown.delete(full);
        }
      } catch {
        /* best-effort cleanup */
      }
    })();
    return register();
  })().finally(() => bakesInFlight.delete(path));

  bakesInFlight.set(path, job);
  return job;
}

export type ExportFormat = "mp4_h264" | "mp4_h265" | "mp4_av1" | "hdr_hevc" | "prores" | "nle_xml" | "fcpxml" | "lossless";
export type ExportQuality = "draft" | "standard" | "high" | "max";

/** Lossless (stream-copy) export, à la LosslessCut: when the timeline is pure cuts of ONE source
 * file with no processing whatsoever, the segments can be copied bit-for-bit (`-c copy` via the
 * concat demuxer) instead of re-encoded — near-instant, zero generation loss. The smart cut
 * below re-encodes only the partial GOPs at each cut's head and tail, so boundaries are
 * FRAME-EXACT (measured 0-frame offsets); the remaining approximation is audio-side: AAC frames
 * quantize to ~21 ms, adding up to ~40 ms of padding per re-encoded seam to the container
 * duration. Sources whose codec can't be head-matched (not h264/hevc) still fall back to pure
 * keyframe-snap copy, where cuts can land up to a GOP early. */
async function exportLossless(doc: EditorDocument, outName: string): Promise<ExportResult> {
  const tl = doc.mainTimeline; // exports always render the real program, never an open compound view
  const fps = tl.fps;
  const notEligible = (why: string): ExportResult => ({
    ok: false,
    error: `Lossless export not possible: ${why} Use format 'mp4_h264' instead (full re-encode, everything supported).`,
  });

  const videoClips: Clip[] = [];
  const audioClips: Clip[] = [];
  for (const t of tl.tracks) {
    if (t.type === "video" && t.hidden) continue;
    if (t.type === "audio" && t.muted) continue;
    for (const c of t.clips) {
      if (c.mediaType === "text") return notEligible("the timeline has text overlays (they must be rendered).");
      if (c.mediaType === "image") return notEligible("the timeline has image clips (they must be encoded to video).");
      if (c.mediaType === "adjustment") return notEligible("the timeline has an adjustment layer (its look must be rendered).");
      if (c.compoundId) return notEligible("the timeline has a compound clip (its nested timeline must be rendered).");
      (c.mediaType === "audio" ? audioClips : videoClips).push(c);
    }
  }
  if (videoClips.length === 0) return notEligible("there are no video clips.");
  const assetId = videoClips[0]!.mediaRef;
  const asset = doc.asset(assetId);
  if (!asset?.url) return notEligible("the source media is not ready.");
  if (![...videoClips, ...audioClips].every((c) => c.mediaRef === assetId))
    return notEligible("clips come from more than one source file (mixing sources requires re-encoding).");

  const pristine = (c: Clip): string | null => {
    if (c.speed !== 1) return "a speed change";
    if (c.volume !== 1) return "a volume change";
    if (c.audioDuck) return "auto-ducking";
    if (c.audioFx) return "a voice effect (audioFx)";
    if (c.opacity !== 1) return "an opacity change";
    if (c.fadeInFrames > 0 || c.fadeOutFrames > 0) return "a fade";
    if (c.color || c.effects?.length || c.mask) return "color/effects/masks";
    if (c.blendMode && c.blendMode !== "normal") return "a blend mode";
    if (c.opacityTrack || c.positionTrack || c.scaleTrack || c.rotationTrack || c.cropTrack || c.volumeTrack) return "keyframe animation";
    if (!isIdentityCrop(c.crop)) return "a crop";
    const t = c.transform;
    if (Math.abs(t.width - 1) > 0.001 || Math.abs(t.height - 1) > 0.001 || Math.abs(t.centerX - 0.5) > 0.001 || Math.abs(t.centerY - 0.5) > 0.001)
      return "a transform (position/scale)";
    if (t.rotation !== 0 || t.flipHorizontal || t.flipVertical) return "a rotation/flip";
    return null;
  };
  for (const c of [...videoClips, ...audioClips]) {
    const why = pristine(c);
    if (why) return notEligible(`clip ${c.id} has ${why} (stream copy can't apply processing).`);
  }

  // Video segments in timeline order; the audio edit (if any) must mirror the video edit exactly,
  // since stream copy carries both streams together.
  videoClips.sort((a, b) => a.startFrame - b.startFrame);
  if (audioClips.length > 0) {
    if (audioClips.length !== videoClips.length) return notEligible("audio was edited differently from video.");
    audioClips.sort((a, b) => a.startFrame - b.startFrame);
    for (let i = 0; i < videoClips.length; i++) {
      const v = videoClips[i]!;
      const x = audioClips[i]!;
      if (x.startFrame !== v.startFrame || x.durationFrames !== v.durationFrames || x.trimStartFrame !== v.trimStartFrame)
        return notEligible("audio was edited differently from video.");
    }
  }
  for (let i = 1; i < videoClips.length; i++) {
    if (videoClips[i]!.startFrame !== videoClips[i - 1]!.startFrame + videoClips[i - 1]!.durationFrames)
      return notEligible("clips have gaps or overlaps on the timeline (black gaps must be rendered).");
  }

  // ── Smart cut (à la LosslessCut's experimental smart cut) ────────────────────
  // Plain stream copy can only start a segment on a KEYFRAME, so cut points land up to a whole
  // GOP early. Instead, for each segment: if the in-point sits on a keyframe, stream-copy it whole;
  // otherwise re-encode ONLY the short head [in → next keyframe) with codec parameters matched to
  // the source, stream-copy the rest, and concat all pieces. Frame-accurate, and typically >95% of
  // the output is still untouched source bits.
  const src = asset.url.replace(/\\/g, "/");
  const halfFrame = 0.5 / fps;

  // Source video stream parameters (to make the re-encoded heads concat-compatible with the copies).
  const probe = await run(FFPROBE_BIN, [
    "-v", "error", "-select_streams", "v:0",
    "-show_entries", "stream=codec_name,pix_fmt,time_base,bit_rate:format=bit_rate",
    "-of", "json", src,
  ]);
  let codecName = "";
  let pixFmt = "yuv420p";
  let timescale = 0;
  let bitRate = 0;
  try {
    const info = JSON.parse(probe.stdout) as { streams?: { codec_name?: string; pix_fmt?: string; time_base?: string; bit_rate?: string }[]; format?: { bit_rate?: string } };
    const st = info.streams?.[0];
    codecName = st?.codec_name ?? "";
    pixFmt = st?.pix_fmt ?? "yuv420p";
    const tb = st?.time_base?.split("/");
    timescale = tb?.length === 2 ? Number(tb[1]) : 0;
    bitRate = Number(st?.bit_rate ?? info.format?.bit_rate ?? 0);
  } catch {
    /* fall back below */
  }
  const headEncoder = codecName === "h264" ? "libx264" : codecName === "hevc" ? "libx265" : null;
  const headVideoArgs = headEncoder
    ? [
        "-c:v", headEncoder, "-pix_fmt", pixFmt,
        // No B-frames in the re-encoded partial GOPs: B-reorder shifts the piece's first video
        // pts by the codec delay, and the concat DEMUXER ignores the mp4 edit list that would
        // normalize it — each seam then opens a 2-frame pts gap (stream longer than its frames).
        "-bf", "0",
        ...(bitRate > 0 ? ["-b:v", String(Math.round(bitRate * 1.2))] : ["-crf", "17"]),
        ...(timescale > 0 ? ["-video_track_timescale", String(timescale)] : []),
      ]
    : null;

  /** Keyframe pts_times of the video stream in [t, t+window). */
  const keyframesAfter = async (t: number, windowS = 15): Promise<number[]> => {
    const kf = await run(FFPROBE_BIN, [
      "-v", "error", "-read_intervals", `${s(Math.max(0, t - 0.25))}%${s(t + windowS)}`,
      "-select_streams", "v:0", "-show_packets", "-show_entries", "packet=pts_time,flags", "-of", "json", src,
    ]);
    try {
      const pk = (JSON.parse(kf.stdout) as { packets?: { pts_time?: string; flags?: string }[] }).packets ?? [];
      return pk
        .filter((p) => (p.flags ?? "").includes("K") && p.pts_time != null)
        .map((p) => Number(p.pts_time))
        .sort((a, b) => a - b);
    } catch {
      return [];
    }
  };

  const pieces: string[] = [];
  const cleanup: string[] = [];
  let reencodedSeconds = 0;
  const p7 = (n: number): string => n.toFixed(7).replace(/\.?0+$/, "");
  // Copy pieces seek with a QUARTER-FRAME nudge past the keyframe: ffprobe prints pts to 6
  // decimals, which can round BELOW the true keyframe time (frame 100 at 30 fps = 3.3333333…
  // prints "3.333333") — and a backward keyframe-seek from a hair below the keyframe lands a
  // whole GOP early, prepending ~seconds of duplicate content. From inside (kf, kf+1frame) the
  // seek always lands on OUR keyframe; stream copy still starts at that keyframe's packet.
  const copyFrom = (kf: number): string => p7(kf + 0.25 / fps);
  /** Write piece `idx`: `wantFrames` source frames starting at fromStr. Encoded pieces are
   * frame-exact by construction (-frames:v counts output frames; -t only bounds the audio).
   * Copied pieces need a corrective re-mux: stream-copy's -t stops on DECODE-order timestamps,
   * so B-frame reorder overshoots by the codec delay (measured +2 frames at x264's default
   * bf=3) — probe the piece and re-cut with -t shortened by the overshoot (CFR packet spacing
   * is uniform, so the corrected stop is exact). */
  const makePiece = async (idx: number, fromStr: string, dur: number, encode: boolean, wantFrames: number): Promise<string | null> => {
    if (dur <= halfFrame || wantFrames <= 0) return null;
    const p = join(exportsDir, `_smart_${idx}.mp4`);
    // Encoded heads re-encode AUDIO too (aac): copying audio through an accurate `-ss` seek leaves
    // its pts misaligned with the re-encoded video, and the concat then pads the audio stream out
    // past the video (the output ends up seconds longer). A ~1–3 s aac re-encode is inaudible.
    const args = (t: number): string[] =>
      encode && headVideoArgs
        ? ["-y", "-ss", fromStr, "-i", src, "-t", p7(t), "-frames:v", String(wantFrames), ...headVideoArgs, "-c:a", "aac", "-b:a", "192k", p]
        : ["-y", "-ss", fromStr, "-i", src, "-t", p7(t), "-c", "copy", "-avoid_negative_ts", "make_zero", p];
    const frameCount = async (): Promise<number> => {
      const fr = await run(FFPROBE_BIN, ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=nb_frames", "-of", "csv=p=0", p]);
      return Number(fr.stdout.trim()) || 0;
    };
    let r = await run(FFMPEG_BIN, args(dur));
    if (r.code === 0 && !encode) {
      const got = await frameCount();
      if (got > 0 && got !== wantFrames) {
        const retry = await run(FFMPEG_BIN, args(dur - (got - wantFrames) / fps));
        // A failed retry has already clobbered the piece (-y): regenerate the near-miss original
        // rather than losing the segment outright.
        if (retry.code !== 0 || (await frameCount()) !== wantFrames) r = await run(FFMPEG_BIN, args(dur));
      }
    }
    if (r.code !== 0 || !(await Bun.file(p).exists())) return null;
    cleanup.push(p);
    if (encode) reencodedSeconds += dur;
    return p;
  };

  let pieceIdx = 0;
  for (const c of videoClips) {
    // Exact rational frame times (frameToSeconds/sf): the old 3-decimal formatting rounded
    // repeating-decimal in-points ABOVE the target frame's pts, so accurate seeks started the
    // head one frame late.
    const inS = frameToSeconds(c.trimStartFrame, fps);
    const outS = frameToSeconds(c.trimStartFrame + c.durationFrames, fps);
    let plan: { fromStr: string; dur: number; frames: number; encode: boolean }[];
    if (!headVideoArgs) {
      // Unknown codec — can't synthesize a matching head; keyframe-snap copy (the old behavior).
      plan = [{ fromStr: sf(c.trimStartFrame, fps), dur: outS - inS, frames: c.durationFrames, encode: false }];
    } else {
      const kfs = await keyframesAfter(inS);
      const kfAt = kfs.find((k) => Math.abs(k - inS) <= halfFrame);
      const nextKf = kfs.find((k) => k > inS + halfFrame);
      const kfIn = kfAt ?? nextKf; // first keyframe at/after the in-point (within the probe window)
      // The copy piece must also END on a GOP boundary: -t truncates stream copy in DECODE order,
      // so a mid-GOP stop can drop trailing B-frames while keeping their future references — the
      // frame COUNT can be corrected but the tail CONTENT stays wrong (measured: last frames
      // 844,845 replaced by 846,847). Like the head, the final partial GOP is re-encoded instead.
      const tailKfs = await keyframesAfter(Math.max(inS, outS - 15));
      const kfOut = [...tailKfs].reverse().find((k) => k <= outS + halfFrame && kfIn !== undefined && k > kfIn + halfFrame) ?? kfIn;
      if (kfIn === undefined || kfIn >= outS - halfFrame) {
        // No keyframe inside the clip (single partial GOP): encode it whole.
        plan = [{ fromStr: sf(c.trimStartFrame, fps), dur: outS - inS, frames: c.durationFrames, encode: true }];
      } else {
        plan = [];
        const headFrames = kfAt !== undefined ? 0 : Math.round((kfIn - inS) * fps);
        if (headFrames > 0) plan.push({ fromStr: sf(c.trimStartFrame, fps), dur: kfIn - inS, frames: headFrames, encode: true });
        const copyEnd = kfOut ?? kfIn; // kfOut falls back to kfIn (giant-GOP probe miss) → tail-encode the rest
        const copyFrames = Math.round((copyEnd - inS) * fps) - headFrames;
        const tailFrames = c.durationFrames - headFrames - copyFrames;
        plan.push({ fromStr: copyFrom(kfIn), dur: copyEnd - kfIn, frames: copyFrames, encode: false });
        // Tail seek starts a QUARTER FRAME before the keyframe (mirror-image of copyFrom): the
        // accurate seek discards decoded frames below the target anyway, and the margin keeps a
        // 6-decimal probe value that rounded UP from ever skipping the keyframe itself.
        if (tailFrames > 0) plan.push({ fromStr: p7(copyEnd - 0.25 / fps), dur: outS - copyEnd + 0.25 / fps, frames: tailFrames, encode: true });
      }
    }
    for (const step of plan) {
      const p = await makePiece(pieceIdx++, step.fromStr, step.dur, step.encode, step.frames);
      if (p) pieces.push(p);
    }
  }
  if (pieces.length === 0) return { ok: false, error: "Lossless export produced no segments (ffmpeg failed on every piece)." };

  const listPath = join(exportsDir, "_lossless_concat.txt");
  await Bun.write(listPath, ["ffconcat version 1.0", ...pieces.map((p) => `file '${p.replace(/\\/g, "/").replace(/'/g, "'\\''")}'`)].join("\n"));
  const outPath = join(exportsDir, outName.replace(/\.[^.]+$/, "") + ".mp4");
  const { stderr, code } = await run(FFMPEG_BIN, [
    "-y", "-f", "concat", "-safe", "0", "-i", listPath, "-c", "copy", "-avoid_negative_ts", "make_zero", "-movflags", "+faststart", outPath,
  ]);
  for (const p of cleanup) void rm(p, { force: true }).catch(() => {});
  if (code !== 0) return { ok: false, error: `ffmpeg exited ${code}: ${stderr.split("\n").slice(-6).join("\n")}` };
  const total = videoClips.reduce((sum, c) => sum + c.durationFrames, 0) / fps;
  return { ok: true, path: outPath, durationSeconds: total };
}

/** Video/audio codec args per format. ProRes uses 10-bit 4:2:2 + PCM audio in a .mov.
 * quality maps to x264/x265 CRF (lower = better/larger): draft 28, standard 21, high 18, max 14. */
function codecArgs(format: ExportFormat, quality: ExportQuality = "high"): { video: string[]; audio: (mix: boolean) => string[] } {
  const crf = { draft: "28", standard: "21", high: "18", max: "14" }[quality];
  // Tag the stream as BT.709 (matching the explicit RGB→YUV conversion in the filtergraph) so
  // players decode exactly what we encoded instead of guessing.
  const bt709 = ["-colorspace", "bt709", "-color_primaries", "bt709", "-color_trc", "bt709", "-color_range", "tv"];
  switch (format) {
    case "mp4_h265":
      return {
        video: ["-c:v", "libx265", "-tag:v", "hvc1", "-preset", "medium", "-crf", crf, "-pix_fmt", "yuv420p", ...bt709],
        audio: (m) => (m ? ["-c:a", "aac", "-b:a", "192k"] : ["-an"]),
      };
    case "hdr_hevc":
      // True HDR: HLG BT.2020 in 10-bit HEVC (Main10). The HLG/BT.2020 triplet is written BOTH as
      // x265 VUI (in-bitstream, what most players trust) and as container/stream tags — some
      // players (QuickTime especially) only switch to HDR rendering when both agree.
      return {
        video: [
          "-c:v", "libx265", "-tag:v", "hvc1", "-preset", "medium", "-crf", crf, "-pix_fmt", "yuv420p10le",
          "-x265-params", "colorprim=bt2020:transfer=arib-std-b67:colormatrix=bt2020nc",
          "-colorspace", "bt2020nc", "-color_primaries", "bt2020", "-color_trc", "arib-std-b67", "-color_range", "tv",
        ],
        audio: (m) => (m ? ["-c:a", "aac", "-b:a", "320k"] : ["-an"]),
      };
    case "prores":
      return {
        video: ["-c:v", "prores_ks", "-profile:v", "3", "-pix_fmt", "yuv422p10le", ...bt709],
        audio: (m) => (m ? ["-c:a", "pcm_s16le"] : ["-an"]),
      };
    case "mp4_av1":
      // SVT-AV1: ~30% smaller than x265 at equal quality. CRF scale differs from x264/x265
      // (roughly +8 for comparable quality); preset 7 keeps encode times sane on CPU.
      return {
        video: [
          "-c:v", "libsvtav1", "-preset", "7",
          "-crf", { draft: "38", standard: "32", high: "27", max: "22" }[quality],
          "-svtav1-params", "tune=0", "-pix_fmt", "yuv420p10le", ...bt709,
        ],
        audio: (m) => (m ? ["-c:a", "aac", "-b:a", "192k"] : ["-an"]),
      };
    default:
      return {
        video: ["-c:v", "libx264", "-preset", "veryfast", "-crf", crf, "-pix_fmt", "yuv420p", ...bt709],
        audio: (m) => (m ? ["-c:a", "aac", "-b:a", "192k"] : ["-an"]),
      };
  }
}

/** hdr_hevc pre-flight: the HDR graph is only honest when EVERY visual source is HDR. Mixed
 * timelines are refused rather than up-converted — inverse-mapping SDR into HLG has to guess at
 * peak level and gamut expansion, and silently wrong color is worse than a clear no. */
async function hdrExportRefusal(doc: EditorDocument): Promise<string | null> {
  let hdrCount = 0;
  const sdrNames = new Set<string>();
  for (const track of doc.mainTimeline.tracks) {
    if (track.hidden) continue; // hidden tracks don't render, so they can't disqualify the export
    for (const c of track.clips) {
      if (c.mediaType !== "video" && c.mediaType !== "image") continue;
      const a = doc.asset(c.mediaRef);
      if (!a?.url || a.generationStatus.kind !== "none") continue;
      if (c.mediaType === "video" && (await isHdrSource(a.url))) hdrCount++;
      else sdrNames.add(a.name); // images are SDR by nature
    }
  }
  if (hdrCount === 0)
    return "HDR export not possible: the timeline has no HDR (HLG/PQ) video sources — there is no HDR data to preserve. Use format 'mp4_h265' or 'mp4_h264' instead.";
  if (sdrNames.size > 0)
    return `HDR export not possible: the timeline mixes HDR and SDR sources (SDR: ${[...sdrNames].slice(0, 5).join(", ")}). Up-converting SDR to HLG would guess at colors, so it is refused. Export 'mp4_h265' instead (tone-mapped SDR, every source supported), or remove the SDR clips.`;
  return null;
}

export async function exportTimeline(
  doc: EditorDocument,
  outName = "export.mp4",
  format: ExportFormat = "mp4_h264",
  quality: ExportQuality = "high",
  _retried = false,
): Promise<ExportResult> {
  if (format === "nle_xml") return exportNleXml(doc, outName);
  if (format === "fcpxml") return exportFcpXml(doc, outName);
  if (format === "lossless") return exportLossless(doc, outName);
  const hdr = format === "hdr_hevc";
  if (hdr) {
    const refusal = await hdrExportRefusal(doc);
    if (refusal) return { ok: false, error: refusal };
  }

  const g = await buildVisualGraph(doc, hdr);
  if (!g) return { ok: false, error: "Timeline is empty — nothing to export." };

  // RGB→YUV with an EXPLICIT BT.709 matrix: the compositing graph works in RGBA, and swscale's
  // default matrix for the way back is BT.601 with the output left untagged — players then assume
  // BT.709 for HD and decode the 601-coded values wrong (everything looks slightly brighter/washed).
  // The HDR path plays the same trick with the BT.2020 matrix into 10-bit; setparams then re-tags
  // the frames so the encoder sees tags consistent with the VUI codecArgs asks x265 for.
  const colorOut = hdr
    ? "scale=out_color_matrix=bt2020:out_range=tv:flags=accurate_rnd,format=yuv420p10le,setparams=colorspace=bt2020nc:color_primaries=bt2020:color_trc=arib-std-b67:range=tv"
    : "scale=out_color_matrix=bt709:out_range=tv:flags=accurate_rnd,format=yuv420p";
  const filters = [...g.filters, ...g.audioFilters, `[${g.vlabel}]${colorOut}[vout]`];
  let aMap: string[] = [];
  if (buildAudioMix(g, filters, "aout")) aMap = ["-map", "[aout]"];

  const outPath = join(exportsDir, outName);
  const c = codecArgs(format, quality);
  const args = [
    "-y",
    ...g.inputs,
    "-filter_complex",
    filters.join(";"),
    "-map",
    "[vout]",
    ...aMap,
    "-r",
    fpsArg(g.fps), // exact rational for NTSC ("30000/1001"): "29.97" would encode 2997/100 and drift
    "-t",
    sf(g.totalFrames, g.fps),
    ...c.video,
    ...c.audio(aMap.length > 0),
    "-movflags", // moov atom up front → the file starts playing/streaming before it fully downloads
    "+faststart",
    outPath,
  ];

  // Tagged so a cancel request (HTTP /export/cancel or the cancel_export tool) can kill this run.
  const { stderr, code } = await run(FFMPEG_BIN, args, { tag: "export" });
  if (code !== 0) {
    // Checked BEFORE the Vulkan retry: a killed ffmpeg exits nonzero with arbitrary stderr, and a
    // user cancel must never trigger a rerun. The half-written file is deleted so it can't be
    // mistaken for a finished export (mp4 without a moov atom is unplayable anyway).
    if (consumeKilled("export")) {
      void rm(outPath, { force: true }).catch(() => {});
      return { ok: false, error: "Export cancelled." };
    }
    // The Vulkan/libplacebo path can fail on the REAL graph even when the probe passed (device
    // creation refused with many instances, driver resets, remote sessions). Never fail an export
    // over the tone-map backend: switch this process to the CPU chain and rerun once.
    if (!_retried && isVulkanFailure(stderr)) {
      disablePlacebo(`export failed: ${stderr.split("\n").findLast((l) => /vulkan|placebo/i.test(l)) ?? "vulkan error"}`);
      return exportTimeline(doc, outName, format, quality, true);
    }
    return { ok: false, error: `ffmpeg exited ${code}: ${stderr.split("\n").slice(-8).join("\n")}` };
  }
  return { ok: true, path: outPath, durationSeconds: g.durSec };
}

/** Render a composited timeline range [startFrame, endFrame) to an mp4 file — for save_range_as_media
 * ("bake" a clip/selection into a reusable library asset). Returns true on success. */
export async function saveRangeToFile(doc: EditorDocument, startFrame: number, endFrame: number, destPath: string): Promise<boolean> {
  const g = await buildVisualGraph(doc);
  if (!g) return false;
  const f0 = Math.max(0, Math.min(startFrame, endFrame));
  const f1 = Math.max(f0 + 1, Math.max(startFrame, endFrame));
  const t0s = sf(f0, g.fps);
  const durS = sf(f1 - f0, g.fps);
  const filters = [...g.filters, ...g.audioFilters, `[${g.vlabel}]trim=start=${t0s}:duration=${durS},setpts=PTS-STARTPTS,scale=out_color_matrix=bt709:out_range=tv:flags=accurate_rnd,format=yuv420p[vout]`];
  let aMap: string[] = [];
  if (buildAudioMix(g, filters, "amixed")) {
    filters.push(`[amixed]atrim=start=${t0s}:duration=${durS},asetpts=PTS-STARTPTS[aout]`);
    aMap = ["-map", "[aout]"];
  }
  const c = codecArgs("mp4_h264");
  const args = [
    "-y",
    ...g.inputs,
    "-filter_complex",
    filters.join(";"),
    "-map",
    "[vout]",
    ...aMap,
    "-r",
    fpsArg(g.fps),
    "-t",
    durS,
    ...c.video,
    ...c.audio(aMap.length > 0),
    destPath,
  ];
  // Same "export" tag as exportTimeline: merges/bakes are long renders the user cancels the same way.
  const { code, stderr } = await run(FFMPEG_BIN, args, { tag: "export" });
  if (code !== 0 && consumeKilled("export")) {
    // Cancellation, not a codec problem: drop the partial file and don't take the Vulkan retry.
    void rm(destPath, { force: true }).catch(() => {});
    return false;
  }
  if (code !== 0 && isVulkanFailure(stderr)) {
    disablePlacebo("saveRangeToFile failed on the Vulkan path");
    return saveRangeToFile(doc, startFrame, endFrame, destPath);
  }
  return code === 0;
}

function xmlEscape(str: string): string {
  return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** FCP7 XML (xmeml) interchange — imports into Premiere Pro and DaVinci Resolve. Carries tracks,
 * clip timing (start/end), source in/out, and file references. Text/generator clips are omitted. */
async function exportNleXml(doc: EditorDocument, outName: string): Promise<ExportResult> {
  const tl = doc.project.timeline;
  const fps = tl.fps;
  // FCP7 xmeml's NTSC convention: an integer timebase plus <ntsc>TRUE</ntsc> (30+TRUE = 29.97);
  // frame numbers themselves are rate-agnostic. num/1000 turns 30000/1001 into timebase 30.
  const rat = fpsRational(fps);
  const ntsc = rat.den !== 1;
  const timebase = ntsc ? Math.round(rat.num / 1000) : rat.num;
  const rateXml = `<rate><timebase>${timebase}</timebase><ntsc>${ntsc ? "TRUE" : "FALSE"}</ntsc></rate>`;
  const total = timelineTotalFrames(tl);
  const emittedFiles = new Set<string>();

  const fileEl = (assetId: string, indent: string): string => {
    const a = doc.asset(assetId);
    const id = `file-${assetId}`;
    if (emittedFiles.has(id)) return `${indent}<file id="${id}"/>`;
    emittedFiles.add(id);
    const path = (a?.url ?? "").replace(/\\/g, "/");
    const pathurl = path ? `file://localhost/${path.replace(/^\//, "")}` : "";
    const dur = Math.max(1, Math.round((a?.durationSeconds ?? 0) * fps));
    const hasV = a?.type !== "audio";
    const hasA = a?.type === "audio" || a?.hasAudio;
    const media = `${hasV ? `<video><samplecharacteristics><width>${tl.width}</width><height>${tl.height}</height></samplecharacteristics></video>` : ""}${hasA ? "<audio><channelcount>2</channelcount></audio>" : ""}`;
    return [
      `${indent}<file id="${id}">`,
      `${indent}  <name>${xmlEscape(a?.name ?? assetId)}</name>`,
      `${indent}  <pathurl>${xmlEscape(pathurl)}</pathurl>`,
      `${indent}  ${rateXml}`,
      `${indent}  <duration>${dur}</duration>`,
      `${indent}  <media>${media}</media>`,
      `${indent}</file>`,
    ].join("\n");
  };

  const clipItem = (c: Clip, indent: string): string => {
    if (c.mediaType === "text" || !c.mediaRef) return "";
    return [
      `${indent}<clipitem id="clipitem-${c.id}">`,
      `${indent}  <name>${xmlEscape(doc.asset(c.mediaRef)?.name ?? c.mediaRef)}</name>`,
      `${indent}  <enabled>TRUE</enabled>`,
      `${indent}  <duration>${Math.max(1, c.durationFrames)}</duration>`,
      `${indent}  ${rateXml}`,
      `${indent}  <start>${c.startFrame}</start>`,
      `${indent}  <end>${clipEndFrame(c)}</end>`,
      `${indent}  <in>${c.trimStartFrame}</in>`,
      `${indent}  <out>${c.trimStartFrame + c.durationFrames}</out>`,
      fileEl(c.mediaRef, `${indent}  `),
      `${indent}</clipitem>`,
    ].join("\n");
  };

  const trackXml = (kind: "video" | "audio", indent: string) =>
    tl.tracks
      .filter((t) => t.type === kind)
      .map((t) => `${indent}<track>\n${t.clips.map((c) => clipItem(c, `${indent}  `)).filter(Boolean).join("\n")}\n${indent}</track>`)
      .join("\n");

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE xmeml>
<xmeml version="5">
  <sequence id="cupcat-sequence">
    <name>${xmlEscape(doc.project.name)}</name>
    <duration>${total}</duration>
    ${rateXml}
    <media>
      <video>
        <format><samplecharacteristics><width>${tl.width}</width><height>${tl.height}</height><rate><timebase>${timebase}</timebase></rate></samplecharacteristics></format>
${trackXml("video", "        ")}
      </video>
      <audio>
${trackXml("audio", "        ")}
      </audio>
    </media>
  </sequence>
</xmeml>
`;

  const outPath = join(exportsDir, `${outName.replace(/\.[^.]+$/, "")}.xml`);
  // Verify the write actually landed — never report success on a failed/partial write.
  try {
    const bytes = await Bun.write(outPath, xml);
    if (bytes < xml.length) return { ok: false, error: `XML write was truncated (${bytes}/${xml.length} bytes) to ${outPath}` };
  } catch (e) {
    return { ok: false, error: `Failed to write XML to ${outPath}: ${e instanceof Error ? e.message : String(e)}` };
  }
  return { ok: true, path: outPath, durationSeconds: total / fps };
}

/** FCPXML 1.11 — the modern interchange for Final Cut Pro and DaVinci Resolve (the FCP7 xmeml
 * above predates lanes and rational time). Layout mapping:
 *  - bottom-most video track → the spine (primary storyline), holes filled with <gap> so the
 *    spine stays contiguous (FCPXML has no implicit gaps)
 *  - every other video/image clip → connected <asset-clip lane="N"> (N>0, stacking upward in the
 *    same order the compositor draws)
 *  - audio-track clips → connected <asset-clip> on negative lanes (the FCPXML audio convention)
 *  - text clips → <title> with a basic text style
 * Times are rational seconds over an fps*100 timescale ("100/3000s" = one 30 fps frame): FCPXML
 * rejects naive fractions like "1/30s", and fps*100 is the canonical FCP denominator family.
 * NTSC rates use the exact 1001 rationals instead ("1001/30000s" = one 29.97 frame).
 * Color/effects/keyframes/speed are NOT carried (noted in an XML comment in the output) — those
 * are baked only in rendered video exports. */
async function exportFcpXml(doc: EditorDocument, outName: string): Promise<ExportResult> {
  const tl = doc.project.timeline;
  const fps = tl.fps;
  const rat = fpsRational(fps);
  const total = timelineTotalFrames(tl);
  // NTSC rates use the canonical 1001-family fractions (one 29.97 frame = "1001/30000s" — exactly
  // what FCP itself writes); integer rates keep the fps*100 denominator family ("100/3000s").
  const t = (frames: number): string =>
    rat.den === 1 ? `${Math.round(frames) * 100}/${rat.num * 100}s` : `${Math.round(frames) * rat.den}/${rat.num}s`;
  const ready = (c: Clip): boolean => {
    const a = doc.asset(c.mediaRef);
    return !!a?.url && a.generationStatus.kind === "none";
  };

  // Resource table: r1 = sequence format, r2 = the shared title effect (only when titles exist),
  // r3+ = one <asset> per referenced media file, registered lazily on first use.
  const assetRes = new Map<string, string>();
  let nextRes = 3;
  const resources: string[] = [
    `    <format id="r1" frameDuration="${t(1)}" width="${tl.width}" height="${tl.height}" colorSpace="1-1-1 (Rec. 709)"/>`,
  ];
  const resFor = (assetId: string): string | null => {
    const existing = assetRes.get(assetId);
    if (existing) return existing;
    const a = doc.asset(assetId);
    if (!a?.url) return null;
    const id = `r${nextRes++}`;
    assetRes.set(assetId, id);
    const hasV = a.type === "video" || a.type === "image";
    const attrs = [
      `id="${id}"`,
      `name="${xmlEscape(a.name)}"`,
      `start="0s"`,
      `duration="${t(Math.max(0, Math.round(a.durationSeconds * fps)))}"`,
      hasV ? `hasVideo="1"` : "",
      // Video assets reference the sequence format so importers don't probe a frame rate that
      // disagrees with the frame math used for every clip below.
      a.type === "video" ? `format="r1"` : "",
      a.hasAudio || a.type === "audio" ? `hasAudio="1" audioSources="1" audioChannels="2"` : "",
    ]
      .filter(Boolean)
      .join(" ");
    const src = `file:///${encodeURI(a.url.replace(/\\/g, "/").replace(/^\//, ""))}`;
    resources.push(`    <asset ${attrs}>`, `      <media-rep kind="original-media" src="${xmlEscape(src)}"/>`, `    </asset>`);
    return id;
  };

  // Track → lane. The compositor draws the reversed track array bottom-up, so the LAST video
  // track is the background layer = the spine; positive lanes count upward in that same stacking
  // order, audio tracks take negative lanes.
  const videoTracks = tl.tracks.filter((tr) => tr.type === "video");
  const mainTrack = videoTracks[videoTracks.length - 1] ?? null;
  const laneOf = new Map<string, number>();
  let vLane = 0;
  let aLane = 0;
  for (const tr of [...tl.tracks].reverse()) {
    if (tr.type === "audio") laneOf.set(tr.id, --aLane);
    else if (tr !== mainTrack) laneOf.set(tr.id, ++vLane);
  }

  // A video clip whose audio already exists as a separate linked clip must not ALSO bring its
  // embedded audio along on import, or the sound doubles — srcEnable narrows such clips.
  const linkedAudioGroups = new Set<string>();
  for (const tr of tl.tracks) for (const c of tr.clips) if (c.mediaType === "audio" && c.linkGroupId) linkedAudioGroups.add(c.linkGroupId);
  const srcEnableFor = (c: Clip, a: MediaAsset): string => {
    if (c.mediaType === "audio") return a.type === "video" ? ` srcEnable="audio"` : "";
    if (a.hasAudio && c.linkGroupId && linkedAudioGroups.has(c.linkGroupId)) return ` srcEnable="video"`;
    return "";
  };

  // Spine slots: main-track clips + gap fillers, contiguous over [0, total). Connected clips hang
  // off the slot their start frame falls inside; `children` collects their serialized lines.
  interface SpineSlot {
    clip: Clip | null; // null = gap
    offset: number; // sequence position (frames)
    start: number; // local in-point (frames; 0 for gaps)
    duration: number;
    children: string[];
  }
  const slots: SpineSlot[] = [];
  const mainClips = (mainTrack?.clips ?? [])
    .filter((c) => c.mediaType !== "text" && ready(c))
    .sort((a, b) => a.startFrame - b.startFrame);
  let cursor = 0;
  for (const c of mainClips) {
    if (c.startFrame > cursor) slots.push({ clip: null, offset: cursor, start: 0, duration: c.startFrame - cursor, children: [] });
    slots.push({ clip: c, offset: c.startFrame, start: c.trimStartFrame, duration: c.durationFrames, children: [] });
    cursor = clipEndFrame(c);
  }
  if (cursor < total) slots.push({ clip: null, offset: cursor, start: 0, duration: total - cursor, children: [] });
  if (slots.length === 0) slots.push({ clip: null, offset: 0, start: 0, duration: Math.max(1, total), children: [] });

  // A connected clip's `offset` lives in its PARENT's local time (the same coordinate space as
  // the parent's `start`), not in sequence time: seqTime = parentOffset + (localTime − parentStart).
  const anchorSlot = (seqFrame: number): SpineSlot => {
    let found = slots[0]!;
    for (const slot of slots) {
      if (slot.offset > seqFrame) break;
      found = slot;
    }
    return found;
  };
  const localOffset = (slot: SpineSlot, seqFrame: number): number => slot.start + (seqFrame - slot.offset);

  const assetClipTag = (c: Clip, a: MediaAsset, ref: string, offsetFrames: number, lane?: number): string =>
    `asset-clip ref="${ref}"${lane !== undefined ? ` lane="${lane}"` : ""} offset="${t(offsetFrames)}" name="${xmlEscape(a.name)}" start="${t(c.trimStartFrame)}" duration="${t(c.durationFrames)}"${srcEnableFor(c, a)}`;

  /** "#RRGGBB(AA)" → FCPXML "r g b a" floats. */
  const fcpColor = (hex: string): string => {
    const h = hex.replace(/^#/, "");
    const ch = (i: number) => (h.length >= i + 2 ? parseInt(h.slice(i, i + 2), 16) / 255 : 1).toFixed(4);
    return `${ch(0)} ${ch(2)} ${ch(4)} ${h.length === 8 ? ch(6) : "1"}`;
  };
  let usesTitles = false;
  let titleStyleSeq = 0;
  const titleLines = (c: Clip, lane: number): string[] => {
    usesTitles = true;
    const ts = c.textStyle;
    const styleId = `ts${++titleStyleSeq}`;
    const slot = anchorSlot(c.startFrame);
    const face = ts?.fontName?.includes("-Bold") ? ` fontFace="Bold"` : "";
    return [
      `<title ref="r2" lane="${lane}" offset="${t(localOffset(slot, c.startFrame))}" name="${xmlEscape(c.textContent ?? "Title")}" duration="${t(c.durationFrames)}">`,
      `  <text>`,
      `    <text-style ref="${styleId}">${xmlEscape(c.textContent ?? "")}</text-style>`,
      `  </text>`,
      `  <text-style-def id="${styleId}">`,
      `    <text-style font="${xmlEscape((ts?.fontName ?? "Helvetica").split("-")[0]!)}"${face} fontSize="${Math.round(ts?.fontSize ?? 96)}" fontColor="${fcpColor(ts?.color ?? "#FFFFFF")}" alignment="${ts?.alignment ?? "center"}"/>`,
      `  </text-style-def>`,
      `</title>`,
    ];
  };

  // Attach every non-spine clip to its anchor slot (text clips can sit on any track, including
  // the spine's own).
  for (const tr of tl.tracks) {
    const lane = laneOf.get(tr.id) ?? 1;
    for (const c of [...tr.clips].sort((a, b) => a.startFrame - b.startFrame)) {
      if (c.mediaType === "text") {
        if (c.textContent) anchorSlot(c.startFrame).children.push(...titleLines(c, Math.max(1, lane)));
        continue;
      }
      if (tr === mainTrack || !ready(c)) continue;
      const a = doc.asset(c.mediaRef)!;
      const ref = resFor(c.mediaRef);
      if (!ref) continue;
      const slot = anchorSlot(c.startFrame);
      slot.children.push(`<${assetClipTag(c, a, ref, localOffset(slot, c.startFrame), lane)}/>`);
    }
  }

  const IND = "            "; // spine-item indent
  const spineLines: string[] = [];
  for (const slot of slots) {
    let tag: string;
    if (slot.clip) {
      const a = doc.asset(slot.clip.mediaRef)!;
      tag = assetClipTag(slot.clip, a, resFor(slot.clip.mediaRef)!, slot.offset);
    } else {
      tag = `gap name="Gap" offset="${t(slot.offset)}" duration="${t(slot.duration)}"`;
    }
    if (slot.children.length === 0) {
      spineLines.push(`${IND}<${tag}/>`);
    } else {
      spineLines.push(`${IND}<${tag}>`, ...slot.children.map((l) => `${IND}  ${l}`), `${IND}</${slot.clip ? "asset-clip" : "gap"}>`);
    }
  }
  // Titles need an effect resource to ref; the uid is FCP's stock "Basic Title" Motion template
  // (the one FCP itself writes), which Resolve also maps to its own text generator.
  if (usesTitles) {
    resources.splice(1, 0, `    <effect id="r2" name="Basic Title" uid=".../Titles.localized/Basic Text.localized/Basic Title.localized/Basic Title.moti"/>`);
  }

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE fcpxml>
<fcpxml version="1.11">
  <!-- Exported by CupCat. Color grades, effects, keyframe animation, transforms and speed changes
       are not carried in FCPXML - they are baked only in rendered video exports. -->
  <resources>
${resources.join("\n")}
  </resources>
  <library>
    <event name="CupCat">
      <project name="${xmlEscape(doc.project.name)}">
        <sequence format="r1" duration="${t(total)}" tcStart="0s" tcFormat="NDF">
          <spine>
${spineLines.join("\n")}
          </spine>
        </sequence>
      </project>
    </event>
  </library>
</fcpxml>
`;

  const outPath = join(exportsDir, `${outName.replace(/\.[^.]+$/, "")}.fcpxml`);
  // Verify the write actually landed — never report success on a failed/partial write.
  try {
    const bytes = await Bun.write(outPath, xml);
    if (bytes < xml.length) return { ok: false, error: `FCPXML write was truncated (${bytes}/${xml.length} bytes) to ${outPath}` };
  } catch (e) {
    return { ok: false, error: `Failed to write FCPXML to ${outPath}: ${e instanceof Error ? e.message : String(e)}` };
  }
  return { ok: true, path: outPath, durationSeconds: total / fps };
}

/** Render composited frames at the given project-frame numbers → base64 PNGs (downscaled). */
/** A "read the video" composite (à la video-use): filmstrip + waveform + a red overlay on every
 * silence (cut candidate) + a seconds ruler + word labels from the transcript — one PNG so the
 * agent can reason about cuts without dumping thousands of frames. All local (ffmpeg + whisper). */
export async function renderTimelineView(
  srcPath: string,
  startSec: number,
  durSec: number,
  hasVideo: boolean,
  hasAudio: boolean,
  words: { word: string; start: number; end: number }[],
  silences: { start: number; end: number }[],
  destPath: string,
): Promise<boolean> {
  const W = 1280;
  const STRIP_H = 170;
  const WAVE_H = 150;
  const dur = Math.max(0.1, durSec);
  const COLS = Math.max(6, Math.min(18, Math.round(dur / 2)));
  const xOf = (t: number) => Math.round((Math.max(0, Math.min(dur, t)) / dur) * W);
  const esc = (str: string) => str.replace(/['":%\\]/g, "").slice(0, 16);
  const FF = ffPath(FONT);
  const parts: string[] = [];
  const layers: string[] = [];
  if (hasVideo) {
    parts.push(
      `[0:v]trim=start=${s(startSec)}:duration=${s(dur)},setpts=PTS-STARTPTS,fps=${COLS}/${s(dur)},scale=-1:${STRIP_H},tile=${COLS}x1[st0]`,
    );
    parts.push(`[st0]scale=${W}:${STRIP_H},setsar=1[strip]`);
    layers.push("strip");
  }
  if (hasAudio) {
    parts.push(
      `[0:a]atrim=start=${s(startSec)}:duration=${s(dur)},asetpts=PTS-STARTPTS,showwavespic=s=${W}x${WAVE_H}:colors=0x33ddff[wavefg]`,
    );
    // showwavespic's background is transparent — overlay it on a solid dark panel so the cyan wave
    // pops and the red silence markers stay visible once the PNG is flattened.
    parts.push(`color=c=0x0c1014:s=${W}x${WAVE_H}[wavebg]`);
    parts.push(`[wavebg][wavefg]overlay[wave]`);
    layers.push("wave");
  }
  if (layers.length === 0) return false;
  const waveTop = hasVideo ? STRIP_H : 0;
  const totalH = (hasVideo ? STRIP_H : 0) + (hasAudio ? WAVE_H : 0);
  let base: string;
  if (layers.length === 2) {
    parts.push(`[strip][wave]vstack=inputs=2[stacked]`);
    base = "stacked";
  } else {
    base = layers[0]!;
  }
  const draws: string[] = [];
  if (hasAudio) {
    for (const sil of silences) {
      const x1 = xOf(sil.start);
      const w = Math.max(2, xOf(sil.end) - x1);
      draws.push(`drawbox=x=${x1}:y=${waveTop}:w=${w}:h=${WAVE_H}:color=red@0.45:t=fill`);
    }
  }
  const step = Math.max(1, Math.round(dur / 8));
  for (let t = 0; t <= dur + 0.001; t += step) {
    const x = Math.min(W - 34, xOf(t));
    draws.push(`drawbox=x=${x}:y=0:w=1:h=${totalH}:color=white@0.35:t=1`);
    draws.push(`drawtext=fontfile=${FF}:text='${t.toFixed(0)}s':x=${x + 2}:y=2:fontsize=16:fontcolor=white:box=1:boxcolor=black@0.55`);
  }
  const wordY = (hasAudio ? waveTop + WAVE_H : STRIP_H) - 18;
  const cap = 80;
  const sampled = words.length <= cap ? words : words.filter((_, i) => i % Math.ceil(words.length / cap) === 0);
  sampled.forEach((wd, i) => {
    const t = esc(wd.word);
    if (!t) return;
    draws.push(
      `drawtext=fontfile=${FF}:text='${t}':x=${xOf(wd.start)}:y=${wordY - (i % 2) * 17}:fontsize=13:fontcolor=yellow:box=1:boxcolor=black@0.5`,
    );
  });
  parts.push(`[${base}]${draws.length ? draws.join(",") : "null"}[out]`);
  const scriptFile = join(exportsDir, "_tlview.filtergraph");
  await Bun.write(scriptFile, parts.join(";\n"));
  // -/filter_complex (load option value from file): the old -filter_complex_script was REMOVED in
  // ffmpeg ≥8 (the bundled build) — it now errors "Unrecognized option".
  const args = ["-y", "-i", srcPath, "-/filter_complex", scriptFile, "-map", "[out]", "-frames:v", "1", destPath];
  const { code, stderr } = await run(FFMPEG_BIN, args);
  if (code !== 0) console.error(`[timeline_view] ffmpeg exited ${code}: ${stderr.slice(-300)}`);
  return code === 0 && (await Bun.file(destPath).exists());
}

export async function renderFrames(doc: EditorDocument, frames: number[]): Promise<string[]> {
  // Render the ACTIVE view (doc.timeline): with a compound open, inspect_timeline must show the
  // sub-timeline being edited, not the main program.
  let g = await buildVisualGraph(doc, false, doc.timeline);
  if (!g) return [];
  const out: string[] = [];
  for (const fr of frames) {
    const mkFilters = (gg: NonNullable<typeof g>) => [
      ...gg.filters,
      `[${gg.vlabel}]trim=start=${sf(Math.max(0, fr), gg.fps)}:duration=${sf(1, gg.fps)},setpts=PTS-STARTPTS,scale=640:-2,format=rgb24[out]`,
    ];
    // jpg not png — these go into the chat history; see frameToBase64's 413 note
    const png = join(exportsDir, `_frame_${fr}.jpg`);
    let { code, stderr } = await run(FFMPEG_BIN, ["-y", ...g.inputs, "-filter_complex", mkFilters(g).join(";"), "-map", "[out]", "-frames:v", "1", "-q:v", "5", png]);
    if (code !== 0 && isVulkanFailure(stderr)) {
      // Switch to the CPU chain, rebuild the graph, redo THIS frame; later frames reuse it.
      disablePlacebo("renderFrames failed on the Vulkan path");
      g = await buildVisualGraph(doc, false, doc.timeline);
      if (!g) return out;
      ({ code, stderr } = await run(FFMPEG_BIN, ["-y", ...g.inputs, "-filter_complex", mkFilters(g).join(";"), "-map", "[out]", "-frames:v", "1", "-q:v", "5", png]));
    }
    if (code !== 0) {
      console.error(`[renderFrames] ffmpeg exited ${code} for frame ${fr}: ${stderr.split("\n").slice(-4).join(" | ")}`);
      continue;
    }
    const f = Bun.file(png);
    if (await f.exists()) out.push(Buffer.from(await f.arrayBuffer()).toString("base64"));
  }
  return out;
}

/** Render one composited frame (graded look) + measure its color scopes. For inspect_color. */
export async function renderFrameAndScopes(
  doc: EditorDocument,
  frame: number,
): Promise<{ b64: string | null; scopes: Record<string, number> | null }> {
  const g = await buildVisualGraph(doc, false, doc.timeline); // active view — see renderFrames
  if (!g) return { b64: null, scopes: null };
  const png = join(exportsDir, `_scope_${frame}.jpg`);
  const filters = [
    ...g.filters,
    `[${g.vlabel}]trim=start=${sf(Math.max(0, frame), g.fps)}:duration=${sf(1, g.fps)},setpts=PTS-STARTPTS,scale=720:-2,format=rgb24[out]`,
  ];
  const { code, stderr } = await run(FFMPEG_BIN, ["-y", ...g.inputs, "-filter_complex", filters.join(";"), "-map", "[out]", "-frames:v", "1", "-q:v", "5", png]);
  if (code !== 0) {
    if (isVulkanFailure(stderr)) {
      disablePlacebo("renderFrameAndScopes failed on the Vulkan path");
      return renderFrameAndScopes(doc, frame);
    }
    return { b64: null, scopes: null };
  }
  const f = Bun.file(png);
  const b64 = (await f.exists()) ? Buffer.from(await f.arrayBuffer()).toString("base64") : null;
  const scopes = await imageScopes(png);
  return { b64, scopes };
}

/** Render the composited timeline frame at full resolution to destPath (for capture_frame). */
export async function renderFrameToFile(doc: EditorDocument, frame: number, destPath: string): Promise<boolean> {
  const g = await buildVisualGraph(doc, false, doc.timeline); // active view — see renderFrames
  if (!g) return false;
  const filters = [...g.filters, `[${g.vlabel}]trim=start=${sf(Math.max(0, frame), g.fps)}:duration=${sf(1, g.fps)},setpts=PTS-STARTPTS,format=rgb24[out]`];
  const { code, stderr } = await run(FFMPEG_BIN, ["-y", ...g.inputs, "-filter_complex", filters.join(";"), "-map", "[out]", "-frames:v", "1", destPath]);
  if (code !== 0 && isVulkanFailure(stderr)) {
    disablePlacebo("renderFrameToFile failed on the Vulkan path");
    return renderFrameToFile(doc, frame, destPath);
  }
  return code === 0;
}
