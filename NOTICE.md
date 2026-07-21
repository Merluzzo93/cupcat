# CupCat — Notices & Licensing

**CupCat** is a free, AI-native video editor for Windows: a CapCut alternative where
**Claude** edits your timeline over MCP and **Higgsfield** generates media.

## License: GPL-3.0-or-later

CupCat ports the timeline data model, the MCP tool surface, and the agent prompts from
**Palmier Pro** (© Palmier, Inc.), which is licensed under **GPL-3.0**. Because CupCat is a
derivative work of GPLv3 software, **CupCat as a whole is distributed under GPL-3.0-or-later**.

## Provenance

- **UI shell / project scaffold** — derived from **OpenCut**
  (github.com/opencut-app/opencut), **MIT** licensed. MIT is compatible with combination
  into a GPLv3 work.
- **Timeline model, MCP tool surface, agent instructions** — ported from **Palmier Pro**
  (**GPLv3**) into TypeScript.
- **Generative AI** — provided by **Higgsfield** through its official CLI; not bundled, and
  used under the user's own Higgsfield account.
- **Claude** connects as an MCP client (Claude Code / Claude Desktop) under the user's own
  Anthropic subscription. No API key is embedded in CupCat.

The full GPL-3.0 text lives in `LICENSE`. Third-party dependencies retain their own licenses.

## Bundled binaries (desktop installer)

The Windows installer ships these third-party tools as sidecars; each keeps its own license:

- **ffmpeg / ffprobe** — © the FFmpeg project. The bundled build is GPL-licensed, compatible with CupCat's GPLv3. (ffmpeg.org)
- **whisper.cpp** (`whisper-cli` + ggml libraries) — MIT, © ggml-org / G. Gerganov. (github.com/ggml-org/whisper.cpp)
- **ggml large-v3-turbo (q5) & ggml-base** speech models — derived from OpenAI Whisper (MIT), redistributed via whisper.cpp.
- **yt-dlp** — Unlicense (public domain); used for URL imports the user requests. (github.com/yt-dlp/yt-dlp)
- **sherpa-onnx** (`sherpa-onnx-offline-speaker-diarization` + onnxruntime) — Apache-2.0, © k2-fsa / Xiaomi Corp. Used for on-device speaker diarization. (github.com/k2-fsa/sherpa-onnx)
- **pyannote segmentation-3.0** speaker segmentation model (ONNX export) — MIT, © pyannote (huggingface.co/pyannote/segmentation-3.0); **3D-Speaker ERes2Net** speaker embedding model — Apache-2.0, © Alibaba 3D-Speaker. Both redistributed via sherpa-onnx.
- **YuNet** face detection model (`face_detection_yunet_2023mar.onnx`) — MIT, © Shiqi Yu and contributors,
  redistributed via OpenCV Zoo (github.com/opencv/opencv_zoo). Run on-device by `cupcat-faces`, our own
  sidecar (`apps/faces`, GPL-3.0-or-later), which links the ONNX Runtime already bundled above.
- **ort** Rust bindings for ONNX Runtime — MIT/Apache-2.0, © pyke.io; **image** crate — MIT, © image-rs.
- **Higgsfield CLI** — © Higgsfield; used under the user's own Higgsfield account.

## Bundled web assets

- **MediaPipe Tasks Vision** (wasm runtime) and the **BlazeFace short-range** face-detection
  model — **Apache-2.0**, © Google. Bundled in the editor UI for on-device auto-reframe;
  no data leaves the machine. (developers.google.com/mediapipe)

These binaries are not committed (see `.gitignore`); `apps/desktop/README.md` documents how to fetch/build them before bundling.
