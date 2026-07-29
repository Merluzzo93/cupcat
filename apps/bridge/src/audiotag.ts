// Running the audio tagger: what does each two seconds of this recording sound like.
//
// sherpa-onnx's offline audio-tagging CLI with the CED-tiny model (AudioSet, 527 labels, Apache-2.0)
// — the same on-device runtime already bundled for diarization and stem separation, in
// sidecars/tagging. 6 MB of weights, ~100× realtime, no network and no account.
//
// The CLI tags ONE file per run and reloads the model each time (~0.3s of the ~0.31s a window
// costs), so the work is: one ffmpeg pass that cuts the whole recording into fixed windows, then one
// short process per window. A two-minute clip is about twenty seconds of tagging.
//
// Everything this module decides is mechanical — which windows exist, what the model said. What any
// of it MEANS lives in soundevents.ts, where it can be tested without a model.

import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { FFMPEG_BIN } from "./config";
import { run } from "./proc";

// Same env-override pattern as the diarizer and the separator: the desktop shell points these at
// sidecars/tagging; dev falls back to a PATH lookup with the model next to the exe.
const TAG_BIN = process.env.CUPCAT_TAGGING_BIN ?? "sherpa-onnx-offline-audio-tagging";
const TAG_DIR =
  process.env.CUPCAT_TAGGING_DIR ?? (TAG_BIN.includes("/") || TAG_BIN.includes("\\") ? dirname(TAG_BIN) : "");

const MODEL_FILE = "ced-tiny.int8.onnx";
const LABELS_FILE = "class_labels_indices.csv";

export interface TaggedWindow {
  startSeconds: number;
  endSeconds: number;
  tags: { name: string; prob: number }[];
}

/** True when the tagging binary and its model are both present, so a tool can fail with a sentence
 * instead of a stack trace. */
export async function taggingAvailable(): Promise<boolean> {
  if (!TAG_DIR) return false;
  return (
    (await Bun.file(join(TAG_DIR, MODEL_FILE)).exists()) && (await Bun.file(join(TAG_DIR, LABELS_FILE)).exists())
  );
}

/** `AudioEvent(name="Applause", index=67, prob=0.83)` → `{ name: "Applause", prob: 0.83 }`. */
export function parseTags(stdout: string): { name: string; prob: number }[] {
  const out: { name: string; prob: number }[] = [];
  for (const m of stdout.matchAll(/AudioEvent\(name="([^"]*)", index=\d+, prob=([\d.eE+-]+)\)/g)) {
    const prob = Number(m[2]);
    if (Number.isFinite(prob)) out.push({ name: m[1]!, prob });
  }
  return out;
}

export interface TagOptions {
  /** Window length in seconds. Two is short enough to place a caption and long enough for the model
   * to hear what the sound is. */
  windowSeconds?: number;
  /** How many labels to keep per window. */
  topK?: number;
  /** Called with (done, total) so a long recording can report progress instead of appearing hung. */
  onProgress?: (done: number, total: number) => void;
}

/**
 * Tag every window of `src`'s audio.
 *
 * The windows come out of one ffmpeg pass through the segment muxer, which writes exact,
 * back-to-back PCM files — so window *n* starts at exactly `n * windowSeconds` and no timestamp
 * arithmetic is needed downstream.
 */
export async function tagAudio(src: string, opts: TagOptions = {}): Promise<TaggedWindow[]> {
  const windowSeconds = opts.windowSeconds ?? 2;
  const topK = opts.topK ?? 5;
  if (!(await taggingAvailable())) {
    throw new Error(
      `Audio tagging model not found in ${TAG_DIR || "(tagging dir not set)"}. Expected ${MODEL_FILE} + ${LABELS_FILE}.`,
    );
  }
  const model = join(TAG_DIR, MODEL_FILE);
  const labels = join(TAG_DIR, LABELS_FILE);

  const tmp = await mkdtemp(join(tmpdir(), "cctag-"));
  try {
    // 16 kHz mono 16-bit is what the model wants; the segment muxer cuts on exact sample counts.
    const { code, stderr } = await run(FFMPEG_BIN, [
      "-y", "-i", src, "-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le",
      "-f", "segment", "-segment_time", String(windowSeconds), join(tmp, "w%05d.wav"),
    ]);
    if (code !== 0) throw new Error(`Could not read the audio: ${stderr.split("\n").slice(-3).join(" ")}`);

    const wavs = (await readdir(tmp)).filter((f) => f.endsWith(".wav")).sort();
    const out: TaggedWindow[] = [];
    for (let i = 0; i < wavs.length; i++) {
      const { code: tc, stdout } = await run(TAG_BIN, [
        `--ced-model=${model}`, `--labels=${labels}`, `--top-k=${topK}`, join(tmp, wavs[i]!),
      ]);
      // One unreadable window must not lose the other four hundred.
      if (tc === 0) {
        out.push({ startSeconds: i * windowSeconds, endSeconds: (i + 1) * windowSeconds, tags: parseTags(stdout) });
      }
      opts.onProgress?.(i + 1, wavs.length);
    }
    return out;
  } finally {
    await rm(tmp, { recursive: true, force: true }).catch(() => {});
  }
}
