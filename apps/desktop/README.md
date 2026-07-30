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

**One command populates the folder.** 402 downloaded files, each source pinned to an exact version and
verified by SHA-256, and the assembled tree checked against `tools/sidecars/sidecars.lock.json`:

```sh
bun run sidecars            # ~1.3 GB, cached in .sidecar-cache/ so a re-run costs nothing
bun run sidecars:check      # verify an existing folder without downloading
```

It exists because a folder that only one laptop knows how to build cannot be built by CI — and CI is
not optional: SignPath signs artifacts produced by a GitHub-hosted workflow and nothing else. The
pinning is not ceremony either. Writing it caught two things a hand-built folder hides: OpenCV Zoo
serves YuNet through Git LFS, so `raw.githubusercontent.com` hands you a 131-byte pointer file with a
cheerful HTTP 200; and the shipped folder had silently lost `espeak-ng-data/voices/!v/Mr serious`
somewhere along the way.

One file is BUILT rather than downloaded, and the lock deliberately ignores it:

```sh
# face detection — our own Rust sidecar
cargo build --release --manifest-path apps/faces/Cargo.toml
cp apps/faces/target/release/cupcat-faces.exe apps/desktop/src-tauri/sidecars/faces/
```

`higgsfield.exe` used to be built here too, with `bun build --compile` over the `@higgsfield/cli` npm
package. That package is only a launcher — its postinstall downloads the real binary — so the result
was the bun runtime wrapped around a program that did not need it: 98 MB where the official build is
8.6 MB. It is now fetched and pinned like everything else, same version and same commit (0.1.33 /
`08b6bcd5`), verified identical on every command the bridge calls and on a live `model list --json`.

Notes worth keeping:

- The diarization embedding model MUST NOT be a Mandarin-only one (`…_sv_zh-cn_…`): CupCat shipped
  that until 1.7.13 and it merged two clearly different English speakers into a single "S1".
- `tagging/class_labels_indices.csv` is not optional — `caption_sounds` maps its display names to the
  words it writes.
- Every sidecar folder carries its OWN `onnxruntime.dll`, and `ORT_DYLIB_PATH` points the faces
  sidecar at the copy beside it. A sidecar that reaches into a sibling folder for its runtime is one
  deletion away from silently loading Windows' own `System32\onnxruntime.dll` and failing in a way
  every caller catches — see `apps/bridge/src/sidecars.test.ts`.
- ⚠️ After REPLACING a sidecar file, delete the stale copy from the staging directory as well:
  `tauri build` copies resources in but never removes ones that have gone from the source, so the old
  file rides along in the installer — `rm target/release/sidecars/<the file you replaced>`.

Wired env (`main.rs`): `CUPCAT_FFMPEG_BIN`, `CUPCAT_FFPROBE_BIN`, `CUPCAT_HIGGSFIELD_BIN`,
`CUPCAT_WHISPER_KIND=cpp`, `CUPCAT_WHISPER_BIN`, `CUPCAT_WHISPER_MODEL_FILE`,
`CUPCAT_FACES_BIN`, `CUPCAT_FACES_MODEL`, `ORT_DYLIB_PATH`.

Note that `resources` in `tauri.conf.json` lists every sidecar **subdirectory** by name: the
`sidecars/*` glob matches files only, so a new subfolder that isn't listed silently ships empty.

## First run (Fase 7d)

A setup step runs `higgsfield auth login` (browser OAuth) for generation, and helps connect Claude
via `claude mcp add --transport http cupcat http://127.0.0.1:19789/mcp` (Claude Code) or the bundled
`.mcpb` (Claude Desktop). CupCat uses the user's own Claude subscription — no API key is embedded.
