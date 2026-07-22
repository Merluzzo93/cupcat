// MCP tool definitions — the 31-tool surface, ported from Palmier Pro's ToolDefinitions and
// adapted to CupCat (generation runs through the Higgsfield CLI; "canGenerate" reflects whether
// `higgsfield auth login` has been done). Schemas are plain JSON Schema.

export interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

function obj(properties: Record<string, unknown> = {}, required: string[] = []): Record<string, unknown> {
  const s: Record<string, unknown> = { type: "object" };
  if (Object.keys(properties).length) s.properties = properties;
  if (required.length) s.required = required;
  return s;
}

export const TOOL_DEFS: ToolDef[] = [
  // ── read ──
  {
    name: "get_timeline",
    description:
      "Always call at the start of a session. Returns project settings (fps, resolution, totalFrames), the track list with types and order, all clips with their frames and properties, and canGenerate (if false, the Higgsfield CLI isn't authenticated — tell the user to run `higgsfield auth login` before generation/upscale tools). The clipId/trackId values here are what every other tool accepts.\n\nClip and track fields equal to their defaults are omitted: mediaType 'video', sourceClipType = mediaType, speed 1, volume 1, opacity 1, trims/fades 0, identity transform/crop, default textStyle, track muted/hidden false. Text clips never report trims.\n\nCaption clips (sharing a captionGroupId) come back per track as captionGroups instead of clips: properties common to the group are hoisted into 'shared' and each clip is a [clipId, startFrame, durationFrames, text] row. Rows are capped at 200 per group; page with startFrame/endFrame when clipCount exceeds the rows shown.",
    inputSchema: obj({
      startFrame: { type: "integer", description: "Optional. Window start (inclusive); only clips intersecting [startFrame, endFrame) are returned." },
      endFrame: { type: "integer", description: "Optional. Window end (exclusive)." },
    }),
  },
  {
    name: "get_media",
    description:
      "Call before referencing any asset. Every mediaRef in other tools comes from the IDs returned here. Also exposes generationStatus (generating | downloading | rendering | failed | none) for async-generated and -imported assets.",
    inputSchema: obj(),
  },
  {
    name: "inspect_media",
    description:
      "Look at a media asset before referencing or editing it. Images: dimensions + the picture. Video: duration, dimensions, sampled frames you can SEE, and a transcription of the audio track. Audio: transcription. Pass atSeconds (e.g. the sceneChanges from analyze_footage) to grab one frame per shot instead of uniform sampling. Use this to verify what an asset actually contains instead of guessing from its name.",
    inputSchema: obj(
      {
        mediaRef: { type: "string", description: "Asset ID from get_media." },
        startSeconds: { type: "number", description: "Video/audio. Source-time window start (uniform sampling)." },
        endSeconds: { type: "number", description: "Video/audio. Window end (default: asset duration)." },
        maxFrames: { type: "integer", description: "Uniform sampling frame count (default 4, max 8)." },
        atSeconds: { type: "array", items: { type: "number" }, description: "Video. Grab frames at these exact source times instead of uniform sampling (max 12) — e.g. analyze_footage's sceneChanges for one frame per shot." },
      },
      ["mediaRef"],
    ),
  },
  {
    name: "get_transcript",
    description:
      "Returns the spoken transcript of the CURRENT timeline in project frames — walks every audio/video clip, maps each word through that clip's trim/speed/position, and concatenates in timeline order. Use for transcript-driven edits (filler-word / dead-air removal, locating a quote) and to verify what remains after cutting. If identify_speakers was run on an asset earlier in the session, that asset's words gain a 4th element — the speaker label ('S1','S2'…) — and wordFormat reflects it. Speaker tagging never runs diarization by itself (it is slow); call identify_speakers explicitly first when you need speakers.",
    inputSchema: obj({
      startFrame: { type: "integer", description: "Optional. Only return words ending after this project frame." },
      endFrame: { type: "integer", description: "Optional. Only return words starting before this project frame." },
      clipId: { type: "string", description: "Scope the transcript to a single clip." },
      language: { type: "string", description: "Optional ISO language hint (e.g. 'it', 'en') to improve transcription accuracy." },
    }),
  },
  {
    name: "inspect_timeline",
    description:
      "See the composited timeline — what the user sees in the preview at a given frame: all video tracks stacked with transforms, opacity, crop, and keyframes applied, plus text/caption overlays. Use to verify your edits landed. Frames are project frames. (Compositing render is wired in a later build.)",
    inputSchema: obj({
      startFrame: { type: "integer", description: "Project frame to render (default 0)." },
      endFrame: { type: "integer", description: "Optional. Sample maxFrames evenly across [startFrame, endFrame)." },
      maxFrames: { type: "integer", description: "Frames to sample when endFrame is set (default 6, max 12)." },
    }),
  },
  {
    name: "timeline_view",
    description:
      "READ a clip in one image (like video-use): a composite with the filmstrip (sampled frames) on top, the audio waveform below, a RED overlay on every detected silence (your cut candidates), a seconds ruler, and the transcript words in yellow at their timestamps. The fastest way to SEE where dead air and word boundaries are before cutting — no frame dumping. Then call ripple_delete_ranges (units:'seconds') on the red regions to remove the pauses. Defaults to the first audio/video clip if clipId is omitted.",
    inputSchema: obj({
      clipId: { type: "string", description: "Timeline clip to inspect. Omit to use the first audio/video clip." },
      language: { type: "string", description: "Optional ISO language hint for the transcript (e.g. 'it', 'en')." },
      thresholdDb: { type: "number", description: "Silence threshold in dB (default -30; lower = stricter)." },
      minSilenceSeconds: { type: "number", description: "Minimum silence length to mark, in seconds (default 0.4)." },
    }),
  },
  {
    name: "list_projects",
    description: "List every CupCat project (name, folder path, and which one is currently open). Use before open_project/new_project to see what's available.",
    inputSchema: obj({}),
  },
  {
    name: "open_project",
    description: "Switch to an existing project by name (from list_projects) or by folder path. Reloads the timeline/media from that project; loose media files in its folder are auto-imported.",
    inputSchema: obj({ name: { type: "string", description: "Project name (from list_projects) or a folder path." } }, ["name"]),
  },
  {
    name: "new_project",
    description: "Create a brand-new, empty project with the given name and switch to it.",
    inputSchema: obj({ name: { type: "string", description: "Name for the new project." } }, ["name"]),
  },
  {
    name: "add_matte",
    description:
      "Create a solid-color background clip (a matte) — for color blocks, letterboxing, a backdrop behind text, or a full-frame overlay layer for a blend mode. Adds it to the media library, and places it on the timeline immediately if startFrame+durationFrames are given.",
    inputSchema: obj(
      {
        color: { type: "string", description: "'#RRGGBB' or '#RRGGBBAA' (default '#000000')." },
        width: { type: "integer", description: "Defaults to the project canvas width." },
        height: { type: "integer", description: "Defaults to the project canvas height." },
        startFrame: { type: "integer", description: "Place on the timeline at this project frame. Omit to only add to the library." },
        durationFrames: { type: "integer", description: "Required together with startFrame to place it." },
        trackIndex: { type: "integer", description: "Optional destination track (0 = top layer)." },
      },
      [],
    ),
  },
  {
    name: "add_adjustment_layer",
    description:
      "Add an ADJUSTMENT LAYER: a clip with no media of its own whose color grade and effects apply to EVERYTHING composited below it during its time window (CapCut/After Effects semantics). PREFER this over grading clips one by one for 'applica un filtro a tutto il video' / 'make the whole video black-and-white' / a look over a whole section — one layer instead of N per-clip grades. Create it, then call apply_color / apply_effect on the returned clipId (supported there: all color knobs + look/blur/sharpen/grain/vignette/chromakey; glow and shake are NOT applied by adjustment layers). Split/move/trim/remove it like any clip to reshape where the look applies.",
    inputSchema: obj(
      {
        startFrame: { type: "integer", description: "Project frame where the adjustment starts." },
        durationFrames: { type: "integer", description: "How long it stays active, in project frames." },
        trackIndex: { type: "integer", description: "Optional destination video track. Omit to create a fresh TOP track (recommended — it then affects every existing video layer)." },
        name: { type: "string", description: "Optional label shown on the timeline block." },
      },
      ["startFrame", "durationFrames"],
    ),
  },
  {
    name: "merge_clips",
    description:
      "Flatten the ENTIRE timeline into one single clip: renders everything (all tracks, segments, overlays, audio) to a new video file, then replaces the timeline with that one continuous clip. Use after editing — e.g. once you've removed pauses and the user wants the split segments turned back into a single unbroken clip (this also removes any seam between segments). Irreversible-ish: the new clip is a flattened render, so do edits first.",
    inputSchema: obj({}),
  },
  {
    name: "remove_words",
    description:
      "Cut specific spoken words out of a clip and ripple the gap closed (audio stays in sync). Pass words (e.g. ['um','you know','so']) to remove every occurrence, or fillers:true to auto-remove common filler words ('um','uh','like','ehm','cioè',…). stutters:true also removes stutters/word-restarts ('the the', 'compl- completely'): the earlier occurrence is deleted, the re-said word kept. Uses the on-device transcript; pair with timeline_view to see what's left. Removes only the words — run dead-air removal separately for the pauses.",
    inputSchema: obj(
      {
        clipId: { type: "string", description: "Timeline clip to edit." },
        words: { type: "array", items: { type: "string" }, description: "Words/phrases to remove (case-insensitive). Omit to use the filler list." },
        fillers: { type: "boolean", description: "Also remove common filler words (default true when 'words' is omitted)." },
        stutters: { type: "boolean", description: "Also remove immediate word repeats and restarts (keeps the later, complete occurrence)." },
        retakes: { type: "boolean", description: "Also remove abandoned sentences that were immediately re-said (two consecutive sentences starting with the same 2+ words → the earlier WHOLE sentence is cut). HIGH-risk: review the transcript first per the deletion-risk policy." },
        language: { type: "string", description: "Optional ISO language hint (e.g. 'it', 'en')." },
      },
      ["clipId"],
    ),
  },
  {
    name: "search_media",
    description:
      "Search the media library by content: what's on screen (visual: asset names + the AI generation prompt each clip was made from, token-ranked) and what's said (spoken: on-device transcript match). Hits are source-second ranges ready to convert into add_clips trims. For visual find on non-AI footage, use inspect_media to SEE candidate frames.",
    inputSchema: obj(
      {
        query: { type: "string", description: "What to find. Visual: a caption-style scene description. Spoken: the words to match." },
        scope: { type: "string", enum: ["visual", "spoken", "both"], description: "Optional. Default both." },
        mediaRef: { type: "string", description: "Optional. Restrict to one asset." },
        limit: { type: "integer", description: "Optional. Max hits per group (default 10, max 50)." },
      },
      ["query"],
    ),
  },
  {
    name: "list_models",
    description:
      "Lists Higgsfield AI models (job_set_types) with their type. Always call before generate_video, generate_image, generate_audio, or upscale_media so the model you pick exists and supports the asset type you need. Returns { models }. If empty, the Higgsfield CLI may not be authenticated — tell the user to run `higgsfield auth login`.",
    inputSchema: obj({
      type: { type: "string", enum: ["video", "image", "audio", "upscale"], description: "Filter by type. Omit to list all." },
      model: { type: "string", description: "Optional. A model id (job_set_type) — returns THAT model's parameter spec (names, types, defaults, required, enums) instead of the list. Call before generate_* to know which settings to pass via `params`." },
    }),
  },

  // ── timeline edit ──
  {
    name: "add_clips",
    description:
      "Places one or more media assets on the timeline as one undoable action. Each entry's asset type must be compatible with its target track (video/image interchangeable across video/image tracks; audio requires an audio track). A video asset with audio placed on a video track auto-creates a linked audio clip on an audio track.\n\ntrackIndex is optional: omit it on every entry to auto-create one shared video track and/or one shared audio track — THE right move for music beds and overlays; set it on every entry to target existing tracks. Mixing is rejected.\n\nPlacing into an occupied region of an explicit track is REFUSED (it would delete what's there — e.g. music wiping the voice track); the error says what to do. Pass replace:true only when you intend to overwrite that region.",
    inputSchema: obj(
      {
        entries: {
          type: "array",
          description: "Clips to add. Validated up front; one bad entry rejects the whole call.",
          items: obj(
            {
              mediaRef: { type: "string", description: "ID of the media asset from get_media." },
              trackIndex: { type: "integer", description: "Optional. 0-based track index. Omit on every entry to auto-create shared tracks." },
              startFrame: { type: "integer", description: "Timeline frame position (project frames)." },
              durationFrames: { type: "integer", description: "Clip length on the timeline, in project frames." },
              trimStartFrame: { type: "integer", description: "Optional. Frames skipped from the START of the source, in PROJECT frames (timeline fps). 0 = start of source." },
              trimEndFrame: { type: "integer", description: "Optional. Frames trimmed off the END of the source, in PROJECT frames. 0 = trim nothing." },
            },
            ["mediaRef", "startFrame", "durationFrames"],
          ),
        },
        replace: { type: "boolean", description: "Intentionally overwrite occupied regions of explicit target tracks (default false: occupied = error)." },
      },
      ["entries"],
    ),
  },
  {
    name: "insert_clips",
    description:
      "Inserts one or more assets at a single point and RIPPLES: every clip at or after atFrame is pushed right to open a gap, so nothing is overwritten. The non-destructive counterpart to add_clips. Entries are laid end-to-end from atFrame on the target track; the push (sum of durations) also applies to every sync-locked track so linked audio stays aligned. trackIndex is required.",
    inputSchema: obj(
      {
        trackIndex: { type: "integer", description: "0-based track index to insert into and ripple." },
        atFrame: { type: "integer", description: "Timeline frame where insertion begins; clips at/after shift right by the inserted duration." },
        entries: {
          type: "array",
          items: obj(
            {
              mediaRef: { type: "string", description: "ID of the media asset." },
              durationFrames: { type: "integer", description: "Optional. Timeline length; omit to use the asset's full source duration." },
              trimStartFrame: { type: "integer", description: "Optional. Source START offset in PROJECT frames." },
              trimEndFrame: { type: "integer", description: "Optional. Source END trim in PROJECT frames." },
            },
            ["mediaRef"],
          ),
        },
      },
      ["trackIndex", "atFrame", "entries"],
    ),
  },
  {
    name: "remove_clips",
    description:
      "Removes one or more clips by ID as one undoable action. Any clip in a link group (e.g. a video with its paired audio) takes its whole group with it.",
    inputSchema: obj({ clipIds: { type: "array", items: { type: "string" }, description: "Clip IDs to remove." } }, ["clipIds"]),
  },
  {
    name: "remove_tracks",
    description:
      "Removes whole tracks and every clip on them in one undoable action. Linked partners on OTHER tracks are not removed. Remaining track indexes shift down after removal.",
    inputSchema: obj({ trackIndexes: { type: "array", items: { type: "integer" }, description: "0-based track indexes to remove." } }, ["trackIndexes"]),
  },
  {
    name: "apply_layout",
    description:
      "Arrange multiple clips into a preset composition in one call — split-screen, picture-in-picture, or a grid — instead of hand-computing transform math per clip. Sets each clip's position/size (transform) to its slot; a mismatched-aspect clip fits into its slot without distortion (same as the preview). Available layouts: 'side-by-side' (2 slots, left/right halves), 'top-bottom' (2 slots), 'pip-top-left'/'pip-top-right'/'pip-bottom-left'/'pip-bottom-right' (2 slots: slot 0 = full-frame background, slot 1 = a small corner box), 'grid-2x2' (4 slots), 'grid-3x3' (9 slots).",
    inputSchema: obj(
      {
        layout: {
          type: "string",
          enum: ["side-by-side", "top-bottom", "pip-top-left", "pip-top-right", "pip-bottom-left", "pip-bottom-right", "grid-2x2", "grid-3x3"],
        },
        clipIds: { type: "array", items: { type: "string" }, description: "One clip per slot, in slot order. Use this OR 'slots', not both." },
        slots: {
          type: "array",
          description: "Alternative to clipIds: one entry per slot, each with a batch of clip IDs sharing that slot over time (e.g. several guests taking turns in the same PiP corner).",
          items: { type: "object", properties: { clipIds: { type: "array", items: { type: "string" } } }, required: ["clipIds"] },
        },
      },
      ["layout"],
    ),
  },
  {
    name: "reorder_tracks",
    description:
      "Change the stacking order of tracks by moving one track to a new index (its clips ride along). Index 0 is the top/front layer. Use to put a video above/below another or move an audio track.",
    inputSchema: obj(
      {
        from: { type: "integer", description: "Current 0-based index of the track to move." },
        to: { type: "integer", description: "Destination 0-based index." },
      },
      ["from", "to"],
    ),
  },
  {
    name: "move_clips",
    description:
      "Moves one or more clips to a new track and/or frame. One undoable action. Each move needs the clip ID and at least one of toTrack (compatible with the clip's type) and toFrame. Overlap on the destination resolves as in add_clips. Linked partners follow the named clip: startFrame propagates as a delta; track changes don't.",
    inputSchema: obj(
      {
        moves: {
          type: "array",
          items: obj(
            {
              clipId: { type: "string", description: "The clip ID to move." },
              toTrack: { type: "integer", description: "Destination track index. Omit to keep current track." },
              toFrame: { type: "integer", description: "Destination start frame. Omit to keep current start." },
            },
            ["clipId"],
          ),
        },
      },
      ["moves"],
    ),
  },
  {
    name: "set_clip_properties",
    description:
      "Apply the same property values to one or more clips in one undoable action. Pass any of durationFrames, trimStartFrame, trimEndFrame, speed, volume, opacity, transform, or — for text clips only — content, fontName, fontSize, color, alignment, styleRanges. trim* are source offsets, not timeline. speed 1 = normal, <1 slows (longer), >1 speeds up. volume/opacity 0..1. transform uses 0..1 normalized canvas coords (partial merge). Setting volume/opacity here clears keyframes on that property. audioFx puts a voice effect (pitch | robot | echo | radio) on the clip's audio, rendered at export. For moves use move_clips; for animation use set_keyframes. Timing changes carry over to linked partners.",
    inputSchema: obj(
      {
        clipIds: { type: "array", items: { type: "string" }, description: "Clip IDs to update." },
        durationFrames: { type: "integer" },
        trimStartFrame: { type: "integer", description: "SOURCE offset in PROJECT frames, not a timeline frame." },
        trimEndFrame: { type: "integer", description: "SOURCE offset in PROJECT frames." },
        speed: { type: "number", description: "Playback speed (default 1)." },
        volume: { type: "number", description: "0..1. Clears volume keyframes." },
        opacity: { type: "number", description: "0..1. Clears opacity keyframes." },
        transform: {
          type: "object",
          properties: {
            centerX: { type: "number" },
            centerY: { type: "number" },
            width: { type: "number" },
            height: { type: "number" },
            flipHorizontal: { type: "boolean" },
            flipVertical: { type: "boolean" },
          },
        },
        content: { type: "string", description: "Text clips only." },
        fontName: { type: "string", description: "Text clips only." },
        fontSize: { type: "number", description: "Text clips only." },
        color: { type: "string", description: "Text clips only. '#RRGGBB' or '#RRGGBBAA'." },
        alignment: { type: "string", enum: ["left", "center", "right"], description: "Text clips only." },
        styleRanges: {
          type: "array",
          description:
            "Text clips only. Rich per-substring styling: each range styles content[start:end) — CHARACTER offsets — with any of color/bold/italic/fontSizeScale layered over the clip's base style. Use this to color/embolden one word inside a title instead of splitting it into multiple text clips. REPLACES the whole list; pass [] (or null) to clear. Example: 'CIAO MONDO ROSSO' with the last word red = [{start:11,end:16,color:'#FF2020'}]. Ignored on karaoke caption clips.",
          items: obj(
            {
              start: { type: "integer", description: "Start character offset into content (inclusive)." },
              end: { type: "integer", description: "End character offset (exclusive)." },
              color: { type: "string", description: "'#RRGGBB' or '#RRGGBBAA'." },
              bold: { type: "boolean" },
              italic: { type: "boolean" },
              fontSizeScale: { type: "number", description: "Multiplier on the clip's fontSize (e.g. 1.3)." },
            },
            ["start", "end"],
          ),
        },
        blendMode: {
          type: "string",
          enum: ["normal", "multiply", "screen", "overlay", "darken", "lighten", "difference", "exclusion", "softlight", "hardlight", "add", "subtract"],
          description: "How this clip composites onto the layers below it (video/image clips). 'normal' is the default (plain alpha overlay). Great for light leaks/glow ('screen'/'add'), vignettes/shadows ('multiply'/'darken'), color-grade overlays ('overlay'/'softlight').",
        },
        audioDuck: {
          type: "boolean",
          description: "Music-bed clips: true = on export, this clip's audio is automatically side-chain compressed under all OTHER audio — it dips whenever speech plays and swells back in the gaps, no volume keyframes needed. (The live preview approximates the duck in real time; the export applies the exact sidechain compression.)",
        },
        audioFx: {
          type: "object",
          description:
            "Voice effect on this clip's audio, rendered at export (the live preview plays the clean audio). Pass null to remove. amount meaning depends on type: pitch = semitones -12..+12 (default +4; negative = deeper, positive = chipmunk); echo = delay in seconds 0.05..1.5 (default 0.25); robot and radio ignore amount.",
          properties: {
            type: {
              type: "string",
              enum: ["pitch", "robot", "echo", "radio"],
              description: "pitch = shift the voice up/down by `amount` semitones; robot = metallic monotone; echo = repeating echo delayed by `amount` seconds; radio = telephone/AM-radio band-limited voice.",
            },
            amount: { type: "number", description: "pitch: semitones (-12..+12, default +4). echo: delay seconds (0.05..1.5, default 0.25). robot/radio: ignored." },
          },
        },
      },
      ["clipIds"],
    ),
  },
  {
    name: "set_keyframes",
    description:
      "Set animated keyframes on one property of one clip. Replaces the existing track (empty array clears). Frames are CLIP-RELATIVE (0 = first frame of the clip). Each row is [frame, ...values, interp?] where interp ∈ {linear, hold, smooth, bezier} (default smooth).\n  • volume [frame, value] 0..1 (dB envelope)\n  • opacity [frame, value] 0..1\n  • rotation [frame, degrees]\n  • position [frame, topLeftX, topLeftY] in 0..1 (TOP-LEFT, not center)\n  • scale [frame, width, height] in 0..1 (normalized size, not a factor)\n  • crop [frame, top, right, bottom, left] insets in 0..1\nCustom easing: a 'bezier' row may append 4 handle numbers — [frame, ...values, 'bezier', outX, outY, inX, inY]. The segment between two keyframes is a CSS-style cubic timing curve with P1 = (outX, outY) of the FIRST keyframe and P2 = (inX, inY) of the SECOND (in* always shapes the segment ENTERING that keyframe). Handle X ∈ 0..1 (time within the segment); handle Y is unclamped (beyond 0..1 = overshoot). 'bezier' without handles = same ease as smooth. Example — dramatic slam pan over 60 frames, like CSS cubic-bezier(0.9,0,0.1,1): {property: 'position', keyframes: [[0, 0.05, 0.05, 'bezier', 0.9, 0, 0, 0], [60, 0.75, 0.65, 'bezier', 0, 0, 0.1, 1]]} — the first row's out-handle (0.9,0) + the last row's in-handle (0.1,1) shape the move (slow start, violent middle, slow settle); the first row's in* and the last row's out* touch no segment and are ignored. Preview and export render it identically.",
    inputSchema: obj(
      {
        clipId: { type: "string" },
        property: { type: "string", enum: ["volume", "opacity", "rotation", "position", "scale", "crop"] },
        keyframes: { type: "array", description: "Replacement rows. Empty array clears.", items: { type: "array" } },
      },
      ["clipId", "property", "keyframes"],
    ),
  },
  {
    name: "apply_color",
    description:
      "Author/refine a COLOR GRADE on video/image/adjustment clips — the colorist path (distinct from apply_effect). MERGES with the clip's current grade: only the params you pass change, the rest are preserved, so you can nudge one knob at a time (pass reset:true to start from neutral). All knobs optional. Undoable; verify visually with inspect_color (loop: apply_color → inspect_color → adjust).",
    inputSchema: obj(
      {
        clipIds: { type: "array", items: { type: "string" }, description: "Clip ids from get_timeline (video/image)." },
        reset: { type: "boolean", description: "Start from neutral instead of merging onto the current grade. Default false." },
        exposure: { type: "number", description: "-3…3 EV. Overall brightness." },
        contrast: { type: "number", description: "0.5…1.5 (1 = neutral)." },
        saturation: { type: "number", description: "0…2 (1 = neutral; <1 mutes)." },
        vibrance: { type: "number", description: "-1…1 (skin-protected saturation)." },
        temperature: { type: "number", description: "2000…11000 K. HIGHER = warmer, lower = cooler (6500 = neutral)." },
        tint: { type: "number", description: "-100…100. Positive = green, negative = magenta." },
        highlights: { type: "number", description: "-1…1. Recover (<0) or lift (>0) highlights." },
        shadows: { type: "number", description: "-1…1. Lift (>0) or deepen (<0) shadows." },
        blacks: { type: "number", description: "-1…1 black point (negative crush, positive faded/lifted)." },
        whites: { type: "number", description: "-1…1 white point." },
        gamma: { type: "number", description: "0.5…2 midtone gamma (1 = neutral)." },
        lut: { type: "string", description: "Absolute path to a .cube LUT (film look) applied on top of the grade." },
        lutStrength: { type: "number", description: "0…1 LUT mix." },
      },
      ["clipIds"],
    ),
  },
  {
    name: "apply_effect",
    description:
      "Add/update/remove non-color EFFECTS on video/image/adjustment clips — the looks/FX path (distinct from apply_color). MERGES: each effect is added or updated by type; effects you don't mention stay in place. Pass enabled:false to bypass without removing, or list a type in `remove` to delete it. Params are clamped; omitted params keep their current/default value. Available — type: params (range, default): look: name ('cinematic'|'vibrant'|'vintage'|'bw'|'cool'|'warm'|'matte'), amount(0…1, 1) — CapCut-style one-tap filter, shown live in the preview too; vignette: amount(0…1, 0.4); grain: amount(0…1, 0.25); blur: amount(0…50, 8); sharpen: amount(0…3, 1); chromakey: color (hex string, e.g. '0x00ff00'), similarity(0…1, 0.3), blend(0…1, 0.1) — keys out that color to transparency so the layer below shows through; shake: amount(0…1, 0.5) — a handheld-camera wobble (jittery position, not a whole-frame move). Undoable.",
    inputSchema: obj(
      {
        clipIds: { type: "array", items: { type: "string" }, description: "Clip ids from get_timeline (video/image)." },
        effects: {
          type: "array",
          description: "Effects to add or update.",
          items: obj(
            {
              type: { type: "string", description: "Effect type id: vignette | grain | blur | sharpen | chromakey | shake." },
              params: { type: "object", description: "Param values keyed by name (see tool description)." },
              enabled: { type: "boolean", description: "Default true; false bypasses without removing." },
            },
            ["type"],
          ),
        },
        remove: { type: "array", items: { type: "string" }, description: "Effect type ids to remove from the clips." },
      },
      ["clipIds"],
    ),
  },
  {
    name: "inspect_color",
    description:
      "Render the current GRADED look of a timeline clip (its color + effects applied, composited in context) so you can SEE the result, plus basic per-channel level stats. Use the grading loop: apply_color/apply_effect → inspect_color → read the gap → adjust → repeat.",
    inputSchema: obj(
      {
        clipId: { type: "string", description: "Timeline clip to measure (its graded look)." },
        atFrame: { type: "integer", description: "Optional clip-relative frame to sample (default mid-clip)." },
      },
      ["clipId"],
    ),
  },
  {
    name: "set_track_properties",
    description:
      "Toggle a track's state: muted (silences an audio track), hidden (hides a video track's visuals), or locked (protects from edits). trackIndex from get_timeline.",
    inputSchema: obj(
      {
        trackIndex: { type: "integer", description: "Track index from get_timeline." },
        muted: { type: "boolean" },
        hidden: { type: "boolean" },
        locked: { type: "boolean" },
      },
      ["trackIndex"],
    ),
  },
  {
    name: "trim_clip",
    description:
      "Trim a clip's left or right edge, source-aware. deltaFrames > 0 trims inward (shortens), < 0 extends outward (bounded by available source for video/audio). The left edge also shifts startFrame and the source in-point. With ripple:true, downstream clips on the track shift to keep the timeline tight (no gap/overlap).",
    inputSchema: obj(
      {
        clipId: { type: "string" },
        edge: { type: "string", enum: ["left", "right"] },
        deltaFrames: { type: "integer", description: "Frames to trim (+) or extend (−) at that edge." },
        ripple: { type: "boolean", description: "If true, shift downstream clips by the same amount so no gap/overlap opens (ripple trim)." },
      },
      ["clipId", "edge", "deltaFrames"],
    ),
  },
  {
    name: "duplicate_clips",
    description:
      "Duplicate clips in place — clones full properties (color grade, effects, transform, keyframes); each copy lands right after its original on the same track.",
    inputSchema: obj({ clipIds: { type: "array", items: { type: "string" } } }, ["clipIds"]),
  },
  {
    name: "paste_clips",
    description:
      "Recreate clips from full property objects at a target frame (the copy/paste path). 'clips' is an array of clip property bags (as returned in the project); 'atFrame' repositions the group so its earliest clip starts there.",
    inputSchema: obj(
      { clips: { type: "array", items: { type: "object" } }, atFrame: { type: "integer" } },
      ["clips"],
    ),
  },
  {
    name: "add_transition",
    description:
      "Add a transition to a clip. type: 'fade_in' / 'fade_out' / 'cross' (dissolve — also fades the previous clip out); 'slide_in' / 'slide_out' (clip slides on/off, set direction); 'zoom_in' / 'zoom_out' (clip scales in/out, centered). durationFrames is clamped to half the clip length. Slide/zoom replace the clip's position/scale keyframes, so apply them to a clip that isn't already animated. Rendered in export and preview (eased).",
    inputSchema: obj(
      {
        clipId: { type: "string" },
        type: {
          type: "string",
          enum: ["fade_in", "fade_out", "cross", "slide_in", "slide_out", "zoom_in", "zoom_out"],
        },
        durationFrames: { type: "integer" },
        direction: { type: "string", enum: ["left", "right", "up", "down"], description: "For slide_*: where the clip enters from / exits to (default left)." },
      },
      ["clipId", "durationFrames"],
    ),
  },
  {
    name: "make_transition",
    description:
      "GENERATIVE transition (unique): describe a transition that doesn't exist in any preset — 'glitch sweep', 'ink bleed', 'film burn', 'light leak', 'liquid wipe' — and Claude writes a full-frame alpha animation for it, rendered locally (VP9 alpha), and places it centered on the cut at the END of clipId so it masks the edit. The .mg.html is saved, so the transition is reusable and tweakable. Free, offline, no template pack needed. Use for any transition beyond the fixed add_transition set.",
    inputSchema: obj(
      {
        clipId: { type: "string", description: "The transition plays over the cut at the END of this clip." },
        prompt: { type: "string", description: "The transition to design, e.g. \"horizontal glitch sweep, cyan/magenta\"." },
        durationSeconds: { type: "number", description: "Transition length (default 0.8, max 3)." },
        html: { type: "string", description: "Ready-made self-contained HTML (skips generation) — for re-renders." },
        name: { type: "string", description: "Asset name stem." },
      },
      ["clipId"],
    ),
  },
  {
    name: "save_template",
    description:
      "Save the CURRENT timeline's structure (track layout, clip timing, text, transitions, project format) as a reusable named template. Media clips become typed slots to be filled later. The counter-move to a template marketplace: reuse a look you built, or (via chat) 'make a template like this reel'. Templates are global across projects.",
    inputSchema: obj({ name: { type: "string", description: "Template name." } }, ["name"]),
  },
  {
    name: "apply_template",
    description:
      "Rebuild the timeline from a saved template, filling its video/image and audio slots. Pass visualRefs (ordered video/image asset ids) and audioRefs (ordered audio ids); omit both to auto-fill from the library by type. Unfilled slots become placeholder clips you can drop media onto. See list_templates for names.",
    inputSchema: obj(
      {
        name: { type: "string", description: "Template name (from list_templates)." },
        visualRefs: { type: "array", items: { type: "string" }, description: "Ordered video/image asset ids/names to fill the visual slots." },
        audioRefs: { type: "array", items: { type: "string" }, description: "Ordered audio asset ids/names to fill the audio slots." },
      },
      ["name"],
    ),
  },
  {
    name: "list_templates",
    description: "List saved templates (name + how many visual/audio slots each expects). Use before apply_template.",
    inputSchema: obj({}, []),
  },
  {
    name: "analyze_footage",
    description:
      "Scan a video asset for visual structure and defects, all locally with ffmpeg: black frames (dead intros/outros), frozen/static picture (no motion), and scene changes (shot boundaries). Returns source-second ranges/timestamps. Use before editing to auto-trim junk, cut or speed up motionless stretches, or split a montage per scene. (Distinct from analyze_video, which is the cloud virality/attention analysis.)",
    inputSchema: obj(
      {
        mediaRef: { type: "string", description: "Video asset id from get_media." },
        sceneThreshold: { type: "number", description: "Scene-change sensitivity 0.05–0.9 (default 0.3; lower = more cuts reported)." },
      },
      ["mediaRef"],
    ),
  },
  {
    name: "detect_silence",
    description:
      "Detect silent ranges in an audio or video asset with ffmpeg. Returns ranges in source seconds AND project frames — feed them to ripple_delete_ranges to cut dead air, or speed up the gaps. thresholdDb default −30, minSilenceSeconds default 0.6. Ranges come back pre-shrunk by padSeconds per side (a margin so cuts keep a natural breath around speech instead of clipping word attacks).",
    inputSchema: obj(
      {
        mediaRef: { type: "string", description: "Audio/video asset id from get_media." },
        thresholdDb: { type: "number", description: "Silence threshold in dB (default −30; lower = stricter)." },
        minSilenceSeconds: { type: "number", description: "Minimum gap length to report (default 0.6 s)." },
        padSeconds: { type: "number", description: "Margin kept on each side of every silence (default 0.1 s; pass 0 to cut flush against the detected boundary)." },
        minKeepSeconds: { type: "number", description: "Speech blips shorter than this between two silences (breaths/clicks) are merged into the cut instead of surviving as flash-frames (default 0.15 s; 0 disables)." },
      },
      ["mediaRef"],
    ),
  },
  {
    name: "capture_frame",
    description:
      "Render the composited timeline frame at atFrame (default 0) and add it to the library as a new image asset — a freeze-frame / still you can reuse on the timeline or as a generation reference.",
    inputSchema: obj({ atFrame: { type: "integer", description: "Project frame to capture (default 0)." } }),
  },
  {
    name: "auto_rough_cut",
    description:
      "ROUGH CUT (first-assembly): turn a FOLDER of raw footage (or a list of clips) into an editable draft on the timeline, locally. Analyzes each video with ffmpeg, trims dead black heads/tails, lays the clips end-to-end on V1 (linked audio follows), and drops the first audio asset in scope as a music bed on its own track. THE tool for 'make a first cut / rough cut from this folder / assemble these clips'. Fast and offline — no export, no cloud. Returns the assembled order so you can then refine (reorder, tighten via the transcript, add titles/transitions) before the user exports.",
    inputSchema: obj(
      {
        folder: { type: "string", description: "Folder name or id whose videos to assemble (and its subfolders). Omit to use all root videos." },
        mediaRefs: { type: "array", items: { type: "string" }, description: "Explicit ordered list of video asset ids/names (overrides folder)." },
        maxClipSeconds: { type: "number", description: "Cap each clip's length on the timeline (trims the tail). Omit for full clips." },
        music: { type: "boolean", description: "Add the first audio asset in scope as a music bed on its own track (default true)." },
        order: { type: "string", enum: ["name", "as-is"], description: "Clip order: by name (default, natural/numeric) or library order." },
      },
      [],
    ),
  },
  {
    name: "match_loudness",
    description:
      "PLATFORM LOUDNESS: normalise a library asset to the loudness a platform expects, using a two-pass measure-then-apply so it lands on target instead of drifting. THE tool for 'too quiet/too loud for YouTube', 'normalise the audio', 'match broadcast levels', 'make it as loud as other videos'. Targets: youtube (-14 LUFS, also Spotify/Apple), tiktok (-14, tighter range), podcast (-16), broadcast (-23 EBU R128), cinema (-27). Picture is stream-copied. Produces a NEW library asset.",
    inputSchema: obj(
      {
        media: { type: "string", description: "Library asset id (or exact name)." },
        target: { type: "string", enum: ["youtube", "tiktok", "podcast", "broadcast", "cinema"], description: "Where it's going (default youtube)." },
      },
      ["media"],
    ),
  },
  {
    name: "repair_audio",
    description:
      "REPAIR DAMAGED AUDIO (not just clean it): rebuild samples that clipped past full scale, remove impulsive clicks/crackle from bad cables or edits, and tame harsh sibilance. THE tool for 'the audio is distorted/crackly/clipping', 'harsh S sounds', 'the recording is damaged'. Different from enhance_audio, which removes steady background noise from an otherwise good recording — use that for hiss/hum, this for damage. Produces a NEW library asset.",
    inputSchema: obj(
      {
        media: { type: "string", description: "Library asset id (or exact name)." },
        declip: { type: "boolean", description: "Rebuild clipped samples (default true)." },
        declick: { type: "boolean", description: "Remove clicks and crackle (default true)." },
        deesser: { type: "boolean", description: "Tame harsh sibilance (default true)." },
      },
      ["media"],
    ),
  },
  {
    name: "auto_color",
    description:
      "AUTO COLOUR CORRECTION / SHOT MATCHING: measure a clip's exposure, contrast and white balance from its own frames and correct them — or pass `reference` to move it toward ANOTHER clip's look so two cameras cut together. THE tool for 'the colours look off', 'too blue/orange', 'too dark/flat', 'fix the white balance', 'make these two shots match'. Measurement-driven and deliberately conservative. Produces a NEW library video.",
    inputSchema: obj(
      {
        media: { type: "string", description: "Library video asset id (or exact name) to correct." },
        reference: { type: "string", description: "Optional library video whose look to match. Omit to balance the clip on its own." },
        strength: { type: "number", description: "0-1.5 how far to push the correction (default 1)." },
      },
      ["media"],
    ),
  },
  {
    name: "apply_lut",
    description:
      "APPLY A LUT: grade a clip with a .cube / .3dl look-up table — the format every LUT pack ships. Use for 'apply this LUT', 'use my film look', 'grade it with this .cube'. Intensity below 1 blends the graded picture back over the original. Produces a NEW library video.",
    inputSchema: obj(
      {
        media: { type: "string", description: "Library video asset id (or exact name)." },
        lutPath: { type: "string", description: "Absolute path to a .cube or .3dl file." },
        intensity: { type: "number", description: "0-1 blend against the original (default 1 = full)." },
      },
      ["media", "lutPath"],
    ),
  },
  {
    name: "quality_report",
    description:
      "PRE-PUBLISH CHECK: measure a library asset and report what would embarrass the user after upload — loudness against the platform target, clipped or too-quiet audio, black frames at the head/tail, frozen picture, and flashing that could trigger photosensitive seizures. THE tool for 'is this ready to publish', 'check this before I upload', 'anything wrong with this export'. Read-only: nothing is rendered or changed. Report the findings verbatim and offer the matching fix tool for each one.",
    inputSchema: obj(
      {
        media: { type: "string", description: "Library asset id (or exact name)." },
        target: { type: "string", enum: ["youtube", "tiktok", "podcast", "broadcast", "cinema"], description: "Which platform's loudness to judge against (default youtube)." },
      },
      ["media"],
    ),
  },
  {
    name: "auto_chapters",
    description:
      "CHAPTERS FROM SPEECH: split a library video into chapters by topic and return a ready-to-paste YouTube chapter list, optionally dropping a timeline marker at each one. THE tool for 'add chapters', 'YouTube timestamps', 'break this into sections', 'what are the topics'. Uses the cached transcript, so on a video already transcribed (captions, clipping, filler removal) it is nearly instant and costs one short model call.",
    inputSchema: obj(
      {
        media: { type: "string", description: "Library video asset id (or exact name) with speech." },
        addMarkers: { type: "boolean", description: "Also place a timeline marker at each chapter (default true)." },
        language: { type: "string", description: "Force the transcript language (ISO code) instead of auto-detecting." },
      },
      ["media"],
    ),
  },
  {
    name: "stabilize_video",
    description:
      "STABILIZE SHAKY FOOTAGE: analyse the camera shake in a library video and render a smoothed copy. THE tool for 'this is shaky', 'stabilise this', 'handheld looks rough', 'make it smooth', 'gimbal look'. Two-pass, fully local, no quality trade beyond the small edge warp. Produces a NEW library video; the original is untouched. Roughly 0.7x realtime.",
    inputSchema: obj(
      {
        media: { type: "string", description: "Library video asset id (or exact name)." },
        strength: { type: "integer", description: "1-10, how much smoothing (default 5). Raise for very shaky handheld, lower to keep intentional camera movement." },
      },
      ["media"],
    ),
  },
  {
    name: "enhance_audio",
    description:
      "CLEAN UP VOICE AUDIO: remove background hiss/room tone/air-conditioning, cut mains hum and rumble, and level the result to broadcast loudness (EBU R128). THE tool for 'the audio is noisy/hissy', 'clean the voice', 'too quiet', 'fix the sound', 'normalise the levels'. Local and free. The picture is copied untouched — only the audio is re-encoded. Produces a NEW library asset.",
    inputSchema: obj(
      {
        media: { type: "string", description: "Library asset id (or exact name) — video with audio, or an audio file." },
        strength: { type: "integer", description: "1-10 denoise aggressiveness (default 5). High values can make a voice sound processed — prefer 4-6." },
        removeHum: { type: "boolean", description: "Cut mains hum and low rumble below the voice (default true)." },
        normalize: { type: "boolean", description: "Level to EBU R128 -16 LUFS (default true). Set false to keep the original dynamics." },
      },
      ["media"],
    ),
  },
  {
    name: "denoise_video",
    description:
      "REMOVE VIDEO GRAIN: reduce sensor noise in low-light footage. Use for 'grainy', 'noisy picture', 'shot in the dark', 'clean up the image'. Local, free, fast. Produces a NEW library video. Note this softens fine detail — keep the strength low unless the noise is heavy.",
    inputSchema: obj(
      {
        media: { type: "string", description: "Library video asset id (or exact name)." },
        strength: { type: "integer", description: "1-10 (default 4). Above ~6 the picture starts to look plasticky." },
      },
      ["media"],
    ),
  },
  {
    name: "deflicker_video",
    description:
      "FIX PULSING BRIGHTNESS: even out frame-to-frame exposure flicker — artificial lighting beating against the shutter, or a time-lapse. Use for 'the image pulses/flickers', 'brightness jumps'. Local and free. Produces a NEW library video.",
    inputSchema: obj({ media: { type: "string", description: "Library video asset id (or exact name)." } }, ["media"]),
  },
  {
    name: "duck_music",
    description:
      "DUCK MUSIC UNDER A VOICE: render a copy of a music track that automatically drops in level whenever the voice speaks and comes back up in the gaps. THE tool for 'the music covers the voice', 'lower the music when I talk', 'add ducking', 'balance music and speech'. Local and free — this is the mix move every talking-head edit needs. Produces a NEW audio asset to use instead of the original music.",
    inputSchema: obj(
      {
        music: { type: "string", description: "Library asset id (or exact name) of the MUSIC track." },
        voice: { type: "string", description: "Library asset id (or exact name) carrying the VOICE (a video with speech works)." },
        amount: { type: "integer", description: "1-10 how hard the music is pushed down (default 6)." },
      },
      ["music", "voice"],
    ),
  },
  {
    name: "slip_clip",
    description:
      "SLIP EDIT: change WHICH part of the source a clip shows, without moving it on the timeline or changing its length. THE tool for 'the framing is right but the action starts too late', 'show a bit earlier/later in that take', 'shift the content inside the clip'. Positive deltaFrames reveals LATER source content, negative reveals earlier. Clamped to the media that exists — a partial slip is applied rather than refused. Undoable.",
    inputSchema: obj(
      {
        clipId: { type: "string", description: "Clip to slip (from get_timeline)." },
        deltaFrames: { type: "integer", description: "Timeline frames to slip. Positive = show later source content, negative = earlier." },
      },
      ["clipId", "deltaFrames"],
    ),
  },
  {
    name: "close_gaps",
    description:
      "CLOSE GAPS: pull clips left so the empty space between them disappears, keeping their order and lengths. THE tool for 'remove the gaps', 'close the holes', 'tighten the timeline' after deleting takes. Leading space before the first clip is kept unless fromStart is true (an intro pad is usually deliberate). Undoable.",
    inputSchema: obj(
      {
        trackIndex: { type: "integer", description: "Only this track. Omit to close gaps on every track." },
        minFrames: { type: "integer", description: "Ignore gaps shorter than this (default 2) — a sliver is usually deliberate spacing." },
        fromStart: { type: "boolean", description: "Also close the space before the first clip (default false)." },
      },
      [],
    ),
  },
  {
    name: "blur_faces",
    description:
      "PRIVACY / FACE BLUR: find every human face in a library video and render a copy with each one covered, following it as it moves. THE tool whenever the user wants faces blurred, hidden, censored, anonymised, pixelated, made unrecognisable, or asks to 'protect people's privacy' / 'hide bystanders' / 'GDPR' in footage. Faces are found by looking at sampled frames (works on profiles, background people and faces on screens), each face is tracked, and a face that leaves the shot stops being covered. Produces a NEW library video — the original is untouched. Cost scales with length: sample every 2-3s on long footage, every 0.5-1s when people move fast.",
    inputSchema: obj(
      {
        media: { type: "string", description: "Library video asset id (or exact name) whose faces should be covered." },
        mode: { type: "string", enum: ["blur", "pixelate"], description: "blur = soft smear (default); pixelate = mosaic squares, the classic TV anonymisation look." },
        strength: { type: "integer", description: "1-10, how unrecognisable (default 6). Scaled to face size, so it holds at any resolution." },
        everySeconds: { type: "number", description: "Seconds between sampled frames (default 1). Lower = follows fast movement better but costs more; raise to 2-3 on long or static footage." },
        padding: { type: "number", description: "Extra margin around each face as a fraction of its size (default 0.18). Raise if hair or a chin peeks out." },
      },
      ["media"],
    ),
  },
  {
    name: "auto_clips",
    description:
      "AI CLIPPING (OpusClip-style): analyze a long library video's speech and automatically create the N most viral-worthy SHORT CLIPS — each self-contained with a hook, exported as its own file (9:16 vertical + burned karaoke captions by default) and added to the library with a title and virality score. THE tool for 'make clips/shorts/reels from this video'. Needs speech (uses the transcript) and the Claude connection used by chat. Runs one export per clip — expect ~1 minute of work per clip.",
    inputSchema: obj(
      {
        media: { type: "string", description: "Library video asset id (or exact name) to clip." },
        count: { type: "integer", description: "How many clips to create (1-10, default 3)." },
        minSeconds: { type: "number", description: "Minimum clip length in seconds (default 15)." },
        maxSeconds: { type: "number", description: "Maximum clip length in seconds (default 60)." },
        aspect: { type: "string", enum: ["9:16", "original"], description: "Output framing: vertical crop for socials (default) or the source aspect." },
        captions: { type: "boolean", description: "Burn word-synced captions (default true)." },
        captionStyle: { type: "string", enum: ["karaoke", "clean", "boxed", "minimal"], description: "Caption look: karaoke = yellow active-word pop (default); clean = bold white; boxed = white on dark box; minimal = small discreet subtitles." },
        titleOverlay: { type: "boolean", description: "Burn the AI title top-center for the first ~4s (default true — the OpusClip look)." },
        beepWords: { type: "array", items: { type: "string" }, description: "Words to censor: speech is muted and replaced with a beep wherever they occur." },
        watermarkPath: { type: "string", description: "Absolute path to a PNG logo — overlaid top-right on every clip (brand kit)." },
        watermarkOpacity: { type: "number", description: "Watermark opacity 0-1 (default 0.85)." },
        prompt: { type: "string", description: "Optional guidance, e.g. 'only the moments about pricing' — wins over general virality." },
        visual: { type: "boolean", description: "Force VISUAL curation (scene detection + Claude vision) — automatic when the video has no speech. Use for gameplay, b-roll, music videos." },
        language: { type: "string", description: "Spoken language hint for transcription (e.g. 'it')." },
      },
      ["media"],
    ),
  },
  {
    name: "identify_speakers",
    description:
      "EXPERIMENTAL — local diarization; most reliable on clean multi-speaker recordings; single-speaker content should come back as 1 speaker. Similar-sounding voices (close pitch/timbre) can get attributed to the wrong turn even when turn BOUNDARIES are right — treat speaker labels as best-effort. Returns speaker turns labeled 'S1','S2'… (order of first appearance) with start/end in SOURCE seconds, plus speakerCount. Pass numSpeakers whenever the user knows it — fixed-count clustering is far more reliable than automatic discovery. After a run, get_transcript tags that asset's words with these speaker labels. Slow on long files (neural pipeline over the whole audio). If the attribution sounds swapped when the user listens ('quello è l'altro speaker'), correct it with set_speaker_turns — the corrected turns replace this run's.",
    inputSchema: obj(
      {
        mediaRef: { type: "string", description: "Audio (or video-with-audio) asset id from get_media." },
        numSpeakers: { type: "integer", description: "Exact number of speakers, when known (recommended — improves clustering a lot)." },
      },
      ["mediaRef"],
    ),
  },
  {
    name: "add_opener",
    description:
      "Put an INTRO at the head of the timeline or an OUTRO at the tail. THE tool for 'metti un'intro / una sigla / un titolo iniziale / una schermata finale / outro con logo'. Built from a matte, text and (if the brand kit has one) the logo — not a video file — so it takes the project's resolution, stays fully editable, and adds nothing to disk. An intro pushes everything else right to make room. Openers: title-card, logo-open, title-over (intro); end-card, credits (outro). Say that the length can be changed by dragging the clip's edge.",
    inputSchema: obj(
      {
        opener: { type: "string", enum: ["title-card", "logo-open", "title-over", "end-card", "credits"], description: "Which starter to use." },
        title: { type: "string", description: "Main line. Sensible wording is used when omitted." },
        subtitle: { type: "string", description: "Smaller second line (optional)." },
        durationSeconds: { type: "number", description: "0.5-30 (each starter has its own default)." },
      },
      ["opener"],
    ),
  },
  {
    name: "brand_kit",
    description:
      "The logo and colours reused across every project — read it by passing nothing, change it by passing fields. Intros and outros fill themselves from this. It is stored OUTSIDE the app folder, so updating CupCat never touches it. Pass logoRef:'' to remove the logo.",
    inputSchema: obj(
      {
        background: { type: "string", description: "Card background, '#RRGGBB'." },
        accent: { type: "string", description: "Text colour, '#RRGGBB'." },
        logoRef: { type: "string", description: "IMAGE asset id or name from the library; '' removes it." },
        fontName: { type: "string", description: "Font used by opener text." },
      },
      [],
    ),
  },
  {
    name: "emphasize_speaker",
    description:
      "PUNCH IN on whoever has the line: keyframes a gentle push-in onto the speaking person's face for their turns, then back out. THE tool for 'enfatizza questo spezzone / zoom su chi parla / stringi sulla persona'. Pass `speaker` (after identify_speakers) for all of that person's turns, or fromSeconds/toSeconds for one stretch. It is applied as keyframes on the clip — editable, undoable, and no re-encode, so nothing is lost in quality. When several faces are in shot it picks the one whose MOUTH is moving; if that measurement does not clearly decide (nobody obviously talking, an off-screen voice, faces too small) it skips that stretch and SAYS SO rather than guessing at someone. Report which stretches were skipped.",
    inputSchema: obj(
      {
        clipId: { type: "string", description: "The VIDEO clip to punch in on (from get_timeline)." },
        speaker: { type: "string", description: "Speaker label from identify_speakers ('S1'…) — emphasises all of that person's turns." },
        fromSeconds: { type: "number", description: "Start of one stretch, in SOURCE seconds (instead of speaker)." },
        toSeconds: { type: "number", description: "End of that stretch, in SOURCE seconds." },
        zoom: { type: "number", description: "How much of the frame height the face should fill, 0.15-0.8 (default 0.4). Higher = tighter." },
      },
      ["clipId"],
    ),
  },
  {
    name: "split_audio_by_speaker",
    description:
      "Give every voice its own audio track: cuts an audio clip where the speaker changes and moves each piece onto a track named after them ('S1', 'S2'…). THE tool for 'separa gli speaker / una traccia per persona / dividi l'audio per chi parla'. Needs identify_speakers to have run on that asset first. Nothing is duplicated or deleted — the pieces are the same audio, sorted, so volume, cleanup or a mute can be applied per person; stretches where nobody speaks stay on the original track. If the clip is linked to a picture, the picture is cut at the same points (that is what keeps it locked to its sound) — say so when reporting, it is visible on the timeline. Undoable.",
    inputSchema: obj({ clipId: { type: "string", description: "The AUDIO clip to separate (from get_timeline). For a video with sound, pass its linked audio clip." } }, ["clipId"]),
  },
  {
    name: "get_speakers",
    description:
      "The speaker turns ALREADY worked out for the project's media — read-only, instant, and it never starts a diarization run. Omit mediaRef for every asset that has turns (what the timeline's speaker lane loads on open); pass one to ask about a single asset. An asset missing from the result simply means identify_speakers has not been run on it yet. Times are SOURCE seconds.",
    inputSchema: obj({ mediaRef: { type: "string", description: "One asset id or name; omit for all of them." } }, []),
  },
  {
    name: "set_speaker_turns",
    description:
      "Correct the speaker turns after identify_speakers when the attribution is wrong (similar voices get swapped) — what the user actually HEARS wins over the model. REPLACES the cached diarization for that asset: from then on get_transcript tags words with these corrected turns. Times are SOURCE seconds; the list must be sorted by startSeconds, non-overlapping, each turn with a positive span. Speaker labels are free-form ('S1', 'Anna', …).",
    inputSchema: obj(
      {
        mediaRef: { type: "string", description: "Audio (or video-with-audio) asset id from get_media." },
        turns: {
          type: "array",
          description: "The COMPLETE replacement turn list, sorted by startSeconds.",
          items: obj(
            {
              speaker: { type: "string", description: "Label to tag words with ('S1', 'Anna', …)." },
              startSeconds: { type: "number", description: "Turn start in SOURCE seconds." },
              endSeconds: { type: "number", description: "Turn end in SOURCE seconds." },
            },
            ["speaker", "startSeconds", "endSeconds"],
          ),
        },
      },
      ["mediaRef", "turns"],
    ),
  },
  {
    name: "detect_beats",
    description:
      "Music beat detection (no cloud): BPM, confidence, and beat/onset timestamps of an audio (or video-with-audio) asset. Use before beat-synced editing; feed the returned beat times to cuts, zooms, captions or effects that should land on the rhythm.",
    inputSchema: obj({ media: { type: "string", description: "Library asset id (or exact name) of the music." } }, ["media"]),
  },
  {
    name: "sync_to_beats",
    description:
      "CapCut-style BEAT SYNC: ripple-trims every clip on a video track so each cut lands exactly on a beat of the given music. Clips only get shorter (never stretched); linked audio follows; downstream clips stay tight. THE tool for 'monta a tempo di musica'. If the music is already placed on the timeline, the beat grid anchors to its position.",
    inputSchema: obj(
      {
        media: { type: "string", description: "Library asset id (or name) of the MUSIC to sync to." },
        trackIndex: { type: "integer", description: "Video track whose clips get aligned (default: first video track with clips)." },
        beatEvery: { type: "integer", description: "Cut on every Nth beat (1 = every beat, 2 = every other, 4 = every bar in 4/4). Default 1." },
        minClipSeconds: { type: "number", description: "Never make a clip shorter than this (default 1)." },
      },
      ["media"],
    ),
  },
  {
    name: "save_range_as_media",
    description:
      "Bake a composited timeline range (or a single clip) into a NEW reusable video asset in the library — trims, speed, effects, color, transforms, and audio are flattened into one clip. Pass clipId to bake that clip, or startFrame + endFrame for a custom range.",
    inputSchema: obj({
      clipId: { type: "string", description: "Bake this clip's range (its startFrame..end). Overrides startFrame/endFrame." },
      startFrame: { type: "integer", description: "Range start (project frame). Use with endFrame when no clipId is given." },
      endFrame: { type: "integer", description: "Range end (exclusive, project frame)." },
      name: { type: "string", description: "Optional name for the new asset." },
    }),
  },
  {
    name: "make_compound",
    description:
      "Raggruppa clip in una SEQUENZA ANNIDATA modificabile (compound clip) — 'crea una sequenza/compound', 'group these clips', 'nest this section'. Moves the selected clips (all involved tracks, relative layout preserved, time-overlapping linked audio included automatically) into a nested timeline, and replaces them with ONE compound clip spanning the selection on the topmost involved video track. The compound clip moves/trims/speeds/grades like any video clip — the effects apply ON TOP of its composited content. Edit inside it LIVE with open_compound (no re-baking by hand); undo with uncompound. Depth 1 only: a selection containing a compound clip is refused.",
    inputSchema: obj(
      {
        clipIds: { type: "array", items: { type: "string" }, description: "Timeline clips to move into the nested sequence." },
        name: { type: "string", description: "Optional sequence name (shown on the compound clip)." },
      },
      ["clipIds"],
    ),
  },
  {
    name: "open_compound",
    description:
      "Enter a compound clip's nested timeline: EVERY tool (get_timeline, add/split/move/trim, effects, keyframes…) then reads and writes the SUB-timeline — frames restart at 0 and get_timeline reports activeCompound so you know where you are. The preview and timeline UI follow live. Edit with the normal tools, then close_compound to return; the compound clip on the main timeline updates automatically. Nesting is depth 1: you cannot create another compound while inside one.",
    inputSchema: obj({
      clipId: { type: "string", description: "A compound clip's id from get_timeline (it carries a compoundId field)." },
      compoundId: { type: "string", description: "Alternative: the compound sequence id itself." },
    }),
  },
  {
    name: "close_compound",
    description:
      "Leave the open compound and return to the MAIN timeline (frames are absolute again — re-read get_timeline). The compound clip's rendered content refreshes automatically from the edits made inside.",
    inputSchema: obj({}),
  },
  {
    name: "uncompound",
    description:
      "Inverse of make_compound: expand a compound clip back into its individual clips at the clip's current position (relative layout re-applied on tracks spliced in at its stacking position). The nested sequence is deleted only when this was its last clip — duplicated compound clips are independent instances of the same sequence.",
    inputSchema: obj({ clipId: { type: "string", description: "The compound clip to expand." } }, ["clipId"]),
  },
  {
    name: "relink_media",
    description:
      "Repoint a media asset to a new file path (e.g. footage that was moved) and re-probe it. Use when an asset's file is missing or its path changed.",
    inputSchema: obj(
      {
        mediaRef: { type: "string", description: "Asset id from get_media." },
        path: { type: "string", description: "New absolute file path to the media file." },
      },
      ["mediaRef", "path"],
    ),
  },
  {
    name: "split_clip",
    description:
      "Split a clip at one or more frames. Pass atFrame for a single cut, or atFrames (array) to chop the clip into several pieces in one call. Each frame must be strictly between the clip's start and end.",
    inputSchema: obj(
      {
        clipId: { type: "string" },
        atFrame: { type: "integer", description: "Single frame to split at (between clip start and end)." },
        atFrames: { type: "array", items: { type: "integer" }, description: "Batch: multiple project frames to split at in one call." },
      },
      ["clipId"],
    ),
  },
  {
    name: "set_project_format",
    description:
      "Set the canvas/output resolution (and optionally fps) used by the preview AND export. Width×height in pixels — e.g. 1920×1080 (16:9 landscape), 1080×1920 (9:16 vertical/Reels/TikTok), 1080×1080 (1:1 square), 1080×1350 (4:5). Clip transforms are normalized, so clips reframe to the new aspect automatically. Use whenever the user asks for an aspect ratio, orientation, or platform format.",
    inputSchema: obj(
      {
        width: { type: "integer", description: "Canvas width in pixels (16–7680)." },
        height: { type: "integer", description: "Canvas height in pixels (16–7680)." },
        fps: { type: "number", description: "Optional frames per second: an integer 1–120, or an NTSC rate (23.976, 29.97, 59.94 — handled as exact rationals end-to-end)." },
      },
      [],
    ),
  },
  {
    name: "track_motion",
    description:
      "LOCAL motion tracking (free): follow a subject (a face, an object) through a footage clip and PIN an overlay/text/sticker clip to it — the overlay 'sticks' to the moving thing via position keyframes. Pure on-device template matching, no model. Pass clipId (the footage to track in), attachClipId (the overlay to move), and roi = {x,y,w,h} fractions 0..1 marking the thing in the FIRST overlapping frame. The two clips must overlap in time.",
    inputSchema: obj(
      {
        clipId: { type: "string", description: "Footage clip to track the subject in." },
        attachClipId: { type: "string", description: "Overlay/text/sticker clip to pin to the tracked subject." },
        roi: {
          type: "object",
          description: "Region to track in the first overlapping frame, as fractions 0..1.",
          properties: {
            x: { type: "number" }, y: { type: "number" }, w: { type: "number" }, h: { type: "number" },
          },
        },
      },
      ["clipId", "attachClipId", "roi"],
    ),
  },
  {
    name: "separate_stems",
    description:
      "LOCAL stem separation (free): split an audio or video clip's sound into VOICE and MUSIC (accompaniment) with the on-device sherpa spleeter model. Fast (~8× realtime), offline. Use for 'isolate the vocals', 'remove the music', 'karaoke' (keep music), 'clean up the dialogue'. Adds the stems to the library as new audio assets. keep: 'voice' or 'music' to make just one.",
    inputSchema: obj(
      {
        mediaRef: { type: "string", description: "Audio or video asset id/name with sound." },
        keep: { type: "string", enum: ["voice", "music"], description: "Make only this stem. Omit for both." },
      },
      ["mediaRef"],
    ),
  },
  {
    name: "clean_audio",
    description:
      "Clean up clips' audio for the export: denoise (FFT noise reduction), normalize (loudness ≈ -16 LUFS for consistent levels across clips), and/or highpass (roll off low rumble/hum). Pass clipIds plus any of denoise (0..1 strength, 0 = off), normalize (bool), highpass (bool). Use for voiceover/talking-head footage that sounds noisy, hummy, or uneven.",
    inputSchema: obj(
      {
        clipIds: { type: "array", items: { type: "string" }, description: "Clips to process (video/audio with sound)." },
        denoise: { type: "number", description: "0..1 noise-reduction strength (0 = off)." },
        normalize: { type: "boolean", description: "Loudness-normalize to ≈ -16 LUFS." },
        highpass: { type: "boolean", description: "Remove low rumble below ~80 Hz." },
      },
      ["clipIds"],
    ),
  },
  {
    name: "set_mask",
    description:
      "Apply a shape mask to clips: keep only a region visible with a soft (feathered) edge; invert to hide that region instead (spotlight/vignette, or to reveal an underlying overlay/background). shape 'rect'|'ellipse' use center cx/cy (0..1) + half-size rw/rh (0..1). shape 'path' is the freeform pen mask (\"maschera a penna libera — 'ritaglia a mano questa forma'\"): pass points, an array of ≥3 [x,y] vertices in 0..1 clip space (closed automatically); smooth:true rounds the outline through the points (Catmull-Rom) instead of straight edges. feather (0..1) softens the edge and IS visible live in the preview. Pass clear:true to remove.",
    inputSchema: obj(
      {
        clipIds: { type: "array", items: { type: "string" } },
        shape: { type: "string", enum: ["rect", "ellipse", "path"] },
        cx: { type: "number", description: "Center X 0..1 (default 0.5; rect/ellipse only)." },
        cy: { type: "number", description: "Center Y 0..1 (default 0.5; rect/ellipse only)." },
        rw: { type: "number", description: "Half-width 0..1 (default 0.4; rect/ellipse only)." },
        rh: { type: "number", description: "Half-height 0..1 (default 0.4; rect/ellipse only)." },
        points: {
          type: "array",
          items: { type: "array", items: { type: "number" }, minItems: 2, maxItems: 2 },
          description: "shape 'path' only: ≥3 [x,y] vertices in 0..1 clip space, closed implicitly.",
        },
        smooth: { type: "boolean", description: "shape 'path' only: smooth the outline through the points (Catmull-Rom) instead of straight polygon edges." },
        feather: { type: "number", description: "Edge softness 0..1 (default 0.05)." },
        invert: { type: "boolean", description: "Hide the inside, keep the outside." },
        clear: { type: "boolean", description: "Remove the mask." },
      },
      ["clipIds"],
    ),
  },
  {
    name: "punch_in",
    description:
      "THE tool for any zoom toward a point — meme zooms, dramatic push-ins, 'zoom sul volto'. Give it the source point to frame (targetX/targetY 0..1 from a frame you inspected) and a zoom factor; it does everything correctly in one undoable call: splits the window into its own segment (linked audio follows), computes the transform with the right convention, CLAMPS the target so no black edge can ever appear (it reports when it clamps and how close it could get), clears stale keyframes that would override the transform, and optionally applies b/w, shake or vignette to just that segment. mode 'cut' = instant snap (meme style, default); 'smooth' = eased push-in/out with rampFrames. Do NOT build zooms by hand from split_clip + transforms/keyframes — this replaces that whole dance.",
    inputSchema: obj(
      {
        clipId: { type: "string", description: "Video/image clip to zoom." },
        targetX: { type: "number", description: "Source point X 0..1 to frame (default 0.5)." },
        targetY: { type: "number", description: "Source point Y 0..1 to frame (default 0.5)." },
        scale: { type: "number", description: "Zoom factor 1.05–8 (default 2.2)." },
        startFrame: { type: "integer", description: "Timeline frame where the zoom window starts (default clip start). The window is split into its own segment." },
        endFrame: { type: "integer", description: "Timeline frame where the zoom window ends (default clip end)." },
        mode: { type: "string", enum: ["cut", "smooth"], description: "'cut' snaps in/out instantly (meme, default); 'smooth' eases over rampFrames." },
        rampFrames: { type: "integer", description: "Ease length for mode 'smooth' (default 6)." },
        bw: { type: "boolean", description: "Also desaturate the segment (dramatic b/w)." },
        shake: { type: "boolean", description: "Also add camera shake to the segment." },
        vignette: { type: "boolean", description: "Also add a dark vignette to the segment." },
      },
      ["clipId"],
    ),
  },
  {
    name: "magnify",
    description:
      "Lens magnifier: a circular magnifying glass fixed over a spot of the footage (detail callouts, 'lente di ingrandimento'). Creates a zoomed duplicate of the clip on a muted track above, ellipse-masked around the target, so the base stays intact and the lens can be removed by deleting that clip. targetX/targetY (0..1), zoom (default 2), radius (fraction of the canvas short side, default 0.16), optional startFrame/endFrame window. The feathered edge is visible live in the preview and matches the export.",
    inputSchema: obj(
      {
        clipId: { type: "string", description: "Video/image clip to magnify." },
        targetX: { type: "number", description: "Lens center X 0..1 (default 0.5)." },
        targetY: { type: "number", description: "Lens center Y 0..1 (default 0.5)." },
        zoom: { type: "number", description: "Magnification 1.2–6 (default 2)." },
        radius: { type: "number", description: "Lens radius as a fraction of the canvas short side (default 0.16)." },
        feather: { type: "number", description: "Edge softness 0..0.5 (default 0.08)." },
        startFrame: { type: "integer", description: "Timeline frame where the lens appears (default clip start)." },
        endFrame: { type: "integer", description: "Timeline frame where the lens disappears (default clip end)." },
      },
      ["clipId"],
    ),
  },
  {
    name: "multicam_cut",
    description:
      "THE tool for 'montaggio multicam' after sync_audio: give it the synced angle clips (one per camera, stacked on separate video tracks, aligned in time) and where to switch. In ONE undoable call it computes the angles' common overlap window, splits every angle at every cut, keeps only the chosen angle's picture per segment (the other angles' pieces in that span are removed), and keeps ONE camera's audio CONTINUOUS across the whole window — picture switches, sound never cuts. Before the first cut the first listed angle shows. For music-driven switching, run detect_beats first and use (a subset of) the beat frames as cut points. Do NOT build a multicam montage by hand from split_clip + remove_clips.",
    inputSchema: obj(
      {
        angleClipIds: {
          type: "array",
          items: { type: "string" },
          description: "2+ video clips, one per camera angle, time-aligned (typically covering the same span after sync_audio). angleIndex in cuts and audioAngle index into THIS array.",
        },
        cuts: {
          type: "array",
          items: { type: "array", items: { type: "number" } },
          description: "Switch points: [timelineFrame, angleIndex] pairs inside the angles' common overlap window. Any order — sorted and deduped automatically (same frame twice: the last one wins).",
        },
        audioAngle: {
          type: "integer",
          description: "Which angle's audio survives, kept continuous over the window (default 0 = first angle). -1 leaves every angle's audio in place (e.g. when a separate music bed drives the sound).",
        },
      },
      ["angleClipIds", "cuts"],
    ),
  },
  {
    name: "speed_ramp",
    description:
      "Apply a speed ramp (gradually changing playback speed) to a clip while keeping its timeline length unchanged: the clip is split into constant-speed segments going from fromSpeed to toSpeed (e.g. 1→4 to accelerate, 4→1 to decelerate into a beat). Reliable — no variable-rate artifacts. clipId + fromSpeed + toSpeed (both >0; <1 = slow-mo), optional segments (2..24, default 10; more = smoother).",
    inputSchema: obj(
      {
        clipId: { type: "string" },
        fromSpeed: { type: "number", description: "Start speed (1 = normal, <1 slower, >1 faster)." },
        toSpeed: { type: "number", description: "End speed." },
        segments: { type: "integer", description: "Number of steps, 2..24 (default 10)." },
      },
      ["clipId", "fromSpeed", "toSpeed"],
    ),
  },
  {
    name: "ripple_delete_ranges",
    description:
      "Cuts one or more ranges out and closes the gaps in one undoable action — the fast path for filler-word/dead-air removal. Pass exactly one of clipId or trackIndex.\n• trackIndex: ranges are PROJECT frames spanning any clips on that track; units must be 'frames'.\n• clipId: ranges are cut within that single clip; allows units 'seconds' (source-media seconds) or 'frames'.\nOverlapping ranges merge. Sync-locked tracks shift to preserve alignment; refuses if a sync-locked clip would move past frame 0. Returns the post-cut layout.",
    inputSchema: obj(
      {
        trackIndex: { type: "integer", description: "Cut project-frame ranges across a whole track. Requires units 'frames'." },
        clipId: { type: "string", description: "Cut ranges within this single clip only." },
        ranges: { type: "array", description: "[start, end] pairs (end > start).", items: { type: "array", items: { type: "number" } } },
        units: { type: "string", enum: ["seconds", "frames"], description: "'frames' (default) = project frames; 'seconds' = source seconds (clipId mode only)." },
        ignoreSyncLock: { type: "boolean", description: "If true, this call does NOT ripple sync-locked sibling tracks (only the target track and its linked audio shift). Default false." },
      },
      ["ranges"],
    ),
  },
  {
    name: "sync_cameras",
    description:
      "MULTICAM ALIGN, from the library: take 2+ recordings of the SAME moment from different cameras and lay them on the timeline already lined up — one video track each, stacked, frames matching. THE tool for 'ho ripreso con due telefoni / allinea le camere / multicam'. Cameras are matched by the sound they share, so different mic positions are fine: only the loudness pattern is compared, not the tone. The longest camera is the reference unless referenceRef says otherwise; a camera that started rolling EARLIER slides the whole rig right instead of being clamped out of sync. Duplicate sound is silenced (not deleted) on every camera but the reference — pass keepAudio:'all' to keep it. Reports the shift and a confidence per camera and says plainly which cameras it could NOT match, rather than pretending. Follow with multicam_cut to switch between the aligned angles.",
    inputSchema: obj(
      {
        mediaRefs: { type: "array", items: { type: "string" }, description: "2-8 video asset ids or names from get_media — one per camera." },
        referenceRef: { type: "string", description: "Camera the others line up to (default: the longest, most likely to overlap the rest)." },
        keepAudio: { type: "string", enum: ["reference", "all"], description: "'reference' (default) silences the duplicate sound on the other cameras; 'all' keeps every track audible." },
        searchWindowSeconds: { type: "number", description: "How far apart the cameras might have started rolling, in seconds (default 30)." },
        minConfidence: { type: "number", description: "Minimum match confidence 0..1 (default 0.5). Below it the camera is placed unaligned and flagged." },
      },
      ["mediaRefs"],
    ),
  },
  {
    name: "sync_audio",
    description:
      "Align one or more clips to a reference clip and shift the targets on the timeline (referenceClipId stays put). strategy 'auto' (default) resolves each target by the best available signal: embedded source timecode when BOTH clips carry one (jam-synced multicam/dual-system — exact, works even without usable audio) → creation_time metadata as a coarse ±1s seed that narrows the audio-correlation search to ±3s, refined by waveform → pure audio cross-correlation. Each result says which strategy resolved it ('timecode' | 'creation_time+audio' | 'audio') plus the applied offsetFrames; audio-based matches also report confidence and are refused when weak.",
    inputSchema: obj(
      {
        referenceClipId: { type: "string", description: "Clip the others align to. Stays put." },
        targetClipId: { type: "string", description: "Single clip to align." },
        targetClipIds: { type: "array", items: { type: "string" }, description: "Clips to align with the reference." },
        strategy: { type: "string", enum: ["auto", "timecode", "audio"], description: "'auto' (default): timecode if both clips have one, else creation_time-seeded audio, else audio. 'timecode': metadata only — errors per clip when either side lacks a timecode. 'audio': force waveform correlation." },
        searchWindowSeconds: { type: "number", description: "Max ± offset in seconds for audio correlation (default 30). Ignored when timecode resolves the clip." },
        minConfidence: { type: "number", description: "Minimum correlation confidence 0..1 (default 0.5). Audio-based strategies only." },
      },
      ["referenceClipId"],
    ),
  },
  {
    name: "undo",
    description:
      "Reverts the assistant's most recent timeline edit as one step. The recovery path when an edit went too far. Undoes only edits the assistant made this session, most-recent-first; refuses if the latest change wasn't the assistant's. After undoing, re-read with get_timeline before editing again. Takes no arguments.",
    inputSchema: obj(),
  },
  {
    name: "redo",
    description:
      "Re-applies the most recently undone edit as one step (inverse of undo). Only works right after undo: any new edit clears the redo history. After redoing, re-read with get_timeline before editing again. Takes no arguments.",
    inputSchema: obj(),
  },
  {
    name: "add_texts",
    description:
      "Adds one or more text clips (titles, captions, lower-thirds) in one undoable action. Text renders as an overlay. Transform uses 0..1 normalized canvas coords: (0.5,0.5) center, (0.5,0.9) bottom-center. Omit transform to center. Colors are '#RRGGBB' or '#RRGGBBAA'.\n\ntrackIndex optional: omit on every entry to auto-create one new video track at the top (the common case); set it on every entry to target existing non-audio tracks. To show multiple texts at once, put each on a DIFFERENT track.",
    inputSchema: obj(
      {
        entries: {
          type: "array",
          items: obj(
            {
              trackIndex: { type: "integer", description: "Optional. Existing non-audio track. Omit on every entry to auto-create one track." },
              startFrame: { type: "integer" },
              durationFrames: { type: "integer" },
              content: { type: "string", description: "Text to display. Supports \\n." },
              transform: {
                type: "object",
                properties: {
                  centerX: { type: "number" },
                  centerY: { type: "number" },
                  width: { type: "number" },
                  height: { type: "number" },
                },
              },
              fontName: { type: "string", description: "Default 'Helvetica-Bold'." },
              fontSize: { type: "number", description: "Canvas points (default 96)." },
              color: { type: "string", description: "Default '#FFFFFF'." },
              alignment: { type: "string", enum: ["left", "center", "right"] },
              styleRanges: {
                type: "array",
                description:
                  "Rich per-substring styling: each range styles content[start:end) (CHARACTER offsets) with any of color/bold/italic/fontSizeScale over the entry's base style — the way to color/embolden ONE word of a title without splitting it into several text clips.",
                items: obj(
                  {
                    start: { type: "integer", description: "Start character offset into content (inclusive)." },
                    end: { type: "integer", description: "End character offset (exclusive)." },
                    color: { type: "string", description: "'#RRGGBB' or '#RRGGBBAA'." },
                    bold: { type: "boolean" },
                    italic: { type: "boolean" },
                    fontSizeScale: { type: "number", description: "Multiplier on the entry's fontSize (e.g. 1.3)." },
                  },
                  ["start", "end"],
                ),
              },
            },
            ["startFrame", "durationFrames", "content"],
          ),
        },
      },
      ["entries"],
    ),
  },
  {
    name: "add_captions",
    description:
      "Auto-caption spoken audio: transcribes and places styled caption clips on a new track. The reliable path for 'caption this'. Omit clipIds to auto-pick the track with the most speech. Set karaoke:true for the TikTok/Reels style: short lines stay on screen and the word being SPOKEN is tinted (highlightColor, default yellow) in perfect sync — in the preview and burned into exports. Default is one cue per spoken phrase (no highlight). Pass language when you know it (e.g. 'it') — auto-detect can mislabel the first words.",
    inputSchema: obj({
      clipIds: { type: "array", items: { type: "string" }, description: "Optional. Audio/video clips to caption." },
      language: { type: "string", description: "Optional BCP-47 language (e.g. 'it', 'en'). Recommended when known." },
      karaoke: { type: "boolean", description: "Karaoke captions: the spoken word is tinted with highlightColor, word-accurate timing." },
      wordsPerCue: { type: "integer", description: "Words shown per line in karaoke mode (default 4; 1 = single-word pop). Implies karaoke." },
      highlightColor: { type: "string", description: "Karaoke color of the word being spoken (default '#FFD400')." },
      fontName: { type: "string" },
      fontSize: { type: "number", description: "Default 48." },
      color: { type: "string" },
      centerX: { type: "number", description: "Default 0.5." },
      centerY: { type: "number", description: "Default 0.9." },
      textCase: { type: "string", enum: ["auto", "upper", "lower"] },
    }),
  },
  {
    name: "add_motion_graphic",
    description:
      "AI MOTION GRAPHICS — THE tool for 'aggiungi una lower third / titolo animato / card capitolo / contatore animato / quote card / logo reveal'. Describe the graphic in 'prompt' (include exact text + language): Claude designs a self-contained HTML/CSS animation, it renders locally to a TRANSPARENT overlay (VP9 alpha) at project resolution, and lands on a new top track at startFrame. Free, local, no templates — the saved HTML source is returned so tweaks are one more call (describe the change, or pass edited 'html' directly). Rendering takes ~2-8s per second of animation — tell the user it's working.",
    inputSchema: obj(
      {
        prompt: { type: "string", description: "What to design, with the exact on-screen text (e.g. \"lower third elegante: 'DOTT. DI CAPUA' sopra, 'Odontoiatra' sotto, slide-in da sinistra, palette teal\")." },
        html: { type: "string", description: "Ready-made self-contained HTML (skips generation) — for re-renders after edits." },
        durationSeconds: { type: "number", description: "Animation length incl. intro/outro (default 4, max 20)." },
        startFrame: { type: "integer", description: "Timeline frame where the overlay starts (default 0)." },
        name: { type: "string", description: "Asset name stem." },
      },
      [],
    ),
  },
  {
    name: "save_version",
    description:
      "Checkpoint the ENTIRE project under a name (timeline + library refs) — the safety net for big autonomous edits. Save one BEFORE any sweeping change (first cut, restructure, format change) and after milestones the user approves. Restore later with restore_version. Cheap and instant.",
    inputSchema: obj({ name: { type: "string", description: "Short label, e.g. 'prima-del-montaggio'." } }),
  },
  {
    name: "list_versions",
    description: "List saved project versions (newest last). Names include their timestamp.",
    inputSchema: obj(),
  },
  {
    name: "restore_version",
    description:
      "Revert the whole project to a saved version (substring match on the name from list_versions; newest match wins). Replaces the current timeline — save_version first if the current state might still matter. Undo history resets.",
    inputSchema: obj({ name: { type: "string", description: "Version name or substring." } }, ["name"]),
  },
  {
    name: "add_marker",
    description:
      "Pin a MARKER (bookmark) on the timeline ruler at a frame, with an optional note and color — 'segna dove ridono', 'bookmark the drop': use markers to annotate key moments for the user while reviewing footage, without touching any clip. Markers show as colored flags on the ruler (hover reveals the note) and persist with the project. Returns the created marker as JSON; list existing ones via get_timeline's markers array.",
    inputSchema: obj(
      {
        frame: { type: "integer", description: "Project frame to mark." },
        color: { type: "string", description: "'#RRGGBB' flag color (default amber '#F59E0B')." },
        note: { type: "string", description: "What happens here ('risata', 'hook', 'best take')." },
      },
      ["frame"],
    ),
  },
  {
    name: "update_marker",
    description:
      "Edit an existing timeline marker's note, color, or frame (markerId from add_marker or get_timeline). Pass note:'' to clear the note.",
    inputSchema: obj(
      {
        markerId: { type: "string", description: "Marker id from add_marker or get_timeline." },
        note: { type: "string", description: "New note ('' clears it)." },
        color: { type: "string", description: "'#RRGGBB'." },
        frame: { type: "integer", description: "Move the marker to this project frame." },
      },
      ["markerId"],
    ),
  },
  {
    name: "remove_marker",
    description: "Delete a timeline marker by id.",
    inputSchema: obj({ markerId: { type: "string", description: "Marker id from add_marker or get_timeline." } }, ["markerId"]),
  },
  {
    name: "export_captions",
    description:
      "Export the timeline's spoken dialogue as a standard SRT subtitle file in the ORIGINAL language (timeline-mapped times, trim/speed-aware) — for YouTube uploads and external players. For a TRANSLATED file use translate_captions mode:'srt'. Optional language hint for the transcription.",
    inputSchema: obj({ language: { type: "string", description: "Optional BCP-47 hint (e.g. 'it')." } }),
  },
  {
    name: "import_captions",
    description:
      "Import an existing subtitle file (SRT or WebVTT) as styled caption clips on a new track — for users who already have subtitles authored elsewhere. Cue times are TIMELINE seconds (the file is assumed to match the current cut). Same styling knobs as add_captions.",
    inputSchema: obj(
      {
        path: { type: "string", description: "Absolute path of the .srt or .vtt file." },
        fontName: { type: "string" },
        fontSize: { type: "number", description: "Default 48." },
        color: { type: "string" },
        centerX: { type: "number", description: "Default 0.5." },
        centerY: { type: "number", description: "Default 0.9." },
      },
      ["path"],
    ),
  },
  {
    name: "translate_captions",
    description:
      "Translate the timeline's SPOKEN dialogue into another language: transcribes on-device, translates every phrase with the same Claude connection the chat uses (needs Claude signed in), and places the translation as styled caption clips on a new track (same mechanics as add_captions) — or, with mode 'srt', writes a standard exports/subtitles-<lang>.srt file and returns its path instead. Cues stay aligned to the timeline (trim/speed-aware). THE tool for 'add English subtitles', 'traduci i sottotitoli', 'export a Spanish SRT'. In captions mode, karaoke:true keeps the spoken-word tint (like add_captions) — word timing is APPROXIMATED by distributing each phrase's span across the translated words proportionally to length, since the translation has no true word timestamps.",
    inputSchema: obj(
      {
        targetLanguage: { type: "string", description: "Language to translate INTO — ISO code or name (e.g. 'en', 'es', 'French')." },
        mode: { type: "string", enum: ["captions", "srt"], description: "'captions' (default) places translated caption clips on a new track; 'srt' writes exports/subtitles-<lang>.srt and returns the path." },
        clipIds: { type: "array", items: { type: "string" }, description: "Optional. Only translate speech from these timeline clips (default: every audio/video clip)." },
        karaoke: { type: "boolean", description: "Captions mode only: tint the word being spoken (highlightColor) with per-word timing approximated proportionally across each phrase." },
        wordsPerCue: { type: "integer", description: "Words shown per karaoke line (default 4). Implies karaoke." },
        highlightColor: { type: "string", description: "Karaoke color of the word being spoken (default '#FFD400')." },
      },
      ["targetLanguage"],
    ),
  },
  {
    name: "dub_timeline",
    description:
      "LOCAL voice DUBBING: transcribe the timeline's speech, translate it, speak it in the target language with local Piper TTS, time-fit each line to its original window (so it stays roughly in sync), place it on a new audio track, and duck (or mute) the original voice. Offline and free — no region locks. Use for 'dub this in English/Italian/…'. Needs a Piper voice for the target language (bundled: it, en). Runs one TTS per line — expect a little time on long timelines.",
    inputSchema: obj(
      {
        targetLanguage: { type: "string", description: "Language to dub into, e.g. 'en', 'it', 'es'." },
        voice: { type: "string", description: "Piper voice: a language shorthand ('it'/'en') or an explicit .onnx filename. Defaults to the target language." },
        muteOriginal: { type: "boolean", description: "Mute the original voice instead of ducking it (default false)." },
        duckTo: { type: "number", description: "Original voice level under the dub, 0..1 (default 0.2)." },
      },
      ["targetLanguage"],
    ),
  },

  // ── generation (Higgsfield) ──
  {
    name: "generate_video",
    description:
      "Starts a Higgsfield video generation and waits for it. The asset is downloaded into the project library and becomes usable in add_clips. Costs real money and is not undoable — propose prompt/model/duration/aspect ratio and get confirmation first. Use list_models (type='video') for model IDs (job_set_types).",
    inputSchema: obj(
      {
        prompt: { type: "string", description: "Text description of the video." },
        name: { type: "string", description: "Display name in the library. Defaults to the first 30 chars of the prompt." },
        model: { type: "string", description: "Higgsfield model job_set_type (e.g. 'seedance_2_0'). Use list_models. Defaults to the first available." },
        duration: { type: "integer", description: "Duration in seconds (model-dependent)." },
        aspectRatio: { type: "string", description: "e.g. '16:9', '9:16', '1:1'." },
        resolution: { type: "string", description: "e.g. '720p', '1080p'." },
        startFrameMediaRef: { type: "string", description: "Media asset ID to use as the first frame (image-to-video)." },
        endFrameMediaRef: { type: "string", description: "Media asset ID for the last frame (model-dependent)." },
        sourceVideoMediaRef: { type: "string", description: "Source video asset ID (video-to-video models)." },
        referenceImageMediaRefs: { type: "array", items: { type: "string" }, description: "Image reference asset IDs." },
        folderId: { type: "string", description: "Optional. Folder to place the result in." },
        params: { type: "object", description: "Optional model-specific settings. Run list_models with this model first to see its parameter spec (names, enums, required), then pass any of them here (e.g. quality, seed, style, motion). Merged into the call." },
      },
      ["prompt"],
    ),
  },
  {
    name: "generate_image",
    description:
      "Starts a Higgsfield image generation and waits for it. The asset is downloaded into the library. Costs real money and is not undoable. Use list_models (type='image') for model IDs (e.g. 'nano_banana_2', 'gpt_image_2').",
    inputSchema: obj(
      {
        prompt: { type: "string", description: "Text description of the image." },
        name: { type: "string", description: "Display name. Defaults to the first 30 chars of the prompt." },
        model: { type: "string", description: "Higgsfield model job_set_type. Use list_models. Defaults to the first available." },
        aspectRatio: { type: "string", description: "e.g. '16:9', '9:16'." },
        resolution: { type: "string", description: "e.g. '2K', '4K'." },
        quality: { type: "string", description: "Model-dependent (e.g. 'low', 'medium', 'high')." },
        referenceMediaRefs: { type: "array", items: { type: "string" }, description: "Reference image asset IDs." },
        folderId: { type: "string", description: "Optional. Folder to place the result in." },
        params: { type: "object", description: "Optional model-specific settings. Run list_models with this model first to see its parameter spec (names, enums, required), then pass any of them here (e.g. quality, seed, style, motion). Merged into the call." },
      },
      ["prompt"],
    ),
  },
  {
    name: "generate_audio",
    description:
      "Starts a Higgsfield audio generation (text-to-speech or music) and waits for it. The asset is downloaded into the library and placed with add_clips. Costs real money and is not undoable. Use list_models (type='audio') for options.",
    inputSchema: obj({
      prompt: { type: "string", description: "TTS: the text to speak. Music: style/mood/genre." },
      name: { type: "string", description: "Display name." },
      model: { type: "string", description: "Higgsfield audio model job_set_type. Use list_models." },
      voice: { type: "string", description: "TTS only. Voice preset." },
      duration: { type: "integer", description: "Length in seconds (model-dependent)." },
      folderId: { type: "string", description: "Optional. Folder to place the result in." },
      params: { type: "object", description: "Optional model-specific settings (run list_models with this model to see them). TTS requires a voice: inworld_text_to_speech → { voice }; text2speech_v2 → { model, voice_id, voice_type }. Also language, instrumental, etc." },
    }),
  },
  {
    name: "smooth_slowmo",
    description:
      "LOCAL smooth slow-motion (free): render a motion-interpolated slowed copy of a VIDEO with ffmpeg (synthesizes in-between frames along motion vectors — fluid, not stuttered/duplicated). CapCut paywalls this; here it's offline. factor < 1 (0.5 = half speed / 2× longer, 0.25 = quarter). Returns a new silent video asset. Use for 'make this slow-mo / smooth slow motion'.",
    inputSchema: obj(
      {
        mediaRef: { type: "string", description: "Video asset id or name." },
        factor: { type: "number", description: "Speed factor < 1 (0.5 = half speed, 0.25 = quarter). Default 0.5." },
        outFps: { type: "integer", description: "Output fps (default: source fps). Higher = smoother, slower to render." },
      },
      ["mediaRef"],
    ),
  },
  {
    name: "upscale_media",
    description:
      "Upscales a video or image asset to a higher resolution using a Higgsfield upscaler. The upscaled asset is downloaded into the library. Use list_models for an upscaler that supports the asset's type. Costs real money and is not undoable.",
    inputSchema: obj(
      {
        mediaRef: { type: "string", description: "ID of the video or image asset to upscale." },
        model: { type: "string", description: "Upscaler model job_set_type (e.g. 'bytedance_image_upscale'). Defaults to the first that supports the type." },
      },
      ["mediaRef"],
    ),
  },
  {
    name: "import_media",
    description:
      "Imports external media into the project library — the bridge for assets from other MCP servers (stock, web search) or local files. The 'source' object must set exactly one of: url (HTTPS, downloaded in the background) or path (absolute local file path). Supported: video (mov, mp4, m4v), audio (mp3, wav, aac, m4a, flac), image (png, jpg, jpeg, webp). Returns an asset id usable in add_clips. Costs nothing.",
    inputSchema: obj(
      {
        source: {
          type: "object",
          properties: {
            url: { type: "string", description: "HTTPS URL." },
            path: { type: "string", description: "Absolute local file path readable by the bridge." },
            mimeType: { type: "string", description: "Optional type override (e.g. for signed URLs)." },
          },
        },
        name: { type: "string", description: "Display name. Defaults to the filename." },
        folderId: { type: "string", description: "Optional. Folder to place the result in." },
      },
      ["source"],
    ),
  },
  {
    name: "import_from_url",
    description:
      "Download a video from a URL (YouTube, Vimeo, direct links…) into the project and import it into the library — runs a local yt-dlp, no accounts or API keys needed. Picks the best mp4 up to 4K and merges audio. Blocks until the download finishes (long videos take a while) and returns the imported asset id and duration. Costs nothing.",
    inputSchema: obj(
      { url: { type: "string", description: "Video page URL (YouTube, Vimeo, …) or a direct http(s) media URL." } },
      ["url"],
    ),
  },
  {
    name: "record_start",
    description:
      "Start recording the SCREEN (full desktop, 30 fps) or the WEBCAM (first DirectShow camera) to an mp4 with the bundled ffmpeg. Runs in the background until record_stop; one recording at a time (errors if one is already active). audio true (default) also captures the default microphone when present. Use for 'record my screen', 'registra lo schermo', 'record a webcam clip'. Costs nothing.",
    inputSchema: obj(
      {
        source: { type: "string", enum: ["screen", "webcam"], description: "What to capture: the desktop or the first webcam." },
        audio: { type: "boolean", description: "Also record the default microphone (default true; falls back to video-only if none is found)." },
      },
      ["source"],
    ),
  },
  {
    name: "record_stop",
    description:
      "Stop the active screen/webcam recording with a clean ffmpeg shutdown (the mp4 is properly finalized), import it into the media library, and return the new asset id + duration/resolution — immediately usable in add_clips. Errors if no recording is in progress.",
    inputSchema: obj(),
  },
  {
    name: "generate_speech",
    description:
      "Generate a spoken VOICEOVER wav from text with the bundled Piper TTS — fully local and free, no cloud, no accounts. THE tool for 'aggiungi un voiceover/una narrazione che dice X' / 'add a voiceover saying X'. Bundled voices: Italian ('it', default) and English ('en'); speed adjusts the pace. Synthesizes, imports the wav into the media library, and returns the asset id + duration — then place it with add_clips on an audio track. Costs nothing.",
    inputSchema: obj(
      {
        text: { type: "string", description: "The exact words to speak (plain text; punctuation shapes pauses and pacing)." },
        voice: { type: "string", description: "'it' (Italian, default), 'en' (English), or an explicit Piper .onnx model filename from the voices dir." },
        speed: { type: "number", description: "Speaking pace 0.5-2 (1 = natural, 1.3 = brisk narration; clamped)." },
        name: { type: "string", description: "Optional asset/file name for the generated wav (default voiceover-<timestamp>)." },
      },
      ["text"],
    ),
  },

  // ── Higgsfield edits & analysis (CLI models) ──
  {
    name: "auto_reframe",
    description:
      "LOCAL auto-reframe (free, no cloud): reframe a VIDEO to a new aspect ratio (9:16 vertical by default) by analyzing each shot for where the subject/detail sits and cropping to keep it in frame, shot by shot. Returns a new video asset in the library, ready immediately. THE default for 'make this vertical / crop to 9:16 / reframe for reels'. Deterministic and offline. (For AI content-aware reframing that can invent off-frame content, use 'reframe' — that one costs money.)",
    inputSchema: obj(
      {
        mediaRef: { type: "string", description: "Video asset id or name from get_media." },
        aspectRatio: { type: "string", description: "Target aspect ratio (default '9:16'), e.g. '9:16', '1:1', '4:5'." },
        smooth: { type: "boolean", description: "Temporally smooth framing between shots (default true)." },
      },
      ["mediaRef"],
    ),
  },
  {
    name: "reframe",
    description:
      "AI content-aware reframe of a VIDEO to a new aspect ratio with Higgsfield (can synthesize off-frame content, not a hard crop). Returns a new video asset in the library (async — resolves in get_media). Costs real money — prefer the free local 'auto_reframe' unless the user explicitly wants AI reframing.",
    inputSchema: obj(
      {
        mediaRef: { type: "string", description: "Video asset id from get_media." },
        aspectRatio: { type: "string", description: "Target aspect ratio, e.g. '9:16', '1:1', '16:9'." },
      },
      ["mediaRef", "aspectRatio"],
    ),
  },
  {
    name: "remove_background",
    description:
      "Remove the background from an IMAGE or VIDEO asset (cutout / matte) with Higgsfield. Returns a new asset (async). Use to composite a subject over other layers. Costs real money.",
    inputSchema: obj({ mediaRef: { type: "string", description: "Image or video asset id from get_media." } }, ["mediaRef"]),
  },
  {
    name: "outpaint_image",
    description:
      "Expand (uncrop) an IMAGE beyond its borders with Higgsfield, generating new surroundings. Returns a new image asset (async). Use to extend a still to a wider/taller frame. Costs real money.",
    inputSchema: obj(
      {
        mediaRef: { type: "string", description: "Image asset id from get_media." },
        aspectRatio: { type: "string", description: "Optional target aspect ratio for the expanded image." },
      },
      ["mediaRef"],
    ),
  },
  {
    name: "analyze_video",
    description:
      "Score a VIDEO's virality with Higgsfield's Virality Predictor: hook strength, attention, retention, distraction risk, overall creative score. Returns a text report (no media). Use to validate a hook or compare creative before publishing.",
    inputSchema: obj({ mediaRef: { type: "string", description: "Video asset id from get_media." } }, ["mediaRef"]),
  },

  // ── render ──
  {
    name: "export_video",
    description:
      "USER-INITIATED ONLY — refuses agent calls: exports run from the Export button/dialog. When the edit is done, tell the user to press Export (top right). (Reference for the UI path:) Renders the current timeline to a video file with ffmpeg and returns a download URL. Composites every layer with position, scale, rotation, opacity, crop, color grade, effects, and keyframes (zoom/pan/fades, eased to match the preview), and mixes audio. Output resolution and fps come from the project format (set_project_format) — 3840×2160 = 4K, 1080×1920 = vertical, etc. Pick quality for the size/fidelity trade-off. format 'lossless' = stream copy (NO re-encode of the untouched middle): near-instant and zero quality loss, but ONLY when the timeline is pure cuts of one source (no effects/text/speed/transform). Cut boundaries are frame-exact (only the partial GOP at each cut's head/tail is re-encoded); for non-h264/hevc sources it falls back to keyframe-snapped copy, where cuts can land up to a GOP early. Great for plain trims and after dead-air removal when nothing else was applied; if ineligible it returns the reason instead of exporting.",
    inputSchema: obj({
      name: { type: "string", description: "Output filename (default 'export')." },
      format: {
        type: "string",
        enum: ["mp4_h264", "mp4_h265", "mp4_av1", "hdr_hevc", "prores", "nle_xml", "fcpxml", "lossless"],
        description: "mp4_h264 (default), mp4_h265, mp4_av1 (SVT-AV1 10-bit — ~30% smaller than H.265, slower encode), hdr_hevc (true HDR — HLG BT.2020 10-bit HEVC; needs an all-HDR timeline), prores (.mov), nle_xml (FCP7 XML for Premiere/Resolve), fcpxml (FCPXML 1.11 for Final Cut/Resolve), or lossless (stream copy — instant, zero loss, pure-cut timelines of one source only).",
      },
      quality: {
        type: "string",
        enum: ["draft", "standard", "high", "max"],
        description: "Encode quality/size trade-off (h264/h265): draft (small), standard, high (default), max (near-lossless, large).",
      },
    }),
  },
  {
    name: "cancel_export",
    description: "Stops the running export/merge render immediately; the partial file is discarded. No-op if nothing is rendering.",
    inputSchema: obj(),
  },

  // ── library / folders ──
  {
    name: "list_folders",
    description: "Lists every folder in the media panel as {id, name, parentFolderId}. Use to find an existing folder by name before generating new media.",
    inputSchema: obj(),
  },
  {
    name: "create_folder",
    description: "Creates folders. Pass name/parentFolderId for one folder or entries for several. Undoable. Use to organize related generations (e.g. 'Hero shot variations').",
    inputSchema: obj({
      name: { type: "string", description: "Folder name." },
      parentFolderId: { type: "string", description: "Optional parent folder id." },
      entries: { type: "array", items: obj({ name: { type: "string" }, parentFolderId: { type: "string" } }, ["name"]) },
    }),
  },
  {
    name: "move_to_folder",
    description: "Moves media assets to folders. Pass assetIds/folderId for one destination or entries for several. Omit folderId to move to root. Undoable.",
    inputSchema: obj({
      assetIds: { type: "array", items: { type: "string" } },
      folderId: { type: "string", description: "Destination folder id. Omit for root." },
      entries: { type: "array", items: obj({ assetIds: { type: "array", items: { type: "string" } }, folderId: { type: "string" } }, ["assetIds"]) },
    }),
  },
  {
    name: "rename_media",
    description: "Renames media assets. Pass mediaRef/name for one or entries for several. Undoable.",
    inputSchema: obj({
      mediaRef: { type: "string" },
      name: { type: "string" },
      entries: { type: "array", items: obj({ mediaRef: { type: "string" }, name: { type: "string" } }, ["mediaRef", "name"]) },
    }),
  },
  {
    name: "duplicate_media",
    description: "Duplicate a library media asset (an independent copy you can rename/edit). Pass mediaRef. Undoable.",
    inputSchema: obj({ mediaRef: { type: "string" } }, ["mediaRef"]),
  },
  {
    name: "rename_folder",
    description: "Renames folders. Pass folderId/name for one or entries for several. Undoable.",
    inputSchema: obj({
      folderId: { type: "string" },
      name: { type: "string" },
      entries: { type: "array", items: obj({ folderId: { type: "string" }, name: { type: "string" } }, ["folderId", "name"]) },
    }),
  },
  {
    name: "delete_media",
    description: "Deletes media assets from the library. Any clips referencing them are removed from the timeline in the same undoable action.",
    inputSchema: obj({ assetIds: { type: "array", items: { type: "string" }, description: "Media asset ids to delete." } }, ["assetIds"]),
  },
  {
    name: "delete_folder",
    description: "Deletes folders and everything inside them (subfolders and assets). Clips referencing any deleted asset are removed from the timeline in the same undoable action.",
    inputSchema: obj({ folderIds: { type: "array", items: { type: "string" }, description: "Folder ids to delete." } }, ["folderIds"]),
  },

  // ── memory / learning ──
  {
    name: "remember",
    description:
      "Save a durable learning to CupCat's memory so future sessions start already knowing it. Use proactively: user preferences (style, pacing, fonts, aspect ratios, caption look), recurring workflows, corrections the user made, and mistakes to avoid. Memory is injected into your instructions when a project opens. scope 'project' = this project only; 'global' = carried across all the user's CupCat projects.",
    inputSchema: obj(
      {
        note: { type: "string", description: "The learning, one concise sentence (e.g. 'User prefers 9:16 vertical with large bold bottom captions')." },
        scope: { type: "string", enum: ["project", "global"], description: "'project' (default) or 'global'." },
      },
      ["note"],
    ),
  },
];

export const TOOL_NAMES: string[] = TOOL_DEFS.map((t) => t.name);
