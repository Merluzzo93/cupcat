// Auto-learning memory. Two markdown stores, injected into the MCP server instructions at
// connect time so Claude starts every session already knowing the user + project, and a
// `remember` tool to append learnings as work happens.
//   - global  (~/CupCat/memory.md)          → who the user is + cross-project preferences
//   - project (<projectRoot>/.cupcat/memory.md) → facts/decisions specific to this project

import { appendFile, mkdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { projectRoot } from "./config";

// Computed at call time so it follows runtime project switches (projectRoot is a live binding).
const projectMemoryFile = () => process.env.CUPCAT_PROJECT_MEMORY ?? join(projectRoot, ".cupcat", "memory.md");
const GLOBAL_MEMORY = process.env.CUPCAT_GLOBAL_MEMORY ?? join(homedir(), "CupCat", "memory.md");

async function readIf(path: string): Promise<string> {
  try {
    return (await readFile(path, "utf8")).trim();
  } catch {
    return "";
  }
}

/** Markdown block appended to the server instructions when a client connects. */
export async function loadMemories(): Promise<string> {
  const [g, p] = await Promise.all([readIf(GLOBAL_MEMORY), readIf(projectMemoryFile())]);
  if (!g && !p) return "";
  let out =
    "\n\n# Learned memory — read first\nWhat you already know about this user and project, saved from past sessions. Apply it proactively, without being asked.\n";
  if (g) out += `\n## Global (across all the user's CupCat projects)\n${g}\n`;
  if (p) out += `\n## This project\n${p}\n`;
  return out;
}

export async function appendMemory(scope: "project" | "global", note: string): Promise<void> {
  const file = scope === "global" ? GLOBAL_MEMORY : projectMemoryFile();
  await mkdir(dirname(file), { recursive: true });
  const stamp = new Date().toISOString().slice(0, 10);
  await appendFile(file, `- (${stamp}) ${note.replace(/\s+/g, " ").trim()}\n`, "utf8");
}
