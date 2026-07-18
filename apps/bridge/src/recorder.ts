// Screen / webcam recording via a persistent ffmpeg process.
//
// record_start spawns ffmpeg capturing the desktop (gdigrab) or a DirectShow webcam into an .mp4
// in the project's media dir; the process stays alive until record_stop writes "q" to its stdin —
// ffmpeg's clean-shutdown command, which finalizes the moov atom so the file is playable. One
// recording at a time. The executor then imports the finished file through the normal
// import_media flow so probing/proxies/thumbnails match a manual import.

import type { Subprocess } from "bun";
import { join } from "node:path";
import { FFMPEG_BIN, mediaDir } from "./config";
import { run } from "./proc";

export type RecordSource = "screen" | "webcam";

interface ActiveRecording {
  proc: Subprocess<"pipe", "ignore", "pipe">;
  path: string;
  source: RecordSource;
  startedAt: number;
  stderrTail: () => string;
}

/** The (at most one) in-flight recording, keyed by output path. */
const recordings = new Map<string, ActiveRecording>();

const lastLines = (s: string, n = 3): string =>
  s
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(-n)
    .join(" | ");

export interface DshowDevices {
  video: string[];
  audio: string[];
}

/** Enumerate DirectShow capture devices (webcams / microphones). ffmpeg prints the list on stderr
 * as `[dshow @ …] "Device Name" (video|audio)`; "Alternative name" lines don't match and are skipped. */
export async function listDshowDevices(): Promise<DshowDevices> {
  const { stderr } = await run(FFMPEG_BIN, ["-hide_banner", "-list_devices", "true", "-f", "dshow", "-i", "dummy"]);
  const video: string[] = [];
  const audio: string[] = [];
  for (const line of stderr.split(/\r?\n/)) {
    const m = line.match(/"([^"]+)"\s*\((video|audio)\)\s*$/);
    if (m) (m[2] === "video" ? video : audio).push(m[1]!);
  }
  return { video, audio };
}

/** Start a screen or webcam recording. Resolves once ffmpeg has survived its startup window (a
 * capture that can't open its device dies within ~1.5 s); throws with ffmpeg's own words if not. */
export async function startRecording(source: RecordSource, audio: boolean): Promise<{ path: string; note: string }> {
  const current = [...recordings.values()][0];
  if (current) {
    throw new Error(`A ${current.source} recording is already in progress (started ${Math.round((Date.now() - current.startedAt) / 1000)}s ago) — call record_stop first.`);
  }

  const ts = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
  const dest = join(mediaDir, `recording-${ts}.mp4`);
  const args: string[] = ["-hide_banner", "-y"];
  let note = "";
  let hasAudio = false;

  if (source === "screen") {
    args.push("-f", "gdigrab", "-framerate", "30", "-i", "desktop");
    if (audio) {
      const mic = (await listDshowDevices()).audio[0];
      if (mic) {
        args.push("-f", "dshow", "-i", `audio=${mic}`);
        hasAudio = true;
        note = ` with microphone "${mic}"`;
      } else {
        note = " (no microphone found — video only)";
      }
    }
  } else {
    const devs = await listDshowDevices();
    const cam = devs.video[0];
    if (!cam) throw new Error("No webcam found — ffmpeg's DirectShow device list has no video device.");
    const mic = audio ? devs.audio[0] : undefined;
    args.push("-f", "dshow", "-i", mic ? `video=${cam}:audio=${mic}` : `video=${cam}`);
    hasAudio = !!mic;
    note = ` from "${cam}"${mic ? ` with microphone "${mic}"` : audio ? " (no microphone found — video only)" : ""}`;
  }

  args.push("-c:v", "libx264", "-preset", "ultrafast", "-crf", "23", "-pix_fmt", "yuv420p");
  // gdigrab reports the raw desktop size, which can be odd (e.g. 1366×767 after DPI math) —
  // yuv420p 4:2:0 needs even dimensions, so snap down.
  if (source === "screen") args.push("-vf", "scale=trunc(iw/2)*2:trunc(ih/2)*2");
  if (hasAudio) args.push("-c:a", "aac", "-b:a", "160k");
  args.push(dest);

  // Bun.spawn directly (not run()): the process must OUTLIVE this call, and record_stop needs its
  // stdin pipe to send the "q" clean-shutdown command.
  const proc = Bun.spawn([FFMPEG_BIN, ...args], { stdin: "pipe", stdout: "ignore", stderr: "pipe" });
  let tail = "";
  void (async () => {
    const dec = new TextDecoder();
    for await (const chunk of proc.stderr) tail = (tail + dec.decode(chunk)).slice(-8192);
  })().catch(() => {
    /* stream closed with the process */
  });

  const early = await Promise.race([proc.exited, new Promise<null>((r) => setTimeout(() => r(null), 1500))]);
  if (early !== null) {
    throw new Error(`ffmpeg could not start the ${source} recording (exit ${early}): ${lastLines(tail) || "no output"}`);
  }

  recordings.set(dest, { proc, path: dest, source, startedAt: Date.now(), stderrTail: () => tail });
  return { path: dest, note };
}

/** Stop the active recording cleanly: "q" on ffmpeg's stdin (writes the moov atom), wait for exit
 * (10 s timeout → kill), and hand back the finished file's path for import. */
export async function stopRecording(): Promise<{ path: string; source: RecordSource; seconds: number }> {
  const rec = [...recordings.values()][0];
  if (!rec) throw new Error("No recording is in progress — call record_start first.");
  recordings.delete(rec.path);

  try {
    rec.proc.stdin.write("q");
    rec.proc.stdin.flush();
    await rec.proc.stdin.end();
  } catch {
    /* process already gone — the exit wait below settles it */
  }
  const exited = await Promise.race([rec.proc.exited, new Promise<null>((r) => setTimeout(() => r(null), 10_000))]);
  if (exited === null) {
    rec.proc.kill();
    await Promise.race([rec.proc.exited, new Promise((r) => setTimeout(r, 2000))]);
  }

  const seconds = Math.round((Date.now() - rec.startedAt) / 100) / 10;
  const file = Bun.file(rec.path);
  if (!(await file.exists()) || file.size === 0) {
    throw new Error(`Recording failed — ffmpeg wrote no usable file. ${lastLines(rec.stderrTail()) || ""}`.trim());
  }
  return { path: rec.path, source: rec.source, seconds };
}
