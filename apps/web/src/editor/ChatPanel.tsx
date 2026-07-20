// Palmier-style AI assistant panel. The user writes in plain language; Claude runs the real editing
// tools on the bridge and the timeline updates live. Bottom-left holds the model selector (like
// Palmier's "Sonnet 4.6" chip); selected library assets ride along as @-mentioned references.

import { type ReactNode, useEffect, useRef, useState } from "react";
import { t } from "./i18n";
import { clearChat, deleteChat, newChat, recheckConnections, selectChat, sendChat, setAnthropicKey, stopChat, ui, useEditor } from "./store";
import type { MediaAsset } from "@cupcat/editor-core";
import { assetTypeIcon, filterAssets, findMentionToken, insertMention } from "./chatMentions";
import { promptLibrary } from "./promptLibrary";

// ── component ─────────────────────────────────────────────────────────────────────────────────

// Lightweight inline markdown for assistant messages: **bold**, *italic*, `code`. Anything unpaired
// stays literal. Line breaks are kept by the whitespace-pre-wrap container.
function renderMarkdown(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /(\*\*[^*\n]+\*\*|\*[^*\n]+\*|`[^`\n]+`)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let key = 0;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const tok = m[0];
    if (tok.startsWith("**")) out.push(<strong key={key++}>{tok.slice(2, -2)}</strong>);
    else if (tok.startsWith("`"))
      out.push(
        <code key={key++} className="rounded bg-neutral-800 px-1 text-[0.92em] text-emerald-300 break-words [overflow-wrap:anywhere]">
          {tok.slice(1, -1)}
        </code>,
      );
    else out.push(<em key={key++}>{tok.slice(1, -1)}</em>);
    last = m.index + tok.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

export function ChatPanel() {
  const { chat, chatList, activeChatId, chatBusy, chatModel, agentModels, agentHasKey, selectedAssetIds, project } = useEditor();
  const [draft, setDraft] = useState("");
  const [keyDraft, setKeyDraft] = useState("");
  const [showKey, setShowKey] = useState(false);
  const [caret, setCaret] = useState(0); // textarea caret — the @token is detected around it
  const [mentionIdx, setMentionIdx] = useState(0);
  const [mentionDismissed, setMentionDismissed] = useState(false); // Esc hides the popup without editing text
  const [showPrompts, setShowPrompts] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // The panel is user-resizable (drag its right edge): long prompts and tool logs were cramped at
  // a fixed 320px. Width persists across sessions.
  const [panelW, setPanelW] = useState<number>(() => {
    const v = parseInt(localStorage.getItem("cupcat.chatW") ?? "", 10);
    return Number.isFinite(v) ? Math.min(640, Math.max(300, v)) : 320;
  });
  const startResize = (e: React.PointerEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = panelW;
    const move = (ev: PointerEvent) => {
      const w = Math.min(640, Math.max(300, startW + (ev.clientX - startX)));
      setPanelW(w);
    };
    const up = (ev: PointerEvent) => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      const w = Math.min(640, Math.max(300, startW + (ev.clientX - startX)));
      localStorage.setItem("cupcat.chatW", String(w));
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [chat]);

  // Composer auto-grows with its content (up to ~7 lines, then scrolls): a fixed 2-row textarea
  // hid everything but the last lines of longer prompts.
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "0px";
    el.style.height = `${Math.min(200, Math.max(40, el.scrollHeight))}px`;
    // Scrollbar only once the cap is reached — otherwise WebView2 paints arrow gutters on a
    // one-line composer.
    el.style.overflowY = el.scrollHeight > 200 ? "auto" : "hidden";
  }, [draft]);

  const mentions = selectedAssetIds
    .map((id) => project?.media.find((m) => m.id === id))
    .filter((m): m is NonNullable<typeof m> => !!m);

  // @-mention typeahead state — token detection follows the caret, so mentions work mid-sentence
  const allAssets = project?.media ?? [];
  const mentionToken = findMentionToken(draft, caret);
  const isMentioning = mentionToken !== null && !mentionDismissed;
  const suggestions = isMentioning ? filterAssets(allAssets, mentionToken.query) : [];

  // Reset highlight when the query changes (a stale index could point past the filtered list)
  useEffect(() => {
    setMentionIdx(0);
  }, [mentionToken?.query]);

  const applyMention = (asset: MediaAsset) => {
    if (!mentionToken) return;
    // Insert "@Name (asset_id)" inline: the agent resolves ids natively, so the reference stays
    // valid even if the library selection changes before sending.
    const next = insertMention(draft, mentionToken, asset.name, asset.id);
    setDraft(next.text);
    setCaret(next.caret);
    // Also ride along as a structured ref (sendChat forwards selectedAssetIds as mentionedMediaRefs)
    if (!selectedAssetIds.includes(asset.id)) ui.toggleAsset(asset.id, true);
    // Restore focus + caret after React flushes the controlled value
    requestAnimationFrame(() => {
      const el = textareaRef.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(next.caret, next.caret);
    });
  };

  const submit = () => {
    const text = draft.trim();
    if (!text || chatBusy) return;
    setDraft("");
    void sendChat(text);
  };

  // Prompt library: fill the composer without sending — the user completes any [placeholders] first
  const applyPrompt = (text: string) => {
    setDraft(text);
    setCaret(text.length);
    setShowPrompts(false);
    requestAnimationFrame(() => {
      const el = textareaRef.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(text.length, text.length);
    });
  };

  // Drag/drop: accept one or more library assets dropped anywhere on the assistant panel.
  const addAssets = (ids: string[]) => {
    for (const id of ids) {
      if (allAssets.find((a) => a.id === id) && !selectedAssetIds.includes(id)) ui.toggleAsset(id, true);
    }
  };
  const handleDrop = (e: React.DragEvent<HTMLElement>) => {
    e.preventDefault();
    setDragOver(false);
    const multi = e.dataTransfer.getData("application/x-cupcat-assets");
    if (multi) {
      try {
        const ids = JSON.parse(multi) as string[];
        if (Array.isArray(ids) && ids.length) return addAssets(ids);
      } catch {
        /* fall back to single below */
      }
    }
    const single = e.dataTransfer.getData("text/plain");
    if (single) addAssets([single]);
  };
  const handleDragOver = (e: React.DragEvent<HTMLElement>) => {
    const types = e.dataTransfer.types; // not `t` — that's the translate function in this module
    if (types.includes("application/x-cupcat-asset") || types.includes("application/x-cupcat-assets")) {
      e.preventDefault();
      e.dataTransfer.dropEffect = "copy";
      if (!dragOver) setDragOver(true);
    }
  };
  const handleDragLeave = (e: React.DragEvent<HTMLElement>) => {
    if (e.currentTarget === e.target) setDragOver(false);
  };

  // Paste: accept image files pasted into the composer
  const handlePaste = (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const items = Array.from(e.clipboardData.items);
    const imageItem = items.find((item) => item.kind === "file" && item.type.startsWith("image/"));
    if (!imageItem) return; // let the default textarea paste handle text
    e.preventDefault();
    // We can't upload the image here (no bridge upload endpoint in store API), so at minimum
    // show a note in the draft so the user knows we saw it.
    setDraft((d) => d + "[pasted image]");
  };

  const handleTextareaKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (isMentioning && suggestions.length > 0) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setMentionIdx((i) => (i + 1) % suggestions.length);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setMentionIdx((i) => (i - 1 + suggestions.length) % suggestions.length);
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        applyMention(suggestions[Math.min(mentionIdx, suggestions.length - 1)]);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setMentionDismissed(true); // hide the popup, keep the typed text as-is
        return;
      }
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  };

  return (
    <aside
      style={{ width: panelW }}
      className={`relative flex shrink-0 flex-col border-r border-neutral-800 bg-neutral-900/60 ${
        dragOver ? "ring-2 ring-inset ring-sky-500" : ""
      }`}
      onDrop={handleDrop}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
    >
      {/* right-edge resize handle */}
      <div
        onPointerDown={startResize}
        title={t("chat.resize")}
        className="absolute right-0 top-0 z-20 h-full w-1 cursor-col-resize transition-colors hover:bg-sky-500/50"
      />
      {dragOver && (
        <div className="pointer-events-none absolute inset-0 z-30 flex items-center justify-center bg-sky-500/10 text-xs font-medium text-sky-300">
          Drop to reference in chat
        </div>
      )}
      {/* The panel is a fixed 320px: the header must never overflow, whatever combination of
        * controls is visible. Left label shrinks first; the history select flexes; every action
        * is icon-only with a tooltip. */}
      <div className="relative flex items-center gap-1 border-b border-neutral-800 px-3 py-2">
        <span className="min-w-0 shrink truncate text-xs font-medium uppercase tracking-wide text-neutral-400">{t("chat.title")}</span>
        <div className="ml-auto flex min-w-0 items-center gap-1">
          {chatList.length > 0 && (
            // w-24 (not w-0+basis): with width:0 the flex parent measured this select at 0px and
            // it collapsed to a ~10px sliver — the history dropdown was effectively invisible.
            <select
              value={activeChatId}
              onChange={(e) => void selectChat(e.target.value)}
              title={t("chat.history")}
              className="w-24 min-w-0 shrink truncate rounded border border-neutral-700 bg-neutral-950 px-1 py-0.5 text-[10px] text-neutral-300 outline-none"
            >
              {chatList.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.title || "New chat"}
                </option>
              ))}
            </select>
          )}
          <button
            type="button"
            onClick={() => setShowPrompts((v) => !v)}
            className={`shrink-0 rounded px-1.5 py-0.5 text-[12px] hover:bg-neutral-800 hover:text-neutral-200 ${
              showPrompts ? "bg-neutral-800 text-neutral-200" : "text-neutral-400"
            }`}
            title={t("chat.readyPrompts")}
          >
            ✨
          </button>
          {(chat.length > 0 || chatList.length > 0) && activeChatId && (
            <button
              type="button"
              onClick={() => {
                if (confirm("Delete this conversation? It will be removed from history.")) void deleteChat(activeChatId);
              }}
              className="shrink-0 rounded px-1.5 py-0.5 text-[12px] text-neutral-500 hover:bg-neutral-800 hover:text-red-400"
              title={t("chat.deleteConv")}
            >
              🗑
            </button>
          )}
          {chat.length > 0 && (
            <button
              type="button"
              onClick={() => void clearChat()}
              className="shrink-0 rounded px-1.5 py-0.5 text-[12px] text-neutral-400 hover:bg-neutral-800 hover:text-neutral-200"
              title={t("chat.clearMessages")}
            >
              🧹
            </button>
          )}
          <button
            type="button"
            onClick={() => void newChat()}
            className="shrink-0 rounded px-1.5 py-0.5 text-[12px] text-neutral-400 hover:bg-neutral-800 hover:text-neutral-200"
            title={t("chat.newConv")}
          >
            ＋
          </button>
        </div>
        {showPrompts && (
          <>
            {/* Invisible backdrop: click anywhere else to close the dropdown */}
            <div className="fixed inset-0 z-30" onClick={() => setShowPrompts(false)} />
            <div className="absolute right-2 top-full z-40 mt-1 max-h-80 w-64 overflow-y-auto rounded-lg border border-neutral-700 bg-neutral-900 py-1 shadow-2xl">
              {promptLibrary.map((cat) => (
                <div key={cat.category}>
                  <div className="px-3 pb-0.5 pt-2 text-[10px] font-medium uppercase tracking-wide text-neutral-500">{cat.category}</div>
                  {cat.prompts.map((p) => (
                    <button
                      key={p}
                      type="button"
                      onClick={() => applyPrompt(p)}
                      className="block w-full px-3 py-1.5 text-left text-xs leading-snug text-neutral-300 hover:bg-neutral-800 hover:text-neutral-100"
                    >
                      {p}
                    </button>
                  ))}
                </div>
              ))}
            </div>
          </>
        )}
      </div>

      <div ref={scrollRef} className="flex-1 space-y-3 overflow-y-auto p-3">
        {chat.length === 0 && (
          <div className="space-y-2 text-xs leading-relaxed text-neutral-500">
            <p className="text-neutral-300">{t("chat.empty")}</p>
            <p>{t("chat.examples")}</p>
            <p>{t("chat.emptyHint")}</p>
          </div>
        )}
        {chat.map((turn, i) => (
          <div key={i} className={turn.role === "user" ? "flex justify-end" : ""}>
            <div
              className={
                turn.role === "user"
                  ? "max-w-[85%] rounded-2xl rounded-br-sm bg-neutral-700/70 px-3 py-2 text-xs text-neutral-100"
                  : "w-full text-xs text-neutral-200"
              }
            >
              {turn.tools && turn.tools.length > 0 && (
                // Build-log style: one row per tool call — status dot, tool name, inline result
                // snippet. Scannable like a terse CI log instead of opaque gear chips.
                <div className="mb-1.5 flex flex-col gap-0.5">
                  {turn.tools.map((t, j) => (
                    <div
                      key={j}
                      className={`flex items-baseline gap-1.5 rounded-md px-1.5 py-0.5 text-[10px] leading-4 ${
                        t.isError ? "bg-red-950/60 text-red-300" : "bg-neutral-800/60 text-neutral-400"
                      }`}
                      title={t.text}
                    >
                      <span className={t.isError ? "text-red-400" : t.text === "…" ? "animate-pulse text-amber-400" : "text-emerald-400"}>●</span>
                      <span className="shrink-0 font-medium text-neutral-300">{t.name}</span>
                      {t.text && t.text !== "…" && (
                        <span className="truncate text-neutral-500">· {t.text.length > 90 ? `${t.text.slice(0, 90)}…` : t.text}</span>
                      )}
                    </div>
                  ))}
                </div>
              )}
              {turn.text && (
                // break-words + overflow-wrap:anywhere so a long unbreakable asset name (no spaces)
                // wraps instead of overflowing and triggering a horizontal scrollbar on the panel.
                <div className="whitespace-pre-wrap break-words [overflow-wrap:anywhere] leading-relaxed">{renderMarkdown(turn.text)}</div>
              )}
              {turn.role === "assistant" && !turn.text && chatBusy && i === chat.length - 1 && (
                <div className="text-neutral-500">…</div>
              )}
              {/* Tool-loop budget hit: one-click resume — the conversation and every edit persist,
                * so continuing picks up mid-task instead of redoing anything. */}
              {turn.limitHit && i === chat.length - 1 && !chatBusy && (
                <button
                  type="button"
                  onClick={() => void sendChat("continua")}
                  className="mt-2 rounded-md bg-amber-500/90 px-3 py-1.5 text-xs font-semibold text-neutral-950 hover:bg-amber-400"
                >
                  ▶ Continua da dove sei rimasto
                </button>
              )}
            </div>
          </div>
        ))}
      </div>

      {!agentHasKey ? (
        <div className="space-y-2 border-t border-neutral-800 p-3">
          <p className="text-[11px] text-neutral-400">
            Claude isn't connected right now. CupCat uses your Claude subscription via Claude Code — make sure Claude Code
            is signed in, then re-check. It also reconnects automatically.
          </p>
          <div className="flex gap-1.5">
            <button
              type="button"
              onClick={() => recheckConnections()}
              className="rounded-md bg-neutral-200 px-2.5 py-1.5 text-xs font-medium text-neutral-900 hover:bg-white"
            >
              Re-check connection
            </button>
            <button
              type="button"
              onClick={() => setShowKey((v) => !v)}
              className="rounded-md border border-neutral-700 px-2.5 py-1.5 text-xs text-neutral-400 hover:text-neutral-200"
            >
              Use API key
            </button>
          </div>
          {showKey && (
            <div className="flex gap-1.5">
              <input
                type="password"
                value={keyDraft}
                onChange={(e) => setKeyDraft(e.target.value)}
                placeholder="sk-ant-…"
                className="min-w-0 flex-1 rounded-md border border-neutral-700 bg-neutral-950 px-2 py-1.5 text-xs text-neutral-200 outline-none placeholder:text-neutral-600 focus:border-neutral-500"
              />
              <button
                type="button"
                onClick={() => keyDraft.trim() && setAnthropicKey(keyDraft.trim())}
                className="rounded-md bg-neutral-200 px-2.5 py-1.5 text-xs font-medium text-neutral-900 hover:bg-white"
              >
                Save
              </button>
            </div>
          )}
        </div>
      ) : (
        <div
          className="border-t border-neutral-800 p-2"
        >
          {mentions.length > 0 && (
            <div className="mb-1.5 flex flex-wrap gap-1 px-1">
              {mentions.map((m) => (
                <span key={m.id} className="inline-flex items-center gap-1 rounded-md bg-neutral-800 px-1.5 py-0.5 text-[10px] text-neutral-300">
                  @{m.name.length > 16 ? `${m.name.slice(0, 15)}…` : m.name}
                  <button type="button" className="text-neutral-500 hover:text-neutral-200" onClick={() => ui.toggleAsset(m.id, true)}>
                    ×
                  </button>
                </span>
              ))}
            </div>
          )}

          {/* @-mention typeahead: floats above the composer so it never pushes the layout around */}
          <div className="relative">
            {isMentioning && suggestions.length > 0 && (
              <div className="absolute inset-x-0 bottom-full z-20 mb-1.5 overflow-hidden rounded-lg border border-neutral-700 bg-neutral-900 py-1 shadow-xl">
                {suggestions.map((asset, idx) => (
                  <button
                    key={asset.id}
                    type="button"
                    onMouseDown={(e) => { e.preventDefault(); applyMention(asset); }}
                    className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs transition ${
                      idx === mentionIdx ? "bg-neutral-700 text-neutral-100" : "text-neutral-300 hover:bg-neutral-800"
                    }`}
                  >
                    <span aria-hidden>{assetTypeIcon(asset.type)}</span>
                    <span className="truncate">{asset.name}</span>
                    <span className="ml-auto shrink-0 text-[10px] text-neutral-600">{asset.id}</span>
                  </button>
                ))}
              </div>
            )}

            <div className="rounded-xl border border-neutral-700 bg-neutral-950 focus-within:border-neutral-500">
              <textarea
                ref={textareaRef}
                value={draft}
                onChange={(e) => {
                  setDraft(e.target.value);
                  setCaret(e.target.selectionStart ?? e.target.value.length);
                  setMentionDismissed(false); // typing again re-opens a dismissed popup
                }}
                onSelect={(e) => setCaret(e.currentTarget.selectionStart ?? 0)}
                onKeyDown={handleTextareaKeyDown}
                onPaste={handlePaste}
                rows={1}
                placeholder={t("chat.placeholder")}
                className="block w-full resize-none overflow-y-auto bg-transparent px-3 pt-2 text-xs leading-5 text-neutral-200 outline-none placeholder:text-neutral-600"
              />
              <div className="flex items-center justify-between px-2 pb-2">
                <select
                  value={chatModel}
                  onChange={(e) => ui.setChatModel(e.target.value)}
                  className="rounded-md bg-neutral-800 px-1.5 py-1 text-[11px] text-neutral-300 outline-none hover:bg-neutral-700"
                >
                  {agentModels.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.label}
                    </option>
                  ))}
                </select>
                {/* While a run streams, the send button becomes a real STOP: the bridge halts the
                  * agent at the next safe boundary and edits already applied are kept. */}
                <button
                  type="button"
                  onClick={chatBusy ? () => void stopChat() : submit}
                  disabled={!chatBusy && !draft.trim()}
                  className={`flex h-7 w-7 items-center justify-center rounded-full transition disabled:cursor-not-allowed disabled:bg-neutral-700 disabled:text-neutral-500 ${
                    chatBusy ? "bg-red-500/90 text-white hover:bg-red-400" : "bg-neutral-200 text-neutral-900 hover:bg-white"
                  }`}
                  title={chatBusy ? "Ferma l'assistente (le modifiche già fatte restano)" : "Send"}
                >
                  {chatBusy ? <span className="text-xs">■</span> : <span className="text-sm leading-none">↑</span>}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </aside>
  );
}
