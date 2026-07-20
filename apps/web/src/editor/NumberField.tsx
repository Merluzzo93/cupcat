// Numeric inspector field with label-drag scrubbing and inline math. Dragging horizontally on the
// label scrubs the value (Shift = ×0.1 fine); typing accepts safe arithmetic ("1920/2", "0.5+0.25")
// evaluated by mathExpr.ts — junk keeps the old value. Enter/blur commits, Esc reverts.

import { useEffect, useRef, useState } from "react";
import { t } from "./i18n";
import type { KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent } from "react";
import { evaluateExpr } from "./mathExpr";

interface NumberFieldProps {
  value: number;
  onCommit: (v: number) => void;
  min: number;
  max: number;
  step?: number;
  label?: string;
  /** true = the transform/crop row look (px-1.5 py-0.5); false = the full-width field look. */
  compact?: boolean;
}

/** Round away float noise (0.30000000000000004 → 0.3): to the step's precision, else 4 decimals. */
function tidy(n: number, step?: number): number {
  const decimals = step ? (String(step).split(".")[1]?.length ?? 0) : 4;
  return Number(n.toFixed(decimals));
}

export function NumberField({ value, onCommit, min, max, step, label, compact = false }: NumberFieldProps) {
  const [local, setLocal] = useState(String(value));
  const reverting = useRef(false);
  useEffect(() => {
    setLocal(String(value));
  }, [value]);

  const clamp = (n: number) => Math.min(max, Math.max(min, n));

  const commitText = (text: string) => {
    const n = evaluateExpr(text);
    if (n === null) {
      setLocal(String(value)); // junk → keep the old value
      return;
    }
    const v = tidy(clamp(n), step);
    setLocal(String(v));
    if (v !== value) onCommit(v);
  };

  const onKeyDown = (e: ReactKeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") commitText(e.currentTarget.value);
    else if (e.key === "Escape") {
      reverting.current = true; // blur below must NOT commit the reverted text
      setLocal(String(value));
      e.currentTarget.blur();
    }
  };

  // ── label scrubbing ─────────────────────────────────────────────────────────
  // Pointer capture on the label; each px of horizontal drag moves the value by `step` (or a
  // 1/300th of the range when no step is given). Live commits are throttled like the canvas
  // overlays (~30 fps) so the bridge isn't flooded; pointer-up sends the final value.
  const scrub = useRef<{ startX: number; startValue: number; lastSent: number; lastValue: number } | null>(null);
  const perPx = step ?? (max - min) / 300;

  const onScrubDown = (e: ReactPointerEvent<HTMLSpanElement>) => {
    e.preventDefault();
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    scrub.current = { startX: e.clientX, startValue: value, lastSent: 0, lastValue: value };
  };
  const onScrubMove = (e: ReactPointerEvent<HTMLSpanElement>) => {
    const s = scrub.current;
    if (!s) return;
    const fine = e.shiftKey ? 0.1 : 1;
    const v = tidy(clamp(s.startValue + (e.clientX - s.startX) * perPx * fine), step);
    s.lastValue = v;
    setLocal(String(v));
    const now = Date.now();
    if (now - s.lastSent > 33) {
      s.lastSent = now;
      onCommit(v);
    }
  };
  const onScrubUp = () => {
    const s = scrub.current;
    if (!s) return;
    scrub.current = null;
    if (s.lastValue !== value) onCommit(s.lastValue);
  };

  return (
    <label className={`flex flex-1 flex-col ${compact ? "gap-0.5" : "gap-1"}`}>
      {label != null && (
        <span
          onPointerDown={onScrubDown}
          onPointerMove={onScrubMove}
          onPointerUp={onScrubUp}
          onPointerCancel={onScrubUp}
          title={t("nf.scrubHint")}
          style={{ touchAction: "none" }}
          className={`cursor-ew-resize select-none text-[10px] ${compact ? "text-neutral-500" : "text-neutral-400"}`}
        >
          {label}
        </span>
      )}
      <input
        type="text"
        inputMode="decimal"
        value={local}
        onChange={(e) => setLocal(e.target.value)}
        onBlur={(e) => {
          if (reverting.current) {
            reverting.current = false;
            return;
          }
          commitText(e.target.value);
        }}
        onKeyDown={onKeyDown}
        className={
          compact
            ? "w-full rounded border border-neutral-800 bg-neutral-900 px-1.5 py-0.5 text-[11px] text-neutral-200 outline-none focus:border-sky-600"
            : "rounded-md border border-neutral-800 bg-neutral-900 px-2 py-1 text-[11px] text-neutral-200 outline-none focus:border-sky-600"
        }
      />
    </label>
  );
}
