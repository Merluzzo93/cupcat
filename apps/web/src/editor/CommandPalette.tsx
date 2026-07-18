// Ctrl+K command palette. Fuzzy-matches editor actions, panel toggles, and library media by name;
// anything that doesn't match a command is sent to the assistant as a chat message (the "type
// anything" fallback that makes the whole app feel AI-native). Opening is handled two ways so it
// works everywhere: useKeyboard maps the `command_palette` action when focus is on the canvas, and
// this component listens globally to also catch Ctrl+K while the chat composer is focused.

import { useEffect, useMemo, useRef, useState } from "react";
import { loadOverrides, resolveAction } from "./actions";
import { newChat, sendChat, sendCommand, ui, useEditor } from "./store";

interface Command {
  id: string;
  label: string;
  hint?: string;
  group: string;
  run: () => void;
}

/** Subsequence fuzzy score: all query chars must appear in order. Lower = better; null = no match.
 * Consecutive and word-start matches are rewarded so "refr" ranks "Reframe" above "Reference frame". */
function fuzzyScore(query: string, text: string): number | null {
  if (!query) return 0;
  const q = query.toLowerCase();
  const t = text.toLowerCase();
  let qi = 0;
  let score = 0;
  let prevMatch = -2;
  for (let ti = 0; ti < t.length && qi < q.length; ti++) {
    if (t[ti] === q[qi]) {
      score += ti === prevMatch + 1 ? 0 : ti === 0 || /\s/.test(t[ti - 1]) ? 1 : 3;
      prevMatch = ti;
      qi++;
    }
  }
  return qi === q.length ? score + (t.length - q.length) * 0.05 : null;
}

export function CommandPalette() {
  const { paletteOpen, project } = useEditor();
  const [query, setQuery] = useState("");
  const [idx, setIdx] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  // Global Ctrl+K: catch it even while the chat composer (an input) has focus — useKeyboard bails
  // on input targets, so it can't. Honors user key overrides via resolveAction.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const tag = target?.tagName?.toLowerCase();
      const inField = !!tag && (["input", "textarea", "select"].includes(tag) || target!.isContentEditable);
      if (inField && resolveAction(e, loadOverrides()) === "command_palette") {
        e.preventDefault();
        ui.setPalette(true);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    if (paletteOpen) {
      setQuery("");
      setIdx(0);
      setTimeout(() => inputRef.current?.focus(), 20);
    }
  }, [paletteOpen]);

  const close = () => ui.setPalette(false);

  const commands = useMemo<Command[]>(() => {
    const list: Command[] = [
      { id: "new_chat", label: "New assistant conversation", group: "Assistant", run: () => void newChat() },
      { id: "undo", label: "Undo", group: "Edit", run: () => sendCommand("undo", {}) },
      { id: "redo", label: "Redo", group: "Edit", run: () => sendCommand("redo", {}) },
      { id: "split", label: "Split clip at playhead", group: "Edit", run: () => ui.setTool("blade") },
      { id: "tool_select", label: "Select tool", group: "Tools", run: () => ui.setTool("select") },
      { id: "tool_blade", label: "Blade tool", group: "Tools", run: () => ui.setTool("blade") },
      { id: "add_marker", label: "Add marker at playhead", group: "Tools", run: () => sendCommand("add_marker", { frame: 0 }) },
      { id: "panel_chat", label: "Toggle assistant panel", group: "View", run: () => ui.togglePanel("chat") },
      { id: "panel_media", label: "Toggle media library", group: "View", run: () => ui.togglePanel("media") },
      { id: "panel_inspector", label: "Toggle inspector", group: "View", run: () => ui.togglePanel("inspector") },
      { id: "max_preview", label: "Maximize preview", group: "View", run: () => ui.setMaximized("preview") },
      { id: "max_timeline", label: "Maximize timeline", group: "View", run: () => ui.setMaximized("timeline") },
    ];
    // Library media → open as a source tab
    for (const m of project?.media ?? []) {
      if (m.generationStatus.kind !== "none") continue;
      list.push({ id: `media_${m.id}`, label: m.name, hint: `Open ${m.type}`, group: "Media", run: () => ui.openSource(m.id) });
    }
    return list;
  }, [project]);

  const results = useMemo(() => {
    const q = query.trim();
    if (!q) return commands.slice(0, 40);
    return commands
      .map((c) => ({ c, s: fuzzyScore(q, c.label + " " + c.group) }))
      .filter((r): r is { c: Command; s: number } => r.s !== null)
      .sort((a, b) => a.s - b.s)
      .slice(0, 40)
      .map((r) => r.c);
  }, [query, commands]);

  useEffect(() => {
    setIdx((i) => Math.min(i, Math.max(0, results.length - 1)));
  }, [results.length]);

  if (!paletteOpen) return null;

  const askAssistant = () => {
    const text = query.trim();
    if (!text) return;
    close();
    void sendChat(text);
  };

  const runAt = (i: number) => {
    const cmd = results[i];
    if (cmd) {
      close();
      cmd.run();
    } else {
      askAssistant();
    }
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      close();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      setIdx((i) => Math.min(results.length, i + 1)); // results.length = the "ask assistant" row
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setIdx((i) => Math.max(0, i - 1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      runAt(idx);
    }
  };

  const hasQuery = query.trim().length > 0;
  // Group headers for display
  let lastGroup = "";

  return (
    <div className="fixed inset-0 z-[100] flex items-start justify-center bg-black/40 pt-[12vh]" onClick={close}>
      <div
        className="w-[560px] max-w-[90vw] overflow-hidden rounded-xl border border-neutral-700 bg-neutral-900 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <input
          ref={inputRef}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder="Type a command, a media name, or a request for the assistant…"
          className="w-full border-b border-neutral-800 bg-transparent px-4 py-3 text-sm text-neutral-100 outline-none placeholder:text-neutral-500"
        />
        <div className="max-h-[52vh] overflow-y-auto py-1">
          {results.map((c, i) => {
            const showGroup = c.group !== lastGroup;
            lastGroup = c.group;
            return (
              <div key={c.id}>
                {showGroup && (
                  <div className="px-4 pb-0.5 pt-2 text-[10px] font-medium uppercase tracking-wide text-neutral-500">{c.group}</div>
                )}
                <button
                  type="button"
                  onMouseEnter={() => setIdx(i)}
                  onClick={() => runAt(i)}
                  className={`flex w-full items-center gap-2 px-4 py-1.5 text-left text-sm ${
                    i === idx ? "bg-neutral-700/70 text-neutral-100" : "text-neutral-300"
                  }`}
                >
                  <span className="truncate">{c.label}</span>
                  {c.hint && <span className="ml-auto shrink-0 text-[11px] text-neutral-500">{c.hint}</span>}
                </button>
              </div>
            );
          })}
          {/* Fallback row: send the typed text to the assistant */}
          {hasQuery && (
            <>
              <div className="px-4 pb-0.5 pt-2 text-[10px] font-medium uppercase tracking-wide text-neutral-500">Assistant</div>
              <button
                type="button"
                onMouseEnter={() => setIdx(results.length)}
                onClick={() => askAssistant()}
                className={`flex w-full items-center gap-2 px-4 py-1.5 text-left text-sm ${
                  idx === results.length ? "bg-violet-600/40 text-neutral-100" : "text-neutral-300"
                }`}
              >
                <span aria-hidden>✨</span>
                <span className="truncate">
                  Ask the assistant: “<span className="text-neutral-100">{query.trim()}</span>”
                </span>
              </button>
            </>
          )}
          {!hasQuery && results.length === 0 && (
            <div className="px-4 py-3 text-sm text-neutral-500">No commands.</div>
          )}
        </div>
        <div className="flex items-center gap-3 border-t border-neutral-800 px-4 py-1.5 text-[10px] text-neutral-500">
          <span>↑↓ navigate</span>
          <span>↵ run</span>
          <span>esc close</span>
        </div>
      </div>
    </div>
  );
}
