// Pure pen-mask helpers: canvas↔clip coordinate mapping for the pen overlay, and the CSS
// mask-image builder that makes every mask shape — including feather and invert — visible LIVE
// on the preview canvas (the export renders the exact ffmpeg equivalent; same geometry model).
// Kept free of React/DOM so vitest can pin the math down.

import { type MaskSpec, maskPathD, type Transform, transformTopLeft } from "@cupcat/editor-core";

// ─── canvas ↔ clip coordinate mapping ────────────────────────────────────────
// Mask points live in CLIP space (0..1 of the clip's box), the pen draws in CANVAS space
// (0..1 of the stage). The bridge is the clip's static transform box; rotation is deliberately
// ignored — the mask applies pre-rotation in both export and CSS, so drawing happens on the
// unrotated box.

/** Canvas-normalized point → clip-space point. Not clamped: the caller decides whether
 * out-of-box points are meaningful (set_mask clamps to 0..1 on commit). */
export function canvasToClip(nx: number, ny: number, t: Transform): [number, number] {
  const tl = transformTopLeft(t);
  // Degenerate (zero-size) boxes can't be divided through; fall back to a unit box so the pen
  // never produces NaN points.
  const w = t.width > 1e-6 ? t.width : 1;
  const h = t.height > 1e-6 ? t.height : 1;
  return [(nx - tl.x) / w, (ny - tl.y) / h];
}

/** Clip-space point → canvas-normalized point (exact inverse of canvasToClip). */
export function clipToCanvas(px: number, py: number, t: Transform): [number, number] {
  const tl = transformTopLeft(t);
  return [tl.x + px * t.width, tl.y + py * t.height];
}

// ─── CSS mask-image builder ──────────────────────────────────────────────────

export interface MaskCss {
  maskImage: string;
  /** Set only when maskImage stacks two gradients that must be intersected (soft rect). */
  composite?: "intersect";
}

const pc = (v: number) => `${(v * 100).toFixed(2)}%`;

/** Inline SVG data-URI mask: the shared path builder (same one the export matte uses) in a
 * 0..100 viewBox stretched over the box, feather as feGaussianBlur. invert wraps the shape in a
 * full-rect subpath with fill-rule evenodd, turning it into a hole. Used for "path" masks and
 * for inverted rects (two swapped-stop gradients would intersect to just the corners — wrong; a
 * punched-hole SVG is the correct union of the outside). */
function svgMask(d: string, feather: number, invert: boolean): string {
  // Export ramp ≈ 2·feather·minDim = feather·200 viewBox units ≈ 4σ → σ = feather·50.
  const blur = feather > 0 ? `<filter id='f' x='-50%' y='-50%' width='200%' height='200%'><feGaussianBlur stdDeviation='${(feather * 50).toFixed(2)}'/></filter>` : "";
  const fAttr = feather > 0 ? " filter='url(#f)'" : "";
  const path = invert
    ? `<path d='M0,0H100V100H0Z${d}' fill-rule='evenodd' fill='#fff'${fAttr}/>`
    : `<path d='${d}' fill='#fff'${fAttr}/>`;
  const svg = `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100' preserveAspectRatio='none'>${blur}${path}</svg>`;
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}")`;
}

/** CSS mask for a clip's MaskSpec — the live equivalent of the export's alpha (geq / matte).
 * Feather semantics match the export: the soft ramp spans `feather` as a fraction of the
 * relevant dimension. Returns null only for a "path" mask without enough points. */
export function maskImageCss(m: MaskSpec): MaskCss | null {
  const f = Math.max(0, Math.min(1, m.feather));
  if (m.shape === "ellipse") {
    // Radial-gradient percentages are relative to the ellipse's own radii — black up to
    // (1−feather)·r, transparent at r — mirroring geq's clip((1−dist)/feather). Inversion just
    // swaps the stops (opaque outside, hole inside).
    const inner = pc(Math.max(0, 1 - f));
    const stops = m.invert ? `transparent ${inner}, #000 100%` : `#000 ${inner}, transparent 100%`;
    return { maskImage: `radial-gradient(ellipse ${pc(m.rw)} ${pc(m.rh)} at ${pc(m.cx)} ${pc(m.cy)}, ${stops})` };
  }
  if (m.shape === "rect") {
    if (m.invert) {
      // Inverted rect = everything EXCEPT the box → punched-hole SVG (see svgMask WHY above).
      const d = maskPathD(
        [
          [m.cx - m.rw, m.cy - m.rh],
          [m.cx + m.rw, m.cy - m.rh],
          [m.cx + m.rw, m.cy + m.rh],
          [m.cx - m.rw, m.cy + m.rh],
        ],
        false,
        100,
        100,
      );
      return { maskImage: svgMask(d, f, true) };
    }
    // Soft rect: horizontal × vertical linear-gradient bands intersected — the CSS analog of
    // geq's ax·ay product. Feather is a fraction of the FULL frame dimension (like the export's
    // x/W-space math); ramps are clamped so they can't cross on a narrow box.
    const band = (lo: number, hi: number, dir: string) => {
      const mid = (lo + hi) / 2;
      const s0 = Math.min(lo + f, mid);
      const s1 = Math.max(hi - f, mid);
      return `linear-gradient(${dir}, transparent ${pc(lo)}, #000 ${pc(s0)}, #000 ${pc(s1)}, transparent ${pc(hi)})`;
    };
    return {
      maskImage: `${band(m.cx - m.rw, m.cx + m.rw, "to right")}, ${band(m.cy - m.rh, m.cy + m.rh, "to bottom")}`,
      composite: "intersect",
    };
  }
  // "path": the freeform pen mask, straight or Catmull-Rom-smoothed.
  const pts = m.points ?? [];
  if (pts.length < 3) return null;
  return { maskImage: svgMask(maskPathD(pts, !!m.smooth, 100, 100), f, m.invert) };
}
