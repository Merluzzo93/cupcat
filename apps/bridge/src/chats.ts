// Per-project chat conversations, stored in <projectRoot>/.cupcat/chats.json. Each project keeps a
// list of conversations (history) with one active; a new project starts empty. Migrates the older
// single-conversation chat.json on first read.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { projectRoot } from "./config";

export interface ChatMsg {
  role: string;
  text: string;
  tools?: unknown[];
}
export interface Conversation {
  id: string;
  title: string;
  ts: number;
  messages: ChatMsg[];
}
interface ChatsFile {
  activeId: string;
  conversations: Conversation[];
}

const cupcatDir = () => join(projectRoot, ".cupcat");
const chatsFile = () => join(cupcatDir(), "chats.json");
const legacyFile = () => join(cupcatDir(), "chat.json");

let counter = 0;
function newId(): string {
  return `c${Date.now().toString(36)}${(counter++).toString(36)}`;
}

function titleOf(messages: ChatMsg[]): string {
  const first = messages.find((m) => m.role === "user" && m.text && m.text.trim());
  return first ? first.text.trim().replace(/\s+/g, " ").slice(0, 48) : "New chat";
}

async function load(): Promise<ChatsFile> {
  try {
    const d = JSON.parse(await readFile(chatsFile(), "utf8")) as ChatsFile;
    if (Array.isArray(d.conversations)) return d;
  } catch {
    /* fall through */
  }
  // migrate the older single chat.json (one conversation)
  try {
    const old = JSON.parse(await readFile(legacyFile(), "utf8")) as { chat?: ChatMsg[] };
    if (Array.isArray(old.chat) && old.chat.length) {
      const c: Conversation = { id: newId(), title: titleOf(old.chat), ts: Date.now(), messages: old.chat };
      return { activeId: c.id, conversations: [c] };
    }
  } catch {
    /* none */
  }
  return { activeId: "", conversations: [] };
}

async function persist(d: ChatsFile): Promise<void> {
  await mkdir(cupcatDir(), { recursive: true });
  await writeFile(chatsFile(), JSON.stringify(d));
}

export interface ChatsView {
  activeId: string;
  list: { id: string; title: string; ts: number }[];
  messages: ChatMsg[];
}

function view(d: ChatsFile): ChatsView {
  const active = d.conversations.find((c) => c.id === d.activeId) ?? d.conversations[0];
  return {
    activeId: active?.id ?? "",
    list: d.conversations.map((c) => ({ id: c.id, title: c.title, ts: c.ts })).sort((a, b) => b.ts - a.ts),
    messages: active?.messages ?? [],
  };
}

export async function getChats(): Promise<ChatsView> {
  return view(await load());
}

/** Save the active conversation's messages (creates one if none active). */
export async function saveActiveChat(messages: ChatMsg[]): Promise<void> {
  return saveChat("", messages);
}

/** Save a SPECIFIC conversation's messages (empty id = the active one). A run started in one
 * conversation must land its transcript there even if the user switched view mid-run. */
export async function saveChat(id: string, messages: ChatMsg[]): Promise<void> {
  const d = await load();
  let target = id ? d.conversations.find((c) => c.id === id) : d.conversations.find((c) => c.id === d.activeId);
  if (!target) {
    target = { id: id || newId(), title: "New chat", ts: Date.now(), messages: [] };
    d.conversations.push(target);
    if (!id) d.activeId = target.id;
  }
  const active = target;
  active.messages = messages;
  active.ts = Date.now();
  if (!active.title || active.title === "New chat") active.title = titleOf(messages);
  await persist(d);
}

export async function newChat(): Promise<ChatsView> {
  const d = await load();
  const c: Conversation = { id: newId(), title: "New chat", ts: Date.now(), messages: [] };
  d.conversations.push(c);
  d.activeId = c.id;
  await persist(d);
  return view(d);
}

export async function selectChat(id: string): Promise<ChatsView> {
  const d = await load();
  if (d.conversations.some((c) => c.id === id)) {
    d.activeId = id;
    await persist(d);
  }
  return view(d);
}

export async function deleteChat(id: string): Promise<ChatsView> {
  const d = await load();
  d.conversations = d.conversations.filter((c) => c.id !== id);
  if (d.activeId === id) d.activeId = d.conversations[0]?.id ?? "";
  await persist(d);
  return view(d);
}

/** Compact context from the OTHER conversations of this project: title + the last assistant
 * message (the wrap-ups carry quantified summaries by instruction). Lets a new conversation
 * start already knowing what was done, without re-deriving anything. */
export async function conversationSummaries(excludeId?: string): Promise<string> {
  const d = await load();
  const others = d.conversations
    .filter((c) => c.id !== excludeId && c.messages.length > 0)
    .sort((a, b) => b.ts - a.ts)
    .slice(0, 3);
  if (!others.length) return "";
  const lines = others.map((c) => {
    const lastA = [...c.messages].reverse().find((m) => m.role === "assistant" && m.text.trim());
    const snippet = (lastA?.text ?? "").replace(/\s+/g, " ").trim().slice(0, 320);
    return `- "${c.title}": ${snippet || "(nessun esito registrato)"}`;
  });
  const joined = lines.join("\n");
  return `\n\n# Previous conversations in this project (context only — the work described is DONE, do not redo or re-verify it)\n${joined}`;
}
