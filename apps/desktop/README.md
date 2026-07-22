# CupCat Desktop (Tauri)

The Windows desktop shell. It launches the compiled bridge (`cupcat-bridge.exe`) as a **sidecar**
and shows the bundled SPA, which talks to the bridge on `127.0.0.1:19789` (MCP + WebSocket + media).
The result is a single installable app — the end user needs **no** bun, node, ffmpeg, or Python.

## Build prerequisites (build machine only — NOT the end user)

- **Rust** (MSVC toolchain) + the MSVC linker — verified here: `rustc 1.96 x86_64-pc-windows-msvc`.
- **bun** (to compile the bridge and build the web SPA).
- **WebView2** runtime (present on Windows 11 / installed by the NSIS bundle on older Windows).
- Tauri downloads **NSIS** automatically on first bundle.

## Build the installer

From the repo root:

```sh
# 1. Build the web SPA  → apps/web/dist  (bundled by Tauri as the frontend)
bun run build:web

# 2. Compile the bridge → dist-bridge/cupcat-bridge.exe  (self-contained, bun runtime included)
bun run build:bridge

# 3. Copy the bridge in as the Tauri sidecar (target-triple-suffixed name)
cp dist-bridge/cupcat-bridge.exe \
   apps/desktop/src-tauri/binaries/cupcat-bridge-x86_64-pc-windows-msvc.exe

# 4. Build the desktop app + NSIS installer
cd apps/desktop && npx @tauri-apps/cli@latest build
```

The installer lands in `apps/desktop/src-tauri/target/release/bundle/nsis/`.

## Dev

```sh
cd apps/desktop && npx @tauri-apps/cli@latest dev
```

(Requires the web `dist` to exist — run `bun run build:web` first, or point `build.devUrl`
at the Vite dev server.)

## Testing against the RIGHT ffmpeg

The bridge resolves ffmpeg from `CUPCAT_FFMPEG_BIN`, which `main.rs` points at the bundled sidecar.
A dev shell without that variable falls back to whatever `ffmpeg` is on PATH — often a different,
older build. That difference has shipped a real bug: `-filter_complex_script` works on ffmpeg 7 but
was REMOVED in 8 (the bundled build), so face blur passed locally and failed in the installed app.

When testing anything that shells out to ffmpeg, point the bridge at the sidecar:

```sh
CUPCAT_FFMPEG_BIN=apps/desktop/src-tauri/sidecars/ffmpeg.exe CUPCAT_FFPROBE_BIN=apps/desktop/src-tauri/sidecars/ffprobe.exe CUPCAT_PORT=19790 bun run bridge
```

## Bundled sidecars

`tauri build` bundles everything in `src-tauri/sidecars/` (gitignored) into the installer, and
`main.rs` points the bridge at them via env, so the installed app needs nothing preinstalled.
Populate that folder before building:

```sh
mkdir -p apps/desktop/src-tauri/sidecars

# ffmpeg/ffprobe — the REAL binaries (not the chocolatey shims)
cp "C:/ProgramData/chocolatey/lib/ffmpeg/tools/ffmpeg/bin/ffmpeg.exe"  apps/desktop/src-tauri/sidecars/
cp "C:/ProgramData/chocolatey/lib/ffmpeg/tools/ffmpeg/bin/ffprobe.exe" apps/desktop/src-tauri/sidecars/

# Higgsfield CLI → standalone exe (no Node needed)
bun build --compile node_modules/@higgsfield/cli/bin/higgsfield.js \
  --outfile apps/desktop/src-tauri/sidecars/higgsfield.exe

# whisper.cpp (whisper-cli.exe + ggml*.dll) — from github.com/ggml-org/whisper.cpp/releases (whisper-bin-x64.zip)
# + model ggml-base.bin — from huggingface.co/ggerganov/whisper.cpp
# unzip the Release/ DLLs + whisper-cli.exe and the model into src-tauri/sidecars/

# speaker diarization (sidecars/diarize) — sherpa-onnx CLI + DLLs + TWO .onnx models:
#   sherpa-onnx-pyannote-segmentation-3-0.onnx            (who-speaks-when boundaries)
#   3dspeaker_speech_campplus_sv_zh_en_16k-common_advanced.onnx   (which voice is which)
# Both from github.com/k2-fsa/sherpa-onnx/releases (speaker-recongition-models).
# The embedding model MUST NOT be a Mandarin-only one (…_sv_zh-cn_…): CupCat shipped that until
# 1.7.13 and it merged two clearly different English speakers into a single "S1".
#
# ⚠️ After REPLACING a sidecar file, delete the stale copy from the staging directory as well —
# `tauri build` copies resources in but never removes ones that have gone from the source, so the
# old file rides along in the installer:
#   rm target/release/sidecars/<the file you replaced>

# face detection (apps/faces) — our own Rust sidecar, built from source
cargo build --release --manifest-path apps/faces/Cargo.toml
mkdir -p apps/desktop/src-tauri/sidecars/faces
cp apps/faces/target/release/cupcat-faces.exe apps/desktop/src-tauri/sidecars/faces/
# + the YuNet model (MIT, ~230 KB) from github.com/opencv/opencv_zoo
#   → face_detection_yunet_2023mar.onnx, renamed to sidecars/faces/yunet.onnx
```

The faces sidecar links against the ONNX Runtime that diarization already ships
(`ORT_DYLIB_PATH` → `sidecars/diarize/onnxruntime.dll`), so it adds no second runtime — build it
after `diarize/` is populated.

Wired env (`main.rs`): `CUPCAT_FFMPEG_BIN`, `CUPCAT_FFPROBE_BIN`, `CUPCAT_HIGGSFIELD_BIN`,
`CUPCAT_WHISPER_KIND=cpp`, `CUPCAT_WHISPER_BIN`, `CUPCAT_WHISPER_MODEL_FILE`,
`CUPCAT_FACES_BIN`, `CUPCAT_FACES_MODEL`, `ORT_DYLIB_PATH`.

Note that `resources` in `tauri.conf.json` lists every sidecar **subdirectory** by name: the
`sidecars/*` glob matches files only, so a new subfolder that isn't listed silently ships empty.

## First run (Fase 7d)

A setup step runs `higgsfield auth login` (browser OAuth) for generation, and helps connect Claude
via `claude mcp add --transport http cupcat http://127.0.0.1:19789/mcp` (Claude Code) or the bundled
`.mcpb` (Claude Desktop). CupCat uses the user's own Claude subscription — no API key is embedded.
