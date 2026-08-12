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
- **Three engines draw CupCat's text and none of them agree by default** — the browser in the
  preview, ffmpeg's `drawtext` for plain text, libass for karaoke and rich text. drawtext does not
  wrap at all and stacks lines flush left; libass wraps at a width of its own. So line breaks are
  decided in `textmetrics.ts`, from the font file's advance widths, and written into the text as real
  newlines. Never let a renderer choose: that is how a caption came to run 1276 px across a 1280 px
  frame while the preview showed it neatly wrapped.
- **Set `CUPCAT_PROJECT_DIR` before running anything that calls a tool.** Tools that add an asset end
  with `saveProject`, which writes `project.json` in the *user's real* project folder — a scratch
  script driving `executeTool` overwrites whatever project is there. Point it at a temp directory.
- **Never pick a TCP port by hand.** Windows reserves whole blocks of the ephemeral range for Hyper-V
  and WSL (`netsh interface ipv4 show excludedportrange protocol=tcp`), and a bind inside one comes
  back WSAEACCES. `cdp.ts` used to gamble on 19200–19699; on a machine reserving 19146–19661 it failed
  nine launches in ten, and every tool that needs a rendered page — motion graphics, transitions,
  `capture_frame`, `inspect_timeline` — reported "Edge headless unavailable". Ask for port 0 and read
  back what you were given.
- **When ffmpeg fails, the last thing it complains about is rarely the cause.** A filtergraph that
  never builds surfaces as the *audio encoder* giving up ("Could not open encoder before EOF").
  `CUPCAT_DUMP_FFMPEG=1` prints the exact argv, which is the fastest way to the real fault;
  `ffmpegFailureReason` is what picks the honest line out of the stderr for the user.
- **Working files go in `exports/` and must be sweepable.** Anything temporary gets one of the
  prefixes in `scratch.ts`; nothing else in that folder is ever deleted, because the rest is the
  user's rendered video.

## Building and releasing

```
bun run sidecars                       # 402 bundled engine files, pinned + hash-verified
bun run typecheck && bun test          # 840 tests; all must pass
bun run build:web && bun run build:bridge
cp dist-bridge/cupcat-bridge.exe apps/desktop/src-tauri/binaries/cupcat-bridge-x86_64-pc-windows-msvc.exe
cd apps/desktop && npx @tauri-apps/cli@latest build      # needs cargo AND node on PATH
bun run apps/desktop/tools/manifest.ts <version>          # AFTER the build: reads the installer itself
7z x -y -o<dir> target/release/bundle/nsis/CupCat_<v>_x64-setup.exe && rm -rf <dir>/\$PLUGINSDIR
bun run apps/desktop/tools/check-manifest.ts apps/desktop/manifests/<v>.json <dir>   # must be 0/0/0
```

The manifest must be generated **after** `tauri build` and takes both executables **out of the
installer** — tauri stamps the binary while bundling, so `target/release/cupcat.exe` is a different
file from the one that gets installed. Publishing the wrong one puts a checksum in the manifest that no
installed copy can match. Once signing is live it must also come **after** signing, which rewrites
those same bytes: `manifest.ts <version> --installer <signed installer>`.

Releases are meant to be built by `.github/workflows/release.yml` on GitHub-hosted runners — not
because CI is tidier, but because SignPath refuses to sign anything else. See `docs/SIGNING.md`.

**Commit `apps/desktop/manifests/<version>.json` after publishing.** It is what the next build
compares against, and CI cannot push it — the copy in the artifact is the only one. Three releases
went out comparing against 1.8.1 because nobody brought it back.

Then `gh release create v<version>` with the installer, `manifest.json` and the `file__*` assets, and
update the version on the site. A small fix can instead go **into the existing release**
(`manifest.ts <version> --tag v<existing>` + `gh release upload --clobber`): CupCat reads the version
from the manifest, not from the tag.

See `D:\Brain\memory\cupcat-updater-traps.md` before touching the updater or the installer — five
releases failed in production teaching those lessons.
