# Upstream — checked 2026-07-29

## Seen for the first time

- **ffmpeg** `2026-07-28` — Every decode, encode, filter and measurement CupCat performs. 143 MB of the install.
- **yt-dlp** `2026.07.04` — import_from_url — pulling footage in from the web.
- **whisper.cpp** `v1.9.1` — All speech recognition: get_transcript, captions, filler removal, text search, auto_clips.
- **sherpa-onnx** `asr-models-qnn-binary-3` — Speaker diarization (who talks when) and source separation (voice/music stems).
- **piper** `v1.6.0` — generate_speech — local text-to-speech for voiceover.
- **palmier-pro** `v0.6.15` — The blueprint. CupCat copies its data model and MCP surface, on Windows instead of macOS.
- **opencut** `v0.3.0` — The editor shell CupCat's UI descends from.
- **auto-editor** `31.4.0` — Where detect_still's approach came from — cutting on motion, not only on sound.
- **mcp-video** `v1.11.1` — The closest thing to a competitor for CupCat's engine: an MCP server over ffmpeg with QC guardrails.
- **hyperframes** `2026-07-03 @734b404` — Candidate renderer for animated captions and lower thirds beyond what ASS can express.
- **OpenTimelineIO** `v0.18.1` — The interchange format CupCat does not yet write (it exports FCPXML and NLE XML).
- **PySceneDetect** `v0.7.1` — Reference for scene detection; CupCat does its own with ffmpeg's scene score.
- **claude-code-docs** `v2.1.220` — The agent surface CupCat plugs into: MCP transport, tool search, skills, hooks.

## Everything watched

| source | kind | upstream | CupCat ships |
|---|---|---|---|
| ffmpeg | bundled | 2026-07-28 | N-125444-g6d72600a30-20260703 |
| yt-dlp | bundled | 2026.07.04 | 2026.07.04 |
| whisper.cpp | bundled | v1.9.1 | — |
| sherpa-onnx | bundled | asr-models-qnn-binary-3 | — |
| piper | bundled | v1.6.0 | 1.2.0 |
| palmier-pro | reference | v0.6.15 | — |
| opencut | reference | v0.3.0 | — |
| auto-editor | candidate | 31.4.0 | — |
| mcp-video | candidate | v1.11.1 | — |
| hyperframes | candidate | 2026-07-03 @734b404 | — |
| OpenTimelineIO | candidate | v0.18.1 | — |
| PySceneDetect | candidate | v0.7.1 | — |
| claude-code-docs | skill | v2.1.220 | — |
