// Download a video from a web URL into the current project's media folder via a local yt-dlp.
// Kept separate from media.ts (plain HTTP downloads): yt-dlp handles page URLs (YouTube,
// Vimeo, …), format selection, and the video+audio merge — which shells out to ffmpeg, hence
// --ffmpeg-location. No internal timeout: the MCP caller owns cancellation/timeouts.

import { dirname, join } from "node:path";
import { FFMPEG_BIN, mediaDir, YTDLP_BIN } from "./config";
import { run } from "./proc";

/**
 * Download `url` with yt-dlp into the project's media dir as an mp4.
 * Resolves with the absolute path of the downloaded file, or a human-readable error.
 */
export async function importFromUrl(
  url: string,
  onProgress?: (line: string) => void,
): Promise<{ path: string } | { error: string }> {
  if (!/^https?:\/\//i.test(url.trim())) return { error: "Only http(s) URLs are supported." };

  const args = [
    // Best mp4 video (≤4K) + m4a audio, falling back to any single mp4, then anything.
    "-f", "bv*[ext=mp4][height<=2160]+ba[ext=m4a]/b[ext=mp4]/b",
    "--merge-output-format", "mp4",
    "--no-playlist",
    "--restrict-filenames",
    "-o", join(mediaDir, "%(title).60s.%(ext)s"),
    "--newline",
  ];
  // Point yt-dlp at our bundled ffmpeg for the merge step (skip when FFMPEG_BIN is a bare
  // PATH-resolved name — yt-dlp will find it the same way).
  const ffmpegDir = dirname(FFMPEG_BIN);
  if (ffmpegDir && ffmpegDir !== ".") args.push("--ffmpeg-location", ffmpegDir);
  args.push(url.trim());

  const res = await run(YTDLP_BIN, args);
  const stdoutLines = res.stdout.split(/\r?\n/);
  // run() buffers output; replay it so callers still see the download log.
  if (onProgress) for (const line of stdoutLines) if (line.trim()) onProgress(line);

  const stderrTail = res.stderr
    .split(/\r?\n/)
    .filter((l) => l.trim())
    .slice(-3)
    .join(" | ");
  if (res.code !== 0) {
    return { error: `yt-dlp exited with code ${res.code}${stderrTail ? ` — ${stderrTail}` : ""}` };
  }

  // The final file is the LAST .mp4 yt-dlp names: the [Merger] line when separate video+audio
  // streams were merged, otherwise the last download destination (direct/progressive mp4), or
  // the "already been downloaded" notice when the file was fetched on a previous run.
  let path: string | null = null;
  for (const line of stdoutLines) {
    const m =
      line.match(/^\[Merger\] Merging formats into "(.+)"\s*$/) ??
      line.match(/^\[download\] Destination:\s*(.+?)\s*$/) ??
      line.match(/^\[download\]\s+(.+?) has already been downloaded\s*$/);
    const candidate = m?.[1];
    if (candidate && candidate.toLowerCase().endsWith(".mp4")) path = candidate;
  }
  if (!path) {
    return { error: `Could not find the downloaded file in yt-dlp's output${stderrTail ? ` — ${stderrTail}` : ""}` };
  }
  if (!(await Bun.file(path).exists())) {
    return { error: `yt-dlp reported "${path}" but the file does not exist${stderrTail ? ` — ${stderrTail}` : ""}` };
  }
  return { path };
}
