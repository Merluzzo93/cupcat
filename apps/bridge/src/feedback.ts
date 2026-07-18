// Feedback bundles: one folder (zipped when possible) with everything a developer needs to
// reproduce a report — report.json, a full-screen screenshot, the project document, the bridge's
// recent console output, and basic system info. Created by POST /feedback from the editor UI;
// nothing is uploaded anywhere — the user sends the resulting file to the developer manually.

import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { FFMPEG_BIN, projectRoot } from "./config";
import { run } from "./proc";

// ── console ring buffer ──────────────────────────────────────────────────────────────────
// The bridge's console output is often the only trace of what led up to a bug; keep the last
// ~400 lines in memory so a feedback bundle can ship them as logs.txt.

const MAX_CAPTURED_LOGS = 400;
const capturedLogs: string[] = [];
let logCaptureInstalled = false;

function formatLogArg(a: unknown): string {
  if (typeof a === "string") return a;
  if (a instanceof Error) return a.stack ?? a.message;
  try {
    return JSON.stringify(a);
  } catch {
    return String(a);
  }
}

/** Wrap console.log/warn/error: append to a capped ring buffer, then call the original.
 * Called once at bridge startup (idempotent). */
export function installLogCapture(): void {
  if (logCaptureInstalled) return;
  logCaptureInstalled = true;
  for (const level of ["log", "warn", "error"] as const) {
    const original = console[level].bind(console);
    console[level] = (...args: unknown[]) => {
      capturedLogs.push(`${new Date().toISOString()} [${level}] ${args.map(formatLogArg).join(" ")}`);
      if (capturedLogs.length > MAX_CAPTURED_LOGS) capturedLogs.splice(0, capturedLogs.length - MAX_CAPTURED_LOGS);
      original(...args);
    };
  }
}

export function getCapturedLogs(): string {
  return capturedLogs.join("\n");
}

// ── bundle creation ──────────────────────────────────────────────────────────────────────

function timestampSlug(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}-${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}`;
}

/** Full-screen screenshot via PowerShell CopyFromScreen (whole virtual screen, all monitors).
 * Returns "WxH" when it worked, null otherwise — a headless or locked session must not fail
 * the whole bundle. */
async function captureScreenshot(pngPath: string): Promise<string | null> {
  const script = [
    "$ErrorActionPreference='Stop'",
    "Add-Type -AssemblyName System.Windows.Forms",
    "Add-Type -AssemblyName System.Drawing",
    "$b=[System.Windows.Forms.SystemInformation]::VirtualScreen",
    "$bmp=[System.Drawing.Bitmap]::new($b.Width,$b.Height)",
    "$g=[System.Drawing.Graphics]::FromImage($bmp)",
    "$g.CopyFromScreen($b.Left,$b.Top,0,0,$bmp.Size)",
    `$bmp.Save('${pngPath.replace(/'/g, "''")}',[System.Drawing.Imaging.ImageFormat]::Png)`,
    "$g.Dispose()",
    "$bmp.Dispose()",
    '[Console]::Out.Write("$($b.Width)x$($b.Height)")',
  ].join("; ");
  try {
    const res = await run("powershell.exe", ["-NoProfile", "-Command", script]);
    if (res.code !== 0 || !(await Bun.file(pngPath).exists())) return null;
    return res.stdout.trim() || null;
  } catch {
    return null;
  }
}

export interface FeedbackBundleArgs {
  type: string;
  description: string;
  /** Pretty-printed JSON of the current project document (the caller owns ctx.doc). */
  projectJson: string;
}

/** Create `<projectRoot>/feedback/feedback-<ts>/` with report.json, screenshot.png, project.json,
 * logs.txt and system.txt, then try to zip it (Windows 10+ ships bsdtar as `tar`; `-a` picks the
 * zip format from the extension). Returns the ZIP path when zipping worked — the folder is kept
 * either way — else the folder path. */
export async function createFeedbackBundle(args: FeedbackBundleArgs): Promise<string> {
  const ts = timestampSlug();
  const feedbackRoot = join(projectRoot, "feedback");
  const dir = join(feedbackRoot, `feedback-${ts}`);
  await mkdir(dir, { recursive: true });

  await Bun.write(
    join(dir, "report.json"),
    JSON.stringify(
      {
        timestamp: new Date().toISOString(),
        type: args.type,
        description: args.description,
        appVersion: process.env.CUPCAT_VERSION ?? "dev",
        platform: process.platform,
        arch: process.arch,
        bunVersion: Bun.version,
      },
      null,
      2,
    ),
  );

  const screenSize = await captureScreenshot(join(dir, "screenshot.png")); // non-fatal when null

  await Bun.write(join(dir, "project.json"), args.projectJson);
  await Bun.write(join(dir, "logs.txt"), getCapturedLogs() || "(no logs captured)");

  let ffmpegInfo = "(ffmpeg -version failed)";
  try {
    const v = await run(FFMPEG_BIN, ["-version"]);
    if (v.code === 0) ffmpegInfo = v.stdout.split("\n").slice(0, 2).join("\n").trim();
  } catch {
    /* keep the placeholder */
  }
  // Capability matrix — the first thing a bug report needs on "works on my PC" issues: whether THIS
  // machine renders HDR via GPU (libplacebo/Vulkan) or the CPU fallback, and which whisper model it
  // transcribes with. Both probes are cached module-level, so this is cheap.
  let caps = "";
  try {
    const { placeboAvailable } = await import("./ffmpeg");
    caps += `hdr-render: ${(await placeboAvailable()) ? "libplacebo/Vulkan (Dolby Vision per-frame)" : "CPU fallback chain (no Vulkan)"}\n`;
  } catch {
    caps += "hdr-render: (probe failed)\n";
  }
  try {
    const { whisperModelInfo } = await import("./transcribe");
    caps += `whisper: ${await whisperModelInfo()}\n`;
  } catch {
    caps += "whisper: (unknown)\n";
  }
  await Bun.write(join(dir, "system.txt"), `${ffmpegInfo}\n${caps}${screenSize ? `screen: ${screenSize}\n` : ""}`);

  const zipPath = join(feedbackRoot, `feedback-${ts}.zip`);
  try {
    // Use the absolute System32 path on Windows: a Unix-y PATH (Git Bash dev shells) resolves
    // `tar` to GNU tar, which cannot write zip — only Windows' bundled bsdtar can (`-a` picks
    // the format from the .zip extension).
    const tarBin = process.platform === "win32" ? join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe") : "tar";
    const z = await run(tarBin, ["-a", "-cf", zipPath, "-C", dir, "."]);
    if (z.code === 0 && (await Bun.file(zipPath).exists())) return zipPath;
  } catch {
    /* fall back to the folder */
  }
  return dir;
}
