# CupCat — working notes for an agent

Free, local, AI-native video editor for Windows. Bun monorepo: `packages/editor-core` (timeline model),
`apps/bridge` (the engine — MCP over HTTP + WebSocket, compiled to one sidecar binary),
`apps/web` (React UI), `apps/desktop` (Tauri shell → NSIS installer).

## Before starting

**Check what upstream has done.** `bun run upstream` compares every tool CupCat ships or borrows from
against its source and writes `tools/upstream/UPSTREAM.md`. It exits 1 when something moved, 0 when
nothing has. `yt-dlp` in particular rots: sites change and an old build silently stops downloading.

**Read `D:\Brain\memory\cupcat-feature-map.md` before implementing anything from a feature document.**
CupCat already has ~40 of the 66 features those documents describe. The expensive mistake is
rebuilding one.

## Rules that come from things that actually broke

- **Test ffmpeg with the bundled binary**, `apps/desktop/src-tauri/sidecars/ffmpeg.exe`, never the one
  on PATH. They are different versions and behave differently.
- **Hooks before any early return** in a React component. React counts hooks per render and throws
  when the count changes; nothing catches it, the tree unmounts, and the window goes black. This
  shipped once. `apps/web/src/editor/Crash.tsx` now catches it, but the rule stands.
- **Every user-visible string goes through `t()`**, in both dictionaries. A missing Italian entry
  silently renders English — `i18n.test.ts` fails and names it.
- **Line endings vary per file** in this repo. A replacement anchored on the wrong ones fails
  silently, and `git commit -a` then commits nothing.
- **No export without a check.** `quality_report` exists for this; the agent instructions require it.

## Building and releasing

```
bun run typecheck && bun test          # 535 tests; all must pass
bun run build:web && bun run build:bridge
cp dist-bridge/cupcat-bridge.exe apps/desktop/src-tauri/binaries/cupcat-bridge-x86_64-pc-windows-msvc.exe
cd apps/desktop && npx @tauri-apps/cli@latest build      # needs cargo AND node on PATH
bun run apps/desktop/tools/manifest.ts <version>          # AFTER the build: reads the installer itself
7z x -y -o<dir> target/release/bundle/nsis/CupCat_<v>_x64-setup.exe && rm -rf <dir>/\$PLUGINSDIR
bun run apps/desktop/tools/check-manifest.ts apps/desktop/manifests/<v>.json <dir>   # must be 0/0/0
```

The manifest must be generated **after** `tauri build` and takes `cupcat.exe` **out of the installer**
— tauri stamps the binary while bundling, so `target/release/cupcat.exe` is a different file from the
one that gets installed. Publishing the wrong one puts a checksum in the manifest that no installed
copy can match.

Then `gh release create v<version>` with the installer, `manifest.json` and the `file__*` assets, and
update the version on the site. A small fix can instead go **into the existing release**
(`manifest.ts <version> --tag v<existing>` + `gh release upload --clobber`): CupCat reads the version
from the manifest, not from the tag.

See `D:\Brain\memory\cupcat-updater-traps.md` before touching the updater or the installer — five
releases failed in production teaching those lessons.
