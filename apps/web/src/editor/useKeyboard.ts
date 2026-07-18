// Global keyboard shortcut hook for the CupCat editor.
// Attach to EditorApp once. Ignores events when focus is inside an input/textarea/contenteditable
// so typing in the chat composer or inspector fields is never hijacked.
// Bindings live in the action registry (actions.ts): defaults there, user overrides in
// localStorage — this hook only maps event → action id and executes the action.

import { useEffect } from "react";
import { timelineTotalFrames } from "@cupcat/editor-core";
import { loadOverrides, resolveAction } from "./actions";
import {
  copyClips,
  cutClips,
  deleteSelected,
  duplicateSelected,
  pasteClips,
  sendCommand,
  ui,
  useEditor,
} from "./store";
import { kickAudio } from "./Preview";

function isInputTarget(e: KeyboardEvent): boolean {
  const t = e.target as HTMLElement | null;
  if (!t) return false;
  const tag = t.tagName?.toLowerCase();
  if (tag === "input" || tag === "textarea" || tag === "select") return true;
  if (t.isContentEditable) return true;
  return false;
}

function splitSelectedAtPlayhead(project: NonNullable<ReturnType<typeof useEditor>["project"]>, selectedClipIds: string[], playhead: number): void {
  const clips = project.timeline.tracks.flatMap((t) => t.clips);
  for (const id of selectedClipIds) {
    const clip = clips.find((c) => c.id === id);
    if (clip && playhead > clip.startFrame && playhead < clip.startFrame + clip.durationFrames) {
      sendCommand("split_clip", { clipId: id, atFrame: playhead });
    }
  }
}

export function useKeyboard(): void {
  // Read store state each render so the closure is always fresh.
  const state = useEditor();

  useEffect(() => {
    const { playing, playhead, project, selectedClipIds, rangeIn, rangeOut } = state;
    const total = project ? timelineTotalFrames(project.timeline) : 0;

    const handler = (e: KeyboardEvent) => {
      if (isInputTarget(e)) return;

      const actionId = resolveAction(e, loadOverrides());
      if (!actionId) return;
      e.preventDefault();

      switch (actionId) {
        // ── playback ────────────────────────────────────────────────────────
        case "play_pause":
          if (!playing) kickAudio(); // start audio inside the keypress gesture (WebView2 autoplay rule)
          ui.setPlaying(!playing);
          return;
        case "step_back":
          ui.advance(-1, total);
          return;
        case "step_forward":
          ui.advance(1, total);
          return;
        case "step_back_big":
          ui.advance(-10, total);
          return;
        case "step_forward_big":
          ui.advance(10, total);
          return;
        case "goto_start":
          ui.setPlayhead(0);
          return;
        case "goto_end":
          ui.setPlayhead(total);
          return;

        // ── editing ─────────────────────────────────────────────────────────
        case "delete":
          deleteSelected();
          return;
        case "undo":
          sendCommand("undo", {});
          return;
        case "copy":
          copyClips();
          return;
        case "cut":
          cutClips();
          return;
        case "paste":
          pasteClips();
          return;
        case "duplicate":
          duplicateSelected();
          return;
        case "split":
          if (project && selectedClipIds.length) splitSelectedAtPlayhead(project, selectedClipIds, playhead);
          return;

        // ── tools / markers / range ─────────────────────────────────────────
        case "tool_blade":
          ui.setTool("blade");
          return;
        case "tool_select":
          ui.setTool("select");
          return;
        case "add_marker":
          // Drop a marker at the playhead; note/color are edited later via right-click on the flag.
          sendCommand("add_marker", { frame: Math.round(playhead) });
          return;
        case "range_in":
          ui.setRange(playhead, rangeOut);
          return;
        case "range_out":
          ui.setRange(rangeIn, playhead);
          return;
        case "deselect":
          ui.select([]);
          return;
        case "command_palette":
          ui.setPalette(true);
          return;
      }
    };

    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }); // intentionally no dep array — re-runs every render to keep closure fresh
}
