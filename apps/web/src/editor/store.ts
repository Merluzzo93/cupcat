// Editor store: a tiny external store synced with the CupCat bridge over WebSocket.
// The bridge owns the canonical Project; the UI renders it and dispatches commands back.
// Request/response tools (list_models, generate_*, inspect_*) go over POST /mcp; the in-app
// AI assistant streams over /agent/chat (SSE).

import { useSyncExternalStore } from "react";
import type { Clip, Project } from "@cupcat/editor-core";
import { summarizeProjectChange } from "./projectDiff";

// When the SPA is served by the bridge (production / desktop), talk to the same origin the page was
// loaded from — this avoids the localhost-vs-127.0.0.1 CORS mismatch. In dev (vite on another port),
// fall back to the fixed loopback port (the bridge sends loopback CORS headers for that case).
// Any real numeric port means the page is served directly by a bridge's own HTTP server (dev/test
// setups may use a port other than 19789) — same-origin is always correct there. The packaged Tauri
// webview loads from a virtual host (location.port is empty), which is the only case that needs the
// hardcoded loopback fallback.
const BRIDGE_ORIGIN =
  typeof location !== "undefined" && location.port !== ""
    ? `${location.protocol}//${location.host}`
    : "http://127.0.0.1:19789";
export const BRIDGE_HTTP = BRIDGE_ORIGIN;
export const BRIDGE_WS = `${BRIDGE_ORIGIN.replace(/^http/, "ws")}/ws`;

export function mediaUrl(assetId: string): string {
  return `${BRIDGE_HTTP}/media/${encodeURIComponent(assetId)}`;
}

export interface ChatTool {
  name: string;
  text: string;
  isError?: boolean;
}
export interface ChatTurn {
  role: "user" | "assistant";
  text: string;
  tools?: ChatTool[];
  limitHit?: boolean; // turn ended on the tool-loop budget — offer one-click Continue
}
export interface ChatModel {
  id: string;
  label: string;
}

/** Bottom-right activity toast — raised for project changes NOT originated by this window. */
export interface Toast {
  id: number;
  text: string;
  ts: number;
}

export interface EditorState {
  connected: boolean;
  project: Project | null;
  /** Open nested sequence: the bridge then broadcasts the project with `timeline` swapped for the
   * compound's sub-timeline, so the whole editor edits inside it; null = the main timeline. */
  activeCompound: { id: string; name: string } | null;
  playhead: number; // project frames
  pxPerFrame: number; // timeline zoom
  selectedClipIds: string[];
  selectedAssetIds: string[]; // media library selection (used as @ references in chat)
  playing: boolean;
  tool: "select" | "blade"; // timeline cursor mode
  lastMessage: string | null;
  canGenerate: boolean;
  setupBusy: boolean;
  higgsfieldLoginUrl: string | null; // device-login URL surfaced during a Higgsfield sign-in
  claudeLoginUrl: string | null; // authorize URL surfaced during a Claude sign-in
  claudeLoginBusy: boolean;
  claudeLoginProgress: string | null; // latest status line from the official Claude sign-in
  claudeCodeNeeded: boolean; // the login is waiting for the code the user pastes from the browser
  update: { latest: string; downloadUrl: string | null; releaseUrl: string | null; notes: string | null } | null; // newer GitHub release
  updateDismissed: boolean;
  // in-app AI assistant
  chat: ChatTurn[];
  chatList: { id: string; title: string; ts: number }[]; // conversation history (this project)
  activeChatId: string;
  chatBusy: boolean;
  busyChatId: string; // conversation a run is streaming into (may differ from the viewed one)
  chatModel: string;
  agentHasKey: boolean; // Claude connected (subscription OAuth or key)
  claudeExpiresAt: number | null; // Claude OAuth token expiry (ms epoch)
  agentModels: ChatModel[];
  // editor extras
  clipboard: Clip[]; // copied/cut clip objects (full fidelity)
  panels: { chat: boolean; media: boolean; inspector: boolean };
  maximized: "preview" | "timeline" | null;
  snapping: boolean;
  rangeIn: number | null; // I/O range selection (project frames)
  rangeOut: number | null;
  sourceAssetId: string | null; // ACTIVE source tab above the monitor (null = Timeline tab)
  openSourceIds: string[]; // all open source tabs, in tab order
  paletteOpen: boolean; // command palette (Ctrl+K) overlay
  toasts: Toast[]; // external-activity toasts (max 3, auto-dismiss)
}

let state: EditorState = {
  connected: false,
  project: null,
  activeCompound: null,
  playhead: 0,
  pxPerFrame: 2,
  selectedClipIds: [],
  selectedAssetIds: [],
  playing: false,
  tool: "select",
  lastMessage: null,
  canGenerate: false,
  higgsfieldLoginUrl: null,
  claudeLoginUrl: null,
  claudeLoginBusy: false,
  claudeLoginProgress: null,
  claudeCodeNeeded: false,
  update: null,
  updateDismissed: false,
  setupBusy: false,
  chat: [],
  chatList: [],
  activeChatId: "",
  chatBusy: false,
  busyChatId: "",
  chatModel: "claude-opus-4-8",
  agentHasKey: false,
  claudeExpiresAt: null,
  agentModels: [],
  clipboard: [],
  panels: { chat: true, media: true, inspector: true },
  maximized: null,
  snapping: true,
  rangeIn: null,
  rangeOut: null,
  sourceAssetId: null,
  openSourceIds: [],
  paletteOpen: false,
  toasts: [],
};

const listeners = new Set<() => void>();

function emit(): void {
  for (const l of listeners) l();
}

function setState(patch: Partial<EditorState>): void {
  state = { ...state, ...patch };
  emit();
}

function subscribe(l: () => void): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

function getSnapshot(): EditorState {
  return state;
}

// ── activity toasts + external-change detection ──────────────────────────────
// Every local edit echoes back as a WS "state" broadcast, exactly like an edit made by an AI
// agent over MCP or by another window. To tell them apart, every local mutation path records a
// timestamp (and slow local ops — uploads, long MCP tools — additionally hold an in-flight
// counter, since their broadcast lands long after the call started). A "state" that arrives
// with no recent/pending local activity is external → summarize the diff in a toast.
let lastLocalAction = 0;
let localOps = 0; // local requests still in flight (mcpCall / import / project switch)
function markLocalAction(): void {
  lastLocalAction = Date.now();
}
function isExternalChange(): boolean {
  return localOps === 0 && !state.chatBusy && Date.now() - lastLocalAction > 2000;
}

let toastSeq = 0;
/** Show a bottom-right activity toast (auto-dismisses after 5s, max 3 stacked). */
export function pushToast(text: string): void {
  const toast: Toast = { id: ++toastSeq, text, ts: Date.now() };
  setState({ toasts: [...state.toasts, toast].slice(-3) });
  window.setTimeout(() => dismissToast(toast.id), 5000);
}
export function dismissToast(id: number): void {
  if (state.toasts.some((t) => t.id === id)) setState({ toasts: state.toasts.filter((t) => t.id !== id) });
}

export interface CommandAck {
  text: string;
  isError: boolean;
}
// WS commands sent with an id get their ack routed back here (the bridge echoes the id).
const pendingAcks = new Map<number, (ack: CommandAck) => void>();
let cmdSeq = 0;

let socket: WebSocket | null = null;
let connecting = false;
let statusPoll: ReturnType<typeof setInterval> | null = null;

export function connectBridge(): void {
  if (typeof window === "undefined" || socket || connecting) return;
  connecting = true;
  const sock = new WebSocket(BRIDGE_WS);
  sock.onopen = () => {
    socket = sock;
    connecting = false;
    setState({ connected: true });
    void fetchAgentStatus();
    void loadChatHistory(); // restore this project's conversation
    void checkForUpdate(); // prompt to download when a newer GitHub release exists
    // Keep Claude/Higgsfield connection status live so the services always show as connected.
    if (!statusPoll) statusPoll = setInterval(() => void fetchAgentStatus(), 25000);
  };
  sock.onclose = () => {
    socket = null;
    connecting = false;
    if (statusPoll) {
      clearInterval(statusPoll);
      statusPoll = null;
    }
    setState({ connected: false });
    window.setTimeout(connectBridge, 1500);
  };
  sock.onerror = () => {
    sock.close();
  };
  sock.onmessage = (e: MessageEvent) => {
    try {
      const msg = JSON.parse(typeof e.data === "string" ? e.data : "");
      if (msg.type === "state") {
        const next = msg.project as Project;
        const prev = state.project;
        // Update pushed by someone else (AI agent over MCP, another window): summarize what
        // changed in a toast so the timeline never appears to change "by itself". Same-project
        // updates only — switching projects is its own, plainly visible event.
        if (prev && prev.id === next.id && isExternalChange()) {
          const summary = summarizeProjectChange(prev, next);
          if (summary) pushToast(summary);
        }
        setState({
          project: next,
          activeCompound: (msg.activeCompound as EditorState["activeCompound"]) ?? null,
        });
      } else if (msg.type === "ack") {
        setState({ lastMessage: String(msg.text ?? "") });
        markLocalAction(); // acks only ever answer THIS window's commands
        if (typeof msg.id === "number") pendingAcks.get(msg.id)?.({ text: String(msg.text ?? ""), isError: !!msg.isError });
      } else if (msg.type === "higgsfield-login-url" && typeof msg.url === "string") {
        // The bridge already tried to open the browser; open it here too (the WebView can pop the
        // system browser) and surface the URL so the user can click/copy it if nothing opened.
        setState({ higgsfieldLoginUrl: msg.url });
        try { window.open(msg.url, "_blank", "noopener"); } catch {}
      } else if (msg.type === "claude-login-url" && typeof msg.url === "string") {
        // The official Claude sign-in printed its authorize URL; the bridge already opened the
        // browser, we open it here too and reveal the code box (the login now waits for the code).
        setState({ claudeLoginUrl: msg.url, claudeLoginBusy: false, claudeCodeNeeded: true });
        try { window.open(msg.url, "_blank", "noopener"); } catch {}
      } else if (msg.type === "claude-login-progress" && typeof msg.text === "string") {
        setState({ claudeLoginProgress: msg.text });
      } else if (msg.type === "claude-login-error" && typeof msg.text === "string") {
        setState({ claudeLoginProgress: msg.text, claudeLoginBusy: false, claudeCodeNeeded: false });
      } else if (msg.type === "status")
        setState({
          canGenerate: !!msg.canGenerate,
          agentHasKey: msg.claudeConnected !== undefined ? !!msg.claudeConnected : state.agentHasKey,
          claudeExpiresAt: msg.claudeExpiresAt ?? state.claudeExpiresAt,
          setupBusy: false,
          // clear login prompts once the corresponding service is connected
          higgsfieldLoginUrl: msg.canGenerate ? null : state.higgsfieldLoginUrl,
          claudeLoginUrl: msg.claudeConnected ? null : state.claudeLoginUrl,
          claudeLoginBusy: msg.claudeConnected ? false : state.claudeLoginBusy,
          claudeCodeNeeded: msg.claudeConnected ? false : state.claudeCodeNeeded,
          claudeLoginProgress: msg.claudeConnected ? "Connected." : state.claudeLoginProgress,
        });
    } catch {
      /* ignore malformed frames */
    }
  };
}

/** Send a tool command to the bridge (runs as a "user" edit, fire-and-forget). */
export function sendCommand(name: string, args: Record<string, unknown>): void {
  markLocalAction();
  socket?.send(JSON.stringify({ type: "command", name, args }));
}

/** Send a tool command and resolve with the bridge's ack — its text carries created ids etc.
 * (the bridge echoes our command id back on the matching ack). Resolves null when offline or if
 * no ack arrives within 5s. The "state" broadcast for the edit is delivered before the ack on
 * this socket, so the store already holds the updated project when this resolves. */
export function sendCommandWithAck(name: string, args: Record<string, unknown>): Promise<CommandAck | null> {
  markLocalAction();
  const sock = socket;
  if (!sock) return Promise.resolve(null);
  const id = ++cmdSeq;
  return new Promise((resolve) => {
    const timer = window.setTimeout(() => {
      pendingAcks.delete(id);
      resolve(null);
    }, 5000);
    pendingAcks.set(id, (ack) => {
      window.clearTimeout(timer);
      pendingAcks.delete(id);
      resolve(ack);
    });
    sock.send(JSON.stringify({ type: "command", name, args, id }));
  });
}

export interface McpResult {
  text: string;
  isError: boolean;
  content: { type: string; text?: string; data?: string; mimeType?: string }[];
}

/** Call any MCP tool and await its result (request/response over POST /mcp). */
export async function mcpCall(name: string, args: Record<string, unknown>): Promise<McpResult> {
  localOps += 1; // long tools (export, auto_clips…) broadcast state well after the call started
  markLocalAction();
  try {
    const res = await fetch(`${BRIDGE_HTTP}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: Date.now(), method: "tools/call", params: { name, arguments: args } }),
    });
    const j = await res.json();
    const content = j?.result?.content ?? [];
    const text = content
      .filter((c: { type: string }) => c.type === "text")
      .map((c: { text?: string }) => c.text)
      .join("\n");
    return { text: j?.error ? String(j.error.message) : text, isError: !!j?.result?.isError || !!j?.error, content };
  } finally {
    localOps -= 1;
    markLocalAction();
  }
}

/** Trigger `higgsfield auth login` on the bridge (opens a browser). Status updates via "status". */
export function higgsfieldLogin(): void {
  setState({ setupBusy: true });
  socket?.send(JSON.stringify({ type: "setup", action: "higgsfield-login" }));
}

/** Provision + sign in with the official Claude Code CLI (installs it if missing), the same URL
 * flow as Higgsfield. The bridge streams progress and the sign-in URL back; after approving in the
 * browser the user pastes the shown code (submitClaudeCode), which completes the login. */
export function claudeLogin(): void {
  setState({ claudeLoginBusy: true, claudeLoginUrl: null, claudeCodeNeeded: false, claudeLoginProgress: "Starting…" });
  socket?.send(JSON.stringify({ type: "setup", action: "claude-login" }));
}

/** Send the authorization code the user copied from the browser to the running Claude sign-in. */
export function submitClaudeCode(code: string): void {
  if (!code.trim()) return;
  setState({ claudeLoginProgress: "Completing sign-in…", claudeCodeNeeded: false });
  socket?.send(JSON.stringify({ type: "setup", action: "claude-login-code", code: code.trim() }));
}

/** Re-check both connections: re-fetch Claude status + ask the bridge to re-probe Higgsfield. */
export function recheckConnections(): void {
  setState({ setupBusy: true });
  socket?.send(JSON.stringify({ type: "setup", action: "recheck" }));
  void fetchAgentStatus();
}

export interface ProjectEntry {
  name: string;
  path: string;
  current: boolean;
}

/** List projects under the bridge's projects folder. */
export async function listProjects(): Promise<ProjectEntry[]> {
  try {
    const r = await fetch(`${BRIDGE_HTTP}/projects`);
    const j = await r.json();
    return Array.isArray(j.projects) ? (j.projects as ProjectEntry[]) : [];
  } catch {
    return [];
  }
}

/** Upload picked files (or a whole folder) into the current project's media library. */
export async function importFiles(files: FileList | File[], folderId?: string): Promise<number> {
  const arr = Array.from(files);
  if (!arr.length) return 0;
  const fd = new FormData();
  for (const f of arr) fd.append("files", f, f.name);
  if (folderId) fd.append("folderId", folderId);
  localOps += 1; // big uploads mutate the library long after the call started
  markLocalAction();
  try {
    const r = await fetch(`${BRIDGE_HTTP}/import`, { method: "POST", body: fd });
    const j = await r.json();
    return Number(j.count) || 0;
  } catch {
    return 0;
  } finally {
    localOps -= 1;
    markLocalAction();
  }
}

/** Open the native folder picker and return the chosen absolute path, or null. In the packaged
 * desktop app this uses the Tauri dialog (parented to the window, reliable); in the dev browser it
 * falls back to a bridge-spawned native dialog. */
export async function pickFolder(): Promise<string | null> {
  const w = window as unknown as Record<string, unknown>;
  if ("__TAURI_INTERNALS__" in w || "__TAURI__" in w) {
    try {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const sel = await open({ directory: true, title: "Select the CupCat project folder" });
      return typeof sel === "string" ? sel : null;
    } catch {
      /* fall through to the bridge dialog */
    }
  }
  try {
    const r = await fetch(`${BRIDGE_HTTP}/pick-folder`, { method: "POST" });
    const j = await r.json();
    return typeof j.path === "string" ? j.path : null;
  } catch {
    return null;
  }
}

/** Save a bridge file (an export) to disk. A plain cross-origin <a download> is ignored by the
 * webview and a target=_blank just navigates; fetching the bytes into a same-origin blob URL makes
 * the download attribute work in both the browser and the packaged Tauri webview. */
export async function downloadFile(url: string, filename?: string): Promise<void> {
  const name = filename || url.split("/").pop() || "export.mp4";
  const w = window as unknown as Record<string, unknown>;
  // Packaged app: a real "Save As" dialog (WebView2 silently drops programmatic <a download>), then
  // the bridge copies the finished export to the chosen path.
  if ("__TAURI_INTERNALS__" in w || "__TAURI__" in w) {
    try {
      const { save } = await import("@tauri-apps/plugin-dialog");
      const ext = name.split(".").pop() || "mp4";
      const dest = await save({ defaultPath: name, filters: [{ name: ext.toUpperCase(), extensions: [ext] }] });
      if (!dest) return; // user cancelled the dialog
      const r = await fetch(`${BRIDGE_HTTP}/save-export`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name, dest }),
      });
      const j = (await r.json()) as { ok?: boolean };
      if (j.ok) return;
    } catch {
      /* fall through to the blob download */
    }
  }
  // Browser: fetch the bytes into a same-origin blob and save via the download attribute.
  try {
    const r = await fetch(url);
    if (!r.ok) throw new Error(String(r.status));
    const blobUrl = URL.createObjectURL(await r.blob());
    const a = document.createElement("a");
    a.href = blobUrl;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(blobUrl), 15000);
  } catch {
    window.open(url, "_blank"); // last resort
  }
}

/** Ask the bridge to build a feedback/diagnostic package (report + screenshot + project + logs)
 * on disk; returns the created path (zip or folder) the user should send to the developer. */
export async function sendFeedback(type: string, description: string): Promise<{ ok: boolean; path?: string; error?: string }> {
  try {
    const r = await fetch(`${BRIDGE_HTTP}/feedback`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type, description }),
    });
    const j = (await r.json()) as { ok?: boolean; path?: string; error?: string };
    return { ok: !!j.ok, path: j.path, error: j.error };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/** Ask the bridge whether a newer release exists on GitHub. Silent while the repo is private. */
export async function checkForUpdate(): Promise<void> {
  try {
    const r = await fetch(`${BRIDGE_HTTP}/update/check`);
    const j = (await r.json()) as { updateAvailable?: boolean; latest?: string; downloadUrl?: string | null; releaseUrl?: string | null; notes?: string | null };
    if (j.updateAvailable && j.latest) {
      setState({ update: { latest: j.latest, downloadUrl: j.downloadUrl ?? null, releaseUrl: j.releaseUrl ?? null, notes: j.notes ?? null } });
    }
  } catch {
    /* offline / private repo — no update prompt */
  }
}

/** Dismiss the update banner for this session. */
export function dismissUpdate(): void {
  setState({ updateDismissed: true });
}

/** Switch to (or create) a project. The new project arrives via the WS "state" broadcast; the
 * chat is reloaded from the new project's folder (empty for a new project, restored for an old one). */
export async function openProject(name: string, action: "switch" | "create" | "delete" = "switch"): Promise<ProjectEntry[]> {
  localOps += 1;
  markLocalAction();
  try {
    const r = await fetch(`${BRIDGE_HTTP}/projects`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action, name }),
    });
    const j = await r.json();
    await loadChatHistory();
    return Array.isArray(j.projects) ? (j.projects as ProjectEntry[]) : [];
  } catch {
    return [];
  } finally {
    localOps -= 1;
    markLocalAction();
  }
}

function applyChatsView(j: { messages?: ChatTurn[]; list?: { id: string; title: string; ts: number }[]; activeId?: string }): void {
  setState({
    chat: Array.isArray(j.messages) ? j.messages : [],
    chatList: Array.isArray(j.list) ? j.list : [],
    activeChatId: typeof j.activeId === "string" ? j.activeId : "",
  });
}

/** Load this project's active conversation + the history list (empty for a brand-new project). */
export async function loadChatHistory(): Promise<void> {
  try {
    const r = await fetch(`${BRIDGE_HTTP}/chats`);
    applyChatsView(await r.json());
  } catch {
    /* keep current transcript */
  }
}

let chatSaveTimer: ReturnType<typeof setTimeout> | null = null;
/** Persist the active conversation's transcript into the project folder (debounced). */
export function saveChatHistory(): void {
  if (chatSaveTimer) clearTimeout(chatSaveTimer);
  chatSaveTimer = setTimeout(() => {
    void fetch(`${BRIDGE_HTTP}/chats`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "save", messages: state.chat }),
    });
  }, 500);
}

/** Start a fresh conversation (the current one stays in history). */
export async function newChat(): Promise<void> {
  if (chatSaveTimer) clearTimeout(chatSaveTimer);
  try {
    const r = await fetch(`${BRIDGE_HTTP}/chats`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "new" }),
    });
    applyChatsView(await r.json());
  } catch {
    /* ignore */
  }
}

/** Empty the current conversation's messages (keeps it in history, just wipes its content). */
export async function clearChat(): Promise<void> {
  if (chatSaveTimer) clearTimeout(chatSaveTimer);
  setState({ chat: [] });
  try {
    await fetch(`${BRIDGE_HTTP}/chats`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "save", messages: [] }),
    });
  } catch {
    /* ignore */
  }
}

/** applyChatsView but keeping the on-screen transcript (used to materialize an id mid-flow). */
function applyChatsViewKeepMessages(j: { list?: { id: string; title: string; ts: number }[]; activeId?: string }): void {
  setState({
    chatList: Array.isArray(j.list) ? j.list : [],
    activeChatId: typeof j.activeId === "string" ? j.activeId : state.activeChatId,
  });
}

/** Switch to a past conversation. */
export async function selectChat(id: string): Promise<void> {
  if (chatSaveTimer) clearTimeout(chatSaveTimer);
  try {
    const r = await fetch(`${BRIDGE_HTTP}/chats`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "select", id }),
    });
    applyChatsView(await r.json());
    // Coming back to the conversation a run is streaming into: show the LIVE transcript (the
    // saved snapshot on disk predates the in-flight turns).
    if (activeRun && activeRun.chatId === id) setState({ chat: [...activeRun.turns] });
  } catch {
    /* ignore */
  }
}

/** Ask the bridge to stop the running assistant turn at the next safe boundary. */
export async function stopChat(): Promise<void> {
  try {
    await fetch(`${BRIDGE_HTTP}/agent/chat/stop`, { method: "POST" });
  } catch {
    /* the stream's done event still clears busy state */
  }
}

/** Delete a conversation from history. */
export async function deleteChat(id: string): Promise<void> {
  try {
    const r = await fetch(`${BRIDGE_HTTP}/chats`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "delete", id }),
    });
    applyChatsView(await r.json());
  } catch {
    /* ignore */
  }
}

/** Store the user's Claude API key on the bridge so the in-app assistant can run. */
export function setAnthropicKey(key: string): void {
  socket?.send(JSON.stringify({ type: "setup", action: "set-anthropic-key", key }));
  setState({ agentHasKey: true });
}

export async function fetchAgentStatus(): Promise<void> {
  try {
    const r = await fetch(`${BRIDGE_HTTP}/agent/status`);
    const j = await r.json();
    setState({
      agentHasKey: !!j.hasKey,
      agentModels: j.models ?? [],
      canGenerate: !!j.canGenerate,
      claudeExpiresAt: j.claude?.expiresAt ?? null,
    });
  } catch {
    /* offline */
  }
}

// A run is BOUND to the conversation it started in: events mutate the run's own turn objects,
// and the view re-renders only while that conversation is the one on screen — switching away
// mid-run never leaks streaming output into another conversation.
interface ChatRun {
  chatId: string;
  asstTurn: ChatTurn;
  turns: ChatTurn[]; // full transcript to persist for the ORIGINATING conversation
}
let activeRun: ChatRun | null = null;

function applyChatEvent(ev: { type: string; text?: string; name?: string; isError?: boolean; message?: string }, run: ChatRun): void {
  const last = run.asstTurn;
  if (!last) return;
  if (ev.type === "text") last.text += (last.text ? "\n" : "") + (ev.text ?? "");
  else if (ev.type === "tool_use") (last.tools ??= []).push({ name: ev.name ?? "tool", text: "…" });
  else if (ev.type === "tool_result") {
    const t = last.tools?.[last.tools.length - 1];
    if (t) {
      t.text = ev.text ?? "";
      t.isError = ev.isError;
    }
  } else if (ev.type === "limit") last.limitHit = true;
  else if (ev.type === "error") last.text += `${last.text ? "\n" : ""}⚠️ ${ev.message ?? "error"}`;
  // Re-render only when the run's conversation is the one being viewed.
  if (state.activeChatId === run.chatId) setState({ chat: [...state.chat] });
}

/** Send a message to the in-app AI assistant; streams the agent's text + tool activity. */
export async function sendChat(text: string): Promise<void> {
  if (!text.trim() || state.chatBusy) return;
  const mentioned = state.selectedAssetIds.slice();
  // Materialize the conversation id BEFORE starting: the run must know where it belongs even if
  // the user switches conversations while it streams.
  if (!state.activeChatId) {
    try {
      const r = await fetch(`${BRIDGE_HTTP}/chats`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "save", messages: state.chat }),
      });
      applyChatsViewKeepMessages(await r.json());
    } catch {
      /* proceed without an id — worst case behaves like before */
    }
  }
  const history = state.chat.filter((t) => t.text.trim()).map((t) => ({ role: t.role, content: t.text }));
  const userTurn: ChatTurn = { role: "user", text };
  const asstTurn: ChatTurn = { role: "assistant", text: "", tools: [] };
  const run: ChatRun = { chatId: state.activeChatId, asstTurn, turns: [...state.chat, userTurn, asstTurn] };
  activeRun = run;
  setState({
    chat: [...state.chat, userTurn, asstTurn],
    chatBusy: true,
    busyChatId: run.chatId,
  });
  const messages = [...history, { role: "user", content: text }];
  try {
    const res = await fetch(`${BRIDGE_HTTP}/agent/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ messages, model: state.chatModel, mentionedMediaRefs: mentioned, chatId: run.chatId }),
    });
    if (!res.body) throw new Error("no stream");
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let idx: number;
      while ((idx = buf.indexOf("\n\n")) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 2);
        if (line.startsWith("data:")) {
          try {
            applyChatEvent(JSON.parse(line.slice(5).trim()), run);
          } catch {
            /* skip */
          }
        }
      }
    }
  } catch (e) {
    applyChatEvent({ type: "error", message: e instanceof Error ? e.message : String(e) }, run);
  } finally {
    markLocalAction(); // the in-app assistant's edits are this window's doing, not "external"
    // Persist the transcript to the ORIGINATING conversation (not whichever one is on screen now).
    void fetch(`${BRIDGE_HTTP}/chats`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "save", id: run.chatId, messages: run.turns }),
    }).catch(() => {});
    activeRun = null;
    setState({ chatBusy: false, busyChatId: "" });
    saveChatHistory(); // persist this project's conversation
  }
}

// ── clip selection, clipboard, track ops (used by Timeline / keyboard / Inspector) ──
function allClips(): Clip[] {
  return state.project ? state.project.timeline.tracks.flatMap((t) => t.clips) : [];
}
export function copyClips(): void {
  const ids = new Set(state.selectedClipIds);
  const clips = allClips()
    .filter((c) => ids.has(c.id))
    .map((c) => structuredClone(c));
  if (clips.length) setState({ clipboard: clips });
}
export function cutClips(): void {
  copyClips();
  if (state.selectedClipIds.length) {
    sendCommand("remove_clips", { clipIds: state.selectedClipIds });
    setState({ selectedClipIds: [] });
  }
}
export function pasteClips(): void {
  if (state.clipboard.length) sendCommand("paste_clips", { clips: state.clipboard, atFrame: state.playhead });
}
export function duplicateSelected(): void {
  if (state.selectedClipIds.length) sendCommand("duplicate_clips", { clipIds: state.selectedClipIds });
}
export function deleteSelected(): void {
  if (state.selectedClipIds.length) {
    sendCommand("remove_clips", { clipIds: state.selectedClipIds });
    setState({ selectedClipIds: [] });
  }
}
export function setTrackProps(trackIndex: number, patch: { muted?: boolean; hidden?: boolean; locked?: boolean }): void {
  sendCommand("set_track_properties", { trackIndex, ...patch });
}
/** Solo an audio track: mute every other audio track, unmute this one. */
export function soloTrack(trackIndex: number): void {
  const tracks = state.project?.timeline.tracks ?? [];
  tracks.forEach((t, i) => {
    if (t.type === "audio") sendCommand("set_track_properties", { trackIndex: i, muted: i !== trackIndex });
  });
}
export function trimClipEdge(clipId: string, edge: "left" | "right", deltaFrames: number, ripple = false): void {
  if (deltaFrames !== 0) sendCommand("trim_clip", { clipId, edge, deltaFrames, ripple });
}

export function useEditor(): EditorState {
  return useSyncExternalStore(subscribe, getSnapshot, () => state);
}

// ── local UI actions ──
export const ui = {
  setPlayhead: (f: number) => setState({ playhead: Math.max(0, Math.round(f)) }),
  advance: (n: number, max: number) => setState({ playhead: Math.min(max, Math.max(0, state.playhead + n)) }),
  setZoom: (pxPerFrame: number) => setState({ pxPerFrame: Math.min(20, Math.max(0.1, pxPerFrame)) }),
  select: (ids: string[]) => setState({ selectedClipIds: ids, selectedAssetIds: [] }),
  setPlaying: (playing: boolean) => setState({ playing }),
  setTool: (tool: "select" | "blade") => setState({ tool }),
  toggleAsset: (id: string, additive: boolean) =>
    setState({
      selectedClipIds: [],
      selectedAssetIds: additive
        ? state.selectedAssetIds.includes(id)
          ? state.selectedAssetIds.filter((x) => x !== id)
          : [...state.selectedAssetIds, id]
        : state.selectedAssetIds.length === 1 && state.selectedAssetIds[0] === id
          ? []
          : [id],
    }),
  clearAssets: () => setState({ selectedAssetIds: [] }),
  setChatModel: (m: string) => setState({ chatModel: m }),
  // multi-clip selection
  toggleClip: (id: string, additive: boolean) =>
    setState({
      selectedAssetIds: [],
      selectedClipIds: additive
        ? state.selectedClipIds.includes(id)
          ? state.selectedClipIds.filter((x) => x !== id)
          : [...state.selectedClipIds, id]
        : [id],
    }),
  selectClips: (ids: string[]) => setState({ selectedClipIds: ids, selectedAssetIds: [] }),
  // panels / layout / prefs
  togglePanel: (name: "chat" | "media" | "inspector") => setState({ panels: { ...state.panels, [name]: !state.panels[name] } }),
  setMaximized: (m: "preview" | "timeline" | null) => setState({ maximized: state.maximized === m ? null : m }),
  setSnapping: (b: boolean) => setState({ snapping: b }),
  setRange: (inF: number | null, outF: number | null) => setState({ rangeIn: inF, rangeOut: outF }),
  // Source tabs above the monitor, Palmier-style: opening adds a tab (or refocuses it),
  // the Timeline tab is always first, closing a tab falls back to the Timeline view.
  openSource: (assetId: string) =>
    setState({
      openSourceIds: state.openSourceIds.includes(assetId) ? state.openSourceIds : [...state.openSourceIds, assetId],
      sourceAssetId: assetId,
    }),
  closeSource: (assetId?: string) => {
    const id = assetId ?? state.sourceAssetId;
    if (!id) return;
    setState({
      openSourceIds: state.openSourceIds.filter((x) => x !== id),
      sourceAssetId: state.sourceAssetId === id ? null : state.sourceAssetId,
    });
  },
  showTimelineTab: () => setState({ sourceAssetId: null }),
  setPalette: (open: boolean) => setState({ paletteOpen: open }),
};
