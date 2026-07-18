// AI motion graphics — CupCat's answer to template-based MG tools: Claude writes a self-contained
// HTML/CSS animation (lower thirds, chapter cards, animated counters, quote cards…), Edge headless
// rasterizes it to transparent frames (cdp.ts), ffmpeg packs a VP9-alpha WebM, and the result lands
// on the timeline as a normal overlay clip. The generated HTML is kept next to the asset
// (<asset>.mg.html) so a follow-up "make the text bigger" is just an edit + re-render — the clip
// stays hand-editable, never a baked template.

import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { oneShotText } from "./agent-chat";
import { exportsDir, FFMPEG_BIN, mediaDir } from "./config";
import { renderHtmlFrames } from "./cdp";
import { run } from "./proc";

const MG_SYSTEM = `You are a motion designer who writes production HTML/CSS animations.

Return ONE complete self-contained HTML document and NOTHING else (no fences, no commentary).

Hard rules:
- The canvas is exactly {W}x{H}px. html,body{margin:0;width:{W}px;height:{H}px;overflow:hidden;background:transparent}. NEVER paint a full-canvas opaque background — everything outside your graphic must stay transparent (it overlays video).
- Animate ONLY with CSS animations/transitions or the Web Animations API. No requestAnimationFrame loops, no timers, no external resources (fonts, images, scripts) — system font stacks only (e.g. 'Segoe UI', Arial, sans-serif).
- The full animation lasts exactly {D}s: intro in the first ~15%, hold, outro in the last ~15% (animation-fill-mode: both). Everything must resolve deterministically from the animation clock.
- Design quality: real motion-design craft — easing curves (cubic-bezier), staggered reveals, generous type scale for video legibility (min ~{MIN}px text), strong contrast against arbitrary footage (solid shapes or subtle backdrop panels behind text), safe margins ≥5% from edges.
- Respect the user's language for any text they asked for.`;

export interface MotionArgs {
  prompt?: string;
  html?: string;
  durationSeconds?: number;
  name?: string;
}

/** Generate (or take) the HTML, render, encode VP9-alpha WebM into the media dir.
 * Returns the file path + the saved source path, or throws with a clear reason. */
export async function renderMotionGraphic(
  a: MotionArgs,
  canvas: { width: number; height: number; fps: number },
): Promise<{ path: string; htmlPath: string; durationSeconds: number }> {
  const dur = Math.min(20, Math.max(1, a.durationSeconds ?? 4));
  let html = a.html?.trim();
  if (!html) {
    if (!a.prompt) throw new Error("Pass prompt (what to design) or html (ready-made).");
    const sys = MG_SYSTEM.replace(/\{W\}/g, String(canvas.width))
      .replace(/\{H\}/g, String(canvas.height))
      .replace(/\{D\}/g, String(dur))
      .replace(/\{MIN\}/g, String(Math.round(canvas.height / 30)));
    html = (await oneShotText(sys, a.prompt, { maxTokens: 8192 })).trim();
    html = html.replace(/^```(?:html)?\s*/i, "").replace(/```\s*$/, "");
  }
  if (!/<html|<body|<div|<svg/i.test(html)) throw new Error("The generated markup does not look like HTML.");

  const base = (a.name ?? "motion").replace(/[^\p{L}\p{N} _-]/gu, "").trim().replace(/\s+/g, "-").slice(0, 40) || "motion";
  const stamp = Date.now().toString(36);
  const htmlPath = join(mediaDir, `${base}-${stamp}.mg.html`);
  await Bun.write(htmlPath, html);

  const framesDir = join(exportsDir, `_mgframes_${stamp}`);
  try {
    const frames = await renderHtmlFrames(htmlPath, { ...canvas, durationSeconds: dur, outDir: framesDir });
    if (!frames?.length) throw new Error("Rendering failed (Edge headless unavailable or the page didn't paint).");
    const out = join(mediaDir, `${base}-${stamp}.mg.webm`);
    // VP9 with yuva420p keeps the alpha channel; webm tags alpha_mode=1 so the export graph knows
    // to decode with libvpx (ffmpeg's native vp9 decoder drops alpha).
    const { code, stderr } = await run(FFMPEG_BIN, [
      "-y",
      "-framerate", String(canvas.fps),
      "-i", join(framesDir, "f%05d.png"),
      "-c:v", "libvpx-vp9",
      "-pix_fmt", "yuva420p",
      "-b:v", "0",
      "-crf", "24",
      "-auto-alt-ref", "0",
      out,
    ]);
    if (code !== 0) throw new Error(`ffmpeg encode failed: ${stderr.split("\n").slice(-3).join(" | ")}`);
    return { path: out, htmlPath, durationSeconds: dur };
  } finally {
    await rm(framesDir, { recursive: true, force: true }).catch(() => {});
  }
}
