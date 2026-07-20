# CupCat — Roadmap

CupCat is a free, local, AI-native video editor for Windows. This page is about where it's going.
For what already shipped, see the [releases](../../releases) — every version has full notes.

## Principles

These constrain everything below.

1. **Local first.** If a feature can run on your machine, it runs on your machine. Your footage is
   never uploaded to us — there is no "us" in the pipeline.
2. **No meters.** No credits, no per-export fees, no watermark, no account. Optional generative
   features use *your* account with the provider, never ours.
3. **The agent operates the editor.** Chat isn't a sidebar that emits suggestions — it drives the
   same tools a human uses, on the same timeline, with undo.
4. **Speed is never paid for with quality.** An optimization has to produce identical output; if a
   change would make results worse, it doesn't ship.

## Now

- **Interface language** — full English/Italian UI, chosen on first run and switchable in settings.
- **Onboarding** — connect Claude in one click on a fresh machine, with no manual setup.
- **Speed on long footage** — continued profiling of the transcribe → curate → export pipeline.

## Next

- **GPU-accelerated transcription.** On a first run over a long video, on-device transcription is
  the floor (~85% of the total time). A GPU build of the speech engine is the one lever that
  shortens it without dropping to a smaller, less accurate model.
- **More interface languages**, using the same dictionary layer.
- **Deeper agent skills on the timeline** — smarter multicam, better transition judgement.
- **Templates and brand kits** that travel between projects.

## Exploring

Weighed, not committed: macOS support, a plugin surface for custom tools, collaborative review
links, and richer motion-graphics authoring.

## Contributing

Issues and pull requests are welcome — see [CONTRIBUTING.md](CONTRIBUTING.md). If you're proposing a
feature, say which principle above it serves.
