// Local stem separation (B3): split a clip's audio into VOICE and MUSIC (accompaniment) with
// sherpa-onnx's spleeter 2-stems model — the same on-device sherpa runtime already bundled for
// diarization. CapCut Pro-gates vocal isolation; here it's offline, free, and fast (RTF ~0.12, i.e.
// ~8× realtime on CPU). Produces two wavs the executor registers as library assets.

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { FFMPEG_BIN } from "./config";
import { run } from "./proc";

// Same env-override pattern as the diarizer: the desktop shell points these at sidecars/separate;
// dev falls back to a PATH lookup with the models next to the exe.
const SEPARATE_BIN = process.env.CUPCAT_SEPARATE_BIN ?? "sherpa-onnx-offline-source-separation";
const SEPARATE_DIR =
  process.env.CUPCAT_SEPARATE_DIR ??
  (SEPARATE_BIN.includes("/") || SEPARATE_BIN.includes("\\") ? dirname(SEPARATE_BIN) : "");

export interface StemResult {
  vocalsPath: string;
  musicPath: string;
}

/** True when the separation binary + models are actually present (so the tool can fail cleanly). */
export async function separationAvailable(): Promise<boolean> {
  if (!SEPARATE_DIR) return false;
  return (
    (await Bun.file(join(SEPARATE_DIR, "vocals.fp16.onnx")).exists()) &&
    (await Bun.file(join(SEPARATE_DIR, "accompaniment.fp16.onnx")).exists())
  );
}

/**
 * Separate the audio of `src` (any media with sound) into vocals + accompaniment wavs written to
 * `outDir`. spleeter expects 44.1kHz stereo, so we transcode first with ffmpeg.
 */
export async function separateStems(src: string, outDir: string, prefix = "stem"): Promise<StemResult> {
  const vocals = join(SEPARATE_DIR, "vocals.fp16.onnx");
  const accomp = join(SEPARATE_DIR, "accompaniment.fp16.onnx");
  if (!(await separationAvailable())) {
    throw new Error(
      `Local stem separation model not found in ${SEPARATE_DIR || "(separation dir not set)"}. Expected vocals.fp16.onnx + accompaniment.fp16.onnx.`,
    );
  }

  const tmp = await mkdtemp(join(tmpdir(), "ccstems-"));
  try {
    const inWav = join(tmp, "in.wav");
    const { code: cvt, stderr: cvtErr } = await run(FFMPEG_BIN, [
      "-y", "-i", src, "-vn", "-ac", "2", "-ar", "44100", "-c:a", "pcm_s16le", inWav,
    ]);
    if (cvt !== 0) throw new Error(`Could not extract audio: ${cvtErr.split("\n").slice(-3).join(" ")}`);

    const outVocals = join(outDir, `${prefix}_voice.wav`);
    const outMusic = join(outDir, `${prefix}_music.wav`);
    const { code, stderr } = await run(SEPARATE_BIN, [
      `--spleeter-vocals=${vocals}`,
      `--spleeter-accompaniment=${accomp}`,
      `--input-wav=${inWav}`,
      `--output-vocals-wav=${outVocals}`,
      `--output-accompaniment-wav=${outMusic}`,
    ]);
    if (code !== 0) throw new Error(`Separation failed: ${stderr.split("\n").slice(-3).join(" ")}`);
    if (!(await Bun.file(outVocals).exists()) || !(await Bun.file(outMusic).exists())) {
      throw new Error("Separation produced no output.");
    }
    return { vocalsPath: outVocals, musicPath: outMusic };
  } finally {
    await rm(tmp, { recursive: true, force: true }).catch(() => {});
  }
}
