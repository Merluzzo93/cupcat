// Resolver tests for the keyboard action registry: combo parsing/normalization, default
// resolution, override precedence, conflict detection, and modifier order/extras handling.
import { describe, expect, test } from "vitest";
import {
  comboFromEvent,
  conflictOf,
  effectiveKeys,
  formatCombo,
  normalizeCombo,
  resolveAction,
  resolveCombo,
} from "./actions";
import type { KeyLike } from "./actions";

function ev(key: string, mods: Partial<Omit<KeyLike, "key">> = {}): KeyLike {
  return { key, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...mods };
}

describe("normalizeCombo", () => {
  test("canonicalizes modifier order and case", () => {
    expect(normalizeCombo("Shift+Ctrl+Z")).toBe("ctrl+shift+z");
    expect(normalizeCombo("ALT+shift+ArrowLeft")).toBe("alt+shift+arrowleft");
  });

  test("meta/cmd fold into ctrl", () => {
    expect(normalizeCombo("meta+space")).toBe("ctrl+space");
    expect(normalizeCombo("cmd+k")).toBe("ctrl+k");
  });
});

describe("comboFromEvent", () => {
  test("maps space, arrows and meta→ctrl", () => {
    expect(comboFromEvent(ev(" "))).toBe("space");
    expect(comboFromEvent(ev("ArrowLeft", { shiftKey: true }))).toBe("shift+arrowleft");
    expect(comboFromEvent(ev("z", { metaKey: true }))).toBe("ctrl+z");
  });

  test("a pure modifier press is not a combo", () => {
    expect(comboFromEvent(ev("Shift", { shiftKey: true }))).toBeNull();
    expect(comboFromEvent(ev("Control", { ctrlKey: true }))).toBeNull();
  });
});

describe("default resolution", () => {
  test("ctrl+z resolves undo; bare letters resolve tools/markers", () => {
    expect(resolveAction(ev("z", { ctrlKey: true }), {})).toBe("undo");
    expect(resolveAction(ev("m"), {})).toBe("add_marker");
    expect(resolveAction(ev("Escape"), {})).toBe("deselect");
  });

  test("shift+arrow resolves the big step, bare arrow the small one", () => {
    expect(resolveAction(ev("ArrowLeft", { shiftKey: true }), {})).toBe("step_back_big");
    expect(resolveAction(ev("ArrowLeft"), {})).toBe("step_back");
  });

  test("extra shift falls back on keys that don't bind it (Shift+M still adds a marker)", () => {
    expect(resolveAction(ev("M", { shiftKey: true }), {})).toBe("add_marker");
    expect(resolveAction(ev("Z", { ctrlKey: true, shiftKey: true }), {})).toBe("undo");
  });

  test("extra alt falls back too, but ctrl is never dropped", () => {
    expect(resolveAction(ev("m", { altKey: true }), {})).toBe("add_marker");
    // ctrl+m is unbound and must NOT fall back to the bare-key marker action
    expect(resolveAction(ev("m", { ctrlKey: true }), {})).toBeNull();
  });

  test("unbound keys resolve to nothing", () => {
    expect(resolveAction(ev("q"), {})).toBeNull();
    expect(resolveAction(ev("F5"), {})).toBeNull();
  });
});

describe("override precedence", () => {
  test("an override replaces the action's defaults entirely", () => {
    const o = { play_pause: ["p"] };
    expect(resolveCombo("p", o)).toBe("play_pause");
    expect(resolveCombo("space", o)).toBeNull(); // old default no longer fires
    expect(effectiveKeys("play_pause", o)).toEqual(["p"]);
  });

  test("an override claiming another action's default wins over that default", () => {
    const o = { add_marker: ["ctrl+z"] };
    expect(resolveCombo("ctrl+z", o)).toBe("add_marker"); // user intent beats the undo default
  });

  test("resolver is insensitive to the override's written modifier order", () => {
    const o = { split: ["shift+ctrl+s"] };
    expect(resolveAction(ev("s", { ctrlKey: true, shiftKey: true }), o)).toBe("split");
  });
});

describe("conflictOf", () => {
  test("reports the action owning a combo, honoring overrides", () => {
    expect(conflictOf("m", "play_pause", {})).toBe("add_marker");
    expect(conflictOf("m", "add_marker", {})).toBeNull(); // no self-conflict
    expect(conflictOf("m", "play_pause", { add_marker: ["n"] })).toBeNull(); // freed by override
  });
});

describe("formatCombo", () => {
  test("renders friendly key names", () => {
    expect(formatCombo("ctrl+shift+z")).toBe("Ctrl+Shift+Z");
    expect(formatCombo("space")).toBe("Space");
    expect(formatCombo("shift+arrowleft")).toBe("Shift+←");
  });
});
