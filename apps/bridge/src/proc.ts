// Thin wrapper over Bun.spawn for capturing a child process's output.

import type { Subprocess } from "bun";

export interface RunResult {
  stdout: string;
  stderr: string;
  code: number;
}

// Extra environment merged into EVERY child spawn. Needed because Bun.spawn snapshots the process
// environment at startup — mutating process.env at runtime is NOT seen by children spawned with the
// default env. Discovered-at-runtime vars (e.g. VK_DRIVER_FILES pointing at an unregistered Vulkan
// ICD manifest, required for libplacebo/Dolby Vision on driver installs that forgot to register it)
// are registered here once and explicitly passed to every child from then on.
const extraEnv: Record<string, string> = {};
export function addSpawnEnv(env: Record<string, string>): void {
  Object.assign(extraEnv, env);
}

// Cancellation registry: long renders (exports/merges) register their subprocess under a tag so an
// out-of-band request (HTTP endpoint, agent tool) can kill them mid-flight. killTagged() records the
// tag in `killed` because a killed ffmpeg just exits nonzero — the awaiting caller needs a way to
// distinguish "user cancelled" from a real encode failure, and does so via consumeKilled().
export const tagged = new Map<string, Subprocess>();
const killed = new Set<string>();

/** Kill the subprocess registered under `tag`. Returns whether one was actually running. */
export function killTagged(tag: string): boolean {
  const proc = tagged.get(tag);
  if (!proc) return false;
  killed.add(tag);
  proc.kill();
  return true;
}

/** One-shot check-and-clear: was the last run under `tag` killed via killTagged()?
 * Consuming (not just reading) keeps a stale cancel from tainting the NEXT run under the same tag. */
export function consumeKilled(tag: string): boolean {
  return killed.delete(tag);
}

// Agent-tool subprocess registry: while the chat agent is executing a tool, every subprocess it
// spawns is tracked here so a chat-stop can kill them all mid-flight. Untagged tool runs (e.g.
// auto_clips' many ffmpeg passes) are otherwise unreachable by killTagged and would run to
// completion after the user pressed stop.
let agentActive = false;
// Sticky once a stop is requested. Killing only what happens to be running is not enough: a long
// tool runs a SEQUENCE of subprocesses (transcribe = resample -> whisper -> silence; auto_clips
// exports one ffmpeg per clip), so the next one would start right after the kill and the work would
// carry on regardless. While this is set, anything the agent spawns dies immediately.
let agentStopping = false;
const agentProcs = new Set<Subprocess>();

/** Toggle whether run() should register its spawns as agent-owned (call around tool execution). */
export function setAgentActive(on: boolean): void {
  agentActive = on;
  if (!on) agentProcs.clear();
}

/** Kill every subprocess spawned while the agent was active. Returns how many were killed. */
export function killAgentProcs(): number {
  agentStopping = true;
  let n = 0;
  for (const p of agentProcs) {
    try {
      p.kill();
      n++;
    } catch {
      /* already exited */
    }
  }
  agentProcs.clear();
  return n;
}

/** Clear the armed stop. Called when a new chat run begins, so a previous stop can't kill it. */
export function resetAgentStop(): void {
  agentStopping = false;
}

// ── Named jobs ───────────────────────────────────────────────────────────────
// The same idea as the agent registry above, but for work started from a BUTTON rather than from
// the chat: transcribing, diarizing, syncing cameras, repairing audio, exporting clips. These can
// run for minutes, and until now there was no way to see one running and no way to stop it — a
// slow operation was indistinguishable from a frozen app.
//
// Deliberately one at a time. Two half-hour transcodes at once do not finish sooner; they just make
// the machine unusable and every one of them slower.

export interface JobInfo {
  id: string;
  /** Tool name — the UI translates from this; `label` is the fallback for anything it lacks. */
  tool: string;
  label: string;
  startedAt: number;
}

interface Job extends JobInfo {
  procs: Set<Subprocess>;
  stopping: boolean;
}

let currentJob: Job | null = null;

/** Start tracking a long operation. Everything run() spawns from here on belongs to it. */
export function beginJob(id: string, tool: string, label: string): void {
  currentJob = { id, tool, label, startedAt: Date.now(), procs: new Set(), stopping: false };
}

/** Finish it. Safe to call for a job that was already cancelled or replaced. */
export function endJob(id: string): void {
  if (currentJob?.id === id) currentJob = null;
}

/** What is running right now, for the UI to show and offer to stop. */
export function currentJob_(): JobInfo | null {
  return currentJob ? { id: currentJob.id, tool: currentJob.tool, label: currentJob.label, startedAt: currentJob.startedAt } : null;
}

/** Stop the running operation: kill what it has spawned, and — stickily — anything it spawns next,
 * because these tools run a SEQUENCE of subprocesses and killing only the current one lets the work
 * carry straight on. Returns false when there was nothing to stop. */
export function cancelJob(id?: string): boolean {
  if (!currentJob || (id && currentJob.id !== id)) return false;
  currentJob.stopping = true;
  for (const p of currentJob.procs) {
    try {
      p.kill();
    } catch {
      /* already exited */
    }
  }
  currentJob.procs.clear();
  return true;
}

/** Has the running operation been asked to stop? Tools check this between steps. */
export function jobCancelled(id?: string): boolean {
  if (!currentJob) return false;
  if (id && currentJob.id !== id) return false;
  return currentJob.stopping;
}

export async function run(cmd: string, args: string[], opts: { cwd?: string; env?: Record<string, string>; tag?: string; stdin?: string } = {}): Promise<RunResult> {
  const needEnv = opts.env || Object.keys(extraEnv).length > 0;
  const proc = Bun.spawn([cmd, ...args], {
    // "pipe" only when the caller has input to send (e.g. piper reads its text from stdin);
    // the explicit "ignore" otherwise keeps every existing caller's behavior unchanged.
    stdin: opts.stdin === undefined ? "ignore" : "pipe",
    stdout: "pipe",
    stderr: "pipe",
    cwd: opts.cwd,
    env: needEnv ? { ...process.env, ...extraEnv, ...opts.env } : undefined,
  });
  if (opts.stdin !== undefined && proc.stdin && typeof proc.stdin !== "number") {
    // Write everything up front then close — children like piper only start reading on EOF-terminated lines.
    proc.stdin.write(opts.stdin);
    await proc.stdin.end();
  }
  if (opts.tag) {
    tagged.set(opts.tag, proc);
    // A fresh run invalidates any cancel flag left over from a previous run under this tag,
    // so a cancel that raced a completed export can't mislabel the new one as cancelled.
    killed.delete(opts.tag);
  }
  if (currentJob) {
    currentJob.procs.add(proc);
    // Same sticky rule as the agent: a stop that landed between two steps must take out the
    // step that started just after it, or the operation carries on regardless.
    if (currentJob.stopping) {
      try {
        proc.kill();
      } catch {
        /* already gone */
      }
    }
  }
  if (agentActive) {
    agentProcs.add(proc); // killable by a chat-stop (killAgentProcs)
    // A stop that arrived while the previous step was finishing must also take out this one.
    if (agentStopping) {
      try {
        proc.kill();
      } catch {
        /* already gone */
      }
    }
  }
  try {
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    const code = await proc.exited;
    return { stdout, stderr, code };
  } finally {
    // Only unregister if WE are still the registered process — a concurrent re-run under the
    // same tag would otherwise have its registration wiped by the older run's cleanup.
    if (opts.tag && tagged.get(opts.tag) === proc) tagged.delete(opts.tag);
    agentProcs.delete(proc);
  }
}

/** Open a URL in the user's default browser. Windows-only app: `cmd /c start "" <url>` (the empty
 * "" is the window-title arg `start` requires before the URL). Best-effort; never throws. */
export function openInBrowser(url: string): void {
  try {
    Bun.spawn(["cmd", "/c", "start", "", url], { stdout: "ignore", stderr: "ignore", stdin: "ignore" });
  } catch {
    /* best effort — the UI also shows the URL so the user can open it manually */
  }
}
