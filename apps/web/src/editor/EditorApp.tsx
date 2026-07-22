import { useEffect } from "react";
import { t } from "./i18n";
import { connectBridge, dismissToast, useEditor } from "./store";
import { Toolbar } from "./Toolbar";
import { LanguageGate } from "./LanguageGate";
import { WhatsNew } from "./WhatsNew";
import { Onboarding } from "./Onboarding";
import { SetupBanner, UpdateBanner } from "./Setup";
import { ChatPanel } from "./ChatPanel";
import { MediaPanel } from "./MediaPanel";
import { Preview } from "./Preview";
import { Timeline } from "./Timeline";
import { Inspector } from "./Inspector";
import { TranscriptPanel } from "./TranscriptPanel";
import { CommandPalette } from "./CommandPalette";
import { useKeyboard } from "./useKeyboard";

/** Activity toasts (bottom-right): raised by the store when the project changes without this
 * window having done anything — an AI agent editing over MCP, or another window on the same
 * bridge. Without them the timeline appears to change "by itself". Click to dismiss;
 * they auto-dismiss after 5s and at most 3 stack. */
function Toasts() {
  const { toasts } = useEditor();
  if (toasts.length === 0) return null;
  return (
    <div className="pointer-events-none fixed bottom-4 right-4 z-50 flex w-72 flex-col items-stretch gap-2">
      <style>{"@keyframes cc-toast-in { from { opacity: 0 } to { opacity: 1 } }"}</style>
      {toasts.map((toast) => (
        <button
          key={toast.id}
          type="button"
          onClick={() => dismissToast(toast.id)}
          title={t("update.dismiss")}
          style={{ animation: "cc-toast-in 0.2s ease-out" }}
          className="pointer-events-auto rounded-md border border-neutral-700 bg-neutral-900/95 px-3 py-2 text-left text-xs text-neutral-200 shadow-lg hover:border-neutral-500"
        >
          {toast.text}
        </button>
      ))}
    </div>
  );
}

export function EditorApp() {
  useEffect(() => {
    connectBridge();
  }, []);

  useKeyboard();

  const { panels, maximized } = useEditor();

  // When a pane is maximized, collapse side panels and let the center column fill.
  const showSides = maximized === null;

  return (
    <div className="flex h-screen w-screen flex-col overflow-hidden bg-neutral-950 text-neutral-200">
      <LanguageGate />
      <WhatsNew />
      <Onboarding />
      <Toolbar />
      <UpdateBanner />
      <SetupBanner />
      <div className="flex min-h-0 flex-1">
        {showSides && panels.chat && <ChatPanel />}
        {showSides && panels.media && <MediaPanel />}
        <div className="flex min-w-0 flex-1 flex-col">
          <Preview />
          <Timeline />
        </div>
        {/* Text-based editing column: collapses to its own thin toggle strip (the Toolbar's
          * panel buttons don't know about it), so no store "panels" entry is needed. */}
        {showSides && <TranscriptPanel />}
        {showSides && panels.inspector && <Inspector />}
      </div>
      <Toasts />
      <CommandPalette />
    </div>
  );
}
