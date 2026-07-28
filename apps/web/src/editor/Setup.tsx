import { useState } from "react";
import { t } from "./i18n";
import { BRIDGE_HTTP, dismissUpdate, higgsfieldLogin, installUpdate, useEditor } from "./store";

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

/** "112 MB", "1.4 GB", "0.4 MB" — enough to answer "is this quick or is this a coffee". Small
 * updates keep a decimal, because rounding a 400 KB fix to "0 MB" reads as broken. */
function mb(bytes: number): string {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`;
  if (bytes >= 1e7) return `${Math.round(bytes / 1e6)} MB`;
  return `${(bytes / 1e6).toFixed(1)} MB`;
}

/** What a file being downloaded is, in the user's terms. "cupcat-bridge.exe" is our word for it,
 * not theirs, and it is the one thing on screen while they wait. */
function fileLabel(path: string): string {
  const l = path.toLowerCase();
  if (l === "cupcat-bridge.exe") return t("update.partEngine");
  if (l === "cupcat.exe") return t("update.partApp");
  return path.split("/").pop() ?? path;
}

// Shown when the bridge finds a newer GitHub release.
//
// Two ways forward. When the release can be installed in place — the normal case for anyone already
// running CupCat — the first button downloads only the files that actually changed (about 110 MB
// against a 1.4 GB installer, because the speech model and ffmpeg are the same as the ones already
// on disk) and CupCat restarts itself. The installer download stays as the second option, and is the
// only one offered when installing in place is not possible.
export function UpdateBanner() {
  const { update, updateDismissed, updateProgress } = useEditor();
  // Every hook, before any early return. React counts them per render and throws the moment the
  // count changes — and this component's first render is always the empty one, because whether an
  // update exists is only known a second later. Below the return, that made the arrival of a
  // release blank the entire window: the throw unmounts the whole tree, and CupCat opened black
  // for everyone the instant something newer was published.
  const [opening, setOpening] = useState(false);
  const [showNotes, setShowNotes] = useState(false);

  if (!update || updateDismissed) return null;
  const url = update.downloadUrl ?? update.releaseUrl ?? undefined;
  const delta = update.delta;
  const p = updateProgress;

  // Once it is under way the banner belongs to the update: no dismiss, no second button to press.
  if (p && p.phase !== "error") {
    const pct = p.bytesTotal > 0 ? Math.min(100, Math.round((p.bytesDone / p.bytesTotal) * 100)) : 0;
    return (
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-teal-500/30 bg-teal-500/10 px-4 py-2 text-xs text-teal-100">
        <span className="font-semibold">{t("update.title")}</span>
        <span className="text-teal-200/90">
          {p.phase === "download"
            ? t("update.installing", { file: p.file ? fileLabel(p.file) : "", done: mb(p.bytesDone), total: mb(p.bytesTotal) })
            : p.phase === "staged"
              ? t("update.staged")
              : t("update.restarting")}
        </span>
        {p.phase === "download" && (
          <div className="h-1.5 w-40 overflow-hidden rounded-full bg-teal-500/20" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
            <div className="h-full rounded-full bg-teal-400 transition-[width] duration-200" style={{ width: `${pct}%` }} />
          </div>
        )}
      </div>
    );
  }
  // The engine opens it, not the page. Inside the desktop shell's webview window.open on an
  // external URL is ignored outright — the button looked like it did nothing at all — and
  // setting location.href would navigate the EDITOR to the download instead of the browser.
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
    <div className="border-b border-teal-500/30 bg-teal-500/10 px-4 py-2 text-xs text-teal-100">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
      <span className="font-semibold">{t("update.title")}</span>
      <span className="text-teal-200/90">{t("update.available", { version: update.latest })}</span>
      {/* What you are agreeing to install. The notes were being fetched and thrown away, which left
          the only honest answer to "what changes?" being to go and read the release page. */}
      {update.notes && (
        <button onClick={() => setShowNotes((s) => !s)} className="rounded px-1.5 py-1 text-teal-200/80 underline hover:text-teal-100">
          {showNotes ? t("update.hideNotes") : t("update.showNotes")}
        </button>
      )}
      {delta && (
        <>
          <button
            onClick={() => void installUpdate()}
            className="rounded bg-teal-500 px-2.5 py-1 font-medium text-teal-950 hover:bg-teal-400"
          >
            {t("update.install", { size: mb(delta.bytes) })}
          </button>
          <span className="text-teal-200/60">{t("update.insteadOf", { size: mb(delta.fullBytes) })}</span>
        </>
      )}
      {url && (
        <button
          onClick={() => void open()}
          disabled={opening}
          className={
            delta
              ? "rounded px-2.5 py-1 font-medium text-teal-200/80 underline hover:text-teal-100 disabled:opacity-60"
              : "rounded bg-teal-500 px-2.5 py-1 font-medium text-teal-950 hover:bg-teal-400 disabled:opacity-60"
          }
        >
          {opening ? t("update.opening") : t("update.download")}
        </button>
      )}
      {p?.phase === "error" && <span className="text-amber-200">{t("update.failed", { error: p.error ?? "" })}</span>}
      <div className="ml-auto flex items-center gap-2">
        <button onClick={dismissUpdate} className="rounded px-2 py-1 hover:bg-teal-500/20" aria-label={t("update.dismiss")}>
          ✕
        </button>
      </div>
      </div>
      {showNotes && update.notes && (
        <p className="mt-2 max-h-40 overflow-y-auto whitespace-pre-wrap border-t border-teal-500/20 pt-2 leading-relaxed text-teal-100/80">
          {update.notes}
        </p>
      )}
    </div>
  );
}
