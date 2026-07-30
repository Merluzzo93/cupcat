# Upstream — checked 2026-07-30

## Moved since the last check

### ffmpeg — `2026-07-28` → `2026-07-29`
*Every decode, encode, filter and measurement CupCat performs. 143 MB of the install.*
**Why it matters:** Filter behaviour changing under us. CupCat depends on the exact stderr of silencedetect, freezedetect and blackdetect, and on xfade/afade semantics — a major bump has broken parsing before.
CupCat ships `N-125444-g6d72600a30-20260703`.
https://github.com/BtbN/FFmpeg-Builds/releases

### palmier-pro — `v0.6.15` → `v0.6.16`
*The blueprint. CupCat copies its data model and MCP surface, on Windows instead of macOS.*
**Why it matters:** New MCP tools and changes to the agent instructions — the gap analysis CupCat is measured against.
https://github.com/palmier-io/palmier-pro/releases

## Seen for the first time

- **higgsfield-cli** `1.1.20` — Every generated image, video and voice: generate_media and the Higgsfield tools go through this CLI.

## Everything watched

| source | kind | upstream | CupCat ships |
|---|---|---|---|
| ffmpeg | bundled | 2026-07-29 | N-125444-g6d72600a30-20260703 |
| higgsfield-cli | bundled | 1.1.20 | 0.1.33 |
| yt-dlp | bundled | 2026.07.04 | 2026.07.04 |
| whisper.cpp | bundled | v1.9.1 | — |
| sherpa-onnx | bundled | asr-models-qnn-binary-3 | — |
| piper | bundled | v1.6.0 | 1.2.0 |
| palmier-pro | reference | v0.6.16 | — |
| opencut | reference | v0.3.0 | — |
| auto-editor | candidate | 31.4.0 | — |
| mcp-video | candidate | v1.11.1 | — |
| hyperframes | candidate | 2026-07-03 @734b404 | — |
| OpenTimelineIO | candidate | v0.18.1 | — |
| PySceneDetect | candidate | v0.7.1 | — |
| claude-code-docs | skill | v2.1.220 | — |
