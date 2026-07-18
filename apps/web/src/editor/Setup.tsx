import { useState } from "react";
import { dismissUpdate, higgsfieldLogin, useEditor } from "./store";

const CLAUDE_CMD = "claude mcp add --transport http cupcat http://127.0.0.1:19789/mcp";

// First-run setup: shown until Higgsfield is connected. Helps the user sign in to Higgsfield
// (enables generation) and connect Claude (enables AI editing over MCP).
export function SetupBanner() {
  const { connected, canGenerate, setupBusy, higgsfieldLoginUrl } = useEditor();
  const [dismissed, setDismissed] = useState(false);
  const [copied, setCopied] = useState(false);

  if (!connected || canGenerate || dismissed) return null;

  const copy = () => {
    void navigator.clipboard?.writeText(CLAUDE_CMD).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    });
  };

  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-amber-500/30 bg-amber-500/10 px-4 py-2 text-xs text-amber-100">
      <span className="font-semibold">Setup</span>
      <span className="text-amber-200/80">Higgsfield non collegato — la generazione è disabilitata.</span>
      <button
        onClick={higgsfieldLogin}
        disabled={setupBusy}
        className="rounded bg-amber-500 px-2.5 py-1 font-medium text-amber-950 hover:bg-amber-400 disabled:opacity-60"
      >
        {setupBusy ? "Completa l'accesso nel browser…" : "Accedi a Higgsfield"}
      </button>
      {higgsfieldLoginUrl && (
        <span className="text-amber-200/90">
          Browser non aperto?{" "}
          <a href={higgsfieldLoginUrl} target="_blank" rel="noopener noreferrer" className="font-medium underline hover:text-amber-100">
            apri il link di accesso
          </a>
        </span>
      )}

      <div className="ml-auto flex items-center gap-2">
        <span className="text-amber-200/70">Collega Claude:</span>
        <code className="rounded bg-black/30 px-1.5 py-0.5 font-mono text-[10px] text-amber-100">{CLAUDE_CMD}</code>
        <button onClick={copy} className="rounded px-2 py-1 hover:bg-amber-500/20">
          {copied ? "copiato ✓" : "copia"}
        </button>
        <button onClick={() => setDismissed(true)} className="rounded px-2 py-1 hover:bg-amber-500/20" aria-label="Chiudi">
          ✕
        </button>
      </div>
    </div>
  );
}

// Shown when the bridge finds a newer GitHub release. Clicking Scarica opens the installer's
// download (the -setup.exe asset, or the release page as fallback) in the system browser.
export function UpdateBanner() {
  const { update, updateDismissed } = useEditor();
  if (!update || updateDismissed) return null;
  const url = update.downloadUrl ?? update.releaseUrl ?? undefined;
  const open = () => {
    if (!url) return;
    try {
      window.open(url, "_blank", "noopener");
    } catch {
      location.href = url;
    }
  };

  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-teal-500/30 bg-teal-500/10 px-4 py-2 text-xs text-teal-100">
      <span className="font-semibold">Aggiornamento</span>
      <span className="text-teal-200/90">È disponibile CupCat {update.latest}. Scaricala per avere le ultime novità e correzioni.</span>
      {url && (
        <button onClick={open} className="rounded bg-teal-500 px-2.5 py-1 font-medium text-teal-950 hover:bg-teal-400">
          Scarica la nuova versione
        </button>
      )}
      <div className="ml-auto flex items-center gap-2">
        <button onClick={dismissUpdate} className="rounded px-2 py-1 hover:bg-teal-500/20" aria-label="Chiudi">
          ✕
        </button>
      </div>
    </div>
  );
}
