// Media inspection + light processing via the system ffmpeg/ffprobe.

import { rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { exportsDir, FFMPEG_BIN, FFPROBE_BIN } from "./config";
import { addSpawnEnv, run } from "./proc";

export interface ProbeResult {
  durationSeconds: number;
  width?: number;
  height?: number;
  fps?: number;
  hasAudio: boolean;
}

interface FfStream {
  codec_type?: string;
  width?: number;
  height?: number;
  duration?: string;
  r_frame_rate?: string;
}

export async function probeMedia(path: string): Promise<ProbeResult> {
  const { stdout, code } = await run(FFPROBE_BIN, [
    "-v",
    "quiet",
    "-print_format",
    "json",
    "-show_format",
    "-show_streams",
    path,
  ]);
  if (code !== 0) return { durationSeconds: 0, hasAudio: false };
  let data: { streams?: FfStream[]; format?: { duration?: string } } = {};
  try {
    data = JSON.parse(stdout || "{}");
  } catch {
    return { durationSeconds: 0, hasAudio: false };
  }
  const streams = data.streams ?? [];
  const v = streams.find((s) => s.codec_type === "video");
  const a = streams.find((s) => s.codec_type === "audio");
  const durationSeconds = Number(data.format?.duration ?? v?.duration ?? 0) || 0;
  let fps: number | undefined;
  if (v?.r_frame_rate) {
    const parts = String(v.r_frame_rate).split("/").map(Number);
    if (parts.length === 2 && parts[1]) fps = parts[0]! / parts[1]!;
  }
  return { durationSeconds, width: v?.width, height: v?.height, fps, hasAudio: !!a };
}

// Heavy transcode jobs (scrub proxy + thumbnail generation — anything that decodes a 4K HDR frame
// through the float tone-map chain) are gated to a small number of concurrent slots. Without this,
// opening a library of several HDR .mov files (or a version bump invalidating every cached proxy at
// once) fires one ffmpeg process per file simultaneously — they don't finish any faster in parallel
// (the work is CPU-bound) but they DO fight every core for cache/scheduler time, which is what
// "ffmpeg uses tons of CPU and the library takes forever to load" actually was. Any future caller of
// a heavy per-file job should route through this gate rather than spawning ffmpeg directly.
const MAX_CONCURRENT_TRANSCODES = 2;
let activeTranscodes = 0;
const transcodeQueue: Array<() => void> = [];
export async function withTranscodeSlot<T>(fn: () => Promise<T>): Promise<T> {
  // while, not if: a woken waiter must re-check — another caller can slip into the freed slot
  // between the release and this continuation running, and an `if` would let both proceed.
  while (activeTranscodes >= MAX_CONCURRENT_TRANSCODES) {
    await new Promise<void>((resolve) => transcodeQueue.push(resolve));
  }
  activeTranscodes++;
  try {
    return await fn();
  } finally {
    activeTranscodes--;
    transcodeQueue.shift()?.();
  }
}

// ── Dolby Vision / HDR via libplacebo (GPU) ─────────────────────────────────────────────────────
// iPhone HDR footage carries per-frame Dolby Vision RPU metadata describing exactly how each frame
// should be tone-mapped — the phone's own look. ffmpeg's HEVC decoder parses those natively and the
// libplacebo filter APPLIES them (tonemapping=auto), so when the bundled ffmpeg has libplacebo and a
// working Vulkan driver we use the ORIGINAL metadata instead of any hand-calibrated static curve.
// Fallback: the zscale/tonemap chain below (machines without Vulkan, or older ffmpeg builds).

/** Some NVIDIA driver installs ship the Vulkan ICD manifest without registering it (no
 * HKLM\SOFTWARE\Khronos\Vulkan\Drivers key) — the loader then reports VK_ERROR_INCOMPATIBLE_DRIVER
 * even though the GPU is fine. Point the loader at known manifests in the DriverStore directly. */
async function findVulkanIcdEnv(): Promise<Record<string, string> | null> {
  const { readdir } = await import("node:fs/promises");
  const repo = "C:/Windows/System32/DriverStore/FileRepository";
  const manifests = ["nv-vk64.json", "amd-vulkan64.json", "amdvlk64.json", "igvk64.json"];
  try {
    const dirs = await readdir(repo);
    for (const d of dirs) {
      for (const m of manifests) {
        const p = `${repo}/${d}/${m}`;
        if (await Bun.file(p).exists()) {
          const win = p.replace(/\//g, "\\");
          return { VK_DRIVER_FILES: win, VK_ICD_FILENAMES: win };
        }
      }
    }
  } catch {
    /* no driver store access */
  }
  return null;
}

let placeboProbe: Promise<boolean> | null = null;

/** Permanently switch this process to the CPU tone-map chain. Called when a REAL graph fails at
 * Vulkan device creation even though the tiny probe passed — seen when a timeline of many split
 * segments instantiates one libplacebo (= one Vulkan device) per input and the driver refuses
 * (VK_ERROR_INITIALIZATION_FAILED). Rendering must never die over a nicer tone-map. */
export function disablePlacebo(reason: string): void {
  console.error(`[placebo] disabled for this session: ${reason}`);
  placeboProbe = Promise.resolve(false);
}

/** Does this ffmpeg stderr indicate the Vulkan/libplacebo path itself broke (vs a normal error)? */
export function isVulkanFailure(stderr: string): boolean {
  return /libplacebo|vulkan|VK_ERROR/i.test(stderr);
}

/** True when the source needs HDR→SDR tone mapping (each such input costs a libplacebo instance). */
export async function isHdrSource(url: string): Promise<boolean> {
  return isHdr(await probeColor(url));
}

const alphaCache = new Map<string, Promise<boolean>>();
/** WebM VP9-alpha detection (alpha_mode=1 stream tag): these inputs must be decoded with libvpx —
 * ffmpeg's native vp9 decoder silently DROPS the alpha plane and the overlay turns opaque. */
export function hasAlphaMode(url: string): Promise<boolean> {
  let p = alphaCache.get(url);
  if (!p) {
    p = (async () => {
      if (!/\.webm$/i.test(url)) return false;
      const { stdout } = await run(FFPROBE_BIN, ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream_tags=alpha_mode", "-of", "csv=p=0", url]);
      return stdout.trim() === "1";
    })();
    alphaCache.set(url, p);
  }
  return p;
}

/** Once per process: can this ffmpeg run libplacebo on a real Vulkan device? On success any needed
 * ICD env vars are installed into process.env so every later ffmpeg spawn inherits them. */
export function placeboAvailable(): Promise<boolean> {
  placeboProbe ??= (async () => {
    const test = async () =>
      (
        await run(FFMPEG_BIN, [
          "-v", "error", "-f", "lavfi", "-i", "color=c=gray:size=64x64:duration=0.1",
          "-frames:v", "1",
          "-vf", "libplacebo=w=64:h=64:colorspace=bt709:color_primaries=bt709:color_trc=bt709:range=tv:format=yuv420p",
          "-f", "null", "-",
        ])
      ).code === 0;
    try {
      if (await test()) return true;
      const env = await findVulkanIcdEnv();
      if (!env) return false;
      // Registered on the spawn wrapper, NOT process.env: Bun snapshots the environment at startup,
      // so runtime process.env mutations never reach children. The loader also needs the manifest
      // path in native backslash form — with forward slashes NVIDIA fails instance creation.
      addSpawnEnv(env);
      return await test();
    } catch {
      return false;
    }
  })();
  return placeboProbe;
}

/** The libplacebo HDR→SDR conversion (Dolby Vision RPUs applied when present). Optional GPU-side
 * resize in the same pass via w/h expressions. */
export function hdrToSdrPlacebo(size?: { w: string; h: string }): string {
  const wh = size ? `w=${size.w}:h=${size.h}:` : "";
  return `libplacebo=${wh}colorspace=bt709:color_primaries=bt709:color_trc=bt709:range=tv:tonemapping=auto:format=yuv420p`;
}

/** Extract a single downscaled frame as a JPEG thumbnail. Returns true on success. */
const scrubInFlight = new Map<string, Promise<void>>();
/** Path of a video's scrub proxy (sibling file). Version history: v1 480p; v2 720p; v3 mobius
 * tone-map (brightened + oversaturated); v4 VLC-calibrated (too dark/red for iPhone users);
 * v5 Apple-calibrated static chain; v6 = Dolby Vision via libplacebo when available (the source's
 * own per-frame metadata — the phone's true look). Bumping the name regenerates stale proxies. */
export function scrubProxyPath(srcPath: string): string {
  return `${srcPath}.scrubv6.mp4`;
}
/** Ensure an all-intra 480p (no audio) proxy exists for instant per-frame seeking while scrubbing.
 * Generates it in the background on first request; returns the proxy path once it's on disk, else
 * null (callers fall back to the original until it's ready). */
export async function ensureScrubProxy(srcPath: string, opts: { wait?: boolean } = {}): Promise<string | null> {
  const proxy = scrubProxyPath(srcPath);
  const pf = Bun.file(proxy);
  if (await pf.exists()) {
    if (pf.size > 1024) return proxy; // a complete proxy
    await rm(proxy, { force: true }).catch(() => {}); // stale/partial from an interrupted run → redo
  }
  // wait=true blocks until the proxy is ready instead of falling back to the original — required
  // for sources the webview can't play natively (.mov/.mkv/ProRes…): serving the original there
  // renders a black preview, so "slow but correct" beats "instant but broken".
  const inFlight = scrubInFlight.get(proxy);
  if (inFlight) {
    if (!opts.wait) return null;
    await inFlight;
    return (await Bun.file(proxy).exists()) ? proxy : null;
  }
  const job = (async () => {
    // Encode to a temp file and only rename into place on success, so a half-written proxy is never
    // served (a partial mp4 decodes to a black frame). While encoding, exists(proxy) stays false →
    // callers serve the original.
    const tmp = `${proxy}.tmp`;
    try {
      // HDR sources must be tone-mapped in the proxy too, or the PREVIEW stays washed out even
      // after the export pipeline handles it. Preferred: libplacebo (GPU) applying the source's own
      // Dolby Vision per-frame metadata — the phone's true look. Fallback: downscale first, then the
      // calibrated CPU chain (tone-mapping float RGB at 4K runs ~0.3x realtime; at 720p it's 5.4x
      // faster with pixel-identical output, ramp-verified).
      const srcColor = await probeColor(srcPath);
      const hdr = isHdr(srcColor);
      const vf =
        hdr && (await placeboAvailable())
          ? hdrToSdrPlacebo({ w: "-2", h: "'min(720,ih)'" })
          : `scale=-2:min(720\\,ih)${hdr ? `,${hdrToSdr(srcColor)}` : ""}`;
      // -g 1 = every frame a keyframe → a seek decodes exactly one small frame (instant scrub).
      const { code } = await withTranscodeSlot(() =>
        run(FFMPEG_BIN, [
          "-y",
          "-i",
          srcPath,
          "-an",
          "-vf",
          vf,
          "-c:v",
          "libx264",
          "-preset",
          "veryfast",
          "-crf",
          "24",
          "-g",
          "1",
          "-pix_fmt",
          "yuv420p",
          "-movflags",
          "+faststart",
          "-f", // the temp name ends in .tmp, so force the muxer instead of inferring from extension
          "mp4",
          tmp,
        ]),
      );
      if (code === 0 && (await Bun.file(tmp).exists())) await rename(tmp, proxy);
      else {
        console.error(`[scrubProxy] ffmpeg exited ${code} for ${srcPath}`);
        await rm(tmp, { force: true });
      }
    } catch {
      await rm(tmp, { force: true }).catch(() => {});
    } finally {
      scrubInFlight.delete(proxy);
    }
  })();
  scrubInFlight.set(proxy, job);
  if (!opts.wait) return null;
  await job;
  return (await Bun.file(proxy).exists()) ? proxy : null;
}

const dvSdrInFlight = new Map<string, Promise<string | null>>();
/** Full-resolution tone-mapped SDR intermediate for an HDR source — the "decode once" bake.
 * libplacebo (per-frame DolbyVision, the phone's true look) runs a SINGLE sequential pass over
 * the file; every timeline clip then reads the tagged BT.709 result as an ordinary SDR input.
 * This is how split-heavy timelines of one HDR file keep DV rendering: one libplacebo instance
 * per shared source in a graph blows the Vulkan device budget (v1.2.3), and feeding N disjoint
 * trim windows from ONE in-graph split=N deadlocks the overlay framesync into buffering the
 * whole 4K RGBA composite (measured 25 GB before dying). A sibling cache like the scrub proxy
 * (.dvsdr1.mp4), but full-res crf16 with the source audio stream-copied so per-clip audio
 * consumption keeps working off the same input. Returns null when libplacebo is unavailable
 * (callers fall back to the calibrated CPU chain) or the encode fails. */
export async function ensureDvSdrProxy(srcPath: string): Promise<string | null> {
  const proxy = `${srcPath}.dvsdr1.mp4`;
  const pf = Bun.file(proxy);
  if ((await pf.exists()) && pf.size > 1024) return proxy;
  const inFlight = dvSdrInFlight.get(proxy);
  if (inFlight) return inFlight;
  const job = (async (): Promise<string | null> => {
    if (!(await placeboAvailable())) return null;
    const tmp = `${proxy}.tmp`;
    const bt709 = ["-colorspace", "bt709", "-color_primaries", "bt709", "-color_trc", "bt709", "-color_range", "tv"];
    const args = (audio: string[]) => [
      "-y", "-i", srcPath, "-vf", hdrToSdrPlacebo(),
      "-c:v", "libx264", "-preset", "veryfast", "-crf", "16", "-pix_fmt", "yuv420p", ...bt709,
      ...audio,
      "-movflags", "+faststart",
      "-f", "mp4", // the temp name ends in .tmp, so force the muxer instead of inferring from extension
      tmp,
    ];
    try {
      let r = await run(FFMPEG_BIN, args(["-c:a", "copy"]));
      // mp4 can't carry every mov audio codec (PCM in particular) — re-encode audio if copy failed.
      if (r.code !== 0) r = await run(FFMPEG_BIN, args(["-c:a", "aac", "-b:a", "256k"]));
      if (r.code === 0 && (await Bun.file(tmp).exists())) {
        await rename(tmp, proxy);
        return proxy;
      }
      console.error(`[dvSdrProxy] ffmpeg exited ${r.code} for ${srcPath}: ${r.stderr.split("\n").slice(-3).join(" | ")}`);
      await rm(tmp, { force: true });
      return null;
    } catch {
      await rm(tmp, { force: true }).catch(() => {});
      return null;
    } finally {
      dvSdrInFlight.delete(proxy);
    }
  })();
  dvSdrInFlight.set(proxy, job);
  return job;
}

/** Path of a video's static library thumbnail (sibling JPEG). v2 = Dolby Vision rendering. */
export function thumbnailPath(srcPath: string): string {
  return `${srcPath}.thumbv2.jpg`;
}

/** Delete superseded proxy/thumbnail generations in a media folder. Every version bump (scrubv2→v6,
 * thumbv1→v2) left the old files behind forever — dozens of orphans, ~hundreds of MB per project.
 * Current generations and audio proxies are kept. Best-effort, silent. */
export async function cleanupStaleProxies(dir: string): Promise<number> {
  const { readdir } = await import("node:fs/promises");
  let removed = 0;
  try {
    for (const name of await readdir(dir)) {
      const scrub = /\.scrub(v\d+)?\.mp4$/.exec(name);
      const thumb = /\.thumb(v\d+)?\.jpg$/.exec(name);
      const dvsdr = /\.dvsdr(\d+)\.mp4$/.exec(name);
      const stale = (scrub && scrub[1] !== "v6") || (thumb && thumb[1] !== "v2") || (dvsdr && dvsdr[1] !== "1");
      if (!stale) continue;
      try {
        await rm(join(dir, name), { force: true });
        removed++;
      } catch {
        /* locked/in use — next time */
      }
    }
  } catch {
    /* folder unreadable */
  }
  return removed;
}
const thumbInFlight = new Map<string, Promise<void>>();
/** A single small frame, color-corrected same as export — for library/picker thumbnails. Decoding
 * ONE frame (even through the HDR tone-map chain) is ~2 orders of magnitude cheaper than encoding the
 * full scrub proxy video, so the library can show real thumbnails almost immediately instead of
 * waiting on (or triggering CPU contention with) the heavier per-clip scrub proxy. */
export async function ensureThumbnail(srcPath: string): Promise<string | null> {
  const thumb = thumbnailPath(srcPath);
  const tf = Bun.file(thumb);
  if (await tf.exists()) {
    if (tf.size > 256) return thumb;
    await rm(thumb, { force: true }).catch(() => {});
  }
  const inFlight = thumbInFlight.get(thumb);
  if (inFlight) {
    await inFlight;
    return (await Bun.file(thumb).exists()) ? thumb : null;
  }
  const job = (async () => {
    const tmp = `${thumb}.tmp`;
    try {
      const srcColor = await probeColor(srcPath);
      const hdr = isHdr(srcColor);
      const vf =
        hdr && (await placeboAvailable())
          ? hdrToSdrPlacebo({ w: "480", h: "-2" })
          : `scale=480:-2${hdr ? `,${hdrToSdr(srcColor)}` : ""}`;
      // -f image2 -c:v mjpeg: the temp name ends in .tmp, so the muxer/encoder can't be inferred
      // from the extension (same reason the scrub proxy passes -f mp4).
      const grab = (seek: string) =>
        withTranscodeSlot(() =>
          run(FFMPEG_BIN, ["-y", "-ss", seek, "-i", srcPath, "-frames:v", "1", "-vf", vf, "-q:v", "3", "-f", "image2", "-c:v", "mjpeg", tmp]),
        );
      // A fixed small offset dodges a black fade-in at frame 0; a very short clip just falls back to 0.
      let res = await grab("0.5");
      if (res.code !== 0 || !(await Bun.file(tmp).exists())) res = await grab("0");
      if (res.code === 0 && (await Bun.file(tmp).exists())) await rename(tmp, thumb);
      else {
        console.error(`[thumbnail] ffmpeg exited ${res.code} for ${srcPath} (vf=${vf}): ${res.stderr.slice(-400)}`);
        await rm(tmp, { force: true }).catch(() => {});
      }
    } catch {
      await rm(tmp, { force: true }).catch(() => {});
    } finally {
      thumbInFlight.delete(thumb);
    }
  })();
  thumbInFlight.set(thumb, job);
  await job;
  return (await Bun.file(thumb).exists()) ? thumb : null;
}

// Audio-only preview proxy. The packaged WebView2 shell often won't play the source's audio in an
// <audio> element — either it won't demux audio out of a VIDEO container, or the OS AAC path is
// unavailable (the muted preview <video> still shows the picture, which is why video plays but sound
// doesn't). Re-encoding to a standalone Opus/WebM file fixes both: Chromium has a BUILT-IN Opus decoder
// (no OS codec needed) and it's a pure audio file. Falls back to AAC/.m4a if this ffmpeg lacks Opus.
const audioInFlight = new Map<string, Promise<string | null>>();
export async function ensureAudioProxy(srcPath: string): Promise<string | null> {
  const encode = async (ext: string, args: string[], af: string): Promise<string | null> => {
    const proxy = `${srcPath}.audio.${ext}`;
    const pf = Bun.file(proxy);
    if ((await pf.exists()) && pf.size > 512) return proxy;
    const tmp = `${proxy}.tmp`;
    const filterArgs = af ? ["-af", af.replace(/^,/, "")] : [];
    const { code } = await run(FFMPEG_BIN, ["-y", "-i", srcPath, "-vn", ...filterArgs, ...args, tmp]);
    if (code === 0 && (await Bun.file(tmp).exists()) && Bun.file(tmp).size > 512) {
      await rename(tmp, proxy);
      return proxy;
    }
    await rm(tmp, { force: true }).catch(() => {});
    return null;
  };
  const existing = audioInFlight.get(srcPath);
  if (existing) return existing;
  const job = (async () => {
    const af = await channelBalanceFix(srcPath); // fix a source with real signal on only one channel
    return (
      (await encode("webm", ["-c:a", "libopus", "-b:a", "128k", "-ar", "48000", "-ac", "2", "-f", "webm"], af)) ||
      (await encode("m4a", ["-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-ac", "2", "-movflags", "+faststart", "-f", "mp4"], af))
    );
  })();
  audioInFlight.set(srcPath, job);
  try {
    return await job;
  } finally {
    audioInFlight.delete(srcPath);
  }
}

// Some source recordings (phones/webcams/screen-recorders) store real audio in only ONE stereo
// channel — the other is near-digital-silence, not actually mono. Most playback paths still sound
// fine (many devices sum L+R for a mono speaker), but a source with real signal on ONLY the left
// channel goes completely silent on any output routed/balanced toward the right (e.g. a Windows
// balance setting, a one-sided cable/adapter fault) — this is what makes "audio works on my phone,
// silent on this PC" happen even though the encoded audio is perfectly valid. Detect it once per
// source and, if found, center-mix so both channels carry the real signal.
const channelBalanceCache = new Map<string, Promise<string>>();
export async function channelBalanceFix(srcPath: string): Promise<string> {
  let job = channelBalanceCache.get(srcPath);
  if (job) return job;
  job = (async () => {
    const { stderr, code } = await run(FFMPEG_BIN, [
      "-v", "info", "-i", srcPath, "-t", "8", "-map", "0:a:0", "-af", "astats=metadata=0:reset=0", "-f", "null", "-",
    ]);
    if (code !== 0) return "";
    const rms = [...stderr.matchAll(/Channel: (\d+)[\s\S]*?RMS level dB: (-?[\d.]+|-inf)/g)].map((m) => ({
      ch: Number(m[1]),
      db: m[2] === "-inf" ? -140 : Number(m[2]),
    }));
    // Only the per-channel blocks (1, 2, ...), not the trailing "Overall" summary (unnumbered channel).
    const perChannel = rms.filter((r) => r.ch >= 1 && r.ch <= 8);
    if (perChannel.length !== 2) return ""; // mono or >2 channels — nothing to rebalance here
    const [a, b] = perChannel;
    const loud = Math.max(a!.db, b!.db);
    const quiet = Math.min(a!.db, b!.db);
    if (loud > -50 && loud - quiet > 35) {
      // One channel has real signal, the other is silent — sum both onto each so it plays centered
      // regardless of which output channel the destination device actually routes.
      return ",pan=stereo|c0=0.5*c0+0.5*c1|c1=0.5*c0+0.5*c1";
    }
    return "";
  })();
  channelBalanceCache.set(srcPath, job);
  return job;
}

export async function makeThumbnail(srcPath: string, destPath: string, atSeconds = 1): Promise<boolean> {
  const { code } = await run(FFMPEG_BIN, [
    "-y",
    "-ss",
    String(atSeconds),
    "-i",
    srcPath,
    "-frames:v",
    "1",
    "-vf",
    "scale=320:-1",
    destPath,
  ]);
  return code === 0;
}

/** RMS audio envelope (envRate Hz, mono) of a media file's [startSec, +durSec] span — for sync. */
let envelopeSeq = 0;
export async function audioEnvelope(
  path: string,
  startSec: number,
  durSec: number,
  tag: string,
  envRate = 100,
  sampleRate = 8000,
): Promise<Float32Array | null> {
  // Unique per call: concurrent MCP tool calls (or /waveform requests) with the same tag would
  // otherwise write the same temp file with -y and silently corrupt each other's envelope.
  const pcmPath = join(exportsDir, `_sync_${tag}_${envelopeSeq++}.pcm`);
  try {
    const { code } = await run(FFMPEG_BIN, [
      "-y",
      "-ss",
      String(Math.max(0, startSec)),
      "-t",
      String(Math.max(0.05, durSec)),
      "-i",
      path,
      "-ac",
      "1",
      "-ar",
      String(sampleRate),
      "-f",
      "s16le",
      pcmPath,
    ]);
    if (code !== 0) return null;
    const f = Bun.file(pcmPath);
    if (!(await f.exists())) return null;
    const buf = await f.arrayBuffer();
    const even = buf.byteLength - (buf.byteLength % 2);
    if (even < 2) return null;
    const pcm = new Int16Array(buf.slice(0, even));
    const per = Math.max(1, Math.floor(sampleRate / envRate));
    const n = Math.floor(pcm.length / per);
    const env = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      let sum = 0;
      for (let j = 0; j < per; j++) {
        const v = pcm[i * per + j]! / 32768;
        sum += v * v;
      }
      env[i] = Math.sqrt(sum / per);
    }
    return env;
  } finally {
    await rm(pcmPath, { force: true }).catch(() => {});
  }
}

let frameSeq = 0;
/** A downscaled base64 PNG of a frame: an image at t=0, or a video at `atSeconds`. */
export async function frameToBase64(path: string, atSeconds: number, maxWidth = 768): Promise<string | null> {
  // JPEG, not PNG: these frames land in the chat conversation and are re-sent with every request —
  // PNG frames are 10–20x bigger and long sessions blow past the API request-size cap (HTTP 413).
  const out = join(exportsDir, `_inspect_${frameSeq++}.jpg`);
  const args = ["-y"];
  if (atSeconds > 0.001) args.push("-ss", String(atSeconds)); // input-seek for video; -ss breaks single-frame images
  args.push("-i", path, "-frames:v", "1", "-update", "1", "-vf", `scale=min(${maxWidth}\\,iw):-2`, "-q:v", "5", out);
  const { code } = await run(FFMPEG_BIN, args);
  if (code !== 0) return null;
  const f = Bun.file(out);
  if (!(await f.exists())) return null;
  const buf = await f.arrayBuffer();
  if (buf.byteLength === 0) return null;
  return Buffer.from(buf).toString("base64");
}

/** Real, sample-derived waveform peaks (0..1, normalized) for drawing an audio clip. */
export async function audioPeaks(path: string, durationSec: number, buckets: number): Promise<number[] | null> {
  const env = await audioEnvelope(path, 0, durationSec > 0 ? durationSec : 5, "wave", 100, 8000);
  if (!env || env.length === 0) return null;
  const per = Math.max(1, Math.floor(env.length / buckets));
  const out: number[] = [];
  let max = 0.0001;
  for (let i = 0; i < buckets; i++) {
    let m = 0;
    for (let j = 0; j < per; j++) {
      const v = env[i * per + j] ?? 0;
      if (v > m) m = v;
    }
    out.push(m);
    if (m > max) max = m;
  }
  return out.map((v) => Math.min(1, v / max));
}

/** Color scopes of an image via ffmpeg signalstats — luma/chroma/saturation/warm-cool, normalized. */
export async function imageScopes(path: string): Promise<Record<string, number> | null> {
  const { stderr } = await run(FFMPEG_BIN, ["-i", path, "-vf", "signalstats,metadata=print", "-frames:v", "1", "-f", "null", "-"]);
  const get = (k: string) => {
    const m = stderr.match(new RegExp(`signalstats\\.${k}=(-?[0-9.]+)`));
    return m ? Number(m[1]) : undefined;
  };
  const yavg = get("YAVG");
  if (yavg === undefined) return null;
  const r3 = (n: number) => Math.round(n * 1000) / 1000;
  const ymin = get("YMIN") ?? 0;
  const ymax = get("YMAX") ?? 255;
  const uavg = get("UAVG") ?? 128;
  const vavg = get("VAVG") ?? 128;
  const sat = get("SATAVG") ?? 0;
  const hue = get("HUEAVG");
  const scopes: Record<string, number> = {
    lumaAvg: r3(yavg / 255),
    lumaMin: r3(ymin / 255),
    lumaMax: r3(ymax / 255),
    shadowsClipped: ymin <= 2 ? 1 : 0,
    highlightsClipped: ymax >= 253 ? 1 : 0,
    saturationAvg: r3(sat),
    warmCool: r3((vavg - uavg) / 255), // >0 warmer (more red than blue), <0 cooler
    redTilt: r3((vavg - 128) / 128),
    blueTilt: r3((uavg - 128) / 128),
  };
  if (hue !== undefined) scopes.hueAvg = r3(hue);
  return scopes;
}

export interface SilenceRange {
  startSeconds: number;
  endSeconds: number;
}

export interface ColorInfo {
  space: string; // e.g. bt709, smpte170m, bt2020nc, unknown
  transfer: string; // e.g. bt709, smpte2084 (PQ), arib-std-b67 (HLG)
  primaries: string;
  height: number;
}

const colorCache = new Map<string, Promise<ColorInfo>>();
/** Cached probe of a video's color metadata (matrix/transfer/primaries) + height. */
export function probeColor(url: string): Promise<ColorInfo> {
  let job = colorCache.get(url);
  if (job) return job;
  job = (async () => {
    const { stdout, code } = await run(FFPROBE_BIN, [
      "-v", "error", "-select_streams", "v:0",
      "-show_entries", "stream=color_space,color_transfer,color_primaries,height",
      "-of", "json", url,
    ]);
    const out: ColorInfo = { space: "unknown", transfer: "unknown", primaries: "unknown", height: 1080 };
    if (code === 0) {
      try {
        const st = (JSON.parse(stdout) as { streams?: { color_space?: string; color_transfer?: string; color_primaries?: string; height?: number }[] }).streams?.[0];
        out.space = st?.color_space ?? "unknown";
        out.transfer = st?.color_transfer ?? "unknown";
        out.primaries = st?.color_primaries ?? "unknown";
        out.height = st?.height ?? 1080;
      } catch {
        /* defaults */
      }
    }
    return out;
  })();
  colorCache.set(url, job);
  return job;
}

export function isHdr(c: ColorInfo): boolean {
  return c.transfer === "smpte2084" || c.transfer === "arib-std-b67" || c.primaries === "bt2020";
}

export interface SourceTimecodeInfo {
  /** Start-of-file timecode in seconds of real time (null when the source carries none). */
  timecodeSeconds: number | null;
  /** creation_time tag as epoch milliseconds (null when absent/unparseable). */
  creationTime: number | null;
  fps: number | null;
}

/** "HH:MM:SS:FF" (non-drop) or "HH:MM:SS;FF" (drop-frame) → seconds of real time at `fps`. */
function timecodeToSeconds(tc: string, fps: number): number | null {
  const m = /^(\d{1,2}):(\d{2}):(\d{2})([:;])(\d{1,3})$/.exec(tc.trim());
  if (!m || !(fps > 0)) return null;
  const nominal = Math.round(fps); // FF counts against the integer label rate (30 for 29.97)
  let frames = ((Number(m[1]) * 60 + Number(m[2])) * 60 + Number(m[3])) * nominal + Number(m[5]);
  if (m[4] === ";") {
    // Drop-frame skips 2 frame NUMBERS per minute (4 at ~60fps), except every 10th minute, so the
    // label tracks the wall clock at 29.97/59.94 — undo the skips to recover the true frame count.
    const dropped = Math.round(nominal / 15);
    const minutes = Number(m[1]) * 60 + Number(m[2]);
    frames -= dropped * (minutes - Math.floor(minutes / 10));
  }
  return frames / fps;
}

const timecodeCache = new Map<string, Promise<SourceTimecodeInfo>>();
/** Cached probe of a source's embedded start timecode + creation time. Jam-synced multicam /
 * dual-system footage carries the shot's wall-clock position in metadata, so clips can be aligned
 * by exact arithmetic instead of audio correlation (which needs usable, overlapping audio). */
export function sourceTimecode(url: string): Promise<SourceTimecodeInfo> {
  let job = timecodeCache.get(url);
  if (job) return job;
  job = (async () => {
    const out: SourceTimecodeInfo = { timecodeSeconds: null, creationTime: null, fps: null };
    const { stdout, code } = await run(FFPROBE_BIN, [
      "-v", "error",
      "-show_entries", "stream=codec_type,r_frame_rate,avg_frame_rate:stream_tags=timecode,creation_time:format_tags=timecode,creation_time",
      "-of", "json", url,
    ]);
    if (code !== 0) return out;
    try {
      const data = JSON.parse(stdout) as {
        streams?: { codec_type?: string; r_frame_rate?: string; avg_frame_rate?: string; tags?: Record<string, string> }[];
        format?: { tags?: Record<string, string> };
      };
      const streams = data.streams ?? [];
      const v = streams.find((s) => s.codec_type === "video");
      const rate = v?.avg_frame_rate && v.avg_frame_rate !== "0/0" ? v.avg_frame_rate : v?.r_frame_rate;
      if (rate) {
        const [num, den] = rate.split("/").map(Number);
        if (num && den) out.fps = num / den;
      }
      // The timecode tag lives in different places per container: on a dedicated tmcd data track
      // (QuickTime/.mov), on the video stream itself (MXF/some MP4s), or in format tags.
      const tcTag = streams.map((s) => s.tags?.timecode).find(Boolean) ?? data.format?.tags?.timecode;
      if (tcTag && out.fps) out.timecodeSeconds = timecodeToSeconds(tcTag, out.fps);
      const ct = data.format?.tags?.creation_time ?? streams.map((s) => s.tags?.creation_time).find(Boolean);
      if (ct) {
        const ms = Date.parse(ct);
        if (Number.isFinite(ms)) out.creationTime = ms;
      }
    } catch {
      /* defaults */
    }
    return out;
  })();
  timecodeCache.set(url, job);
  return job;
}

/** HDR (PQ/HLG BT.2020) → SDR BT.709 tone-mapping. Without this, HDR phone footage decodes with the
 * wrong transfer/matrix and everything looks washed out / desaturated.
 *
 * Calibrated against APPLE's own HDR→SDR conversion of the same real iPhone footage (the user's SDR
 * .mp4 phone exports sitting next to the HDR .mov — for iPhone users THAT is "the original colors";
 * VLC's rendition, tried first, is visibly darker/redder than what they expect). Anatomy:
 *  - zscale npl=1000 → linearize with the proper HLG OOTF (γ=1.2). zimg couples the OOTF gamma to
 *    npl (γ = 1.2 + 0.42·log10(npl/1000)); npl=100 gives γ≈0.78 which BRIGHTENS everything — that
 *    was the "colori sparati" bug. Never lower npl to tune brightness.
 *  - exposure +2.0 stops → puts HDR reference white near SDR white (players do the same scaling;
 *    without it ref-white lands at 0.2 linear and the image is uniformly dark).
 *  - tonemap hable peak=4 (= 2^stops, the content peak after the gain) → compresses highlights
 *    smoothly, so lit faces/speculars roll to white instead of clipping to orange (the luce.png
 *    bug of the plain zscale conversion).
 *  - eq gamma=1.10 + huesaturation −0.32 on reds/yellows (soft-ranged, strength=8) → Apple's
 *    rendering lifts shadows and mutes skin reds relative to a colorimetric tone-map; without this
 *    step skin looks sunburnt/red-brown next to the phone's own SDR export of the same scene.
 * Face-patch match vs Apple's export: Y 182.4 vs 179.0, V 143.4 vs 141.2, sat 18.1 vs 18.3.
 * Input transfer/matrix/primaries are passed EXPLICITLY from the probe — zscale errors out
 * ("no path between colorspaces") when frame tags alone are missing. */
export function hdrToSdr(c: ColorInfo): string {
  const tin = c.transfer !== "unknown" ? c.transfer : "arib-std-b67";
  const min = c.space !== "unknown" ? c.space : "bt2020nc";
  const pin = c.primaries !== "unknown" ? c.primaries : "bt2020";
  return (
    `zscale=tin=${tin}:min=${min}:pin=${pin}:transfer=linear:npl=1000,format=gbrpf32le,` +
    `exposure=exposure=2.0,tonemap=tonemap=hable:peak=4.0,` +
    `zscale=transfer=bt709:matrix=bt709:primaries=bt709:range=tv,format=yuv420p,` +
    `eq=gamma=1.10,huesaturation=saturation=-0.32:colors=r\\+y:strength=8,format=yuv420p`
  );
}

/** Per-input color fragment for the HDR-preserving export path (format "hdr_hevc") — the
 * counterpart of inputColorFix: instead of tone-mapping HDR down to SDR, keep the signal HDR and
 * normalize every input to HLG/BT.2020 so the whole graph shares ONE HDR interpretation.
 * - HLG (or untagged-HDR) sources: tag-only setparams pass-through — zero pixel work. Explicit
 *   tags matter twice over: the downstream RGBA conversion picks its matrix from them (bt2020
 *   instead of a guessed bt601), and untagged HDR would otherwise decode plain wrong.
 * - PQ sources: zscale transfer remap PQ→HLG (linearize at npl=1000, re-encode as HLG). Both are
 *   HDR — no tone mapping, gamut untouched; content above 1000 nits clips, the standard trade-off
 *   of a BT.2408-style PQ→HLG conversion. tin/min/pin are explicit because zscale errors out
 *   ("no path between colorspaces") when it must rely on missing frame tags.
 * Deliberately NO libplacebo here: each instance costs a Vulkan device and split-heavy timelines
 * exhaust the driver (the v1.2.3 export killer) — zscale is CPU-only and instance-unbounded. */
export async function hdrInputFix(url: string): Promise<string> {
  const c = await probeColor(url);
  const min = c.space !== "unknown" ? c.space : "bt2020nc";
  const pin = c.primaries !== "unknown" ? c.primaries : "bt2020";
  if (c.transfer === "smpte2084") {
    return `zscale=tin=smpte2084:min=${min}:pin=${pin}:transfer=arib-std-b67:matrix=bt2020nc:primaries=bt2020:range=tv:npl=1000`;
  }
  const trc = c.transfer !== "unknown" ? c.transfer : "arib-std-b67";
  return `setparams=colorspace=${min}:color_primaries=${pin}:color_trc=${trc}:range=tv`;
}

/** Per-input color normalization fragment (leading position, no trailing comma; "" when none needed):
 * - HDR sources: full tone-map to SDR BT.709.
 * - UNTAGGED SDR sources: convert with the matrix a player would ASSUME (bt709 for HD, bt601 for SD)
 *   and emit tagged BT.709 frames — so the export looks exactly like the original does in a player.
 * - Correctly tagged SDR sources: nothing (downstream conversions honor the tag). */
export async function inputColorFix(url: string, cpuOnly = false): Promise<string> {
  const c = await probeColor(url);
  if (isHdr(c)) return !cpuOnly && (await placeboAvailable()) ? hdrToSdrPlacebo() : hdrToSdr(c);
  if (c.space === "unknown") {
    // Tag the frames (no pixel work) with the matrix a player would ASSUME for this resolution, so
    // the downstream YUV→RGB conversion decodes them exactly the way the user sees the original.
    const assumed = c.height >= 720 ? "bt709" : "smpte170m";
    return `setparams=colorspace=${assumed}:range=tv`;
  }
  return "";
}

export interface VideoAnalysis {
  blackRanges: SilenceRange[]; // fully-black picture (dead intros/outros, gaps)
  freezeRanges: SilenceRange[]; // frozen/static picture (no motion)
  sceneChanges: number[]; // seconds where the shot visibly changes
}

/** Visual defect + structure detection, all ffmpeg-native (no ML): black frames, frozen picture,
 * and scene changes. Two decode passes over the file; parses the filters' stderr logs. */
export async function analyzeVideo(url: string, opts: { sceneThreshold?: number; scenesOnly?: boolean } = {}): Promise<VideoAnalysis> {
  const out: VideoAnalysis = { blackRanges: [], freezeRanges: [], sceneChanges: [] };

  // Pass 1: black + freeze detection (both log to stderr). Skipped when the caller only wants the
  // shot structure (auto_clips) — it's a second full decode of the file for data nobody reads.
  if (!opts.scenesOnly) {
    const det = await run(FFMPEG_BIN, [
      "-i", url, "-vf", "blackdetect=d=0.1:pic_th=0.98:pix_th=0.10,freezedetect=n=-60dB:d=1", "-an", "-f", "null", "-",
    ]);
    let freezeStart: number | null = null;
    for (const line of det.stderr.split("\n")) {
      const black = line.match(/black_start:\s*(-?[0-9.]+)\s+black_end:\s*(-?[0-9.]+)/);
      if (black) out.blackRanges.push({ startSeconds: Math.max(0, Number.parseFloat(black[1]!)), endSeconds: Number.parseFloat(black[2]!) });
      const fs = line.match(/freeze_start:\s*(-?[0-9.]+)/);
      const fe = line.match(/freeze_end:\s*(-?[0-9.]+)/);
      if (fs) freezeStart = Math.max(0, Number.parseFloat(fs[1]!));
      else if (fe && freezeStart !== null) {
        out.freezeRanges.push({ startSeconds: freezeStart, endSeconds: Number.parseFloat(fe[1]!) });
        freezeStart = null;
      }
    }
  }

  // Pass 2: scene changes — select frames whose scene score exceeds the threshold; showinfo logs
  // each selected frame's pts_time to stderr.
  const thr = Math.min(0.9, Math.max(0.05, opts.sceneThreshold ?? 0.3));
  const sc = await run(FFMPEG_BIN, ["-i", url, "-vf", `select='gt(scene,${thr})',showinfo`, "-an", "-f", "null", "-"]);
  for (const line of sc.stderr.split("\n")) {
    const m = line.match(/pts_time:\s*(-?[0-9.]+)/);
    if (m) out.sceneChanges.push(Math.max(0, Number.parseFloat(m[1]!)));
  }
  return out;
}

/** Detect silent ranges via ffmpeg `silencedetect` (parses its stderr log).
 * `-vn` matters: without it ffmpeg's automatic stream selection also decodes the whole video track
 * for the null muxer — minutes of wasted CPU on a long file, for a measurement that reads only audio. */
export async function audioSilences(url: string, noiseDb: number, minDur: number): Promise<SilenceRange[]> {
  const { stderr } = await run(FFMPEG_BIN, ["-i", url, "-vn", "-af", `silencedetect=noise=${noiseDb}dB:d=${minDur}`, "-f", "null", "-"]);
  const ranges: SilenceRange[] = [];
  let start: number | null = null;
  for (const line of stderr.split("\n")) {
    const ms = line.match(/silence_start:\s*(-?[0-9.]+)/);
    const me = line.match(/silence_end:\s*(-?[0-9.]+)/);
    if (ms) start = Math.max(0, Number.parseFloat(ms[1]!));
    else if (me && start !== null) {
      ranges.push({ startSeconds: start, endSeconds: Number.parseFloat(me[1]!) });
      start = null;
    }
  }
  return ranges;
}
