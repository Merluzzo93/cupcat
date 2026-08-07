// Local text-to-speech via the bundled Piper sidecar (github.com/rhasspy/piper).
//
// Unlike the Higgsfield TTS models this is fully offline and free, so it is the default path for
// "add a voiceover saying X". The desktop shell ships piper.exe + espeak-ng data + .onnx voices in
// sidecars/piper/ and points CUPCAT_PIPER_BIN / CUPCAT_PIPER_VOICES_DIR at it (main.rs), mirroring
// how the ffmpeg/whisper sidecars are wired. synthesizeSpeech writes the wav into the project's
// exports dir; the executor then moves it into the media dir and registers it through the normal
// import_media flow so the asset behaves exactly like a recording.

import { mkdir, readdir } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { exportsDir } from "./config";
import { run } from "./proc";

// Same env-override pattern as WHISPER_BIN in transcribe.ts: the desktop shell sets both vars to
// the bundled sidecars; dev mode falls back to a PATH lookup with voices next to the exe.
const PIPER_BIN = process.env.CUPCAT_PIPER_BIN ?? "piper";
const PIPER_VOICES_DIR =
  process.env.CUPCAT_PIPER_VOICES_DIR ??
  (PIPER_BIN.includes("/") || PIPER_BIN.includes("\\") ? dirname(PIPER_BIN) : "");

export interface SpeechOptions {
  /** 'it' | 'en' (language shorthand → bundled voice for that language) or an explicit .onnx filename/path. */
  voice?: string;
  /** Speaking pace: 1 = natural, 2 = twice as fast, 0.5 = half speed (clamped to 0.5–2). */
  speed?: number;
}

export interface LocalVoice {
  /** What goes in generate_speech's `voice`. The bare filename works; so does the language shorthand. */
  file: string;
  /** 'it', 'en', … — the shorthand that resolves to this voice when it is the first for its language. */
  language: string;
  languageName: string;
  /** The speaker the model was trained on. Piper carries no gender field, so this is all there is. */
  dataset: string;
  quality: string;
}

/**
 * The voices actually installed, read off disk.
 *
 * Without this the only way to find out what is available is to ask for one that is not and read the
 * error — which is how a session went looking for an Italian male narrator that does not exist here,
 * through several wrong guesses. Two bundled voices is a small enough truth to just state.
 */
export async function localVoices(): Promise<LocalVoice[]> {
  let names: string[] = [];
  try {
    names = (await readdir(PIPER_VOICES_DIR)).filter((n) => n.toLowerCase().endsWith(".onnx"));
  } catch {
    return [];
  }
  const out: LocalVoice[] = [];
  for (const file of names.sort()) {
    let language = file.split("_")[0] ?? "";
    let languageName = "";
    let dataset = "";
    let quality = "";
    try {
      const meta = (await Bun.file(join(PIPER_VOICES_DIR, `${file}.json`)).json()) as {
        language?: { family?: string; name_english?: string };
        dataset?: string;
        audio?: { quality?: string };
      };
      language = meta.language?.family ?? language;
      languageName = meta.language?.name_english ?? "";
      dataset = meta.dataset ?? "";
      quality = meta.audio?.quality ?? "";
    } catch {
      /* a voice without its .json still works; the filename is enough to name it */
    }
    out.push({ file, language, languageName, dataset, quality });
  }
  return out;
}

/** Map a voice request to a concrete .onnx model path, with errors that say exactly what to fix. */
async function resolveVoiceModel(voice: string): Promise<string> {
  if (voice.toLowerCase().endsWith(".onnx")) {
    // Explicit model: honor a full path as-is, otherwise look it up in the voices dir.
    const candidate = isAbsolute(voice) || voice.includes("/") || voice.includes("\\") ? voice : join(PIPER_VOICES_DIR, voice);
    if (await Bun.file(candidate).exists()) return candidate;
    throw new Error(
      `Piper voice not found — expected ${candidate} (with its .onnx.json next to it). Download one from huggingface.co/rhasspy/piper-voices, or use 'it'/'en' for a bundled voice.`,
    );
  }
  // Language shorthand: Piper voices are named <lang>_<REGION>-<name>-<quality>.onnx, so a
  // case-insensitive "it_"/"en_" prefix match finds the bundled voice without hardcoding a
  // specific voice name — swapping the bundled voice for another one keeps working.
  const prefix = `${voice.toLowerCase()}_`;
  let onnx: string[] = [];
  try {
    onnx = (await readdir(PIPER_VOICES_DIR)).filter((n) => n.toLowerCase().endsWith(".onnx"));
  } catch {
    /* missing/unset dir → the "not found" error below explains what to configure */
  }
  const match = onnx.filter((n) => n.toLowerCase().startsWith(prefix)).sort()[0];
  if (!match) {
    throw new Error(
      `Piper voice not found — expected a ${prefix}*.onnx model in ${PIPER_VOICES_DIR || "(voices dir not set)"} (available: ${onnx.join(", ") || "none"}). Set CUPCAT_PIPER_VOICES_DIR or pass an explicit .onnx filename.`,
    );
  }
  return join(PIPER_VOICES_DIR, match);
}

/**
 * Synthesize `text` to a wav in the project's exports dir and return its path (a scratch location —
 * the executor moves it into the media library). Returns null when there is nothing to speak.
 */
export async function synthesizeSpeech(text: string, opts: SpeechOptions = {}): Promise<string | null> {
  // Piper reads utterances line-by-line from stdin, so collapse all whitespace/newlines into ONE
  // line to guarantee a single continuous wav. Sentence pacing is unaffected: piper splits and
  // paces sentences internally from the punctuation.
  const line = text.replace(/\s+/g, " ").trim();
  if (!line) return null;

  const model = await resolveVoiceModel(opts.voice ?? "it");
  // Piper expresses pace as --length_scale, a phoneme DURATION multiplier — the inverse of speed
  // (0.769 ≈ 1.3× faster). Clamp so extreme values can't produce unintelligible audio.
  const speed = Math.min(2, Math.max(0.5, opts.speed ?? 1));
  const lengthScale = (1 / speed).toFixed(3);

  await mkdir(exportsDir, { recursive: true });
  const out = join(exportsDir, `tts-${Date.now()}.wav`);

  let res;
  try {
    res = await run(PIPER_BIN, ["--model", model, "--output_file", out, "--length_scale", lengthScale], { stdin: line });
  } catch (e) {
    // Bun.spawn throws (rather than resolving nonzero) when the binary itself is missing.
    throw new Error(
      `Piper not runnable at "${PIPER_BIN}" — set CUPCAT_PIPER_BIN to piper.exe (bundled under sidecars/piper). (${e instanceof Error ? e.message : String(e)})`,
    );
  }
  if (res.code !== 0 || !(await Bun.file(out).exists())) {
    const tail = res.stderr.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).slice(-3).join(" | ");
    throw new Error(`Piper failed (exit ${res.code})${tail ? `: ${tail}` : ""}`);
  }
  return out;
}
