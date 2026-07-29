// What CupCat depends on, or borrows from, upstream — and why it is worth watching.
//
// This list is the point of the whole exercise. A bare "check for new versions" script tells you
// that ffmpeg moved and leaves you to work out whether you care; this one records, per source, what
// CupCat actually does with it, so a report can say "this matters because X" instead of "new tag".
//
// `probe` is how the SHIPPED version is read from the binary we bundle, rather than from a number
// somebody wrote down. Declared versions drift from installed ones — that is precisely the class of
// bug that shipped a manifest describing a different build than the installer contained.

export type Kind = "bundled" | "reference" | "candidate" | "skill";

export interface Source {
  id: string;
  /** GitHub "owner/name", or null for things that are not on GitHub. */
  repo: string | null;
  kind: Kind;
  /** What CupCat uses it for, in one line. Written for someone reading the report cold. */
  role: string;
  /** Why a new release might matter to CupCat — the question the report is really answering. */
  watchFor: string;
  /** Command that prints the bundled version, relative to the sidecars folder. */
  probe?: { bin: string; args: string[]; extract: RegExp };
  /** Releases can be noisy; some projects only tag. */
  useTags?: boolean;
  /** The release tag never changes (a rolling "latest"): compare its publish date instead. */
  datedRelease?: boolean;
}

const S = (s: Source) => s;

export const SOURCES: Source[] = [
  // ── shipped inside the installer: a new version is a decision, not an upgrade ──────────────
  S({
    id: "ffmpeg",
    repo: "BtbN/FFmpeg-Builds",
    // The release is permanently tagged "latest"; what moves is its publish date.
    datedRelease: true,
    kind: "bundled",
    role: "Every decode, encode, filter and measurement CupCat performs. 143 MB of the install.",
    watchFor:
      "Filter behaviour changing under us. CupCat depends on the exact stderr of silencedetect, freezedetect and blackdetect, and on xfade/afade semantics — a major bump has broken parsing before.",
    probe: { bin: "ffmpeg.exe", args: ["-version"], extract: /ffmpeg version (\S+)/ },
  }),
  S({
    id: "yt-dlp",
    repo: "yt-dlp/yt-dlp",
    kind: "bundled",
    role: "import_from_url — pulling footage in from the web.",
    watchFor:
      "This one rots fastest of all: sites change and an old build simply stops downloading. Worth updating on almost every release, and the most likely source of a silent 'it used to work'.",
    probe: { bin: "yt-dlp.exe", args: ["--version"], extract: /(\d{4}\.\d{2}\.\d{2}(?:\.\d+)?)/ },
  }),
  S({
    id: "whisper.cpp",
    repo: "ggml-org/whisper.cpp",
    kind: "bundled",
    role: "All speech recognition: get_transcript, captions, filler removal, text search, auto_clips.",
    watchFor:
      "Faster decoding and GGML model-format changes. A format change means the bundled ggml-large-v3-turbo-q5 must be regenerated — the 547 MB file the delta updater is careful never to re-download.",
  }),
  S({
    id: "sherpa-onnx",
    repo: "k2-fsa/sherpa-onnx",
    kind: "bundled",
    role: "Speaker diarization (who talks when) and source separation (voice/music stems).",
    watchFor: "Better diarization models, and any change to the CLI flags CupCat calls.",
  }),
  S({
    id: "piper",
    repo: "OHF-Voice/piper1-gpl",
    kind: "bundled",
    role: "generate_speech — local text-to-speech for voiceover.",
    watchFor: "New Italian and English voices, and licence changes: the active fork is GPL-3.0.",
    probe: { bin: "piper/piper.exe", args: ["--version"], extract: /([\d.]+)/ },
  }),

  // ── the projects CupCat is a port of, or is built on ───────────────────────────────────────
  S({
    id: "palmier-pro",
    repo: "palmier-io/palmier-pro",
    kind: "reference",
    role: "The blueprint. CupCat copies its data model and MCP surface, on Windows instead of macOS.",
    watchFor: "New MCP tools and changes to the agent instructions — the gap analysis CupCat is measured against.",
  }),
  S({
    id: "opencut",
    repo: "OpenCut-app/OpenCut",
    kind: "reference",
    role: "The editor shell CupCat's UI descends from.",
    watchFor: "The announced rewrite: editor API, plugin system, MCP server, headless mode.",
  }),

  // ── things worth stealing ideas or code from, per the 2026 feature analysis ───────────────
  S({
    id: "auto-editor",
    repo: "WyattBlue/auto-editor",
    kind: "candidate",
    role: "Where detect_still's approach came from — cutting on motion, not only on sound.",
    watchFor: "New --edit methods worth mirroring as CupCat tools.",
  }),
  S({
    id: "mcp-video",
    repo: "KyaniteLabs/mcp-video",
    kind: "candidate",
    role: "The closest thing to a competitor for CupCat's engine: an MCP server over ffmpeg with QC guardrails.",
    watchFor: "Tools CupCat lacks, and their preflight/quality-check conventions.",
  }),
  S({
    id: "hyperframes",
    repo: "hyperframes/hyperframes",
    kind: "candidate",
    role: "Candidate renderer for animated captions and lower thirds beyond what ASS can express.",
    watchFor: "Whether it is worth adopting for word-by-word caption styling.",
  }),
  S({
    id: "OpenTimelineIO",
    repo: "AcademySoftwareFoundation/OpenTimelineIO",
    kind: "candidate",
    role: "The interchange format CupCat does not yet write (it exports FCPXML and NLE XML).",
    watchFor: "Adapter coverage, in case OTIO export becomes worth adding.",
  }),
  S({
    id: "PySceneDetect",
    repo: "Breakthrough/PySceneDetect",
    kind: "candidate",
    role: "Reference for scene detection; CupCat does its own with ffmpeg's scene score.",
    watchFor: "Detection methods measurably better than a scene-score threshold.",
  }),

  // ── skills and agent-side pieces ──────────────────────────────────────────────────────────
  S({
    id: "claude-code-docs",
    repo: "anthropics/claude-code",
    kind: "skill",
    role: "The agent surface CupCat plugs into: MCP transport, tool search, skills, hooks.",
    watchFor: "Changes to MCP or the tool limit that affect how CupCat exposes 120+ tools.",
  }),
];
