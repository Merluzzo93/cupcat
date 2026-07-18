// Freeform pen-mask geometry shared by every consumer of MaskSpec "path": the bridge export
// (SVG rendered to a PNG matte via headless Edge), the live preview (SVG data-URI CSS mask) and
// the pen UI. One path builder means the three renders can never disagree about the shape.

/** A closed cubic-Bezier segment from `from` to `to` with absolute control points c1/c2. */
export interface CubicSegment {
  from: [number, number];
  c1: [number, number];
  c2: [number, number];
  to: [number, number];
}

/** Uniform Catmull-Rom through a CLOSED point loop, converted to cubic Beziers (the standard
 * tangent-thirds construction: c1 = P[i] + (P[i+1]−P[i−1])/6, c2 = P[i+1] − (P[i+2]−P[i])/6).
 * SVG/canvas only speak Bezier, so the smoothing must be baked into cubics before drawing. */
export function catmullRomClosedToBezier(points: [number, number][]): CubicSegment[] {
  const n = points.length;
  const segs: CubicSegment[] = [];
  if (n < 3) return segs;
  for (let i = 0; i < n; i++) {
    const p0 = points[(i - 1 + n) % n]!;
    const p1 = points[i]!;
    const p2 = points[(i + 1) % n]!;
    const p3 = points[(i + 2) % n]!;
    segs.push({
      from: p1,
      c1: [p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6],
      c2: [p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6],
      to: p2,
    });
  }
  return segs;
}

const fmt = (v: number) => (Math.round(v * 10000) / 10000).toString();

/** SVG path `d` for a closed pen mask: points are clip-space (0..1), scaled by sx/sy into the
 * target coordinate system (clip pixels for the export matte, viewBox units for the CSS mask).
 * smooth=true routes through Catmull-Rom cubics; otherwise straight polygon edges. */
export function maskPathD(points: [number, number][], smooth: boolean, sx = 1, sy = 1): string {
  if (points.length < 3) return "";
  if (!smooth) {
    return `M${points.map((p) => `${fmt(p[0] * sx)},${fmt(p[1] * sy)}`).join("L")}Z`;
  }
  const segs = catmullRomClosedToBezier(points);
  let d = `M${fmt(segs[0]!.from[0] * sx)},${fmt(segs[0]!.from[1] * sy)}`;
  for (const s of segs) {
    d += `C${fmt(s.c1[0] * sx)},${fmt(s.c1[1] * sy)} ${fmt(s.c2[0] * sx)},${fmt(s.c2[1] * sy)} ${fmt(s.to[0] * sx)},${fmt(s.to[1] * sy)}`;
  }
  return d + "Z";
}
