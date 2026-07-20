// Editable shortcuts list for the Help dialog. Each row shows an action and its current combos as
// a button; clicking it captures the next key combo. Conflicts warn and need an explicit confirm
// (which frees the combo from its previous owner). Overrides persist via actions.ts → localStorage.

import { useEffect, useState } from "react";
import { t } from "./i18n";
import {
  comboFromEvent,
  conflictOf,
  EDITOR_ACTIONS,
  effectiveKeys,
  formatCombo,
  loadOverrides,
  saveOverrides,
} from "./actions";
import type { KeyOverrides } from "./actions";

interface PendingConflict {
  actionId: string;
  combo: string;
  conflictId: string;
}

export function ShortcutsEditor() {
  const [overrides, setOverrides] = useState<KeyOverrides>(() => ({ ...loadOverrides() }));
  const [capturing, setCapturing] = useState<string | null>(null); // actionId waiting for keys
  const [pending, setPending] = useState<PendingConflict | null>(null);

  const apply = (next: KeyOverrides) => {
    setOverrides(next);
    saveOverrides(next);
  };

  const assign = (actionId: string, combo: string, freeFrom?: string) => {
    const next = { ...overrides };
    if (freeFrom) {
      // The confirmed override steals the combo: the previous owner keeps its OTHER keys only.
      next[freeFrom] = effectiveKeys(freeFrom, overrides).filter((k) => k !== combo);
    }
    next[actionId] = [combo];
    apply(next);
  };

  // Capture mode: one window-level keydown (capture phase) grabs the next combo. Esc cancels.
  useEffect(() => {
    if (!capturing) return;
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      const combo = comboFromEvent(e);
      if (!combo) return; // a lone modifier — keep waiting for the full combo
      setCapturing(null);
      if (combo === "escape") return; // Esc = cancel capture (rebind Deselect via Reset instead)
      const conflictId = conflictOf(combo, capturing, overrides);
      if (conflictId) setPending({ actionId: capturing, combo, conflictId });
      else assign(capturing, combo);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [capturing, overrides]);

  const label = (id: string) => EDITOR_ACTIONS.find((a) => a.id === id)?.label ?? id;
  const categories = [...new Set(EDITOR_ACTIONS.map((a) => a.category))];
  const hasOverrides = Object.keys(overrides).length > 0;

  return (
    <div className="flex flex-col gap-1">
      {categories.map((cat) => (
        <div key={cat}>
          <div className="mb-0.5 mt-1 text-[10px] font-medium uppercase tracking-wide text-neutral-600">{cat}</div>
          {EDITOR_ACTIONS.filter((a) => a.category === cat).map((a) => {
            const keys = effectiveKeys(a.id, overrides);
            const customized = !!overrides[a.id];
            return (
              <div key={a.id} className="flex items-center gap-1.5 py-0.5">
                <span className="flex-1 truncate text-neutral-300">{a.label}</span>
                <button
                  onClick={() => {
                    setPending(null);
                    setCapturing(capturing === a.id ? null : a.id);
                  }}
                  title={t("sc.pressCombo")}
                  className={`min-w-[72px] rounded border px-1.5 py-0.5 font-mono text-[10px] transition-colors ${
                    capturing === a.id
                      ? "border-sky-600 bg-sky-900/40 text-sky-300"
                      : "border-neutral-700 bg-neutral-950 text-neutral-200 hover:bg-neutral-800"
                  }`}
                >
                  {capturing === a.id ? "press keys…" : keys.map(formatCombo).join(" / ") || "—"}
                </button>
                <button
                  onClick={() => {
                    const next = { ...overrides };
                    delete next[a.id];
                    apply(next);
                  }}
                  disabled={!customized}
                  title={t("sc.reset")}
                  className="rounded px-1 py-0.5 text-[10px] text-neutral-600 transition-colors hover:bg-neutral-800 hover:text-neutral-300 disabled:invisible"
                >
                  ↺
                </button>
              </div>
            );
          })}
        </div>
      ))}

      {pending && (
        <div className="mt-1 flex flex-wrap items-center gap-2 rounded border border-amber-800 bg-amber-950/40 px-2 py-1.5 text-[11px] text-amber-200">
          <span>
            <span className="font-mono">{formatCombo(pending.combo)}</span> is already used by "{label(pending.conflictId)}".
          </span>
          <button
            onClick={() => {
              assign(pending.actionId, pending.combo, pending.conflictId);
              setPending(null);
            }}
            className="rounded border border-amber-700 px-1.5 py-0.5 font-medium hover:bg-amber-900/50"
          >
            Use anyway
          </button>
          <button onClick={() => setPending(null)} className="rounded px-1.5 py-0.5 text-amber-300/70 hover:bg-amber-900/40">
            Cancel
          </button>
        </div>
      )}

      <button
        onClick={() => {
          setPending(null);
          setCapturing(null);
          apply({});
        }}
        disabled={!hasOverrides}
        className="mt-1 self-start rounded border border-neutral-700 px-2 py-0.5 text-[10px] text-neutral-400 transition-colors hover:bg-neutral-800 hover:text-neutral-200 disabled:opacity-30"
      >
        Reset all shortcuts
      </button>
    </div>
  );
}
