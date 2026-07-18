# Contributing to CupCat

Thanks for your interest in CupCat — a free, local, AI-native video editor for Windows.

## Project layout

CupCat is a Bun monorepo:

| Package | What it is |
|---|---|
| `packages/editor-core` | Pure-TypeScript timeline model — commands, undo/redo, keyframes, selectors. Framework-free, unit-tested. |
| `apps/web` | The editor UI (React 19 + Vite + Tailwind). |
| `apps/bridge` | The local process: MCP server + WebSocket, the on-device AI toolbox, ffmpeg + generation drivers. Compiles to one sidecar binary. |
| `apps/desktop` | The Tauri shell that bundles everything into a Windows installer. |

## Prerequisites

- **[Bun](https://bun.sh)** (see `package.json` → `engines` / `.prototools` for the pinned version)
- **Rust** + the MSVC toolchain (only needed to build the desktop shell / installer)
- **WebView2** (ships with Windows 11; installable on Windows 10)

The bundled AI engines (ffmpeg, Whisper/GGML models, Piper voices, sherpa-onnx models) live under
`apps/desktop/src-tauri/sidecars/` and are **git-ignored** for size. The published installer already
contains them; for local desktop builds you point the bridge at your own copies via the
`CUPCAT_*_BIN` / `CUPCAT_*_DIR` environment variables (see `apps/bridge/src/config.ts`).

## Develop

```bash
bun install
bun run build:core          # build the shared model (other packages depend on it)

# run the web editor and the bridge (bridge listens on 127.0.0.1:19789)
bun run web
bun run bridge
```

Open the printed local URL. To drive the editor with your own Claude:

```bash
claude mcp add --transport http cupcat http://127.0.0.1:19789/mcp
```

## Before you open a PR

Run the same checks CI runs — they must be green:

```bash
bun run typecheck                        # editor-core + bridge + web
bun --filter @cupcat/editor-core test    # timeline model
bun --filter @cupcat/web test            # editor logic
```

Guidelines:

- **Match the surrounding code** — comment density, naming, and idioms.
- **Keep the model framework-free.** `packages/editor-core` must not import from React/Tauri/bridge.
- **Add a test** when you change model behavior (`*.test.ts` next to the code).
- **UI changes** should be checked at a few window widths; nothing may overflow its panel.
- **Exports are user-initiated.** The AI agent prepares an edit and hands the user the Export
  button — it must never render on the user's behalf. Keep that invariant.

## Reporting bugs

Open an issue with the steps to reproduce, the OS build, and — for editor bugs — the smallest
project that shows the problem. For security issues, see [`SECURITY.md`](SECURITY.md).

By contributing you agree that your contributions are licensed under **GPL-3.0-or-later**.
