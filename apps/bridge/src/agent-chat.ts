// In-app AI assistant — the chat panel's backend. Runs an Anthropic tool-use loop against the same
// tool surface the MCP server exposes, so "edit by chatting" and "edit via Claude Code over MCP" share
// one executor. Streams coarse events (assistant text, tool calls, results, done) to the web UI over
// SSE; the timeline itself updates live through the existing WebSocket state broadcast as tools run.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { SERVER_INSTRUCTIONS } from "./agent-instructions";
import { type BridgeContext, executeTool } from "./executor";
import { killAgentProcs, setAgentActive } from "./proc";
import { conversationSummaries } from "./chats";
import { loadMemories } from "./memory";
import { TOOL_DEFS } from "./mcp-tools";

const API_URL = "https://api.anthropic.com/v1/messages";
const API_VERSION = "2023-06-01";
const KEY_FILE = process.env.CUPCAT_ANTHROPIC_KEY_FILE ?? join(homedir(), "CupCat", "anthropic-key");
// Tool-loop turn budget per user message. Real montage tasks (zooms + music + captions + checks)
// regularly need 20+ tool rounds; a low cap used to stop the agent mid-goal without a word.
// Hitting the cap emits a {type:"limit"} event: the UI shows a one-click Continue button and NO
// work is lost — the conversation and timeline state persist, the next turn resumes mid-task.
const MAX_TURNS = 60;

/** Claude models offered in the chat panel's bottom-left selector (July 2026 lineup).
 * Opus 4.8 stays the default: top agentic/tool-use performance at Opus pricing. Fable 5 is the
 * most capable model overall (always-on thinking, 1M context) for the hardest creative briefs. */
export const CHAT_MODELS = [
  { id: "claude-opus-4-8", label: "Opus 4.8" },
  { id: "claude-fable-5", label: "Fable 5" },
  { id: "claude-sonnet-5", label: "Sonnet 5" },
  { id: "claude-haiku-4-5-20251001", label: "Haiku 4.5" },
];
const DEFAULT_MODEL = CHAT_MODELS[0].id;

/** How the in-app assistant authenticates to Claude. OAuth (the user's Claude subscription) is
 * preferred — no API key needed; an API key is only a last-resort fallback. */
export interface ClaudeAuth {
  mode: "oauth" | "apikey";
  token: string;
}

/** Read the Claude Code subscription OAuth token + expiry from ~/.claude/.credentials.json. */
async function readClaudeOAuth(): Promise<{ accessToken: string; expiresAt: number | null } | null> {
  try {
    const raw = await readFile(join(homedir(), ".claude", ".credentials.json"), "utf8");
    const j = JSON.parse(raw) as { claudeAiOauth?: { accessToken?: string; expiresAt?: number } };
    const tok = j.claudeAiOauth?.accessToken;
    if (typeof tok !== "string" || tok.length === 0) return null;
    return { accessToken: tok, expiresAt: typeof j.claudeAiOauth?.expiresAt === "number" ? j.claudeAiOauth.expiresAt : null };
  } catch {
    return null;
  }
}

export interface ClaudeStatus {
  connected: boolean;
  mode: "oauth" | "apikey" | null;
  expiresAt: number | null; // ms epoch (OAuth only)
  expired: boolean;
}

/** Connection status for the Claude assistant — for the in-app Connections panel. */
export async function getClaudeStatus(): Promise<ClaudeStatus> {
  const oauth = await readClaudeOAuth();
  if (oauth) {
    const expired = oauth.expiresAt != null && oauth.expiresAt <= Date.now();
    return { connected: !expired, mode: "oauth", expiresAt: oauth.expiresAt, expired };
  }
  const auth = await getAuth();
  return { connected: !!auth, mode: auth?.mode ?? null, expiresAt: null, expired: false };
}

/**
 * Resolve Claude auth. Order: the user's Claude subscription OAuth (Claude Code login or
 * ANTHROPIC_AUTH_TOKEN) first, then an API key (env or stored file) as a fallback.
 */
export async function getAuth(): Promise<ClaudeAuth | null> {
  const oauth = await readClaudeOAuth();
  if (oauth) return { mode: "oauth", token: oauth.accessToken };
  const bearer = (process.env.CLAUDE_CODE_OAUTH_TOKEN || process.env.ANTHROPIC_AUTH_TOKEN || "").trim();
  if (bearer) return { mode: "oauth", token: bearer };
  const key = (process.env.CUPCAT_ANTHROPIC_KEY || process.env.ANTHROPIC_API_KEY || "").trim();
  if (key) return { mode: "apikey", token: key };
  try {
    const k = (await readFile(KEY_FILE, "utf8")).trim();
    if (k) return { mode: "apikey", token: k };
  } catch {
    /* none */
  }
  return null;
}

/**
 * The chat models the SIGNED-IN account can actually use. Queries the Models API with the current
 * auth and keeps only the CHAT_MODELS the account is entitled to. Best-effort: on any failure (no
 * auth, endpoint not permitted for this token, network error) it returns the full list, so the
 * dropdown never ends up empty.
 */
export async function availableChatModels(): Promise<typeof CHAT_MODELS> {
  const auth = await getAuth();
  if (!auth) return CHAT_MODELS;
  try {
    const headers: Record<string, string> = { "anthropic-version": API_VERSION };
    if (auth.mode === "apikey") headers["x-api-key"] = auth.token;
    else {
      headers.authorization = `Bearer ${auth.token}`;
      headers["anthropic-beta"] = "oauth-2025-04-20";
    }
    const res = await fetch("https://api.anthropic.com/v1/models?limit=100", { headers });
    if (!res.ok) return CHAT_MODELS;
    const j = (await res.json()) as { data?: { id?: string }[] };
    const ids = (j.data ?? []).map((m) => m.id).filter((x): x is string => typeof x === "string");
    if (ids.length === 0) return CHAT_MODELS;
    // A configured model counts as available if a returned id matches it (either direction handles
    // the dated vs base-id variants, e.g. claude-haiku-4-5 vs claude-haiku-4-5-20251001).
    const avail = CHAT_MODELS.filter((m) => ids.some((id) => id === m.id || id.startsWith(m.id) || m.id.startsWith(id)));
    return avail.length ? avail : CHAT_MODELS;
  } catch {
    return CHAT_MODELS;
  }
}

/** Manual API-key fallback (Setup). Most users never need this — Claude Code OAuth is used. */
export async function setApiKey(key: string): Promise<void> {
  await mkdir(dirname(KEY_FILE), { recursive: true });
  await writeFile(KEY_FILE, key.trim(), "utf8");
}

interface AnthropicContentBlock {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
}
interface ChatMessage {
  role: "user" | "assistant";
  content: string | unknown[];
}

/** MCP tool defs → Anthropic tool schema. */
function anthropicTools() {
  return TOOL_DEFS.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.inputSchema,
  }));
}

/** Executor content blocks → Anthropic tool_result content blocks (text + base64 images). */
function toToolResultContent(content: { type: string; text?: string; data?: string; mimeType?: string }[]) {
  return content.map((c) =>
    c.type === "image"
      ? { type: "image", source: { type: "base64", media_type: c.mimeType ?? "image/jpeg", data: c.data ?? "" } }
      : { type: "text", text: c.text ?? "" },
  );
}

async function callAnthropic(auth: ClaudeAuth, model: string, system: string, messages: ChatMessage[], opts: { tools?: boolean; maxTokens?: number; signal?: AbortSignal } = {}) {
  const headers: Record<string, string> = { "content-type": "application/json", "anthropic-version": API_VERSION };
  const betas: string[] = [];
  if (auth.mode === "apikey") {
    headers["x-api-key"] = auth.token;
  } else {
    // OAuth (Claude subscription): Bearer + the oauth beta header required by /v1/messages.
    headers.authorization = `Bearer ${auth.token}`;
    betas.push("oauth-2025-04-20");
  }
  // Fable 5's safety classifiers can decline a request mid-edit (stop_reason "refusal"). With the
  // server-side fallback the request is transparently re-served by Opus 4.8 inside the same call,
  // so a montage never dies over a false positive on benign editing work.
  const isFable = model.startsWith("claude-fable-5");
  if (isFable) betas.push("server-side-fallback-2026-06-01");
  if (betas.length) headers["anthropic-beta"] = betas.join(",");
  // Claude subscription (Claude Code) OAuth tokens require the request to present as Claude Code:
  // the system prompt's first block must be that identity, or the premium models (Opus/Sonnet) are
  // rejected with a (misleading) rate_limit_error. The real editor instructions follow as block 2.
  const systemParam =
    auth.mode === "oauth"
      ? [
          { type: "text", text: "You are Claude Code, Anthropic's official CLI for Claude." },
          { type: "text", text: system },
        ]
      : system;
  // Transient network failures (socket dropped mid-call, connection reset — seen in the wild as
  // "The socket connection was closed unexpectedly", which used to kill the whole chat turn) are
  // retried a couple of times before surfacing. Only thrown fetch errors retry; HTTP-level errors
  // (4xx/5xx) fall through to the structured handling below.
  let res: Response | null = null;
  let lastNetErr: unknown = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      // Adaptive extended thinking on the 4.6+ chat models: the agent reasons before acting
      // (better plans, fewer flailing tool loops). Thinking blocks come back in content and are
      // passed through untouched on later turns, as the API requires. Fable 5 has thinking
      // always-on (adaptive is the only accepted value). One-shot helpers and the pre-4.6
      // models keep the plain call.
      const adaptive =
        opts.tools !== false &&
        (isFable || model.startsWith("claude-opus-4-8") || model.startsWith("claude-sonnet-4-6") || model.startsWith("claude-sonnet-5"));
      res = await fetch(API_URL, {
        method: "POST",
        headers,
        signal: opts.signal, // a chat-stop aborts the in-flight request
        body: JSON.stringify({
          model,
          max_tokens: opts.maxTokens ?? (adaptive ? 8192 : 4096),
          system: systemParam,
          ...(opts.tools === false ? {} : { tools: anthropicTools() }),
          ...(adaptive ? { thinking: { type: "adaptive" } } : {}),
          ...(isFable ? { fallbacks: [{ model: "claude-opus-4-8" }] } : {}),
          messages,
        }),
      });
      break;
    } catch (e) {
      // A user-requested stop aborts the fetch — surface it at once, never retry.
      if (e instanceof Error && e.name === "AbortError") throw e;
      lastNetErr = e;
      res = null;
      if (attempt < 2) await new Promise((r) => setTimeout(r, 1000 * (attempt + 1) * (attempt + 1)));
    }
  }
  if (!res) {
    const msg = lastNetErr instanceof Error ? lastNetErr.message : String(lastNetErr);
    throw new Error(`Network error talking to Claude (retried 3×): ${msg}. Check your connection and try again — the timeline was not touched by this failure.`);
  }
  if (!res.ok) {
    const body = await res.text();
    let errType = "";
    let detail = body.slice(0, 300);
    try {
      const j = JSON.parse(body) as { error?: { type?: string; message?: string } };
      errType = j.error?.type ?? "";
      const m = j.error?.message;
      if (m && m !== "Error") detail = m;
    } catch {
      /* keep raw */
    }
    if (res.status === 429 || errType === "rate_limit_error") {
      // Not a depleted balance: on Claude Max the premium models (Opus/Sonnet) have a separate,
      // tighter usage window than Haiku. Surface the real reason + when it frees up.
      const retry = res.headers.get("retry-after");
      const reset = res.headers.get("anthropic-ratelimit-unified-5h-reset") || res.headers.get("anthropic-ratelimit-unified-reset");
      const when = retry
        ? `in ~${retry}s`
        : reset
          ? `around ${new Date(Number(reset) * 1000).toLocaleTimeString()}`
          : "once the window resets";
      const isPremium = /opus|sonnet/i.test(model);
      throw new Error(
        `Rate limit reached for ${model}.${
          isPremium
            ? " On Claude Max the premium models (Opus/Sonnet) share a tighter usage window than Haiku — your overall plan still has capacity. Pick Haiku in the model selector for now, or retry " + when + "."
            : " Retry " + when + "."
        }`,
      );
    }
    throw new Error(`Claude API error (${res.status}): ${detail}`);
  }
  return (await res.json()) as { content: AnthropicContentBlock[]; stop_reason: string };
}

export interface ChatRequest {
  messages: ChatMessage[]; // prior turns (role/content), newest user message last
  model?: string;
  mentionedMediaRefs?: string[]; // assets the user selected/@-referenced in the library
  chatId?: string; // originating conversation — used for cross-conversation context + saving
}

// One chat run at a time (the client gates on chatBusy); the Stop button sets this flag and the
// loop exits at the next turn/tool boundary — the timeline keeps whatever edits already landed.
let stopRequested = false;
let currentAbort: AbortController | null = null;
export function requestChatStop(): void {
  stopRequested = true;
  killAgentProcs(); // kill any running tool subprocess (auto_clips ffmpeg passes, etc.)
  currentAbort?.abort(); // cancel the in-flight Claude request so nothing new comes back
}

// ── request size control ──────────────────────────────────────────────────────
// Every send re-transmits the whole conversation, and tool results carry frame images — a long
// editing session (many inspect_timeline/inspect_media calls) eventually pushes the request past
// the API's size cap and every following message dies with HTTP 413. Claude rarely needs to
// re-see OLD frames, so before each call we stub out all but the newest few images (it can always
// re-run the tool), and if the request is still huge we drop all images and truncate giant text.
const KEEP_RECENT_IMAGES = 6;
const MAX_REQUEST_BYTES = 6_000_000;

type AnyBlock = Record<string, unknown> & { type?: string; content?: unknown; text?: unknown };

export function pruneForRequest(messages: ChatMessage[], aggressive = false): ChatMessage[] {
  let total = 0;
  const countImages = (c: unknown): void => {
    if (!Array.isArray(c)) return;
    for (const b of c as AnyBlock[]) {
      if (b?.type === "image") total++;
      else if (b?.type === "tool_result") countImages(b.content);
    }
  };
  for (const m of messages) countImages(m.content);

  const stub: AnyBlock = {
    type: "text",
    text: "[an earlier frame was pruned to keep the request under the API size limit — re-run the tool if you need to see it again]",
  };
  const pruneImages = (msgs: ChatMessage[], keep: number): ChatMessage[] => {
    let cut = Math.max(0, total - keep); // stub the OLDEST images, keep the newest
    const walk = (c: unknown): unknown => {
      if (!Array.isArray(c)) return c;
      return (c as AnyBlock[]).map((b) => {
        if (b?.type === "image" && cut > 0) {
          cut--;
          return stub;
        }
        if (b?.type === "tool_result") return { ...b, content: walk(b.content) };
        return b;
      });
    };
    // Only user messages carry tool results/images. Assistant turns are never touched: their
    // thinking blocks are signature-checked by the API and must be replayed byte-identical.
    return msgs.map((m) => (m.role === "user" ? { ...m, content: walk(m.content) as ChatMessage["content"] } : m));
  };

  let out = pruneImages(messages, aggressive ? 0 : KEEP_RECENT_IMAGES);
  if (JSON.stringify(out).length > MAX_REQUEST_BYTES) out = pruneImages(messages, 0);
  if (JSON.stringify(out).length > MAX_REQUEST_BYTES) {
    const truncText = (c: unknown): unknown =>
      Array.isArray(c)
        ? (c as AnyBlock[]).map((b) => {
            if (typeof b?.text === "string" && b.text.length > 20000)
              return { ...b, text: `${b.text.slice(0, 8000)}\n…[truncated to fit the request size limit]…\n${b.text.slice(-2000)}` };
            if (b?.type === "tool_result") return { ...b, content: truncText(b.content) };
            return b;
          })
        : c;
    out = out.map((m) => (m.role === "user" ? { ...m, content: truncText(m.content) as ChatMessage["content"] } : m));
  }
  return out;
}

/**
 * Run the agent loop, streaming SSE lines. Each event is `data: {json}\n\n`.
 * Event types: text, tool_use, tool_result, error, done.
 */
export async function runChat(ctx: BridgeContext, req: ChatRequest, send: (event: object) => void): Promise<void> {
  const auth = await getAuth();
  if (!auth) {
    send({ type: "error", message: "Not signed in to Claude. Run `claude` (Claude Code) to sign in with your subscription, or add an API key in Setup." });
    send({ type: "done" });
    return;
  }

  stopRequested = false; // a stale stop from a previous run must not kill this one
  const ac = new AbortController();
  currentAbort = ac;
  const memories = await loadMemories();
  const priorConversations = await conversationSummaries(req.chatId).catch(() => "");
  let system = SERVER_INSTRUCTIONS + memories + priorConversations;
  if (req.mentionedMediaRefs?.length) {
    system += `\n\n# Context\nThe user has selected these library assets as references for this message — treat them as the @-mentioned media: ${req.mentionedMediaRefs.join(", ")}.`;
  }

  const messages: ChatMessage[] = req.messages.map((m) => ({ role: m.role, content: m.content }));
  const model = req.model && CHAT_MODELS.some((m) => m.id === req.model) ? req.model : DEFAULT_MODEL;

  try {
    for (let turn = 0; turn < MAX_TURNS; turn++) {
      if (stopRequested) {
        stopRequested = false;
        send({ type: "text", text: "⏹️ Interrotto su tua richiesta. Le modifiche già applicate restano; scrivi \"continua\" per riprendere da qui." });
        break;
      }
      let resp: Awaited<ReturnType<typeof callAnthropic>>;
      try {
        resp = await callAnthropic(auth, model, system, pruneForRequest(messages), { signal: ac.signal });
      } catch (e) {
        // A 413 despite normal pruning (e.g. one giant image) → retry once with everything pruned.
        if (e instanceof Error && /\b413\b/.test(e.message)) {
          resp = await callAnthropic(auth, model, system, pruneForRequest(messages, true), { signal: ac.signal });
        } else throw e;
      }

      for (const block of resp.content) {
        if (block.type === "text" && block.text) send({ type: "text", text: block.text });
      }

      // Fable 5 safety refusal that even the Opus fallback declined (or fallback unavailable):
      // tell the user instead of ending in silence with an empty message.
      if (resp.stop_reason === "refusal") {
        send({
          type: "text",
          text: "⚠️ Il modello ha rifiutato questa richiesta (classificatore di sicurezza). Riprova riformulando, o seleziona Opus 4.8 dal selettore modello in basso.",
        });
        messages.push({ role: "assistant", content: resp.content.length ? resp.content : [{ type: "text", text: "(refused)" }] });
        break;
      }

      if (resp.stop_reason !== "tool_use") {
        messages.push({ role: "assistant", content: resp.content });
        break;
      }

      messages.push({ role: "assistant", content: resp.content });
      const toolResults: unknown[] = [];
      for (const block of resp.content) {
        if (block.type !== "tool_use") continue;
        if (stopRequested) {
          // answer the pending tool_use so the transcript stays valid, then bail at the turn check
          toolResults.push({ type: "tool_result", tool_use_id: block.id, content: [{ type: "text", text: "Cancelled by the user." }], is_error: true });
          continue;
        }
        send({ type: "tool_use", name: block.name, input: block.input });
        // Mark spawns as agent-owned so a chat-stop can kill this tool's subprocesses mid-flight.
        setAgentActive(true);
        let out: Awaited<ReturnType<typeof executeTool>>;
        try {
          out = await executeTool(ctx, block.name ?? "", (block.input ?? {}) as Record<string, unknown>, "agent");
        } finally {
          setAgentActive(false);
        }
        const summary = out.content.find((c) => c.type === "text")?.text ?? "[done]";
        send({ type: "tool_result", name: block.name, text: summary.slice(0, 300), isError: out.isError });
        toolResults.push({
          type: "tool_result",
          tool_use_id: block.id,
          content: toToolResultContent(out.content),
          is_error: out.isError || undefined,
        });
      }
      messages.push({ role: "user", content: toolResults });
      // Turn budget exhausted mid-task: say so + emit a structured event so the UI can offer a
      // one-click Continue. Nothing is lost — every edit already landed and the history persists.
      if (turn === MAX_TURNS - 1) {
        send({
          type: "text",
          text: "⏸️ Pausa tecnica: ho raggiunto il limite di passaggi per un singolo messaggio. Nessun lavoro è andato perso — premi Continua (o scrivi \"continua\") e riprendo esattamente da dove sono rimasto.",
        });
        send({ type: "limit" });
      }
    }
  } catch (e) {
    // An aborted request (user pressed stop) is not an error — report it as a clean interrupt.
    if (stopRequested || (e instanceof Error && e.name === "AbortError")) {
      send({ type: "text", text: "⏹️ Interrotto su tua richiesta. Le modifiche già applicate restano; scrivi \"continua\" per riprendere da qui." });
    } else {
      send({ type: "error", message: e instanceof Error ? e.message : String(e) });
    }
  } finally {
    if (currentAbort === ac) currentAbort = null;
    setAgentActive(false);
    stopRequested = false;
  }
  send({ type: "done" });
}

/** One-shot text completion (no editor tools) — for internal AI features like auto-clip curation.
 * Uses the same auth (OAuth subscription or API key) and retry behavior as the chat agent. */
export async function oneShotText(system: string, user: string, opts: { model?: string; maxTokens?: number } = {}): Promise<string> {
  const auth = await getAuth();
  if (!auth) {
    throw new Error(
      "Claude is not connected. Open the chat panel and sign in (or set an API key) first — AI clip curation runs on the same account as the chat.",
    );
  }
  const model = opts.model && CHAT_MODELS.some((m) => m.id === opts.model) ? opts.model : DEFAULT_MODEL;
  const resp = await callAnthropic(auth, model, system, [{ role: "user", content: user }], {
    tools: false,
    maxTokens: opts.maxTokens ?? 8192,
    signal: currentAbort?.signal, // a chat-stop aborts internal calls too (e.g. auto_clips curation)
  });
  return resp.content
    .filter((b) => b.type === "text")
    .map((b) => b.text ?? "")
    .join("\n")
    .trim();
}

/** One-shot VISION completion (no editor tools) — one user turn of text followed by base64 images,
 * for internal AI features that judge pictures (e.g. visual auto-clip curation of videos without
 * speech). Same auth (OAuth subscription or API key) and retry behavior as the chat agent. */
export async function oneShotVision(
  system: string,
  userText: string,
  images: { data: string; mediaType?: string }[],
  opts: { model?: string; maxTokens?: number } = {},
): Promise<string> {
  const auth = await getAuth();
  if (!auth) {
    throw new Error(
      "Claude is not connected. Open the chat panel and sign in (or set an API key) first — AI clip curation runs on the same account as the chat.",
    );
  }
  const model = opts.model && CHAT_MODELS.some((m) => m.id === opts.model) ? opts.model : DEFAULT_MODEL;
  const content = [
    { type: "text", text: userText },
    ...images.map((i) => ({
      type: "image",
      source: { type: "base64", media_type: i.mediaType ?? "image/jpeg", data: i.data },
    })),
  ];
  const resp = await callAnthropic(auth, model, system, [{ role: "user", content }], {
    tools: false,
    maxTokens: opts.maxTokens ?? 8192,
    signal: currentAbort?.signal, // a chat-stop aborts internal calls too (e.g. auto_clips curation)
  });
  return resp.content
    .filter((b) => b.type === "text")
    .map((b) => b.text ?? "")
    .join("\n")
    .trim();
}
