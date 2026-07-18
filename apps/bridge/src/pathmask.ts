// Freeform pen-mask matte renderer for the export. geq expressions can describe rects and
// ellipses analytically, but an arbitrary (possibly Catmull-Rom-smoothed) polygon cannot be
// expressed that way — so a "path" mask becomes a pre-rendered grayscale PNG matte: the shared
// SVG path (editor-core maskpath) is rasterized once via headless Edge at the clip's box size,
// feather is baked in as a two-pass box blur (≈ gaussian), invert as a negate. The export graph
// then just alphamerges the matte onto the clip.

import { createHash } from "node:crypto";
import { mkdir, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { type MaskSpec, maskPathD } from "@cupcat/editor-core";
import { renderHtmlFrames } from "./cdp";
import { exportsDir, FFMPEG_BIN } from "./config";
import { run } from "./proc";

/** Render (or reuse) the matte PNG for a "path" mask at the clip's box size. Content-addressed
 * cache in exportsDir/masks: the key hashes everything that changes the pixels
 * (points + smooth + feather + invert + wpx + hpx), so edits re-render and repeats are free.
 * Returns null on failure — the caller exports the clip unmasked rather than dying. */
export async function ensurePathMaskPng(m: MaskSpec, wpx: number, hpx: number): Promise<string | null> {
  const pts = m.points ?? [];
  if (m.shape !== "path" || pts.length < 3) return null;
  const key = createHash("sha1")
    .update(JSON.stringify({ p: pts, s: !!m.smooth, f: m.feather, i: m.invert, w: wpx, h: hpx }))
    .digest("hex")
    .slice(0, 16);
  const dir = join(exportsDir, "masks");
  const out = join(dir, `mask-${key}.png`);
  if (await Bun.file(out).exists()) return out; // cache hit
  await mkdir(dir, { recursive: true });
  // White filled path on an opaque black body: the matte lives in the PNG's LUMA, sidestepping
  // any ambiguity from the CDP transparent-background override (RGB under alpha-0 is undefined).
  const d = maskPathD(pts, !!m.smooth, wpx, hpx);
  const html =
    `<!doctype html><html><body style="margin:0;width:${wpx}px;height:${hpx}px;background:#000;overflow:hidden">` +
    `<svg width="${wpx}" height="${hpx}" viewBox="0 0 ${wpx} ${hpx}" xmlns="http://www.w3.org/2000/svg">` +
    `<path d="${d}" fill="#fff"/></svg></body></html>`;
  const htmlPath = join(dir, `mask-${key}.html`);
  const frameDir = join(dir, `_frames-${key}`);
  try {
    await Bun.write(htmlPath, html);
    // durationSeconds 0 → cdp renders exactly one static frame (its frame count floors at 1).
    const frames = await renderHtmlFrames(htmlPath, { width: wpx, height: hpx, fps: 1, durationSeconds: 0, outDir: frameDir });
    if (!frames?.length) {
      console.error("[mask] path-mask render failed (Edge unavailable?) — clip will export unmasked");
      return null;
    }
    // feather × min(wpx,hpx) matches the geq masks' feather normalization (fraction of the short
    // side). luma_power=2 runs the box filter twice — a close, cheap gaussian approximation.
    // boxblur rejects radii ≥ half the frame, so clamp.
    const radius = Math.round(Math.max(0, Math.min(1, m.feather)) * Math.min(wpx, hpx));
    const r = Math.max(0, Math.min(radius, Math.floor(Math.min(wpx, hpx) / 2) - 1));
    const chain = ["format=gray", r > 0 ? `boxblur=luma_radius=${r}:luma_power=2` : "", m.invert ? "negate" : ""]
      .filter(Boolean)
      .join(",");
    // Bake to a temp name and rename: a crashed ffmpeg must never leave a half-written PNG that
    // future exports would treat as a valid cache entry.
    const tmp = join(dir, `mask-${key}.tmp.png`);
    const { code, stderr } = await run(FFMPEG_BIN, ["-y", "-i", frames[0]!, "-vf", chain, "-frames:v", "1", tmp]);
    if (code !== 0) {
      console.error(`[mask] matte bake failed: ${stderr.split("\n").slice(-3).join(" ")}`);
      return null;
    }
    await rename(tmp, out);
    return out;
  } finally {
    await rm(frameDir, { recursive: true, force: true }).catch(() => {});
    await rm(htmlPath, { force: true }).catch(() => {});
  }
}
