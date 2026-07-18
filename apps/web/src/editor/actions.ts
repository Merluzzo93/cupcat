// Editor action registry: every keyboard-triggerable action with its default combos, plus the
// pure resolver that maps a KeyboardEvent to an action id honoring user overrides. useKeyboard
// executes the actions; the Help dialog edits the overrides. Kept free of React/DOM side effects
// (except localStorage persistence) so the resolver is unit-testable.

export interface EditorAction {
  id: string;
  label: string;
  /** Normalized combo strings, e.g. "ctrl+z", "m", "shift+arrowleft". */
  defaultKeys: string[];
  category: string;
}

// Order matters twice: it's the Help-dialog display order, and the deterministic tie-breaker when
// two actions somehow claim the same combo (first in the list wins).
export const EDITOR_ACTIONS: EditorAction[] = [
  { id: "play_pause", label: "Play / pause", defaultKeys: ["space"], category: "Playback" },
  { id: "step_back", label: "Step back 1 frame", defaultKeys: ["arrowleft"], category: "Playback" },
  { id: "step_forward", label: "Step forward 1 frame", defaultKeys: ["arrowright"], category: "Playback" },
  { id: "step_back_big", label: "Step back 10 frames", defaultKeys: ["shift+arrowleft"], category: "Playback" },
  { id: "step_forward_big", label: "Step forward 10 frames", defaultKeys: ["shift+arrowright"], category: "Playback" },
  { id: "goto_start", label: "Go to start", defaultKeys: ["home"], category: "Playback" },
  { id: "goto_end", label: "Go to end", defaultKeys: ["end"], category: "Playback" },
  { id: "undo", label: "Undo", defaultKeys: ["ctrl+z"], category: "Editing" },
  { id: "copy", label: "Copy clips", defaultKeys: ["ctrl+c"], category: "Editing" },
  { id: "cut", label: "Cut clips", defaultKeys: ["ctrl+x"], category: "Editing" },
  { id: "paste", label: "Paste clips", defaultKeys: ["ctrl+v"], category: "Editing" },
  { id: "duplicate", label: "Duplicate clips", defaultKeys: ["ctrl+d"], category: "Editing" },
  { id: "delete", label: "Delete selection", defaultKeys: ["delete", "backspace"], category: "Editing" },
  { id: "split", label: "Split at playhead", defaultKeys: ["s"], category: "Editing" },
  { id: "command_palette", label: "Command palette", defaultKeys: ["ctrl+k"], category: "Tools" },
  { id: "tool_select", label: "Select tool", defaultKeys: ["v"], category: "Tools" },
  { id: "tool_blade", label: "Blade tool", defaultKeys: ["c"], category: "Tools" },
  { id: "add_marker", label: "Add marker at playhead", defaultKeys: ["m"], category: "Tools" },
  { id: "range_in", label: "Set range in-point", defaultKeys: ["i"], category: "Tools" },
  { id: "range_out", label: "Set range out-point", defaultKeys: ["o"], category: "Tools" },
  { id: "deselect", label: "Deselect all", defaultKeys: ["escape"], category: "Tools" },
];

/** actionId → replacement combo list. An entry fully replaces the action's defaults. */
export type KeyOverrides = Record<string, string[]>;

export const KEYBINDINGS_STORAGE_KEY = "cupcat.keybindings";

const MODIFIER_ORDER = ["ctrl", "alt", "shift"] as const;

/** Normalize a combo string: lowercase, canonical modifier order (ctrl, alt, shift), "meta"/"cmd"
 * folded into "ctrl" (the app treats Ctrl and Cmd identically). The space bar is always written
 * as the word "space" (comboFromEvent emits it that way). */
export function normalizeCombo(raw: string): string {
  const parts = raw
    .split("+")
    .map((p) => p.trim().toLowerCase())
    .filter(Boolean);
  const mods = new Set<string>();
  let key = "";
  for (const p of parts) {
    const name = p === "meta" || p === "cmd" ? "ctrl" : p;
    if ((MODIFIER_ORDER as readonly string[]).includes(name)) mods.add(name);
    else key = p;
  }
  const ordered = MODIFIER_ORDER.filter((m) => mods.has(m));
  return [...ordered, key].filter(Boolean).join("+");
}

/** The subset of KeyboardEvent the resolver needs (structural, so tests can pass plain objects). */
export interface KeyLike {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}

/** Event → normalized combo, or null for a pure-modifier press (holding Shift alone is not a combo). */
export function comboFromEvent(e: KeyLike): string | null {
  const k = e.key;
  if (k === "Control" || k === "Shift" || k === "Alt" || k === "Meta") return null;
  const mods: string[] = [];
  if (e.ctrlKey || e.metaKey) mods.push("ctrl"); // meta folds into ctrl (Windows-first app)
  if (e.altKey) mods.push("alt");
  if (e.shiftKey) mods.push("shift");
  const key = k === " " ? "space" : k.toLowerCase();
  return [...mods, key].join("+");
}

/** The combos currently bound to an action (override replaces defaults entirely). */
export function effectiveKeys(actionId: string, overrides: KeyOverrides): string[] {
  const o = overrides[actionId];
  if (o) return o.map(normalizeCombo);
  return EDITOR_ACTIONS.find((a) => a.id === actionId)?.defaultKeys ?? [];
}

/** combo → actionId map. Overridden actions claim their combos BEFORE defaults so a user binding
 * always beats a default that happens to use the same keys. */
function comboMap(overrides: KeyOverrides): Map<string, string> {
  const m = new Map<string, string>();
  for (const a of EDITOR_ACTIONS) {
    if (!overrides[a.id]) continue;
    for (const k of overrides[a.id]!) {
      const n = normalizeCombo(k);
      if (n && !m.has(n)) m.set(n, a.id);
    }
  }
  for (const a of EDITOR_ACTIONS) {
    if (overrides[a.id]) continue;
    for (const k of a.defaultKeys) if (!m.has(k)) m.set(k, a.id);
  }
  return m;
}

/** Resolve a combo to an action id. Exact match first; then progressively drop shift and alt (never
 * ctrl) so Shift+M still adds a marker and Ctrl+Shift+Z still undoes — mirroring the pre-registry
 * handlers, which ignored shift/alt on keys that didn't bind them explicitly. */
export function resolveCombo(combo: string, overrides: KeyOverrides): string | null {
  const m = comboMap(overrides);
  const n = normalizeCombo(combo);
  const exact = m.get(n);
  if (exact) return exact;
  const strip = (c: string, mod: string) =>
    c
      .split("+")
      .filter((p) => p !== mod)
      .join("+");
  for (const drop of [strip(n, "shift"), strip(n, "alt"), strip(strip(n, "shift"), "alt")]) {
    if (drop === n) continue;
    const hit = m.get(drop);
    if (hit) return hit;
  }
  return null;
}

/** KeyboardEvent → action id (or null when nothing is bound to it). */
export function resolveAction(e: KeyLike, overrides: KeyOverrides): string | null {
  const combo = comboFromEvent(e);
  return combo ? resolveCombo(combo, overrides) : null;
}

/** The OTHER action currently owning `combo` (exact match), or null. Used for conflict warnings. */
export function conflictOf(combo: string, exceptActionId: string, overrides: KeyOverrides): string | null {
  const n = normalizeCombo(combo);
  for (const a of EDITOR_ACTIONS) {
    if (a.id === exceptActionId) continue;
    if (effectiveKeys(a.id, overrides).includes(n)) return a.id;
  }
  return null;
}

// ─── persistence ─────────────────────────────────────────────────────────────
// Module cache so useKeyboard's per-keydown lookup never touches localStorage; the Help dialog's
// editor writes through saveOverrides which keeps the cache current.

let cached: KeyOverrides | null = null;

export function loadOverrides(): KeyOverrides {
  if (cached) return cached;
  try {
    const raw = typeof localStorage !== "undefined" ? localStorage.getItem(KEYBINDINGS_STORAGE_KEY) : null;
    const parsed: unknown = raw ? JSON.parse(raw) : {};
    const out: KeyOverrides = {};
    if (parsed && typeof parsed === "object") {
      for (const [id, keys] of Object.entries(parsed as Record<string, unknown>)) {
        if (Array.isArray(keys)) out[id] = keys.filter((k): k is string => typeof k === "string").map(normalizeCombo);
      }
    }
    cached = out;
  } catch {
    cached = {}; // corrupted storage → defaults, never a crash
  }
  return cached;
}

export function saveOverrides(o: KeyOverrides): void {
  cached = o;
  try {
    if (typeof localStorage !== "undefined") localStorage.setItem(KEYBINDINGS_STORAGE_KEY, JSON.stringify(o));
  } catch {
    // storage full/blocked — the in-memory cache still applies for this session
  }
}

// ─── display formatting ──────────────────────────────────────────────────────

const KEY_DISPLAY: Record<string, string> = {
  space: "Space",
  arrowleft: "←",
  arrowright: "→",
  arrowup: "↑",
  arrowdown: "↓",
  escape: "Esc",
  delete: "Del",
  backspace: "⌫",
};

/** "ctrl+shift+z" → "Ctrl+Shift+Z" (arrows/space/etc get friendly glyphs). */
export function formatCombo(combo: string): string {
  return combo
    .split("+")
    .map((p) => KEY_DISPLAY[p] ?? (p.length === 1 ? p.toUpperCase() : p.charAt(0).toUpperCase() + p.slice(1)))
    .join("+");
}
