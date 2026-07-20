// SVG value-vs-frame curve editor for one keyframed property of the selected clip. Lives in the
// Inspector's Keyframes section as an expandable "Curve" panel: draggable keyframe dots
// (horizontal = frame, clamped between neighbors; vertical = value), per-segment "✎" toggles that
// upgrade a segment to a custom cubic-bezier ease, and draggable bezier handles (CSS-timing-style,
// stored normalized on the keyframes). Every edit is written back through the existing
// set_keyframes replace flow (kfRows builders), so easing/handles of untouched rows survive.
// The pure mapping helpers below are exported for unit tests (KeyframeCurveEditor.test.ts).

import { useMemo, useRef, useState } from "react";
import { t } from "./i18n";
import { BEZIER_DEFAULT_IN, BEZIER_DEFAULT_OUT, segmentProgress } from "@cupcat/editor-core";
import type { AnimPair, Clip, Keyframe } from "@cupcat/editor-core";
import { pairRows, scalarRows } from "./kfRows";

export type CurveProp = "opacity" | "scale" | "position" | "rotation";

// ── pure geometry helpers (unit-tested) ──────────────────────────────────────

/** Padded value bounds for the vertical axis. Degenerate (flat) data gets a ±0.5 band so a flat
 * track still draws mid-panel instead of collapsing onto one pixel row. */
export function valueBounds(values: number[], padFrac = 0.1): { min: number; max: number } {
  if (values.length === 0) return { min: -0.5, max: 0.5 };
  let min = Math.min(...values);
  let max = Math.max(...values);
  if (max - min < 1e-9) {
    min -= 0.5;
    max += 0.5;
  }
  const pad = (max - min) * padFrac;
  return { min: min - pad, max: max + pad };
}

/** Clip-relative frame → x pixel inside a panel of width w with padX gutters. */
export function frameToX(frame: number, maxFrame: number, w: number, padX: number): number {
  const span = Math.max(1, maxFrame);
  return padX + (frame / span) * (w - 2 * padX);
}

/** Inverse of frameToX, rounded to a whole frame and clamped to the domain. */
export function xToFrame(x: number, maxFrame: number, w: number, padX: number): number {
  const span = Math.max(1, maxFrame);
  const f = Math.round(((x - padX) / Math.max(1, w - 2 * padX)) * span);
  return Math.min(maxFrame, Math.max(0, f));
}

/** Value → y pixel (SVG y grows downward, so max value maps to the top gutter). */
export function valueToY(v: number, min: number, max: number, h: number, padY: number): number {
  const t = (v - min) / Math.max(1e-9, max - min);
  return h - padY - t * (h - 2 * padY);
}

/** Inverse of valueToY. */
export function yToValue(y: number, min: number, max: number, h: number, padY: number): number {
  const t = (h - padY - y) / Math.max(1, h - 2 * padY);
  return min + t * (max - min);
}

/** Frame bounds a keyframe at index i may be dragged to: strictly between its neighbors (so the
 * track order never flips) and inside [0, maxFrame]. Endpoints of the domain stay reachable. */
export function neighborClamp(frames: number[], i: number, maxFrame: number): [number, number] {
  const lo = i > 0 ? frames[i - 1]! + 1 : 0;
  const hi = i < frames.length - 1 ? frames[i + 1]! - 1 : maxFrame;
  return [lo, hi];
}

/** Absolute (frame, value) of a normalized bezier handle attached to the segment k1→k2. */
export function handlePoint(
  k1: { frame: number; value: number },
  k2: { frame: number; value: number },
  h: readonly [number, number],
): { frame: number; value: number } {
  return { frame: k1.frame + h[0] * (k2.frame - k1.frame), value: k1.value + h[1] * (k2.value - k1.value) };
}

/** Inverse of handlePoint: absolute point → normalized [x, y] handle. Handle x is clamped to 0..1
 * (time must stay inside the segment); y is unclamped (overshoot). A flat segment (zero value
 * delta) can't express a vertical offset — y falls back to the neutral 0. */
export function pointToHandle(
  k1: { frame: number; value: number },
  k2: { frame: number; value: number },
  frame: number,
  value: number,
): [number, number] {
  const df = k2.frame - k1.frame;
  const dv = k2.value - k1.value;
  const hx = Math.min(1, Math.max(0, df !== 0 ? (frame - k1.frame) / df : 0));
  const hy = Math.abs(dv) > 1e-9 ? (value - k1.value) / dv : 0;
  return [hx, hy];
}

// ── component ────────────────────────────────────────────────────────────────

const H = 120; // panel height (px)
const PAD_X = 10;
const PAD_Y = 12;
const CURVE_SAMPLES = 24; // per segment — plenty for a ~300px panel

type Chan = "a" | "b";
type AnyKf = Keyframe<number> | Keyframe<AnimPair>;

function isPairProp(property: CurveProp): boolean {
  return property === "scale" || property === "position";
}

function chanValue(k: AnyKf, pair: boolean, chan: Chan): number {
  return pair ? (k.value as AnimPair)[chan] : (k.value as number);
}

export function KeyframeCurveEditor({
  clip,
  property,
  onCommit,
}: {
  clip: Clip;
  property: CurveProp;
  onCommit: (rows: unknown[][]) => void;
}) {
  const pair = isPairProp(property);
  const track =
    property === "opacity" ? clip.opacityTrack
    : property === "rotation" ? clip.rotationTrack
    : property === "scale" ? clip.scaleTrack
    : clip.positionTrack;

  const [chan, setChan] = useState<Chan>("a");
  // Local working copy while a drag is in flight; null = mirror the store. Committing on
  // pointer-up (not per-move) keeps set_keyframes traffic to one replace per gesture.
  const [draft, setDraft] = useState<AnyKf[] | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(300);
  const dragRef = useRef<
    | { kind: "kf"; index: number }
    | { kind: "handle"; seg: number; end: "out" | "in" }
    | null
  >(null);

  // Measured panel width → crisp 1:1 pixel mapping (no viewBox stretching of the dots).
  const measure = (el: HTMLDivElement | null) => {
    (wrapRef as React.MutableRefObject<HTMLDivElement | null>).current = el;
    if (el && Math.abs(el.clientWidth - width) > 1) setWidth(el.clientWidth);
  };

  const kfs: AnyKf[] = draft ?? (track?.keyframes as AnyKf[] | undefined) ?? [];
  const maxFrame = Math.max(1, clip.durationFrames - 1, ...kfs.map((k) => k.frame));

  const bounds = useMemo(() => {
    const vals: number[] = [];
    for (const k of kfs) {
      if (pair) {
        vals.push((k.value as AnimPair).a, (k.value as AnimPair).b);
      } else {
        vals.push(k.value as number);
      }
    }
    // Include bezier handle extremes of the ACTIVE channel so overshoot handles stay reachable.
    for (let i = 0; i < kfs.length - 1; i++) {
      const k1 = kfs[i]!;
      const k2 = kfs[i + 1]!;
      if (k1.interpolationOut !== "bezier") continue;
      const p1 = { frame: k1.frame, value: chanValue(k1, pair, chan) };
      const p2 = { frame: k2.frame, value: chanValue(k2, pair, chan) };
      vals.push(handlePoint(p1, p2, k1.bezierOut ?? BEZIER_DEFAULT_OUT).value);
      vals.push(handlePoint(p1, p2, k2.bezierIn ?? BEZIER_DEFAULT_IN).value);
    }
    return valueBounds(vals);
  }, [kfs, pair, chan]);

  const fx = (frame: number) => frameToX(frame, maxFrame, width, PAD_X);
  const vy = (v: number) => valueToY(v, bounds.min, bounds.max, H, PAD_Y);

  const linePath = (c: Chan): string => {
    if (kfs.length === 0) return "";
    const pts: string[] = [];
    for (let i = 0; i < kfs.length - 1; i++) {
      const k1 = kfs[i]!;
      const k2 = kfs[i + 1]!;
      const v1 = chanValue(k1, pair, c);
      const v2 = chanValue(k2, pair, c);
      for (let s = 0; s <= CURVE_SAMPLES; s++) {
        const raw = s / CURVE_SAMPLES;
        // segmentProgress is the SAME easing math preview sampling uses — the drawn curve is
        // exactly what plays back.
        const prog = segmentProgress(k1 as Keyframe<number>, k2 as Keyframe<number>, raw);
        const frame = k1.frame + raw * (k2.frame - k1.frame);
        pts.push(`${fx(frame).toFixed(1)},${vy(v1 + prog * (v2 - v1)).toFixed(1)}`);
      }
    }
    if (kfs.length === 1) {
      const v = chanValue(kfs[0]!, pair, c);
      return `M${PAD_X},${vy(v).toFixed(1)} L${width - PAD_X},${vy(v).toFixed(1)}`;
    }
    return `M${pts[0]} L${pts.slice(1).join(" ")}`;
  };

  const commit = (next: AnyKf[]) => {
    const rows = pair
      ? pairRows(next as Keyframe<AnimPair>[])
      : scalarRows(next as Keyframe<number>[]);
    onCommit(rows as unknown[][]);
  };

  const svgPoint = (e: React.PointerEvent): { x: number; y: number } => {
    const rect = (e.currentTarget as SVGElement).closest("svg")!.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  };

  const clampValue = (v: number): number => (property === "opacity" ? Math.min(1, Math.max(0, v)) : v);

  const onDragMove = (e: React.PointerEvent) => {
    const drag = dragRef.current;
    if (!drag) return;
    const { x, y } = svgPoint(e);
    const base = draft ?? (track?.keyframes as AnyKf[] | undefined) ?? [];
    const next = base.map((k) => ({ ...k, value: (pair ? { ...(k.value as AnimPair) } : k.value) as never })) as AnyKf[];
    if (drag.kind === "kf") {
      const k = next[drag.index]!;
      const [lo, hi] = neighborClamp(next.map((n) => n.frame), drag.index, maxFrame);
      k.frame = Math.min(hi, Math.max(lo, xToFrame(x, maxFrame, width, PAD_X)));
      const v = clampValue(yToValue(y, bounds.min, bounds.max, H, PAD_Y));
      if (pair) (k.value as AnimPair)[chan] = v;
      else (k as Keyframe<number>).value = v;
    } else {
      const k1 = next[drag.seg]!;
      const k2 = next[drag.seg + 1]!;
      const p1 = { frame: k1.frame, value: chanValue(k1, pair, chan) };
      const p2 = { frame: k2.frame, value: chanValue(k2, pair, chan) };
      const frame = ((x - PAD_X) / Math.max(1, width - 2 * PAD_X)) * maxFrame; // fractional — handles are continuous
      const value = yToValue(y, bounds.min, bounds.max, H, PAD_Y);
      const h = pointToHandle(p1, p2, frame, value);
      if (drag.end === "out") k1.bezierOut = h;
      else k2.bezierIn = h;
    }
    setDraft(next);
  };

  const onDragEnd = (e: React.PointerEvent) => {
    if (!dragRef.current) return;
    dragRef.current = null;
    (e.currentTarget as Element).releasePointerCapture?.(e.pointerId);
    if (draft) {
      commit(draft);
      setDraft(null);
    }
  };

  const startDrag = (e: React.PointerEvent, d: NonNullable<typeof dragRef.current>) => {
    e.preventDefault();
    e.stopPropagation();
    dragRef.current = d;
    (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
  };

  /** Upgrade segment i to a custom bezier, seeding handles that REPRODUCE its current shape
   * (smooth → the smoothstep-equivalent defaults; linear → collinear handles; hold keeps the
   * defaults — a step can't be expressed as a single cubic). */
  const makeBezier = (i: number) => {
    const base = (track?.keyframes as AnyKf[] | undefined) ?? [];
    const next = base.map((k) => ({ ...k })) as AnyKf[];
    const k1 = next[i]!;
    const k2 = next[i + 1]!;
    if (k1.interpolationOut === "linear") {
      k1.bezierOut = [1 / 3, 1 / 3];
      k2.bezierIn = [2 / 3, 2 / 3];
    } else {
      k1.bezierOut = [...BEZIER_DEFAULT_OUT] as [number, number];
      k2.bezierIn = [...BEZIER_DEFAULT_IN] as [number, number];
    }
    k1.interpolationOut = "bezier";
    commit(next);
  };

  if (!track || track.keyframes.length === 0) {
    return <div className="px-1 py-2 text-[9px] text-neutral-600">No keyframes yet — add one with ◆ above, then shape its curve here.</div>;
  }

  const dimChan: Chan = chan === "a" ? "b" : "a";
  const chanLabels: Record<Chan, string> = property === "position" ? { a: "x", b: "y" } : { a: "w", b: "h" };

  return (
    <div ref={measure} className="flex w-full flex-col gap-1">
      {pair && (
        <div className="flex items-center gap-1">
          <span className="text-[9px] text-neutral-600">{t("kf.channel")}</span>
          {(["a", "b"] as const).map((c) => (
            <button
              key={c}
              onClick={() => setChan(c)}
              className={`rounded border px-1.5 py-0.5 text-[9px] font-medium transition-colors ${
                chan === c
                  ? "border-sky-600 bg-sky-900/40 text-sky-300"
                  : "border-neutral-700 bg-neutral-900 text-neutral-400 hover:bg-neutral-800"
              }`}
            >
              {chanLabels[c]}
            </button>
          ))}
        </div>
      )}
      <svg
        width={width}
        height={H}
        className="rounded border border-neutral-800 bg-neutral-950 touch-none select-none"
        onPointerMove={onDragMove}
        onPointerUp={onDragEnd}
        onPointerLeave={onDragEnd}
      >
        {/* mid gridline */}
        <line x1={PAD_X} y1={H / 2} x2={width - PAD_X} y2={H / 2} stroke="#262626" strokeDasharray="3 3" />
        {/* inactive channel, dimmed */}
        {pair && <path d={linePath(dimChan)} fill="none" stroke="#404040" strokeWidth={1} />}
        {/* active curve */}
        <path d={linePath(chan)} fill="none" stroke="#38bdf8" strokeWidth={1.5} />
        {/* per-segment bezier toggles + handles */}
        {kfs.slice(0, -1).map((k1, i) => {
          const k2 = kfs[i + 1]!;
          const v1 = chanValue(k1, pair, chan);
          const v2 = chanValue(k2, pair, chan);
          const midFrame = (k1.frame + k2.frame) / 2;
          const midProg = segmentProgress(k1 as Keyframe<number>, k2 as Keyframe<number>, 0.5);
          if (k1.interpolationOut !== "bezier") {
            return (
              <g key={`seg${i}`} className="cursor-pointer" onClick={() => makeBezier(i)}>
                <circle cx={fx(midFrame)} cy={vy(v1 + midProg * (v2 - v1))} r={7} fill="transparent" />
                <text
                  x={fx(midFrame)}
                  y={vy(v1 + midProg * (v2 - v1)) - 5}
                  textAnchor="middle"
                  fontSize={8}
                  fill="#737373"
                  className="hover:fill-sky-300"
                >
                  ✎
                </text>
                <title>{t("kf.customBezier")}</title>
              </g>
            );
          }
          const p1 = handlePoint({ frame: k1.frame, value: v1 }, { frame: k2.frame, value: v2 }, k1.bezierOut ?? BEZIER_DEFAULT_OUT);
          const p2 = handlePoint({ frame: k1.frame, value: v1 }, { frame: k2.frame, value: v2 }, k2.bezierIn ?? BEZIER_DEFAULT_IN);
          return (
            <g key={`seg${i}`}>
              <line x1={fx(k1.frame)} y1={vy(v1)} x2={fx(p1.frame)} y2={vy(p1.value)} stroke="#f59e0b" strokeWidth={1} opacity={0.6} />
              <line x1={fx(k2.frame)} y1={vy(v2)} x2={fx(p2.frame)} y2={vy(p2.value)} stroke="#f59e0b" strokeWidth={1} opacity={0.6} />
              <circle
                cx={fx(p1.frame)}
                cy={vy(p1.value)}
                r={4}
                fill="#f59e0b"
                className="cursor-grab"
                onPointerDown={(e) => startDrag(e, { kind: "handle", seg: i, end: "out" })}
              />
              <circle
                cx={fx(p2.frame)}
                cy={vy(p2.value)}
                r={4}
                fill="#f59e0b"
                className="cursor-grab"
                onPointerDown={(e) => startDrag(e, { kind: "handle", seg: i, end: "in" })}
              />
            </g>
          );
        })}
        {/* keyframe dots */}
        {kfs.map((k, i) => (
          <circle
            key={`kf${i}`}
            cx={fx(k.frame)}
            cy={vy(chanValue(k, pair, chan))}
            r={4.5}
            fill="#0a0a0a"
            stroke="#38bdf8"
            strokeWidth={1.5}
            className="cursor-grab"
            onPointerDown={(e) => startDrag(e, { kind: "kf", index: i })}
          >
            <title>{`frame ${k.frame} · ${chanValue(k, pair, chan).toFixed(3)}`}</title>
          </circle>
        ))}
      </svg>
      <div className="text-[8px] text-neutral-600">
        Drag dots to move keyframes, ✎ to give a segment a custom curve, amber handles to shape it.
      </div>
    </div>
  );
}
