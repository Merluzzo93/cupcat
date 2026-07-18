// Pure-math tests for the pen-mask helpers: canvas↔clip coordinate mapping, Catmull-Rom→cubic
// conversion and the CSS mask-image builder. Run with `bun test` or `bunx vitest run`.
import { describe, expect, test } from "vitest";
import type { MaskSpec, Transform } from "@cupcat/editor-core";
import { catmullRomClosedToBezier, maskPathD } from "@cupcat/editor-core";
import { canvasToClip, clipToCanvas, maskImageCss } from "./maskPen";

function tf(patch: Partial<Transform> = {}): Transform {
  return { centerX: 0.5, centerY: 0.5, width: 1, height: 1, rotation: 0, flipHorizontal: false, flipVertical: false, ...patch };
}

describe("canvas↔clip coordinate mapping", () => {
  test("identity transform: canvas coords ARE clip coords", () => {
    const [x, y] = canvasToClip(0.3, 0.7, tf());
    expect(x).toBeCloseTo(0.3, 10);
    expect(y).toBeCloseTo(0.7, 10);
  });

  test("half-size centered box maps its corners to clip 0..1", () => {
    const t = tf({ width: 0.5, height: 0.5 }); // box spans canvas 0.25..0.75 on both axes
    expect(canvasToClip(0.25, 0.25, t)).toEqual([0, 0]);
    const [x1, y1] = canvasToClip(0.75, 0.75, t);
    expect(x1).toBeCloseTo(1, 10);
    expect(y1).toBeCloseTo(1, 10);
  });

  test("off-center box: clipToCanvas is the exact inverse of canvasToClip", () => {
    const t = tf({ centerX: 0.3, centerY: 0.65, width: 0.4, height: 0.22 });
    for (const p of [[0, 0], [1, 1], [0.5, 0.5], [0.13, 0.87], [-0.2, 1.4]] as [number, number][]) {
      const [nx, ny] = clipToCanvas(p[0], p[1], t);
      const [bx, by] = canvasToClip(nx, ny, t);
      expect(bx).toBeCloseTo(p[0], 10);
      expect(by).toBeCloseTo(p[1], 10);
    }
  });

  test("degenerate zero-size box never yields NaN", () => {
    const [x, y] = canvasToClip(0.4, 0.6, tf({ width: 0, height: 0 }));
    expect(Number.isFinite(x)).toBe(true);
    expect(Number.isFinite(y)).toBe(true);
  });
});

describe("Catmull-Rom → cubic Bezier", () => {
  const square: [number, number][] = [
    [0, 0],
    [1, 0],
    [1, 1],
    [0, 1],
  ];

  test("closed loop yields one segment per point, chained through every input point", () => {
    const segs = catmullRomClosedToBezier(square);
    expect(segs.length).toBe(4);
    for (let i = 0; i < 4; i++) {
      expect(segs[i]!.from).toEqual(square[i]!);
      expect(segs[i]!.to).toEqual(square[(i + 1) % 4]!);
    }
  });

  test("tangent-thirds construction on the square's first edge", () => {
    // P0=(0,1) P1=(0,0) P2=(1,0) P3=(1,1): c1 = P1+(P2−P0)/6 = (1/6, −1/6); c2 = P2−(P3−P1)/6 = (5/6, −1/6).
    const s = catmullRomClosedToBezier(square)[0]!;
    expect(s.c1[0]).toBeCloseTo(1 / 6, 10);
    expect(s.c1[1]).toBeCloseTo(-1 / 6, 10);
    expect(s.c2[0]).toBeCloseTo(5 / 6, 10);
    expect(s.c2[1]).toBeCloseTo(-1 / 6, 10);
  });

  test("fewer than 3 points produces no segments", () => {
    expect(catmullRomClosedToBezier([[0, 0], [1, 1]])).toEqual([]);
  });
});

describe("maskPathD", () => {
  const tri: [number, number][] = [
    [0.5, 0.1],
    [0.9, 0.9],
    [0.1, 0.9],
  ];

  test("straight polygon: M…L…Z with scaled coordinates", () => {
    expect(maskPathD(tri, false, 100, 100)).toBe("M50,10L90,90L10,90Z");
  });

  test("smooth path: starts at the first point, uses cubics, and closes", () => {
    const d = maskPathD(tri, true, 100, 100);
    expect(d.startsWith("M50,10C")).toBe(true);
    expect((d.match(/C/g) ?? []).length).toBe(3); // one cubic per point in a closed loop
    expect(d.endsWith("Z")).toBe(true);
  });

  test("non-uniform scale applies per axis", () => {
    expect(maskPathD(tri, false, 200, 100)).toBe("M100,10L180,90L20,90Z");
  });
});

describe("maskImageCss", () => {
  const base = { cx: 0.5, cy: 0.5, rw: 0.3, rh: 0.2, feather: 0.1, invert: false };

  test("ellipse: radial-gradient with the feather ramp ending at the radius", () => {
    const css = maskImageCss({ ...base, shape: "ellipse" } as MaskSpec)!;
    expect(css.maskImage).toContain("radial-gradient(ellipse 30.00% 20.00% at 50.00% 50.00%");
    expect(css.maskImage).toContain("#000 90.00%, transparent 100%"); // opaque core, soft rim
    expect(css.composite).toBeUndefined();
  });

  test("inverted ellipse swaps the stops (hole inside, opaque outside)", () => {
    const css = maskImageCss({ ...base, shape: "ellipse", invert: true } as MaskSpec)!;
    expect(css.maskImage).toContain("transparent 90.00%, #000 100%");
  });

  test("soft rect: two gradient bands intersected", () => {
    const css = maskImageCss({ ...base, shape: "rect" } as MaskSpec)!;
    expect(css.composite).toBe("intersect");
    expect(css.maskImage).toContain("linear-gradient(to right, transparent 20.00%, #000 30.00%, #000 70.00%, transparent 80.00%)");
    expect(css.maskImage).toContain("linear-gradient(to bottom, transparent 30.00%, #000 40.00%, #000 60.00%, transparent 70.00%)");
  });

  test("inverted rect: punched-hole SVG with evenodd, not gradients", () => {
    const css = maskImageCss({ ...base, shape: "rect", invert: true } as MaskSpec)!;
    expect(css.maskImage.startsWith('url("data:image/svg+xml,')).toBe(true);
    expect(decodeURIComponent(css.maskImage)).toContain("fill-rule='evenodd'");
    expect(css.composite).toBeUndefined();
  });

  test("path: SVG data-URI mask with gaussian feather; <3 points is null", () => {
    const m: MaskSpec = { ...base, shape: "path", points: [[0.1, 0.1], [0.9, 0.1], [0.5, 0.9]], smooth: false };
    const css = maskImageCss(m)!;
    const decoded = decodeURIComponent(css.maskImage);
    expect(decoded).toContain("feGaussianBlur stdDeviation='5.00'"); // feather 0.1 → σ = 0.1·50
    expect(decoded).toContain("M10,10L90,10L50,90Z");
    expect(maskImageCss({ ...m, points: [[0, 0], [1, 1]] })).toBeNull();
  });

  test("smooth path routes through Catmull-Rom cubics in the SVG d", () => {
    const m: MaskSpec = { ...base, shape: "path", points: [[0.1, 0.1], [0.9, 0.1], [0.5, 0.9]], smooth: true };
    const decoded = decodeURIComponent(maskImageCss(m)!.maskImage);
    expect(decoded).toContain("C"); // cubic segments present
    expect(decoded).not.toContain("L"); // no straight edges left
  });
});
