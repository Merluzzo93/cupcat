// Auto-provisioning of the OFFICIAL Claude Code CLI so a fresh PC can connect Claude with only a
// browser sign-in — the same UX as Higgsfield. CupCat does NOT implement Anthropic's OAuth itself
// (that would mean impersonating Claude Code and is disallowed). It only orchestrates the official
// binary:
//   1. install it via Anthropic's official installer (https://claude.ai/install.ps1) if missing,
//   2. run `claude auth login --claudeai`, which opens the browser AND prints a sign-in URL,
//   3. relay the code the user pastes back from the browser to that login's stdin.
// The official client performs the whole OAuth exchange and writes ~/.claude/.credentials.json,
// which CupCat then reads (see agent-chat.ts). We are a launcher, not an auth implementation.

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Anthropic's official Windows installer for the native Claude Code build. */
const INSTALL_PS1 = "https://claude.ai/install.ps1";

/** Resolve the official `claude` executable: native install dir first, then PATH. */
export function resolveClaudeBin(): string {
  const bin = join(homedir(), ".local", "bin");
  for (const name of ["claude.exe", "claude"]) {
    const p = join(bin, name);
    if (existsSync(p)) return p;
  }
  return "claude"; // fall back to PATH (npm global, or a freshly PATH-added native install)
}

/** True if a working `claude` binary is available. */
export async function claudeInstalled(): Promise<boolean> {
  try {
    const proc = Bun.spawn([resolveClaudeBin(), "--version"], {
      stdout: "ignore",
      stderr: "ignore",
      stdin: "ignore",
    });
    return (await proc.exited) === 0;
  } catch {
    return false;
  }
}

/** Stream a subprocess's stdout+stderr line-by-line to `onLine` until it exits. */
async function pump(proc: Bun.Subprocess, onLine: (line: string) => void): Promise<void> {
  const dec = new TextDecoder();
  const drain = async (stream: ReadableStream<Uint8Array> | undefined) => {
    if (!stream) return;
    const reader = stream.getReader();
    let buf = "";
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let nl: number;
        while ((nl = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, nl).replace(/\r$/, "").trim();
          buf = buf.slice(nl + 1);
          if (line) onLine(line);
        }
      }
    } catch {
      /* stream closed */
    } finally {
      const tail = buf.trim();
      if (tail) onLine(tail);
      reader.releaseLock();
    }
  };
  await Promise.all([drain(proc.stdout as ReadableStream<Uint8Array>), drain(proc.stderr as ReadableStream<Uint8Array>)]);
}

/** Install the official Claude Code via Anthropic's PowerShell installer. Best-effort progress. */
export async function installClaudeCode(onLog: (line: string) => void): Promise<boolean> {
  onLog("Downloading the official Claude Code…");
  try {
    const proc = Bun.spawn(
      ["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", `irm ${INSTALL_PS1} | iex`],
      { stdout: "pipe", stderr: "pipe", stdin: "ignore" },
    );
    await pump(proc, onLog);
    const code = await proc.exited;
    if (code !== 0) {
      onLog(`Installer exited with code ${code}.`);
      return false;
    }
  } catch (e) {
    onLog(`Could not run the installer: ${e instanceof Error ? e.message : String(e)}`);
    return false;
  }
  return claudeInstalled();
}

/** The in-flight `claude auth login` process, kept alive while we wait for the pasted code. */
let active: Bun.Subprocess | null = null;

/**
 * Run the official `claude auth login --claudeai`. It opens the browser and prints a sign-in URL,
 * which we hand to `onUrl` immediately (like Higgsfield's device login). The login then blocks
 * reading a code from stdin; call `submitClaudeCode()` once the user pastes it from the browser.
 * Resolves true on success (exit 0), after which ~/.claude/.credentials.json exists.
 */
export async function startClaudeLogin(
  onUrl: (url: string) => void,
  onLog: (line: string) => void,
): Promise<boolean> {
  if (active) {
    try {
      active.kill();
    } catch {
      /* ignore */
    }
    active = null;
  }
  let proc: Bun.Subprocess;
  try {
    proc = Bun.spawn([resolveClaudeBin(), "auth", "login", "--claudeai"], {
      stdout: "pipe",
      stderr: "pipe",
      stdin: "pipe",
    });
  } catch (e) {
    onLog(`Could not start sign-in: ${e instanceof Error ? e.message : String(e)}`);
    return false;
  }
  active = proc;
  let sentUrl = false;
  await pump(proc, (line) => {
    if (!sentUrl) {
      // e.g. "If the browser didn't open, visit: https://claude.com/cai/oauth/authorize?…"
      const m = line.match(/https?:\/\/\S*oauth\/authorize\S*/);
      if (m) {
        sentUrl = true;
        onUrl(m[0]);
        return;
      }
    }
    onLog(line);
  });
  const code = await proc.exited;
  if (active === proc) active = null;
  return code === 0;
}

/** Feed the authorization code the user pasted from the browser to the running login process. */
export function submitClaudeCode(code: string): boolean {
  const proc = active;
  if (!proc || !proc.stdin) return false;
  try {
    const sink = proc.stdin as { write: (s: string) => void; flush?: () => void; end?: () => void };
    sink.write(`${code.trim()}\n`);
    sink.flush?.();
    sink.end?.();
    return true;
  } catch {
    return false;
  }
}
