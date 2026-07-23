import { useState } from "react";
import { t } from "./i18n";
import { BRIDGE_HTTP, dismissUpdate, higgsfieldLogin, useEditor } from "./store";

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
      <span className="font-semibold">{t("setup.title")}</span>
      <span className="text-amber-200/80">{t("setup.higgsfieldOff")}</span>
      <button
        onClick={higgsfieldLogin}
        disabled={setupBusy}
        className="rounded bg-amber-500 px-2.5 py-1 font-medium text-amber-950 hover:bg-amber-400 disabled:opacity-60"
      >
        {setupBusy ? t("setup.opening") : t("setup.signIn")}
      </button>
      {higgsfieldLoginUrl && (
        <span className="text-amber-200/90">
          {t("setup.browserNotOpen")}{" "}
          <a href={higgsfieldLoginUrl} target="_blank" rel="noopener noreferrer" className="font-medium underline hover:text-amber-100">
            {t("setup.openLink")}
          </a>
        </span>
      )}

      <div className="ml-auto flex items-center gap-2">
        <span className="text-amber-200/70">{t("setup.connectClaude")}</span>
        <code className="rounded bg-black/30 px-1.5 py-0.5 font-mono text-[10px] text-amber-100">{CLAUDE_CMD}</code>
        <button onClick={copy} className="rounded px-2 py-1 hover:bg-amber-500/20">
          {copied ? t("setup.copied") : t("setup.copy")}
        </button>
        <button onClick={() => setDismissed(true)} className="rounded px-2 py-1 hover:bg-amber-500/20" aria-label={t("common.close")}>
          ✕
        </button>
      </div>
    </div>
  );
}

// Shown when the bridge finds a newer GitHub release. The button opens the installer's download
// (the -setup.exe asset, or the release page as fallback) in the system browser.
export function UpdateBanner() {
  const { update, updateDismissed } = useEditor();
  if (!update || updateDismissed) return null;
  const url = update.downloadUrl ?? update.releaseUrl ?? undefined;
  // The engine opens it, not the page. Inside the desktop shell's webview window.open on an
  // external URL is ignored outright — the button looked like it did nothing at all — and
  // setting location.href would navigate the EDITOR to the download instead of the browser.
  const [opening, setOpening] = useState(false);
  const open = async () => {
    if (!url) return;
    setOpening(true);
    try {
      const r = await fetch(`${BRIDGE_HTTP}/open`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url }),
      }).then((x) => x.json());
      if (!r?.opened) window.open(url, "_blank", "noopener"); // plain browser: this path works
    } catch {
      window.open(url, "_blank", "noopener");
    } finally {
      setOpening(false);
    }
  };

  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-teal-500/30 bg-teal-500/10 px-4 py-2 text-xs text-teal-100">
      <span className="font-semibold">{t("update.title")}</span>
      <span className="text-teal-200/90">{t("update.available", { version: update.latest })}</span>
      {url && (
        <button onClick={() => void open()} disabled={opening} className="rounded bg-teal-500 disabled:opacity-60 px-2.5 py-1 font-medium text-teal-950 hover:bg-teal-400">
          {opening ? t("update.opening") : t("update.download")}
        </button>
      )}
      <div className="ml-auto flex items-center gap-2">
        <button onClick={dismissUpdate} className="rounded px-2 py-1 hover:bg-teal-500/20" aria-label={t("update.dismiss")}>
          ✕
        </button>
      </div>
    </div>
  );
}
