// Where every byte in sidecars/ comes from.
//
// Until now this was prose in apps/desktop/README.md and a folder on one laptop. That is fine right
// up to the moment the build has to happen somewhere else — and it has to: SignPath Foundation only
// signs artifacts produced by a GitHub-hosted workflow, so a release built by hand cannot be signed
// at all. This file is the executable version of those instructions.
//
// Three rules it follows, each of them earned:
//
//  1. EVERY source is pinned to an exact version, and verified by SHA-256 after download. A build
//     input that changes silently is a product that changes silently.
//
//  2. ffmpeg is mirrored in our own release, not fetched from upstream. BtbN's dated builds are
//     PRUNED after about a month — the exact build CupCat ships (N-125444-g6d72600a30-20260703) no
//     longer exists there. Pointing at their rolling "latest" instead would mean every CI run could
//     produce a different editor, which is precisely the risk the upstream watcher exists to flag:
//     CupCat parses the stderr of silencedetect, freezedetect and blackdetect, and a major bump has
//     broken that before. Moving ffmpeg stays a decision, taken deliberately, never a side effect of
//     rebuilding.
//
//  3. One sherpa-onnx release supplies all three of its tools. The folder used to carry binaries
//     from three different builds (three different onnxruntime.dll, 16.6 / 16.0 / 13.2 MB). v1.13.4
//     was checked against the exact flags diarize.ts, separate.ts and audiotag.ts pass, on real
//     audio, before being pinned here.

export type Kind = "file" | "zip" | "tar.bz2" | "tar.gz";

/** A file or directory to lift out of an archive, and where it lands under sidecars/. */
export interface Pick {
  /** Path inside the archive. Ignored for `kind: "file"`. */
  from?: string;
  /** Destination, relative to the sidecars root. */
  to: string;
  /** Copy a whole directory rather than one file (espeak-ng-data is 365 files). */
  dir?: boolean;
}

export interface Source {
  /** Group it belongs to, so a run can fetch just one part while iterating. */
  group: "core" | "models" | "piper" | "diarize" | "separate" | "faces" | "tagging";
  /** Short name for logs. */
  id: string;
  url: string;
  kind: Kind;
  /** SHA-256 of the DOWNLOADED file. The gate that makes "pinned" mean something. */
  sha256: string;
  /** What CupCat needs out of it. */
  picks: Pick[];
  /** Licence and provenance, for NOTICE.md and for whoever reads this next. */
  note: string;
}

const S = (s: Source) => s;

/** The release in our own repo holding inputs that upstream does not keep. */
export const MIRROR_TAG = "sidecars-2026-07";
const mirror = (asset: string) => `https://github.com/Merluzzo93/cupcat/releases/download/${MIRROR_TAG}/${asset}`;

export const SOURCES: Source[] = [
  // ── core: the tools every project touches ────────────────────────────────────
  // Mirrored, not upstream — see rule 2 above. The two binaries are mirrored UNPACKED and one per
  // asset, so the pin below is the SHA-256 of the exact file CupCat ships, not of a repack around it.
  S({
    group: "core",
    id: "ffmpeg",
    url: mirror("ffmpeg-N-125444-g6d72600a30-20260703.exe"),
    kind: "file",
    sha256: "95aee5e6cb047c87a60f01a0968207d6e2bd5819f20bc41c8261c3aceff941ec",
    picks: [{ to: "ffmpeg.exe" }],
    note: "ffmpeg GPL static build by BtbN, © the FFmpeg project. Source: git.ffmpeg.org/ffmpeg.git @ 6d72600a30.",
  }),
  S({
    group: "core",
    id: "ffprobe",
    url: mirror("ffprobe-N-125444-g6d72600a30-20260703.exe"),
    kind: "file",
    sha256: "3d5c036b51929f95ee7328a64ac93ffff7d066624a4b9a53660ce7ba8f3e7488",
    picks: [{ to: "ffprobe.exe" }],
    note: "Same build as ffmpeg above.",
  }),
  S({
    group: "core",
    id: "whisper.cpp",
    url: "https://github.com/ggml-org/whisper.cpp/releases/download/v1.9.1/whisper-bin-x64.zip",
    kind: "zip",
    sha256: "7d8be46ecd31828e1eb7a2ecdd0d6b314feafd82163038ab6092594b0a063539",
    picks: [
      { from: "Release/whisper-cli.exe", to: "whisper-cli.exe" },
      { from: "Release/whisper.dll", to: "whisper.dll" },
      { from: "Release/ggml.dll", to: "ggml.dll" },
      { from: "Release/ggml-base.dll", to: "ggml-base.dll" },
      { from: "Release/ggml-cpu-alderlake.dll", to: "ggml-cpu-alderlake.dll" },
      { from: "Release/ggml-cpu-cannonlake.dll", to: "ggml-cpu-cannonlake.dll" },
      { from: "Release/ggml-cpu-cascadelake.dll", to: "ggml-cpu-cascadelake.dll" },
      { from: "Release/ggml-cpu-haswell.dll", to: "ggml-cpu-haswell.dll" },
      { from: "Release/ggml-cpu-icelake.dll", to: "ggml-cpu-icelake.dll" },
      { from: "Release/ggml-cpu-sandybridge.dll", to: "ggml-cpu-sandybridge.dll" },
      { from: "Release/ggml-cpu-skylakex.dll", to: "ggml-cpu-skylakex.dll" },
      { from: "Release/ggml-cpu-sse42.dll", to: "ggml-cpu-sse42.dll" },
      { from: "Release/ggml-cpu-x64.dll", to: "ggml-cpu-x64.dll" },
    ],
    note: "whisper.cpp v1.9.1 — MIT, © ggml-org / G. Gerganov.",
  }),
  S({
    group: "core",
    id: "higgsfield",
    // The npm package @higgsfield/cli is only a launcher: its postinstall downloads THIS tarball and
    // execs the binary inside. So CupCat takes the binary directly — one pinned download instead of a
    // package whose postinstall has to be trusted, and it joins the lock like everything else.
    //
    // It also corrects something. CupCat shipped a 98 MB higgsfield.exe built by `bun build --compile`
    // over that launcher; the official binary is 8.6 MB. Same version, same commit
    // (0.1.33 / 08b6bcd5), byte-identical --help on every command the bridge calls, and identical
    // output from a real authenticated `model list --video --json`. 90 MB of the installer was the
    // bun runtime wrapped around a program that did not need it.
    url: "https://github.com/higgsfield-ai/cli/releases/download/v0.1.33/hf_0.1.33_windows_amd64.tar.gz",
    kind: "tar.gz",
    sha256: "3c883ac22a83a3d9701a0a4b68b63f43b66f76378e519dc6b2420935dc3b6b69",
    picks: [{ from: "hf.exe", to: "higgsfield.exe" }],
    note: "Higgsfield CLI 0.1.33 — © Higgsfield AI. Bundled unmodified; CupCat uses the user's own account.",
  }),
  S({
    group: "core",
    id: "yt-dlp",
    url: "https://github.com/yt-dlp/yt-dlp/releases/download/2026.07.04/yt-dlp.exe",
    kind: "file",
    sha256: "52fe3c26dcf71fbdc85b528589020bb0b8e383155cfa81b64dd447bbe35e24b8",
    picks: [{ to: "yt-dlp.exe" }],
    note: "yt-dlp 2026.07.04 — Unlicense (public domain).",
  }),

  // ── models: the two big ones, 688 MB of the install ─────────────────────────
  // Hugging Face URLs name a COMMIT, not `resolve/main`. Either way the sha256 below keeps a changed
  // file out of the installer, but a branch pin turns any upstream edit into a broken build, and a
  // release pipeline that only works until someone else pushes is not a pipeline.
  S({
    group: "models",
    id: "ggml-large-v3-turbo-q5",
    url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/5359861c739e955e79d9a303bcbc70fb988958b1/ggml-large-v3-turbo-q5_0.bin",
    kind: "file",
    // The file the delta updater is careful never to re-download.
    sha256: "394221709cd5ad1f40c46e6031ca61bce88931e6e088c188294c6d5a55ffa7e2",
    picks: [{ to: "ggml-large-v3-turbo-q5.bin" }],
    note: "Whisper large-v3-turbo, q5_0 quantised — derived from OpenAI Whisper (MIT).",
  }),
  S({
    group: "models",
    id: "ggml-base",
    url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/5359861c739e955e79d9a303bcbc70fb988958b1/ggml-base.bin",
    kind: "file",
    sha256: "60ed5bc3dd14eea856493d334349b405782ddcaf0028d4b5df4088345fba2efe",
    picks: [{ to: "ggml-base.bin" }],
    note: "Whisper base — derived from OpenAI Whisper (MIT). The fallback when the turbo model is absent.",
  }),

  // ── piper: local text-to-speech ─────────────────────────────────────────────
  S({
    group: "piper",
    id: "piper",
    // The Windows build lives under the DATE tag, not under v1.2.0 — which is nevertheless the
    // version piper.exe reports. The repo is archived; its releases stay downloadable.
    url: "https://github.com/rhasspy/piper/releases/download/2023.11.14-2/piper_windows_amd64.zip",
    kind: "zip",
    sha256: "f3c58906402b24f3a96d92145f58acba6d86c9b5db896d207f78dc80811efcea",
    picks: [
      { from: "piper/piper.exe", to: "piper/piper.exe" },
      { from: "piper/piper_phonemize.dll", to: "piper/piper_phonemize.dll" },
      { from: "piper/espeak-ng.dll", to: "piper/espeak-ng.dll" },
      { from: "piper/onnxruntime.dll", to: "piper/onnxruntime.dll" },
      { from: "piper/onnxruntime_providers_shared.dll", to: "piper/onnxruntime_providers_shared.dll" },
      { from: "piper/libtashkeel_model.ort", to: "piper/libtashkeel_model.ort" },
      { from: "piper/espeak-ng-data", to: "piper/espeak-ng-data", dir: true },
    ],
    note: "piper 1.2.0 — MIT, © Michael Hansen / rhasspy.",
  }),
  S({
    group: "piper",
    id: "voice-it",
    url: "https://huggingface.co/rhasspy/piper-voices/resolve/0d907f158acc877ddeebcbf827659ee13bea8bcd/it/it_IT/paola/medium/it_IT-paola-medium.onnx",
    kind: "file",
    sha256: "6fc918b5a0ea6137382833dddfa567bffbe6a5060c02043c87192ee59c04210c",
    picks: [{ to: "piper/it_IT-paola-medium.onnx" }],
    note: "piper voice it_IT-paola-medium — MIT, via rhasspy/piper-voices.",
  }),
  S({
    group: "piper",
    id: "voice-it-json",
    url: "https://huggingface.co/rhasspy/piper-voices/resolve/0d907f158acc877ddeebcbf827659ee13bea8bcd/it/it_IT/paola/medium/it_IT-paola-medium.onnx.json",
    kind: "file",
    sha256: "aea19c0a7fce29fbc359b93f10e7902854401e4c95ae2ea328ae516b15d296cf",
    picks: [{ to: "piper/it_IT-paola-medium.onnx.json" }],
    note: "Voice config — piper refuses to speak without it.",
  }),
  S({
    group: "piper",
    id: "voice-en",
    url: "https://huggingface.co/rhasspy/piper-voices/resolve/0d907f158acc877ddeebcbf827659ee13bea8bcd/en/en_US/lessac/medium/en_US-lessac-medium.onnx",
    kind: "file",
    sha256: "5efe09e69902187827af646e1a6e9d269dee769f9877d17b16b1b46eeaaf019f",
    picks: [{ to: "piper/en_US-lessac-medium.onnx" }],
    note: "piper voice en_US-lessac-medium — MIT, via rhasspy/piper-voices.",
  }),
  S({
    group: "piper",
    id: "voice-en-json",
    url: "https://huggingface.co/rhasspy/piper-voices/resolve/0d907f158acc877ddeebcbf827659ee13bea8bcd/en/en_US/lessac/medium/en_US-lessac-medium.onnx.json",
    kind: "file",
    sha256: "efe19c417bed055f2d69908248c6ba650fa135bc868b0e6abb3da181dab690a0",
    picks: [{ to: "piper/en_US-lessac-medium.onnx.json" }],
    note: "Voice config.",
  }),

  // ── sherpa-onnx: one release, three tools ───────────────────────────────────
  // The CLIs and DLLs all come from this single archive; only the models differ per folder.
  S({
    group: "diarize",
    id: "sherpa-bin",
    url: "https://github.com/k2-fsa/sherpa-onnx/releases/download/v1.13.4/sherpa-onnx-v1.13.4-win-x64-shared-MD-MinSizeRel-no-tts.tar.bz2",
    kind: "tar.bz2",
    sha256: "14232cce2f6c963ddbf6589a9ef0043f9a4c65580e6900a6494d8635a800b260",
    picks: [
      { from: "sherpa-onnx-v1.13.4-win-x64-shared-MD-MinSizeRel-no-tts/bin/sherpa-onnx-offline-speaker-diarization.exe", to: "diarize/sherpa-onnx-offline-speaker-diarization.exe" },
      { from: "sherpa-onnx-v1.13.4-win-x64-shared-MD-MinSizeRel-no-tts/bin/onnxruntime.dll", to: "diarize/onnxruntime.dll" },
      { from: "sherpa-onnx-v1.13.4-win-x64-shared-MD-MinSizeRel-no-tts/bin/onnxruntime_providers_shared.dll", to: "diarize/onnxruntime_providers_shared.dll" },
      { from: "sherpa-onnx-v1.13.4-win-x64-shared-MD-MinSizeRel-no-tts/bin/sherpa-onnx-offline-source-separation.exe", to: "separate/sherpa-onnx-offline-source-separation.exe" },
      { from: "sherpa-onnx-v1.13.4-win-x64-shared-MD-MinSizeRel-no-tts/bin/onnxruntime.dll", to: "separate/onnxruntime.dll" },
      { from: "sherpa-onnx-v1.13.4-win-x64-shared-MD-MinSizeRel-no-tts/bin/onnxruntime_providers_shared.dll", to: "separate/onnxruntime_providers_shared.dll" },
      { from: "sherpa-onnx-v1.13.4-win-x64-shared-MD-MinSizeRel-no-tts/bin/sherpa-onnx-offline-audio-tagging.exe", to: "tagging/sherpa-onnx-offline-audio-tagging.exe" },
      { from: "sherpa-onnx-v1.13.4-win-x64-shared-MD-MinSizeRel-no-tts/bin/onnxruntime.dll", to: "tagging/onnxruntime.dll" },
      { from: "sherpa-onnx-v1.13.4-win-x64-shared-MD-MinSizeRel-no-tts/bin/onnxruntime_providers_shared.dll", to: "tagging/onnxruntime_providers_shared.dll" },
      // cupcat-faces links against a bundled runtime too. It used to borrow diarization's copy by
      // path, which is how it shipped for months with NO runtime beside it at all and failed on
      // every call — see sidecars.test.ts. Its own copy now, from the same release.
      { from: "sherpa-onnx-v1.13.4-win-x64-shared-MD-MinSizeRel-no-tts/bin/onnxruntime.dll", to: "faces/onnxruntime.dll" },
      { from: "sherpa-onnx-v1.13.4-win-x64-shared-MD-MinSizeRel-no-tts/bin/onnxruntime_providers_shared.dll", to: "faces/onnxruntime_providers_shared.dll" },
    ],
    note: "sherpa-onnx v1.13.4 + ONNX Runtime 1.27.0 — Apache-2.0 / MIT.",
  }),
  S({
    group: "diarize",
    id: "pyannote-segmentation",
    url: "https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-segmentation-models/sherpa-onnx-pyannote-segmentation-3-0.tar.bz2",
    kind: "tar.bz2",
    sha256: "24615ee884c897d9d2ba09bb4d30da6bb1b15e685065962db5b02e76e4996488",
    picks: [
      { from: "sherpa-onnx-pyannote-segmentation-3-0/model.onnx", to: "diarize/sherpa-onnx-pyannote-segmentation-3-0.onnx" },
      { from: "sherpa-onnx-pyannote-segmentation-3-0/LICENSE", to: "diarize/pyannote-segmentation-LICENSE" },
    ],
    note: "pyannote segmentation-3.0 (ONNX export) — MIT, © pyannote.",
  }),
  S({
    group: "diarize",
    id: "campplus-embedding",
    url: "https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-recongition-models/3dspeaker_speech_campplus_sv_zh_en_16k-common_advanced.onnx",
    kind: "file",
    // NOT the Mandarin-only …_sv_zh-cn_… model: CupCat shipped that until 1.7.13 and it merged two
    // clearly different English speakers into one "S1".
    sha256: "aa3cfc16963a10586a9393f5035d6d6b57e98d358b347f80c2a30bf4f00ceba2",
    picks: [{ to: "diarize/3dspeaker_speech_campplus_sv_zh_en_16k-common_advanced.onnx" }],
    note: "3D-Speaker CAM++ speaker embedding (VoxCeleb + CNCeleb + 3D-Speaker) — Apache-2.0, © Alibaba.",
  }),
  S({
    group: "separate",
    id: "spleeter-2stems",
    url: "https://github.com/k2-fsa/sherpa-onnx/releases/download/source-separation-models/sherpa-onnx-spleeter-2stems-fp16.tar.bz2",
    kind: "tar.bz2",
    sha256: "d54561979bd2e08a51e7dbd99ac36bb47564e089eefd403636dbca93e811bba2",
    picks: [
      { from: "sherpa-onnx-spleeter-2stems-fp16/vocals.fp16.onnx", to: "separate/vocals.fp16.onnx" },
      { from: "sherpa-onnx-spleeter-2stems-fp16/accompaniment.fp16.onnx", to: "separate/accompaniment.fp16.onnx" },
    ],
    note: "spleeter 2-stems (ONNX, fp16) — MIT, © Deezer, redistributed via sherpa-onnx.",
  }),
  S({
    group: "tagging",
    id: "ced-tiny",
    url: "https://github.com/k2-fsa/sherpa-onnx/releases/download/audio-tagging-models/sherpa-onnx-ced-tiny-audio-tagging-2024-04-19.tar.bz2",
    kind: "tar.bz2",
    sha256: "84baf315b57d61aa69480c4fee878dab54cbc7be3e877db334e65d8b087e23c3",
    picks: [
      { from: "sherpa-onnx-ced-tiny-audio-tagging-2024-04-19/model.int8.onnx", to: "tagging/ced-tiny.int8.onnx" },
      // NOT optional: caption_sounds maps these display names to the words it writes.
      { from: "sherpa-onnx-ced-tiny-audio-tagging-2024-04-19/class_labels_indices.csv", to: "tagging/class_labels_indices.csv" },
    ],
    note: "CED-tiny audio tagging (AudioSet) — Apache-2.0, © Xiaomi. Label list CC-BY-4.0, © Google.",
  }),
  S({
    group: "faces",
    id: "yunet",
    // media.githubusercontent.com/media/, not raw.githubusercontent.com: opencv_zoo keeps its models
    // in Git LFS, and raw serves the 131-byte POINTER instead — which downloads with a cheerful HTTP
    // 200 and lands in the folder under the right name. The lock caught it; the naked eye would not.
    url: "https://media.githubusercontent.com/media/opencv/opencv_zoo/f12e12798e8314f7c074a6656816c048dcc95b7a/models/face_detection_yunet/face_detection_yunet_2023mar.onnx",
    kind: "file",
    sha256: "8f2383e4dd3cfbb4553ea8718107fc0423210dc964f9f4280604804ed2552fa4",
    picks: [{ to: "faces/yunet.onnx" }],
    note: "YuNet face detection — MIT, © Shiqi Yu and contributors, via OpenCV Zoo.",
  }),
];

/** Everything the build produces itself rather than downloading. */
export const BUILT_FILES = [
  "cupcat-bridge.exe (bun build --compile apps/bridge) — staged as a Tauri sidecar, not here",
  "faces/cupcat-faces.exe (cargo build --release --manifest-path apps/faces/Cargo.toml)",
];
