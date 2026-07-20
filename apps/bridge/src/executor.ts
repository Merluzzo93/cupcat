// Tool executor — turns an MCP/WS tool call into an action.
//
// Routing: read/edit/library tools run against the in-process EditorDocument (editor-core);
// generate_*/upscale/import/list_models go through the Higgsfield CLI + ffmpeg. Generation is
// async: a placeholder asset is added immediately and filled in when the job finishes.

import {
  type Clip,
  type ClipType,
  type EditorDocument,
  type EditSource,
  clipEndFrame,
  getMedia,
  getTimeline,
  listFolders,
  makeClip,
  type MediaAsset,
  newId,
  TIMELINE_COMMANDS,
  trimClip as trimClipCommand,
  undo,
  type Project,
} from "@cupcat/editor-core";
import { detectBeatsFromEnvelope } from "./beats";
import { mkdir, readdir, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { BRIDGE_PORT, exportsDir, FFMPEG_BIN, mediaDir, projectRoot } from "./config";
import { killTagged, run } from "./proc";
import { emitProgress } from "./progress";
import { type ExportFormat, type ExportQuality, ensureCompoundBake, exportTimeline, renderFrameAndScopes, renderFrameToFile, renderFrames, renderTimelineView, saveRangeToFile } from "./export";
import { autoClips } from "./clips";
import { renderFaceBlur } from "./faceblur";
import { deflickerVideo, denoiseVideo, duckMusic, enhanceAudio, stabilizeVideo } from "./enhance";
import { chapterTimestamp, detectChapters } from "./chapters";
import { autoRoughCut } from "./roughcut";
import { reframeLocal } from "./reframe-local";
import { applyTemplate, listTemplates, saveTemplate } from "./templates";
import { smoothSlowMo } from "./slowmo";
import { separateStems } from "./separate";
import { trackMotion } from "./track-local";
import { analyzeVideo, audioEnvelope, audioSilences, ensureAudioProxy, ensureScrubProxy, ensureThumbnail, frameToBase64, probeMedia, sourceTimecode } from "./ffmpeg";
import { generate, getModel, type GenerateOptions, type HfModel, listModels, uploadFile } from "./higgsfield";
import { downloadToFile, guessExt, inferType, mediaPathFor, saveProject } from "./media";
import { startRecording, stopRecording } from "./recorder";
import { multicamCut } from "./multicam";
import { magnify, punchIn } from "./zoom";
import { renderMotionGraphic } from "./motion";
import { cachedDiarization, type Diarization, diarizeSpeakers, overrideDiarization, speakerAt, type SpeakerTurn } from "./diarize";
import { detectRetakes, transcribe } from "./transcribe";
import { synthesizeSpeech } from "./tts";
import { parseSubtitles, toSrt, translateSegments } from "./translate";
import { importFromUrl } from "./url-import";
import { appendMemory } from "./memory";
import { createProject, listProjects, switchProject } from "./projects";

export interface BridgeContext {
  doc: EditorDocument;
  canGenerate: () => boolean;
  refreshHiggsfield: () => Promise<boolean>;
  loginHiggsfield: (onUrl?: (url: string) => void) => Promise<boolean>;
}

type Args = Record<string, unknown>;
type Block = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };
export interface ToolOut {
  content: Block[];
  isError: boolean;
}

const ok = (text: string): ToolOut => ({ content: [{ type: "text", text }], isError: false });
const fail = (text: string): ToolOut => ({ content: [{ type: "text", text }], isError: true });
const okJson = (o: unknown): ToolOut => ok(JSON.stringify(o));
const okImages = (images: string[], note: string): ToolOut => ({
  content: [{ type: "text", text: note }, ...images.map((data) => ({ type: "image" as const, data, mimeType: "image/jpeg" }))],
  isError: false,
});

function numOpt(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}
function strOpt(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

const MEDIA_EXTS = new Set([
  "mp4", "mov", "m4v", "webm", "mkv", "mp3", "wav", "aac", "m4a", "flac", "aiff",
  "png", "jpg", "jpeg", "webp", "gif", "bmp", "tiff",
]);

/** Undo earlier pollution: CupCat's feedback bundles contain a screenshot.png that used to be
 * imported as media, creating a stray "feedback" folder in the library. Drop those assets — never
 * one the user actually placed on the timeline — plus any folder left empty by the removal. */
function pruneSystemImports(ctx: BridgeContext, rootFwd: string): void {
  const prefix = `${rootFwd.replace(/\/+$/, "")}/feedback/`;
  const used = new Set<string>();
  for (const t of ctx.doc.project.timeline.tracks) for (const c of t.clips) if (c.mediaRef) used.add(c.mediaRef);
  const junk = ctx.doc.project.media.filter((m) => (m.url ?? "").replace(/\\/g, "/").startsWith(prefix) && !used.has(m.id));
  if (junk.length === 0) return;
  const touched = new Set(junk.map((m) => m.folderId).filter((f): f is string => !!f));
  ctx.doc.removeAssets(new Set(junk.map((m) => m.id)));
  // Only drop a folder that just lost its last asset and holds no subfolders — a folder the user
  // created on purpose (or one with real media) is never touched.
  ctx.doc.project.folders = ctx.doc.project.folders.filter(
    (f) =>
      !(
        touched.has(f.id) &&
        !ctx.doc.project.media.some((m) => m.folderId === f.id) &&
        !ctx.doc.project.folders.some((c) => c.parentFolderId === f.id)
      ),
  );
  ctx.doc.notifyChanged();
}

/** Scan the open project's folder for loose media files and import any not already in the library. */
export async function importFolderMedia(ctx: BridgeContext): Promise<void> {
  try {
    // Normalize a git-bash /d/foo path to D:/foo so Bun can open it on Windows.
    const root = projectRoot.replace(/^\/([a-zA-Z])\//, (_m, d: string) => `${d.toUpperCase()}:/`);
    pruneSystemImports(ctx, root.replace(/\\/g, "/")); // clean projects polluted by the old scan
    const entries = (await readdir(root, { recursive: true, withFileTypes: true })) as Array<{
      name: string;
      parentPath?: string;
      path?: string;
      isFile: () => boolean;
    }>;
    const haveNames = new Set(ctx.doc.project.media.map((m) => (m.url ?? "").replace(/\\/g, "/").split("/").pop()));
    // Files inside project SUBFOLDERS become library folders of the same name instead of being
    // flattened into the root — a project organized on disk stays organized in the library.
    const rootFwd = root.replace(/\\/g, "/");
    const folderIdByName = new Map<string, string>();
    const folderFor = (name: string): string | undefined => {
      let id = folderIdByName.get(name) ?? ctx.doc.project.folders.find((f) => f.name === name && !f.parentFolderId)?.id;
      if (!id) {
        TIMELINE_COMMANDS.create_folder!(ctx.doc, { name }, "user");
        id = ctx.doc.project.folders.find((f) => f.name === name && !f.parentFolderId)?.id;
      }
      if (id) folderIdByName.set(name, id);
      return id;
    };
    for (const e of entries) {
      if (!e.isFile()) continue;
      const dir = (e.parentPath ?? e.path ?? root).replace(/\\/g, "/");
      // Skip CupCat's own output/state dirs: exports, feedback bundles (they hold a screenshot.png
      // that would otherwise be imported and create a stray "feedback" folder) and any dot-dir
      // (.cupcat, media/.transcripts, …). Only real user media should reach the library.
      if (/\/(\.[^/]+|exports|feedback)(\/|$)/.test(dir) || /\.scrubv?\d*\.mp4|\.dvsdr\d*\.mp4|\.audio\.(webm|m4a)|\.thumbv?\d*\.jpg/.test(e.name)) continue;
      const ext = e.name.split(".").pop()?.toLowerCase() ?? "";
      if (!MEDIA_EXTS.has(ext) || haveNames.has(e.name)) continue;
      haveNames.add(e.name);
      const path = `${dir}/${e.name}`;
      await executeTool(ctx, "import_media", { source: { path } }, "user");
      // Library folder = first subfolder segment under the project root; the conventional
      // "media" container itself doesn't count as organization.
      const rel = dir.startsWith(rootFwd) ? dir.slice(rootFwd.length).replace(/^\/+/, "") : "";
      const seg = rel.split("/").filter((s) => s && s !== "media");
      if (seg.length > 0) {
        const asset = [...ctx.doc.project.media].reverse().find((m) => (m.url ?? "").replace(/\\/g, "/") === path);
        const folderId = folderFor(seg[0]!);
        if (asset && folderId) TIMELINE_COMMANDS.move_to_folder!(ctx.doc, { assetIds: [asset.id], folderId }, "user");
      }
    }
  } catch {
    /* best-effort; folder may be empty or unreadable */
  }
}

async function listProjectsTool(): Promise<ToolOut> {
  const projects = await listProjects();
  return okJson({ projects, note: "Use open_project (existing name/path) or new_project (fresh name) to switch. The current project is marked current:true." });
}

async function openProjectTool(ctx: BridgeContext, args: Args): Promise<ToolOut> {
  const name = strOpt(args.name);
  if (!name) return fail("name is required (a project name from list_projects, or a folder path).");
  const projects = await switchProject(ctx.doc, name);
  void importFolderMedia(ctx);
  const cur = projects.find((p) => p.current);
  return okJson({ projects, opened: cur?.name ?? name });
}

async function newProjectTool(ctx: BridgeContext, args: Args): Promise<ToolOut> {
  const name = strOpt(args.name);
  if (!name) return fail("name is required for the new project.");
  const projects = await createProject(ctx.doc, name);
  return okJson({ projects, created: name });
}

// ── id-prefix expansion (mirrors Palmier's ShortId: accept any unique prefix back) ──

const SCALAR_ID_KEYS = new Set([
  "clipId",
  "sourceClipId",
  "referenceClipId",
  "targetClipId",
  "mediaRef",
  "startFrameMediaRef",
  "endFrameMediaRef",
  "sourceVideoMediaRef",
  "videoSourceMediaRef",
  "folderId",
  "parentFolderId",
]);
const ARRAY_ID_KEYS = new Set([
  "clipIds",
  "targetClipIds",
  "assetIds",
  "folderIds",
  "referenceMediaRefs",
  "referenceImageMediaRefs",
  "referenceVideoMediaRefs",
  "referenceAudioMediaRefs",
]);

function idUniverse(doc: EditorDocument): Set<string> {
  const ids = new Set<string>();
  for (const t of doc.timeline.tracks) {
    ids.add(t.id);
    for (const c of t.clips) {
      ids.add(c.id);
      if (c.linkGroupId) ids.add(c.linkGroupId);
      if (c.captionGroupId) ids.add(c.captionGroupId);
    }
  }
  for (const a of doc.project.media) ids.add(a.id);
  for (const f of doc.project.folders) ids.add(f.id);
  return ids;
}

function expandOne(ref: string, universe: Set<string>): string {
  if (universe.has(ref)) return ref;
  const matches = [...universe].filter((id) => id.startsWith(ref));
  if (matches.length === 1) return matches[0]!;
  return ref; // 0 matches → let the tool emit its own not-found; >1 → tool resolves or errors
}

function expandIds(value: unknown, universe: Set<string>): unknown {
  if (Array.isArray(value)) return value.map((v) => expandIds(v, universe));
  if (value && typeof value === "object") {
    const out: Args = {};
    for (const [k, v] of Object.entries(value as Args)) {
      if (SCALAR_ID_KEYS.has(k) && typeof v === "string") out[k] = expandOne(v, universe);
      else if (ARRAY_ID_KEYS.has(k) && Array.isArray(v)) out[k] = v.map((x) => (typeof x === "string" ? expandOne(x, universe) : x));
      else out[k] = expandIds(v, universe);
    }
    return out;
  }
  return value;
}

// ── model selection ──

function pickModel(models: HfModel[], prefs: string[]): string | null {
  for (const p of prefs) if (models.some((m) => m.jobSetType === p)) return p;
  return models[0]?.jobSetType ?? null;
}

const IMAGE_PREFS = ["gpt_image_2", "nano_banana_2", "nano_banana_flash"];
const VIDEO_PREFS = ["seedance_2_0", "seedance1_5", "kling3_0"];

// ── generation ──

function resolveRefPath(doc: EditorDocument, mediaRef: unknown): string | undefined {
  if (typeof mediaRef !== "string") return undefined;
  const a = doc.asset(mediaRef);
  return a?.url;
}

async function completeGeneration(
  ctx: BridgeContext,
  asset: MediaAsset,
  opts: GenerateOptions,
  referencePaths?: string[],
): Promise<void> {
  // Multiple reference images: upload each + forward through the model's array param (input_images / medias).
  if (referencePaths && referencePaths.length > 1) {
    const spec = (await getModel(opts.model)) as { params?: { name: string; type: string }[] } | null;
    const param = spec?.params?.find(
      (p) => p.type === "array" && ["input_images", "medias", "reference_images", "images"].includes(p.name),
    )?.name;
    if (param) {
      const ids: string[] = [];
      for (const p of referencePaths) {
        const id = await uploadFile(p);
        if (id) ids.push(id);
      }
      if (ids.length) opts = { ...opts, referenceParam: param, referenceIds: ids };
    }
  }
  const res = await generate(opts);
  if (!res.ok || res.urls.length === 0) {
    asset.generationStatus = { kind: "failed", error: res.error ?? "no output produced" };
    ctx.doc.notifyChanged();
    return;
  }
  asset.generationStatus = { kind: "downloading" };
  ctx.doc.notifyChanged();
  const url = res.urls[0]!;
  const path = mediaPathFor(guessExt(url, asset.type));
  if (!(await downloadToFile(url, path))) {
    asset.generationStatus = { kind: "failed", error: "result download failed" };
    ctx.doc.notifyChanged();
    return;
  }
  asset.url = path;
  const probe = await probeMedia(path);
  if (probe.durationSeconds) asset.durationSeconds = probe.durationSeconds;
  asset.sourceWidth = probe.width;
  asset.sourceHeight = probe.height;
  asset.sourceFPS = probe.fps;
  asset.hasAudio = probe.hasAudio;
  asset.generationStatus = { kind: "none" };
  if (asset.hasAudio || asset.type === "audio") void ensureAudioProxy(path).catch(() => {}); // warm the preview audio proxy
  if (asset.type === "video") {
    void ensureThumbnail(path).catch(() => {}); // cheap — warm first so the library shows a real frame fast
    void ensureScrubProxy(path).catch(() => {}); // warm the scrub proxy (non-mp4 sources NEED it to preview at all)
  }
  ctx.doc.notifyChanged();
}

async function startGeneration(ctx: BridgeContext, kind: "image" | "video" | "audio", args: Args): Promise<ToolOut> {
  if (!ctx.canGenerate()) return fail("Higgsfield CLI is not authenticated. Run `higgsfield auth login`, then retry.");
  const prompt = strOpt(args.prompt);
  if (!prompt && kind !== "audio") return fail("prompt is required");

  let model = strOpt(args.model);
  if (!model) {
    if (kind === "audio") return fail("Specify a model for audio (see list_models type='audio').");
    const models = await listModels(kind);
    model = pickModel(models, kind === "image" ? IMAGE_PREFS : VIDEO_PREFS) ?? undefined;
  }
  if (!model) return fail(`No ${kind} models available from Higgsfield (is the CLI authenticated?).`);

  const params: Record<string, string | number> = {};
  if (strOpt(args.aspectRatio)) params.aspect_ratio = String(args.aspectRatio);
  if (strOpt(args.resolution)) params.resolution = String(args.resolution);
  if (strOpt(args.quality)) params.quality = String(args.quality);
  if (numOpt(args.duration) !== undefined) params.duration = numOpt(args.duration)!;
  if (strOpt(args.voice)) params.voice = String(args.voice);
  if (args.params && typeof args.params === "object" && !Array.isArray(args.params)) {
    Object.assign(params, args.params as Record<string, string | number>);
  }

  // Gather every reference image. One ref → the simple `--image` flag (auto-uploads). Two or more →
  // forward them all through the model's array param (resolved + uploaded in completeGeneration).
  const refKey = kind === "video" ? "referenceImageMediaRefs" : "referenceMediaRefs";
  const refList = Array.isArray(args[refKey]) ? (args[refKey] as unknown[]) : [];
  const refPaths = refList.map((r) => resolveRefPath(ctx.doc, r)).filter((p): p is string => !!p);
  const singleImage = refPaths.length === 1 ? refPaths[0] : undefined;

  const refs =
    kind === "video"
      ? {
          startImage: resolveRefPath(ctx.doc, args.startFrameMediaRef),
          endImage: resolveRefPath(ctx.doc, args.endFrameMediaRef),
          video: resolveRefPath(ctx.doc, args.sourceVideoMediaRef),
          image: singleImage,
        }
      : { image: singleImage };

  const name = strOpt(args.name) ?? (prompt ? prompt.slice(0, 30) : `${kind} generation`);
  const folderId = strOpt(args.folderId);
  const asset: MediaAsset = {
    id: newId("asset"),
    type: kind,
    name,
    durationSeconds: 0,
    hasAudio: kind === "video",
    folderId,
    generationStatus: { kind: "generating" },
    generationInput: { kind, prompt, model },
  };
  ctx.doc.addAsset(asset);
  ctx.doc.notifyChanged();

  void completeGeneration(ctx, asset, { model, prompt, params, ...refs }, refPaths.length > 1 ? refPaths : undefined);
  return ok(`Started ${kind} generation as ${asset.id} (model '${model}'). It runs in the background — resolves in get_media once ready; don't poll.`);
}

async function startUpscale(ctx: BridgeContext, args: Args): Promise<ToolOut> {
  if (!ctx.canGenerate()) return fail("Higgsfield CLI is not authenticated. Run `higgsfield auth login`, then retry.");
  const ref = strOpt(args.mediaRef);
  if (!ref) return fail("mediaRef is required");
  const src = ctx.doc.asset(ref);
  if (!src || !src.url) return fail(`Media asset not ready or not found: ${ref}`);

  const all = [...(await listModels("image")), ...(await listModels("video"))].filter((m) => /upscale/i.test(m.jobSetType));
  const model = strOpt(args.model) ?? all[0]?.jobSetType;
  if (!model) return fail("No upscaler model available from Higgsfield.");

  const asset: MediaAsset = {
    id: newId("asset"),
    type: src.type,
    name: `${src.name} (upscaled)`,
    durationSeconds: src.durationSeconds,
    hasAudio: src.hasAudio,
    folderId: src.folderId,
    generationStatus: { kind: "generating" },
    generationInput: { kind: "upscale", model, references: [ref] },
  };
  ctx.doc.addAsset(asset);
  ctx.doc.notifyChanged();

  const refs = src.type === "video" ? { video: src.url } : { image: src.url };
  void completeGeneration(ctx, asset, { model, ...refs });
  return ok(`Started upscale as ${asset.id} (model '${model}'). Resolves in get_media once ready.`);
}

/** Normalize a git-bash / msys path (/d/foo) to a Windows path (D:/foo) so ffmpeg/Bun can open it. */
function normalizeLocalPath(p: string | undefined): string | undefined {
  if (!p) return p;
  const m = p.match(/^\/([a-zA-Z])\/(.*)$/);
  return m ? `${m[1]!.toUpperCase()}:/${m[2]}` : p;
}

async function importMedia(ctx: BridgeContext, args: Args): Promise<ToolOut> {
  const source = args.source as Args | undefined;
  if (!source || typeof source !== "object") return fail("source object is required");
  const url = strOpt(source.url);
  const path = normalizeLocalPath(strOpt(source.path));
  const mimeType = strOpt(source.mimeType);
  const folderId = strOpt(args.folderId);
  if ((url ? 1 : 0) + (path ? 1 : 0) !== 1) return fail("source must set exactly one of url or path");

  if (path) {
    const type = inferType(path, mimeType);
    if (!type) return fail(`Unsupported or unknown media type for: ${path}`);
    const probe = await probeMedia(path);
    const asset: MediaAsset = {
      id: newId("asset"),
      type,
      name: strOpt(args.name) ?? path.split(/[\\/]/).pop() ?? "Imported asset",
      url: path,
      durationSeconds: probe.durationSeconds,
      sourceWidth: probe.width,
      sourceHeight: probe.height,
      sourceFPS: probe.fps,
      hasAudio: probe.hasAudio,
      folderId,
      generationStatus: { kind: "none" },
    };
    ctx.doc.addAsset(asset);
    ctx.doc.notifyChanged();
    return ok(`Imported ${asset.id} (${type}) from path.`);
  }

  // URL import runs in the background.
  const type = inferType(url!, mimeType) ?? "video";
  const asset: MediaAsset = {
    id: newId("asset"),
    type,
    name: strOpt(args.name) ?? (url!.split(/[?#]/)[0]?.split("/").pop() || "Imported asset"),
    durationSeconds: 0,
    hasAudio: type === "video",
    folderId,
    generationStatus: { kind: "downloading" },
    generationInput: { kind: "import" },
  };
  ctx.doc.addAsset(asset);
  ctx.doc.notifyChanged();
  void (async () => {
    const dest = mediaPathFor(guessExt(url!, type));
    if (!(await downloadToFile(url!, dest))) {
      asset.generationStatus = { kind: "failed", error: "download failed" };
      ctx.doc.notifyChanged();
      return;
    }
    asset.url = dest;
    const probe = await probeMedia(dest);
    if (probe.durationSeconds) asset.durationSeconds = probe.durationSeconds;
    asset.sourceWidth = probe.width;
    asset.sourceHeight = probe.height;
    asset.sourceFPS = probe.fps;
    asset.hasAudio = probe.hasAudio;
    asset.generationStatus = { kind: "none" };
    if (asset.hasAudio || type === "audio") void ensureAudioProxy(dest).catch(() => {}); // warm the preview audio proxy
    if (type === "video") {
      void ensureThumbnail(dest).catch(() => {}); // cheap — warm first so the library shows a real frame fast
      void ensureScrubProxy(dest).catch(() => {}); // warm the scrub proxy (non-mp4 sources NEED it to preview at all)
    }
    ctx.doc.notifyChanged();
  })();
  return ok(`Importing ${asset.id} (${type}) from URL in the background; resolves in get_media once ready.`);
}

async function listModelsTool(args: Args): Promise<ToolOut> {
  const single = strOpt(args.model);
  if (single) return okJson(await getModel(single));
  const type = strOpt(args.type);
  let models: HfModel[];
  if (type === "image" || type === "video") {
    models = await listModels(type);
  } else {
    // No flag → the CLI returns every model (image, video, audio, 3d, text); filter to the asked type.
    models = await listModels();
    if (type === "upscale") models = models.filter((m) => /upscale/i.test(m.jobSetType));
    else if (type) models = models.filter((m) => m.type === type);
  }
  return okJson({ models: models.map((m) => ({ id: m.jobSetType, name: m.displayName, type: m.type })) });
}

async function inspectMedia(doc: EditorDocument, args: Args): Promise<ToolOut> {
  const ref = strOpt(args.mediaRef);
  if (!ref) return fail("mediaRef is required");
  const a = doc.asset(ref);
  if (!a) return fail(`Media asset not found: ${ref}`);
  const out: Record<string, unknown> = {
    id: a.id,
    name: a.name,
    type: a.type,
    durationSeconds: a.durationSeconds,
    resolution: a.sourceWidth && a.sourceHeight ? { width: a.sourceWidth, height: a.sourceHeight } : undefined,
    fps: a.sourceFPS,
    hasAudio: a.hasAudio,
    generationStatus: a.generationStatus.kind,
  };
  // Visual frames so the agent can SEE the media (locate faces/eyes/subjects, verify look).
  const images: string[] = [];
  if (a.url && a.generationStatus.kind === "none") {
    if (a.type === "image") {
      const b = await frameToBase64(a.url, 0);
      if (b) images.push(b);
    } else if (a.type === "video") {
      const at = Array.isArray(args.atSeconds)
        ? (args.atSeconds as unknown[]).map(Number).filter((x) => Number.isFinite(x) && x >= 0)
        : null;
      if (at?.length) {
        // Targeted grabs — e.g. the sceneChanges from analyze_footage, giving one frame per shot.
        for (const t of at.slice(0, 12)) {
          const b = await frameToBase64(a.url, t);
          if (b) images.push(b);
        }
        out.frameTimesSeconds = at.slice(0, 12);
      } else {
        const dur = a.durationSeconds || 0;
        const startS = numOpt(args.startSeconds) ?? 0;
        const endS = numOpt(args.endSeconds) ?? dur;
        const span = Math.max(0.001, (endS > startS ? endS - startS : dur) || 1);
        const n = Math.min(8, Math.max(1, Math.round(numOpt(args.maxFrames) ?? 4)));
        for (let i = 0; i < n; i++) {
          const b = await frameToBase64(a.url, startS + (span * (i + 0.5)) / n);
        if (b) images.push(b);
        }
      }
    }
  }
  if ((a.type === "video" || a.type === "audio") && a.url) {
    try {
      const tr = await transcribe(a.url, strOpt(args.language));
      if (tr) {
        out.language = tr.language;
        out.transcriptFormat = ["text", "startSeconds", "endSeconds"];
        out.transcript = tr.segments.slice(0, 400).map((s) => [s.text, Math.round(s.start * 1000) / 1000, Math.round(s.end * 1000) / 1000]);
      }
    } catch {
      // Transcription unavailable (whisper not configured) — still return metadata + frames.
    }
  }
  const content: Block[] = [{ type: "text", text: JSON.stringify(out) }, ...images.map((d) => ({ type: "image" as const, data: d, mimeType: "image/jpeg" }))];
  return { content, isError: false };
}

async function searchMedia(doc: EditorDocument, args: Args): Promise<ToolOut> {
  const q = (strOpt(args.query) ?? "").toLowerCase().trim();
  const scope = strOpt(args.scope) ?? "both";
  const only = strOpt(args.mediaRef);
  // Token-based match: any meaningful query word hitting the searched text counts (with a small
  // bonus for the full phrase). Beats exact-substring — "beach sunset" finds a clip named cryptically
  // but generated from a "sunset over the beach" prompt.
  const STOP = new Set(["the", "a", "an", "of", "in", "on", "at", "to", "and", "or", "with", "for", "over", "un", "una", "il", "la", "di", "che", "con"]);
  const tokens = q.split(/[^\p{L}\p{N}]+/u).filter((t) => t.length > 2 && !STOP.has(t));
  const score = (text: string): number => {
    const t = text.toLowerCase();
    if (!q) return 0;
    let s = t.includes(q) ? 3 : 0;
    for (const tok of tokens) if (t.includes(tok)) s += 1;
    return s;
  };

  const visual =
    scope === "spoken"
      ? []
      : doc.project.media
          .filter((a) => !only || a.id === only)
          // Search the name AND the generation prompt (what the clip was made to depict) — the
          // closest thing to "visual content" available locally without an embedding model.
          .map((a) => ({ a, s: Math.max(score(a.name), score(a.generationInput?.prompt ?? "")) }))
          .filter((r) => r.s > 0)
          .sort((x, y) => y.s - x.s)
          .map((r) => ({ mediaRef: r.a.id, name: r.a.name, type: r.a.type, matchedPrompt: !!r.a.generationInput?.prompt && score(r.a.generationInput.prompt) >= score(r.a.name) }));

  const spoken: { mediaRef: string; startSeconds: number; endSeconds: number; text: string }[] = [];
  if (scope !== "visual" && q) {
    for (const a of doc.project.media) {
      if (only && a.id !== only) continue;
      if ((a.type !== "video" && a.type !== "audio") || !a.url) continue;
      const tr = await transcribe(a.url);
      if (!tr) continue;
      for (const seg of tr.segments) {
        if (score(seg.text) > 0) spoken.push({ mediaRef: a.id, startSeconds: seg.start, endSeconds: seg.end, text: seg.text });
      }
    }
  }
  return okJson({
    visual,
    spoken,
    note: "Visual = name + generation-prompt token match (ranked); spoken = on-device transcript token match. For visual find on non-AI footage, inspect_media lets you SEE candidate frames and pick.",
  });
}

/** Source-media seconds within a clip → project frame, or null if outside the visible range. */
function sourceToProjectFrame(clip: Clip, sourceSec: number, fps: number): number | null {
  const speed = clip.speed > 0 ? clip.speed : 1;
  const offset = sourceSec * fps - clip.trimStartFrame;
  if (offset < 0) return null;
  const proj = clip.startFrame + offset / speed;
  if (proj < clip.startFrame || proj >= clip.startFrame + clip.durationFrames) return null;
  return Math.round(proj);
}

function applyCase(text: string, mode?: string): string {
  if (mode === "upper") return text.toUpperCase();
  if (mode === "lower") return text.toLowerCase();
  return text;
}

function makeCaption(
  text: string,
  startFrame: number,
  durationFrames: number,
  groupId: string,
  style: { fontName: string; fontSize: number; color: string; highlightColor?: string },
  cx: number,
  cy: number,
  karaokeWords?: { word: string; startFrame: number; endFrame: number }[],
): Clip {
  return makeClip({
    mediaRef: "",
    mediaType: "text",
    sourceClipType: "text",
    startFrame,
    durationFrames,
    captionGroupId: groupId,
    textContent: text,
    textStyle: { fontName: style.fontName, fontSize: style.fontSize, color: style.color, alignment: "center", highlightColor: style.highlightColor },
    karaokeWords,
    transform: { centerX: cx, centerY: cy, width: 0.9, height: 0.2, rotation: 0, flipHorizontal: false, flipVertical: false },
  });
}

/** One karaoke cue's words in ABSOLUTE timeline frames (sf/ef), pre-chunked into lines. */
type KaraokeCueWords = { word: string; sf: number; ef: number }[];

/** Turn chunked cue word-groups into caption specs: each cue's line holds up to the next cue when
 * the gap is short (no flicker between lines), word times become clip-RELATIVE karaokeWords.
 * Shared by add_captions and translate_captions so the two karaoke paths can't drift apart. */
function karaokeCueSpecs(
  cues: KaraokeCueWords[],
  fps: number,
): { text: string; startFrame: number; durationFrames: number; words: { word: string; startFrame: number; endFrame: number }[] }[] {
  const specs: ReturnType<typeof karaokeCueSpecs> = [];
  for (let i = 0; i < cues.length; i++) {
    const ws = cues[i]!;
    if (!ws.length) continue;
    const cueStart = ws[0]!.sf;
    const lastEnd = ws[ws.length - 1]!.ef;
    const nextStart = i + 1 < cues.length ? cues[i + 1]![0]!.sf : null;
    // hold the line up to the next cue when the gap is short, otherwise a brief tail
    const cueEnd = nextStart != null && nextStart - lastEnd < fps * 0.8 ? nextStart : lastEnd + Math.round(fps * 0.2);
    const text = ws.map((x) => x.word).join(" ").trim();
    if (!text || cueEnd <= cueStart) continue;
    const words = ws.map((x) => ({
      word: x.word,
      startFrame: x.sf - cueStart,
      endFrame: Math.max(x.sf - cueStart + 1, Math.min(x.ef, cueEnd) - cueStart),
    }));
    specs.push({ text, startFrame: cueStart, durationFrames: Math.max(1, cueEnd - cueStart), words });
  }
  return specs;
}

/** Distribute a cue's [startFrame, endFrame) across its text's words PROPORTIONALLY to character
 * length — the timing approximation used when no real word timestamps exist (translated text:
 * whisper timed the SOURCE words, not the translation). Longer words hold the highlight longer;
 * every word gets at least one frame and offsets stay monotonic. */
function proportionalCueWords(text: string, startFrame: number, endFrame: number): KaraokeCueWords {
  const words = text.split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  const span = endFrame - startFrame;
  const totalChars = words.reduce((sum, w) => sum + w.length, 0) || words.length;
  const out: KaraokeCueWords = [];
  let chars = 0;
  let cursor = startFrame;
  for (const w of words) {
    chars += w.length;
    const ef = Math.max(cursor + 1, startFrame + Math.round((span * chars) / totalChars));
    out.push({ word: w, sf: cursor, ef });
    cursor = ef;
  }
  return out;
}

async function getTranscriptTool(doc: EditorDocument, args: Args): Promise<ToolOut> {
  const fps = doc.timeline.fps;
  const only = strOpt(args.clipId);
  type TWordRow = [string, number, number] | [string, number, number, string];
  const clips: { clipId: string; trackIndex: number; words: TWordRow[] }[] = [];
  let anySpeakers = false;
  for (let ti = 0; ti < doc.timeline.tracks.length; ti++) {
    for (const c of doc.timeline.tracks[ti]!.clips) {
      if (c.mediaType !== "video" && c.mediaType !== "audio") continue;
      if (only && c.id !== only) continue;
      const asset = doc.asset(c.mediaRef);
      if (!asset?.url) continue;
      const tr = await transcribe(asset.url, strOpt(args.language));
      if (!tr) continue;
      // Speaker tags come ONLY from an earlier explicit identify_speakers run (cached per path) —
      // diarization is slow, so a plain transcript read must never trigger it.
      const diar = cachedDiarization(asset.url);
      const words: TWordRow[] = [];
      for (const w of tr.words) {
        const sf = sourceToProjectFrame(c, w.start, fps);
        if (sf == null) continue;
        const ef = sourceToProjectFrame(c, w.end, fps) ?? sf;
        const speaker = diar ? speakerAt(diar, (w.start + w.end) / 2) : undefined;
        if (speaker) {
          words.push([w.word, sf, ef, speaker]);
          anySpeakers = true;
        } else {
          words.push([w.word, sf, ef]);
        }
      }
      if (words.length) clips.push({ clipId: c.id, trackIndex: ti, words });
    }
  }
  clips.sort((a, b) => (a.words[0]?.[1] ?? 0) - (b.words[0]?.[1] ?? 0));
  const wordFormat = anySpeakers ? ["text", "startFrame", "endFrame", "speaker?"] : ["text", "startFrame", "endFrame"];
  return okJson({ wordFormat, clips });
}

async function addCaptionsTool(doc: EditorDocument, args: Args): Promise<ToolOut> {
  const fps = doc.timeline.fps;
  const language = strOpt(args.language);
  let clipIds = (Array.isArray(args.clipIds) ? args.clipIds : []).filter((x): x is string => typeof x === "string");

  if (clipIds.length === 0) {
    let best: { id: string; count: number } | null = null;
    for (const t of doc.timeline.tracks) {
      for (const c of t.clips) {
        if (c.mediaType !== "video" && c.mediaType !== "audio") continue;
        const asset = doc.asset(c.mediaRef);
        if (!asset?.url) continue;
        const tr = await transcribe(asset.url, language);
        if (tr && (!best || tr.segments.length > best.count)) best = { id: c.id, count: tr.segments.length };
      }
    }
    if (best) clipIds = [best.id];
  }
  if (clipIds.length === 0) return fail("No audio/video clips to caption.");

  const cx = numOpt(args.centerX) ?? 0.5;
  const cy = numOpt(args.centerY) ?? 0.9;
  const groupId = newId("cap");
  const wordsPerCue = numOpt(args.wordsPerCue);
  const karaoke = args.karaoke === true || (wordsPerCue !== undefined && wordsPerCue > 0);
  const style = {
    fontName: strOpt(args.fontName) ?? "Helvetica-Bold",
    fontSize: numOpt(args.fontSize) ?? 48,
    color: strOpt(args.color) ?? "#ffffff",
    highlightColor: karaoke ? (strOpt(args.highlightColor) ?? "#FFD400") : undefined,
  };
  const captions: Clip[] = [];

  for (const id of clipIds) {
    const loc = doc.findClip(id);
    if (!loc) continue;
    const c = doc.timeline.tracks[loc.trackIndex]!.clips[loc.clipIndex]!;
    const asset = doc.asset(c.mediaRef);
    if (!asset?.url) continue;
    const tr = await transcribe(asset.url, language);
    if (!tr) continue;
    if (karaoke && Array.isArray(tr.words) && tr.words.length) {
      // Karaoke: cues of a few words each; the whole cue line stays on screen and the word being
      // spoken is tinted via textStyle.highlightColor + per-word karaokeWords timing (relative
      // frames). Preview tints live; export burns the same timing through libass \k. Cues break
      // on pauses so a line never spans a long gap.
      const n = Math.max(1, Math.round(wordsPerCue ?? 4));
      const textCase = strOpt(args.textCase);
      const cues: KaraokeCueWords[] = [];
      let cur: KaraokeCueWords = [];
      let prevEndSec = 0;
      for (const w of tr.words) {
        const sf = sourceToProjectFrame(c, w.start, fps);
        if (sf == null) {
          if (cur.length) cues.push(cur);
          cur = [];
          continue;
        }
        const ef = sourceToProjectFrame(c, w.end, fps) ?? sf + Math.round(fps / 4);
        if (cur.length && (cur.length >= n || w.start - prevEndSec > 1.2)) {
          cues.push(cur);
          cur = [];
        }
        cur.push({ word: applyCase(w.word, textCase), sf, ef: Math.max(sf + 1, ef) });
        prevEndSec = w.end;
      }
      if (cur.length) cues.push(cur);
      for (const spec of karaokeCueSpecs(cues, fps)) {
        captions.push(makeCaption(spec.text, spec.startFrame, spec.durationFrames, groupId, style, cx, cy, spec.words));
      }
    } else {
      for (const seg of tr.segments) {
        const sf = sourceToProjectFrame(c, seg.start, fps);
        if (sf == null) continue;
        const ef = sourceToProjectFrame(c, seg.end, fps) ?? sf + fps;
        const text = applyCase(seg.text, strOpt(args.textCase));
        if (!text) continue;
        captions.push(makeCaption(text, sf, Math.max(1, ef - sf), groupId, style, cx, cy));
      }
    }
  }
  if (captions.length === 0) return fail("No speech detected to caption.");

  doc.mutate("Add Captions", "agent", () => {
    const idx = doc.insertTrack(0, "video");
    const track = doc.timeline.tracks[idx]!;
    track.clips.push(...captions);
    track.clips.sort((a, b) => a.startFrame - b.startFrame);
  });
  return ok(`Added ${captions.length} caption clip${captions.length === 1 ? "" : "s"} on a new track (group ${groupId}).`);
}

// ── Named version snapshots ───────────────────────────────────────────────────
// The safety net that makes autonomous agent editing trustworthy: checkpoint the whole project
// under a name before/after big operations, revert to any of them later. Stored as full project
// JSON files under <project>/.cupcat/versions/.

const versionsDir = () => join(projectRoot, ".cupcat", "versions");
const versionSafe = (name: string) => name.replace(/[^\p{L}\p{N} _-]/gu, "").trim().replace(/\s+/g, "-").slice(0, 60) || "version";

async function saveVersionTool(doc: EditorDocument, args: Args): Promise<ToolOut> {
  const name = versionSafe(strOpt(args.name) ?? "checkpoint");
  const stamp = new Date().toISOString().replace(/[:T]/g, "-").slice(0, 19);
  const file = join(versionsDir(), `${stamp}_${name}.json`);
  await mkdir(versionsDir(), { recursive: true });
  await Bun.write(file, JSON.stringify(doc.project));
  return ok(`Saved version "${name}" (${stamp}). Restore it anytime with restore_version.`);
}

async function listVersionsTool(): Promise<ToolOut> {
  try {
    const files = (await readdir(versionsDir())).filter((f) => f.endsWith(".json")).sort();
    if (!files.length) return ok("No saved versions yet — save_version creates one.");
    return okJson({ versions: files.map((f) => f.replace(/\.json$/, "")) });
  } catch {
    return ok("No saved versions yet — save_version creates one.");
  }
}

async function restoreVersionTool(ctx: BridgeContext, args: Args): Promise<ToolOut> {
  const want = strOpt(args.name);
  if (!want) return fail("name is required (from list_versions).");
  let files: string[] = [];
  try {
    files = (await readdir(versionsDir())).filter((f) => f.endsWith(".json")).sort();
  } catch {
    return fail("No saved versions exist.");
  }
  const match = files.filter((f) => f.replace(/\.json$/, "").includes(want));
  if (!match.length) return fail(`No version matches "${want}". Available: ${files.map((f) => f.replace(/\.json$/, "")).join(", ") || "none"}`);
  const chosen = match[match.length - 1]!; // newest match wins
  const raw = await Bun.file(join(versionsDir(), chosen)).json();
  ctx.doc.reset(raw as Project);
  await saveProject(ctx.doc.project);
  return ok(`Restored version ${chosen.replace(/\.json$/, "")}. The timeline now matches that snapshot (undo history was reset).`);
}

/** AI motion graphics: Claude designs a self-contained HTML/CSS animation, Edge headless renders
 * it to transparent frames, ffmpeg packs a VP9-alpha WebM, and it lands on a new top track as a
 * normal overlay clip. The HTML source is saved next to the asset for later re-edits. */
// make_transition — a GENERATIVE transition: Claude writes a full-frame alpha animation (light
// leak, glitch sweep, ink bleed, shape wipe…) that starts and ends transparent, and it's placed
// centered on a cut so it masks the hard edit. Reuses the motion-graphics engine (local, free);
// the .mg.html is saved for re-edits, so any transition becomes a reusable, tweakable asset.
async function makeTransitionTool(ctx: BridgeContext, args: Args, source: EditSource): Promise<ToolOut> {
  const doc = ctx.doc;
  const clipId = strOpt(args.clipId);
  if (!clipId) return fail("clipId is required — the transition plays over the cut at the END of this clip.");
  let clip: Clip | undefined;
  for (const t of doc.timeline.tracks) {
    const c = t.clips.find((x) => x.id === clipId);
    if (c) {
      clip = c;
      break;
    }
  }
  if (!clip) return fail(`Clip not found: ${clipId}`);
  const style = strOpt(args.prompt) ?? strOpt(args.style) ?? "a soft white light-leak sweep";
  const dur = Math.min(3, Math.max(0.3, numOpt(args.durationSeconds) ?? 0.8));
  const canvas = { width: doc.timeline.width, height: doc.timeline.height, fps: doc.timeline.fps };
  const transitionPrompt =
    `A full-frame VIDEO TRANSITION overlay: ${style}. ` +
    `It MUST begin 100% transparent, animate across the whole frame to briefly cover it, then return to 100% transparent by the end — so it masks a hard cut between two shots. ` +
    `Transparent background (no solid fill). Duration ${dur}s, smooth easing. No text unless the description asks for it.`;
  let rendered: { path: string; htmlPath: string; durationSeconds: number };
  try {
    rendered = await renderMotionGraphic(
      { prompt: transitionPrompt, html: strOpt(args.html), durationSeconds: dur, name: strOpt(args.name) ?? "transition" },
      canvas,
    );
  } catch (e) {
    return fail(e instanceof Error ? e.message : String(e));
  }
  const imported = await executeTool(ctx, "import_media", { source: { path: rendered.path } }, source);
  if (imported.isError) return imported;
  let asset: MediaAsset | undefined;
  for (let i = doc.project.media.length - 1; i >= 0; i--) {
    if (doc.project.media[i]!.url === rendered.path) {
      asset = doc.project.media[i];
      break;
    }
  }
  if (!asset) return fail("Rendered transition did not import.");
  const cutFrame = clipEndFrame(clip);
  const durFrames = Math.max(1, Math.round(rendered.durationSeconds * doc.timeline.fps));
  const startFrame = Math.max(0, cutFrame - Math.round(durFrames / 2));
  const placed = TIMELINE_COMMANDS.add_clips!(doc, { entries: [{ mediaRef: asset.id, startFrame, durationFrames: durFrames }] }, source);
  await saveProject(doc.project);
  return ok(
    `Transition ready: ${asset.id} (${rendered.durationSeconds}s alpha overlay) placed over the cut at frame ${cutFrame}, on a new top track. ` +
      `Source HTML saved at ${rendered.htmlPath} — describe a change to re-render, or reuse this asset on other cuts. ${placed}`,
  );
}

async function saveTemplateTool(ctx: BridgeContext, args: Args): Promise<ToolOut> {
  const name = strOpt(args.name);
  if (!name) return fail("name is required (what to call this template).");
  if (ctx.doc.timeline.tracks.every((t) => t.clips.length === 0)) return fail("The timeline is empty — nothing to save as a template.");
  try {
    const r = await saveTemplate(ctx.doc, name);
    return ok(`Template "${r.name}" saved (${r.visualSlots} video/image slot${r.visualSlots === 1 ? "" : "s"}, ${r.audioSlots} audio slot${r.audioSlots === 1 ? "" : "s"}). Apply it to any project with apply_template.`);
  } catch (e) {
    return fail(`save_template failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}

async function applyTemplateTool(ctx: BridgeContext, args: Args, source: EditSource): Promise<ToolOut> {
  const name = strOpt(args.name);
  if (!name) return fail("name is required (the template to apply — see list_templates).");
  const visual = Array.isArray(args.visualRefs) ? (args.visualRefs as unknown[]).map(String).filter(Boolean) : [];
  const audio = Array.isArray(args.audioRefs) ? (args.audioRefs as unknown[]).map(String).filter(Boolean) : [];
  // If no explicit fills, draw from the library by type (in library order).
  if (visual.length === 0 && audio.length === 0) {
    for (const m of ctx.doc.project.media) {
      if (m.generationStatus.kind !== "none") continue;
      if (m.type === "audio") audio.push(m.id);
      else if (m.type === "video" || m.type === "image") visual.push(m.id);
    }
  }
  try {
    const r = await applyTemplate(ctx.doc, name, { visual, audio }, source === "agent" ? "agent" : "user");
    await saveProject(ctx.doc.project);
    const empty = r.emptySlots > 0 ? ` ${r.emptySlots} slot(s) left empty (placeholder clips) — fill them by dropping media on those clips.` : "";
    return ok(`Applied template "${r.name}": filled ${r.visualUsed}/${r.visualSlots} visual and ${r.audioUsed}/${r.audioSlots} audio slots.${empty}`);
  } catch (e) {
    return fail(`apply_template failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}

async function listTemplatesTool(): Promise<ToolOut> {
  const list = await listTemplates();
  if (list.length === 0) return ok("No templates saved yet. Build a timeline you like, then save_template to reuse its structure.");
  return ok(list.map((t) => `• ${t.name} — ${t.visualSlots} visual + ${t.audioSlots} audio slot(s)`).join("\n"));
}

async function addMotionGraphicTool(ctx: BridgeContext, args: Args, source: EditSource): Promise<ToolOut> {
  const doc = ctx.doc;
  const canvas = { width: doc.timeline.width, height: doc.timeline.height, fps: doc.timeline.fps };
  let rendered: { path: string; htmlPath: string; durationSeconds: number };
  try {
    rendered = await renderMotionGraphic(
      { prompt: strOpt(args.prompt), html: strOpt(args.html), durationSeconds: numOpt(args.durationSeconds), name: strOpt(args.name) },
      canvas,
    );
  } catch (e) {
    return fail(e instanceof Error ? e.message : String(e));
  }
  const imported = await executeTool(ctx, "import_media", { source: { path: rendered.path } }, source);
  if (imported.isError) return imported;
  let asset: MediaAsset | undefined;
  for (let i = doc.project.media.length - 1; i >= 0; i--) {
    if (doc.project.media[i]!.url === rendered.path) {
      asset = doc.project.media[i];
      break;
    }
  }
  if (!asset) return fail("Rendered clip did not import.");
  const startFrame = Math.max(0, Math.round(numOpt(args.startFrame) ?? 0));
  const durationFrames = Math.max(1, Math.round(rendered.durationSeconds * doc.timeline.fps));
  const placed = TIMELINE_COMMANDS.add_clips!(doc, { entries: [{ mediaRef: asset.id, startFrame, durationFrames }] }, source);
  return ok(
    `Motion graphic ready: ${asset.id} placed at frame ${startFrame} for ${rendered.durationSeconds}s (transparent overlay on a new top track). ` +
      `Source HTML saved at ${rendered.htmlPath} — to tweak it, describe the change and call add_motion_graphic again (or pass edited html). ${placed}`,
  );
}

/** Import an existing SRT/WebVTT subtitle file as caption clips (the counterpart of
 * translate_captions mode:'srt'). Times are TIMELINE seconds — the file is assumed authored
 * against the current cut. */
async function importCaptionsTool(doc: EditorDocument, args: Args): Promise<ToolOut> {
  const path = strOpt(args.path);
  if (!path) return fail("path is required (an .srt or .vtt file).");
  const f = Bun.file(path);
  if (!(await f.exists())) return fail(`File not found: ${path}`);
  const cues = parseSubtitles(await f.text());
  if (!cues.length) return fail("No cues found — is this a valid SRT/VTT file?");
  const fps = doc.timeline.fps;
  const style = {
    fontName: strOpt(args.fontName) ?? "Helvetica-Bold",
    fontSize: numOpt(args.fontSize) ?? 48,
    color: strOpt(args.color) ?? "#ffffff",
  };
  const cx = numOpt(args.centerX) ?? 0.5;
  const cy = numOpt(args.centerY) ?? 0.9;
  const groupId = newId("cap");
  const captions = cues.map((c) => {
    const sf = Math.round(c.startSeconds * fps);
    const ef = Math.max(sf + 1, Math.round(c.endSeconds * fps));
    return makeCaption(c.text, sf, ef - sf, groupId, style, cx, cy);
  });
  doc.mutate("Import Captions", "agent", () => {
    const idx = doc.insertTrack(0, "video");
    const track = doc.timeline.tracks[idx]!;
    track.clips.push(...captions);
    track.clips.sort((a, b) => a.startFrame - b.startFrame);
  });
  return ok(`Imported ${captions.length} caption clips from ${path.split(/[\\/]/).pop()} (group ${groupId}).`);
}

async function inspectTimeline(doc: EditorDocument, args: Args): Promise<ToolOut> {
  const start = Math.max(0, numOpt(args.startFrame) ?? 0);
  const end = numOpt(args.endFrame);
  const maxFrames = Math.min(12, Math.max(1, numOpt(args.maxFrames) ?? 6));
  let frames: number[];
  if (end !== undefined && end > start) {
    const step = (end - start) / maxFrames;
    frames = Array.from({ length: maxFrames }, (_, i) => Math.round(start + i * step));
  } else {
    frames = [start];
  }
  const images = await renderFrames(doc, frames);
  if (images.length === 0) return fail("Could not render the timeline (empty, or clips still generating?).");
  return okImages(images, `Composited timeline frame(s) at ${frames.join(", ")} (project frames).`);
}

async function detectSilence(doc: EditorDocument, args: Args): Promise<ToolOut> {
  const ref = strOpt(args.mediaRef);
  if (!ref) return fail("mediaRef is required");
  const a = doc.asset(ref);
  if (!a?.url) return fail(`Media asset not found or not ready: ${ref}`);
  const noiseDb = numOpt(args.thresholdDb) ?? -30;
  const minDur = numOpt(args.minSilenceSeconds) ?? 0.6;
  // Margin (à la auto-editor): shrink every silence range on both sides so the cut keeps a small
  // breath of space around speech. Cutting flush against the detected boundary clips the attack of
  // the next word and the tail of the previous one — the result feels choppy even when technically
  // correct. Callers can pass 0 to cut flush.
  const pad = Math.max(0, numOpt(args.padSeconds) ?? 0.1);
  // Smoothing (à la auto-editor's minclip): a sub-minKeep blip of "speech" sandwiched between two
  // silences is almost always a breath/click, not a word — keeping it produces a flash-frame cut.
  // Merge across it so the blip is removed together with the surrounding dead air.
  const minKeep = Math.max(0, numOpt(args.minKeepSeconds) ?? 0.15);
  const fps = doc.timeline.fps;
  const assetDur = a.durationSeconds ?? Number.POSITIVE_INFINITY;
  const raw = await audioSilences(a.url, noiseDb, minDur);
  const merged: typeof raw = [];
  for (const r of raw) {
    const prev = merged[merged.length - 1];
    if (prev && r.startSeconds - prev.endSeconds < minKeep) prev.endSeconds = r.endSeconds;
    else merged.push({ ...r });
  }
  let ranges = merged
    // Pad only INTERIOR boundaries: a silence starting at 0 (or ending at the file's end) has no
    // speech beside it to protect — padding there just strands a tiny unremovable sliver at the edge.
    .map((r) => ({
      startSeconds: r.startSeconds <= 0.05 ? r.startSeconds : r.startSeconds + pad,
      endSeconds: r.endSeconds >= assetDur - 0.05 ? r.endSeconds : r.endSeconds - pad,
    }))
    .filter((r) => r.endSeconds - r.startSeconds > 0.05);
  // Speech guard: when a transcript is available, no cut range may swallow spoken WORDS — an
  // over-eager threshold (quiet speech misread as "silence") gets trimmed back to the actual gaps.
  let speechTrimmed = 0;
  try {
    const tr = await transcribe(a.url);
    if (tr?.words?.length) {
      const guarded: typeof ranges = [];
      for (const r of ranges) {
        let cur = { ...r };
        let dropped = false;
        for (const w of tr.words) {
          if (w.end <= cur.startSeconds || w.start >= cur.endSeconds) continue;
          speechTrimmed++;
          // A word overlaps the range: keep only the silent part before the word (if meaningful),
          // and continue scanning with the part after it.
          if (w.start - cur.startSeconds > 0.3) guarded.push({ startSeconds: cur.startSeconds, endSeconds: w.start - 0.05 });
          if (cur.endSeconds - w.end > 0.3) {
            cur = { startSeconds: w.end + 0.05, endSeconds: cur.endSeconds };
          } else {
            dropped = true;
            break;
          }
        }
        if (!dropped) guarded.push(cur);
      }
      ranges = guarded.filter((r) => r.endSeconds - r.startSeconds > 0.05);
    }
  } catch {
    // No transcript (whisper unavailable) — silence detection stands on its own.
  }
  return okJson({
    fps,
    padSeconds: pad,
    count: ranges.length,
    ...(speechTrimmed > 0 ? { speechGuard: `${speechTrimmed} range(s) trimmed/dropped because transcript words fell inside them — the threshold was catching quiet speech.` } : {}),
    silences: ranges.map((r) => ({
      startSeconds: Math.round(r.startSeconds * 1000) / 1000,
      endSeconds: Math.round(r.endSeconds * 1000) / 1000,
      startFrame: Math.round(r.startSeconds * fps),
      endFrame: Math.round(r.endSeconds * fps),
    })),
    note: "Ranges are already shrunk by padSeconds on each side (a margin so cuts don't clip word attacks) and verified against the transcript when available (no spoken words inside them). To cut this dead air, call ripple_delete_ranges with units:'seconds', the timeline clipId, and these startSeconds/endSeconds pairs as ranges — it maps source→timeline (honoring trim/speed) and ripples the clip's linked audio in sync. Do NOT convert to frames or add the clip's startFrame yourself; passing the source frames as units:'frames' will cut the wrong part of the timeline.",
  });
}

async function analyzeFootageTool(doc: EditorDocument, args: Args): Promise<ToolOut> {
  const ref = strOpt(args.mediaRef);
  if (!ref) return fail("mediaRef is required");
  const a = doc.asset(ref);
  if (!a?.url) return fail(`Media asset not found or not ready: ${ref}`);
  if (a.type !== "video") return fail("analyze_footage needs a video asset.");
  const res = await analyzeVideo(a.url, { sceneThreshold: numOpt(args.sceneThreshold) });
  const fps = doc.timeline.fps;
  const r3 = (n: number) => Math.round(n * 1000) / 1000;
  return okJson({
    fps,
    blackRanges: res.blackRanges.map((r) => ({ startSeconds: r3(r.startSeconds), endSeconds: r3(r.endSeconds) })),
    freezeRanges: res.freezeRanges.map((r) => ({ startSeconds: r3(r.startSeconds), endSeconds: r3(r.endSeconds) })),
    sceneChanges: res.sceneChanges.map(r3),
    note: "All times are SOURCE seconds. blackRanges = fully black picture (dead intros/outros — usually cut them via ripple_delete_ranges units:'seconds'); freezeRanges = frozen/static picture (no motion — candidates for cutting or speeding up); sceneChanges = where the shot visibly changes (natural split points: pass them to split_clip after converting source→timeline position, or cut per-scene).",
  });
}

const FILLER_WORDS = new Set([
  "um", "umm", "uh", "uhh", "uhm", "er", "err", "ah", "ahh", "hmm", "mm", "mhm", "like", "actually", "basically", "literally",
  "ehm", "eh", "mmm", "cioè", "tipo", "insomma", "praticamente", "allora", "ecco", "diciamo", "niente",
]);

async function removeWords(doc: EditorDocument, args: Args): Promise<ToolOut> {
  const clipId = strOpt(args.clipId);
  if (!clipId) return fail("clipId is required");
  const loc = doc.findClip(clipId);
  if (!loc) return fail(`Clip not found: ${clipId}`);
  const c = doc.timeline.tracks[loc.trackIndex]!.clips[loc.clipIndex]!;
  const a = c.mediaRef ? doc.asset(c.mediaRef) : null;
  if (!a?.url) return fail(`Clip ${clipId} has no ready media.`);

  const norm = (w: string) => w.toLowerCase().replace(/[^\p{L}\p{N}']/gu, "");
  const explicit = Array.isArray(args.words) ? (args.words as unknown[]).map((w) => norm(String(w))).filter(Boolean) : [];
  const useFillers = args.fillers === true || explicit.length === 0;
  const targets = new Set(explicit);

  let tr;
  try {
    tr = await transcribe(a.url, strOpt(args.language));
  } catch {
    return fail("Transcription unavailable (whisper not configured).");
  }
  if (!tr?.words?.length) return fail("No transcript words found for this clip.");

  const fps = doc.timeline.fps;
  const ss = (c.trimStartFrame ?? 0) / fps;
  const dur = c.durationFrames / fps;
  const inClip = tr.words.filter((w) => w.end >= ss && w.start <= ss + dur);
  const matched: { word: string; start: number; end: number }[] = [];
  for (const w of inClip) {
    const n = norm(w.word);
    if (!n) continue;
    if (useFillers ? FILLER_WORDS.has(n) || targets.has(n) : targets.has(n)) {
      matched.push({ word: w.word, start: w.start, end: w.end });
    }
  }
  // Stutter/word-restart detection (opt-in): a word immediately repeated ("the the") or restarted
  // ("compl- completely") within a short gap. Delete the EARLIER occurrence and keep the later one —
  // the re-said word is the one the speaker meant to land.
  let stutterCount = 0;
  if (args.stutters === true) {
    for (let i = 0; i + 1 < inClip.length; i++) {
      const cur = norm(inClip[i]!.word);
      const next = norm(inClip[i + 1]!.word);
      if (!cur || !next) continue;
      const gap = inClip[i + 1]!.start - inClip[i]!.end;
      if (gap > 0.6) continue;
      const isRepeat = cur === next;
      const isRestart = cur.length >= 2 && cur.length < next.length && next.startsWith(cur);
      if (isRepeat || isRestart) {
        matched.push({ word: inClip[i]!.word, start: inClip[i]!.start, end: Math.min(inClip[i + 1]!.start, inClip[i]!.end + gap) });
        stutterCount++;
      }
    }
  }
  // Retake / broken-sentence detection (opt-in, HIGH-risk tier — whole sentences get cut).
  let retakeCount = 0;
  if (args.retakes === true) {
    for (const r of detectRetakes(inClip)) {
      matched.push({ word: `[retake: "${r.text.slice(0, 40)}"]`, start: r.start, end: r.end });
      retakeCount++;
    }
  }
  const looked = `${useFillers ? `filler words${explicit.length ? ` + ${explicit.join(", ")}` : ""}` : explicit.join(", ")}${args.stutters === true ? " + stutters" : ""}${args.retakes === true ? " + retakes" : ""}`;
  if (matched.length === 0) return ok(`No matching words to remove (looked for: ${looked}).`);

  // ripple_delete_ranges expects [start, end] tuples; word times are source seconds.
  const ranges = matched.map((m) => [m.start, m.end]);
  const result = TIMELINE_COMMANDS.ripple_delete_ranges(doc, { clipId, units: "seconds", ranges }, "agent");
  const list = matched.map((m) => m.word).slice(0, 12).join(", ");
  return ok(`Removed ${matched.length} word(s) [${list}${matched.length > 12 ? "…" : ""}]. ${result}`);
}

async function mergeClips(doc: EditorDocument, _args: Args): Promise<ToolOut> {
  // The render below composites the MAIN timeline; with a compound view open, the clip walk and
  // the replacement would target the sub-timeline instead — refuse rather than mixing the two.
  if (doc.activeCompound) return fail("A compound is open — call close_compound first, then merge_clips (it flattens the MAIN timeline).");
  const fps = doc.timeline.fps;
  let total = 0;
  let clipCount = 0;
  for (const t of doc.timeline.tracks)
    for (const c of t.clips) {
      total = Math.max(total, c.startFrame + c.durationFrames);
      clipCount++;
    }
  if (total <= 0 || clipCount === 0) return fail("Timeline is empty — nothing to merge.");
  if (clipCount === 1) return ok("The timeline is already a single clip.");

  // Render the whole composited timeline (all tracks/segments/overlays) to one file…
  const render = await exportTimeline(doc, "merged.mp4", "mp4_h264", "high");
  if (!render.ok || !render.path) return fail(`Merge failed while rendering: ${render.error ?? "unknown error"}`);
  // …copy it into the media library and probe it…
  const dest = mediaPathFor("mp4");
  await Bun.write(dest, Bun.file(render.path));
  const probe = await probeMedia(dest);
  const dur = probe.durationSeconds ? Math.max(1, Math.round(probe.durationSeconds * fps)) : total;
  const asset: MediaAsset = {
    id: newId("asset"),
    type: "video",
    name: "Merged clip",
    url: dest,
    durationSeconds: probe.durationSeconds ?? total / fps,
    sourceWidth: probe.width,
    sourceHeight: probe.height,
    sourceFPS: probe.fps,
    hasAudio: probe.hasAudio,
    generationStatus: { kind: "none" },
  };
  doc.addAsset(asset);
  // …then replace the whole timeline with that one clip (+ its linked audio). No cuts remain.
  doc.mutate("Merge into one clip", "agent", () => {
    doc.timeline.tracks.length = 0;
  });
  TIMELINE_COMMANDS.add_clips(doc, { entries: [{ mediaRef: asset.id, startFrame: 0, durationFrames: dur }] }, "agent");
  void ensureAudioProxy(dest).catch(() => {});
  return ok(
    `Merged ${clipCount} clips into a single ${(dur / fps).toFixed(1)}s clip (${asset.id}). The timeline is now one continuous clip — no cuts, no black frames between segments.`,
  );
}

async function timelineView(doc: EditorDocument, args: Args): Promise<ToolOut> {
  // Pick the clip: explicit clipId, else the first audio/video clip on the timeline.
  let clipId = strOpt(args.clipId);
  if (!clipId) {
    outer: for (const t of doc.timeline.tracks) {
      for (const c of t.clips) {
        const a = c.mediaRef ? doc.asset(c.mediaRef) : null;
        if (a && (a.type === "video" || a.type === "audio")) {
          clipId = c.id;
          break outer;
        }
      }
    }
  }
  if (!clipId) return fail("No clipId given and no audio/video clip on the timeline to inspect.");
  const loc = doc.findClip(clipId);
  if (!loc) return fail(`Clip not found: ${clipId}`);
  const c = doc.timeline.tracks[loc.trackIndex]!.clips[loc.clipIndex]!;
  const a = c.mediaRef ? doc.asset(c.mediaRef) : null;
  if (!a?.url) return fail(`Clip ${clipId} has no ready media.`);
  const hasVideo = a.type === "video";
  const hasAudio = a.type === "video" || a.type === "audio";
  if (!hasVideo && !hasAudio) return fail("timeline_view only works on video or audio clips.");
  const fps = doc.timeline.fps;
  const ss = (c.trimStartFrame ?? 0) / fps;
  const dur = Math.max(0.1, c.durationFrames / fps);

  const words: { word: string; start: number; end: number }[] = [];
  if (hasAudio) {
    try {
      const tr = await transcribe(a.url, strOpt(args.language));
      for (const w of tr?.words ?? []) {
        if (w.end < ss || w.start > ss + dur) continue;
        words.push({ word: w.word, start: w.start - ss, end: w.end - ss });
      }
    } catch {
      // No transcript (whisper unavailable) — still render filmstrip + waveform + silence markers.
    }
  }
  const silences: { start: number; end: number }[] = [];
  if (hasAudio) {
    const noiseDb = numOpt(args.thresholdDb) ?? -30;
    const minDur = numOpt(args.minSilenceSeconds) ?? 0.4;
    for (const r of await audioSilences(a.url, noiseDb, minDur)) {
      if (r.endSeconds < ss || r.startSeconds > ss + dur) continue;
      silences.push({ start: Math.max(0, r.startSeconds - ss), end: Math.min(dur, r.endSeconds - ss) });
    }
  }
  const dest = join(exportsDir, `_tlview_${clipId}.jpg`); // jpg — chat-bound image, see frameToBase64's 413 note
  const ok = await renderTimelineView(a.url, ss, dur, hasVideo, hasAudio, words, silences, dest);
  if (!ok) return fail("Could not render the timeline view (ffmpeg failed).");
  const b64 = Buffer.from(await Bun.file(dest).arrayBuffer()).toString("base64");
  const note =
    `timeline_view of clip ${clipId} — ${dur.toFixed(1)}s, ${words.length} words, ${silences.length} silence region(s). ` +
    `Filmstrip on top, waveform below; RED overlay = silence = cut candidate; yellow = transcript words; vertical lines = the seconds ruler. ` +
    `To remove the dead air, call ripple_delete_ranges with units:'seconds', clipId:'${clipId}', and the red regions' second-ranges.`;
  return okImages([b64], note);
}

async function inspectColor(doc: EditorDocument, args: Args): Promise<ToolOut> {
  const clipId = strOpt(args.clipId);
  if (!clipId) return fail("clipId is required");
  const loc = doc.findClip(clipId);
  if (!loc) return fail(`Clip not found: ${clipId}`);
  const c = doc.timeline.tracks[loc.trackIndex]!.clips[loc.clipIndex]!;
  const rel = numOpt(args.atFrame);
  const frame = c.startFrame + Math.min(c.durationFrames - 1, Math.max(0, rel ?? Math.floor(c.durationFrames / 2)));
  const { b64, scopes } = await renderFrameAndScopes(doc, frame);
  if (!b64) return fail("Could not render the clip's graded frame.");
  const grade = c.color ? JSON.stringify(c.color) : "neutral";
  const fx = c.effects?.length ? c.effects.map((e) => e.type).join(", ") : "none";
  const scopeNote = scopes ? ` Scopes (luma/sat/warm-cool/clipping): ${JSON.stringify(scopes)}` : "";
  return okImages([b64], `Graded look of ${clipId} @ frame ${frame}. Grade: ${grade}. Effects: ${fx}.${scopeNote}`);
}

async function captureFrame(ctx: BridgeContext, args: Args): Promise<ToolOut> {
  const frame = Math.max(0, Math.round(numOpt(args.atFrame) ?? 0));
  const dest = mediaPathFor("png");
  if (!(await renderFrameToFile(ctx.doc, frame, dest))) return fail("Could not render the frame (is the timeline empty there?).");
  const probe = await probeMedia(dest);
  const asset: MediaAsset = {
    id: newId("asset"),
    type: "image",
    name: `Frame ${frame}`,
    url: dest,
    durationSeconds: 0.04,
    sourceWidth: probe.width,
    sourceHeight: probe.height,
    sourceFPS: probe.fps,
    hasAudio: false,
    generationStatus: { kind: "none" },
  };
  ctx.doc.addAsset(asset);
  ctx.doc.notifyChanged();
  return ok(`Captured frame ${frame} as ${asset.id} (added to the library).`);
}

async function addMatte(ctx: BridgeContext, args: Args): Promise<ToolOut> {
  const color = strOpt(args.color) ?? "#000000";
  if (!/^#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/.test(color)) return fail("color must be '#RRGGBB' or '#RRGGBBAA'.");
  const w = Math.max(2, Math.round(numOpt(args.width) ?? ctx.doc.timeline.width ?? 1920));
  const h = Math.max(2, Math.round(numOpt(args.height) ?? ctx.doc.timeline.height ?? 1080));
  const dest = mediaPathFor("png");
  const { code } = await run(FFMPEG_BIN, ["-y", "-f", "lavfi", "-i", `color=c=${color}:s=${w}x${h}`, "-frames:v", "1", dest]);
  if (code !== 0 || !(await Bun.file(dest).exists())) return fail("Could not generate the matte (ffmpeg failed).");
  const asset: MediaAsset = {
    id: newId("asset"),
    type: "image",
    name: `Matte ${color}`,
    url: dest,
    durationSeconds: 0.04,
    sourceWidth: w,
    sourceHeight: h,
    hasAudio: false,
    generationStatus: { kind: "none" },
  };
  ctx.doc.addAsset(asset);
  const startFrame = numOpt(args.startFrame);
  const durationFrames = numOpt(args.durationFrames);
  let placed = "";
  if (startFrame !== undefined && durationFrames !== undefined) {
    const entry: Args = { mediaRef: asset.id, startFrame: Math.max(0, Math.round(startFrame)), durationFrames: Math.max(1, Math.round(durationFrames)) };
    const trackIndex = numOpt(args.trackIndex);
    if (trackIndex !== undefined) entry.trackIndex = Math.round(trackIndex);
    placed = ` ${TIMELINE_COMMANDS.add_clips(ctx.doc, { entries: [entry] }, "agent")}`;
  } else {
    ctx.doc.notifyChanged();
  }
  return ok(`Created a ${w}x${h} ${color} matte as ${asset.id} (added to the library).${placed}`);
}

/** CapCut-style beat detection on a music asset: BPM + beat/onset times from the audio envelope. */
async function detectBeatsTool(ctx: BridgeContext, args: Args): Promise<ToolOut> {
  const ref = strOpt(args.media);
  const a = ref ? (ctx.doc.asset(ref) ?? ctx.doc.project.media.find((m) => m.name === ref) ?? null) : null;
  if (!a?.url) return fail(`Asset not found: ${ref ?? "(media is required)"}`);
  if (!(a.type === "audio" || (a.type === "video" && a.hasAudio))) return fail("detect_beats needs an audio asset (or a video with audio).");
  const dur = Math.min(a.durationSeconds || 600, 600);
  const env = await audioEnvelope(a.url, 0, dur, "beats");
  if (!env) return fail("Could not read this asset's audio.");
  const res = detectBeatsFromEnvelope(env, 100);
  const payload = {
    bpm: res.bpm,
    confidence: res.confidence,
    beatCount: res.beats.length,
    beats: res.beats.slice(0, 400),
    onsetCount: res.onsets.length,
  };
  return ok(JSON.stringify(payload));
}

/** EXPERIMENTAL local speaker diarization (sherpa-onnx sidecar): who speaks when in an asset.
 * The result is cached per source path (diarize.ts), which is what lets get_transcript tag words
 * with speakers afterwards without re-running the slow pipeline. */
async function identifySpeakersTool(ctx: BridgeContext, args: Args): Promise<ToolOut> {
  const ref = strOpt(args.mediaRef);
  const a = ref ? (ctx.doc.asset(ref) ?? ctx.doc.project.media.find((m) => m.name === ref) ?? null) : null;
  if (!a?.url) return fail(`Asset not found: ${ref ?? "(mediaRef is required)"}`);
  if (!(a.type === "audio" || (a.type === "video" && a.hasAudio))) {
    return fail("identify_speakers needs an audio asset (or a video with audio).");
  }
  let d: Diarization | null;
  try {
    d = await diarizeSpeakers(a.url, { numSpeakers: numOpt(args.numSpeakers) });
  } catch (e) {
    return fail(e instanceof Error ? e.message : String(e));
  }
  if (!d) {
    return fail(
      "Speaker diarization unavailable — the sherpa-onnx sidecar or its .onnx models were not found (set CUPCAT_DIARIZE_BIN / CUPCAT_DIARIZE_DIR), or this file's audio could not be read.",
    );
  }
  if (d.turns.length === 0) return ok(`No speech turns found in ${a.id} — nothing to diarize.`);
  const r3 = (x: number) => Math.round(x * 1000) / 1000;
  return okJson({
    speakerCount: d.speakerCount,
    turns: d.turns.map((t) => ({ speaker: t.speaker, startSeconds: r3(t.startSeconds), endSeconds: r3(t.endSeconds) })),
    note: "Experimental local diarization (times are SOURCE seconds). get_transcript now tags this asset's words with these speaker labels.",
  });
}

/** Human correction for identify_speakers: REPLACE the cached speaker turns for an asset so
 * get_transcript tags words with the corrected attribution from then on. Pure session-cache
 * override (no document mutation) — diarization results already live outside the project file. */
async function setSpeakerTurnsTool(ctx: BridgeContext, args: Args): Promise<ToolOut> {
  const ref = strOpt(args.mediaRef);
  const a = ref ? (ctx.doc.asset(ref) ?? ctx.doc.project.media.find((m) => m.name === ref) ?? null) : null;
  if (!a?.url) return fail(`Asset not found: ${ref ?? "(mediaRef is required)"}`);
  if (!(a.type === "audio" || (a.type === "video" && a.hasAudio))) {
    return fail("set_speaker_turns needs an audio asset (or a video with audio).");
  }
  const raw = Array.isArray(args.turns) ? (args.turns as unknown[]) : null;
  if (!raw || raw.length === 0) {
    return fail("turns is required: [{speaker, startSeconds, endSeconds}, …] in SOURCE seconds, sorted by startSeconds.");
  }
  const turns: SpeakerTurn[] = [];
  for (let i = 0; i < raw.length; i++) {
    const t = (raw[i] ?? {}) as Record<string, unknown>;
    const speaker = typeof t.speaker === "string" ? t.speaker.trim() : "";
    const start = typeof t.startSeconds === "number" && Number.isFinite(t.startSeconds) ? t.startSeconds : null;
    const end = typeof t.endSeconds === "number" && Number.isFinite(t.endSeconds) ? t.endSeconds : null;
    if (!speaker || start === null || end === null) {
      return fail(`turns[${i}] must be {speaker (non-empty string), startSeconds (number), endSeconds (number)}.`);
    }
    if (start < 0) return fail(`turns[${i}]: startSeconds must be >= 0 (got ${start}).`);
    if (end <= start) {
      return fail(`turns[${i}]: endSeconds (${end}) must be greater than startSeconds (${start}) — every turn needs a positive span.`);
    }
    const prev = turns[turns.length - 1];
    if (prev && start < prev.endSeconds) {
      return fail(
        `turns[${i}] starts at ${start}s, before the previous turn ends at ${prev.endSeconds}s — turns must be sorted by startSeconds and non-overlapping. Merge or re-split the boundary and resend the full list.`,
      );
    }
    turns.push({ speaker, startSeconds: start, endSeconds: end });
  }
  const d = overrideDiarization(a.url, turns);
  return okJson({
    speakerCount: d.speakerCount,
    turnCount: d.turns.length,
    note: `Replaced the diarization for ${a.id} — get_transcript now tags this asset's words with these corrected turns.`,
  });
}

/** CapCut-style beat sync: ripple-trim each clip on a track so every cut lands on a beat of the
 * given music. Only shortens clips (no source extension), reusing trim_clip's linked+ripple logic. */
async function syncToBeatsTool(ctx: BridgeContext, args: Args): Promise<ToolOut> {
  const ref = strOpt(args.media);
  const a = ref ? (ctx.doc.asset(ref) ?? ctx.doc.project.media.find((m) => m.name === ref) ?? null) : null;
  if (!a?.url) return fail(`Music asset not found: ${ref ?? "(media is required — the music to sync to)"}`);
  const fps = ctx.doc.timeline.fps;
  const dur = Math.min(a.durationSeconds || 600, 600);
  const env = await audioEnvelope(a.url, 0, dur, "beats");
  if (!env) return fail("Could not read the music's audio.");
  const analysis = detectBeatsFromEnvelope(env, 100);
  if (analysis.beats.length < 2) return fail("No usable beat grid found in this music.");
  // A silent/ambient bed produces a fabricated 250 BPM grid at confidence ~0 — cutting to that
  // would shred the track to minClipSeconds slivers on beats that don't exist.
  if (analysis.confidence < 0.05 || analysis.onsets.length < 4) {
    return fail(`This audio has no clear rhythm to sync to (confidence ${analysis.confidence}, ${analysis.onsets.length} attacks detected).`);
  }
  const every = Math.max(1, numOpt(args.beatEvery) ?? 1);
  // Where does beat 0 sit on the timeline? If the music is already placed on a track, anchor the
  // grid to that clip; otherwise assume it starts at frame 0. trimStartFrame is in SOURCE frames,
  // so both the anchor and the beat times scale by the clip's playback speed.
  let musicStart = 0;
  let musicSpeed = 1;
  outer: for (const t of ctx.doc.timeline.tracks) {
    for (const c of t.clips) {
      if (c.mediaRef === a.id) {
        musicSpeed = c.speed || 1;
        musicStart = c.startFrame - Math.round((c.trimStartFrame ?? 0) / musicSpeed);
        break outer;
      }
    }
  }
  const beatFrames = analysis.beats.filter((_, i) => i % every === 0).map((b) => musicStart + Math.round((b / musicSpeed) * fps));
  const trackIndex = numOpt(args.trackIndex) ?? ctx.doc.timeline.tracks.findIndex((t) => t.type === "video" && t.clips.length > 0);
  const track = ctx.doc.timeline.tracks[trackIndex];
  if (!track || track.clips.length === 0) {
    return fail(numOpt(args.trackIndex) !== undefined ? `No clips on track ${trackIndex}.` : "No video track with clips found.");
  }
  const minFrames = Math.max(1, Math.round((numOpt(args.minClipSeconds) ?? 1) * fps));
  const clipIds = [...track.clips].sort((x, y) => x.startFrame - y.startFrame).map((c) => c.id);
  // trimClip has no linked-partner handling (unlike split/rippleDelete), so keep the linked audio
  // in sync ourselves: shorten each partner IN PLACE (no ripple — a track-wide ripple would also
  // drag unrelated clips sharing the audio track, e.g. the music bed, off the very grid we anchor
  // to), then shift the partners of LATER clips by the same delta the video ripple applied.
  const partnersOf = new Map<string, string[]>();
  for (const id of clipIds) {
    const loc0 = ctx.doc.findClip(id);
    if (!loc0) continue;
    const c0 = ctx.doc.timeline.tracks[loc0.trackIndex]!.clips[loc0.clipIndex]!;
    if (!c0.linkGroupId) continue;
    const ids: string[] = [];
    for (const t of ctx.doc.timeline.tracks) {
      for (const q of t.clips) if (q.linkGroupId === c0.linkGroupId && q.id !== c0.id) ids.push(q.id);
    }
    partnersOf.set(id, ids);
  }
  const report: string[] = [];
  for (let i = 0; i < clipIds.length; i++) {
    const id = clipIds[i]!;
    // Re-read fresh each pass — earlier ripple trims shift everything downstream.
    const loc = ctx.doc.findClip(id);
    if (!loc) continue;
    const c = ctx.doc.timeline.tracks[loc.trackIndex]!.clips[loc.clipIndex]!;
    const start = c.startFrame;
    const end = c.startFrame + c.durationFrames;
    const target = beatFrames.find((f) => f >= start + minFrames && f < end);
    if (target === undefined) {
      report.push(`${id}: kept (${c.durationFrames}f — no beat between min length and its end)`);
      continue;
    }
    const cut = end - target;
    const msg = trimClipCommand(ctx.doc, { clipId: id, edge: "right", deltaFrames: cut, ripple: true });
    for (const pid of partnersOf.get(id) ?? []) trimClipCommand(ctx.doc, { clipId: pid, edge: "right", deltaFrames: cut, ripple: false });
    for (let j = i + 1; j < clipIds.length; j++) {
      for (const pid of partnersOf.get(clipIds[j]!) ?? []) {
        const ploc = ctx.doc.findClip(pid);
        if (ploc) ctx.doc.timeline.tracks[ploc.trackIndex]!.clips[ploc.clipIndex]!.startFrame -= cut;
      }
    }
    report.push(`${id}: cut ${cut}f → ends on beat at frame ${target}${msg.startsWith("Trimmed") ? "" : ` (${msg})`}`);
  }
  ctx.doc.notifyChanged();
  return ok(`Beat sync @ ${analysis.bpm} BPM (confidence ${analysis.confidence}) on track ${trackIndex}:\n${report.join("\n")}`);
}

/** OpusClip-style AI clipping: transcribe → Claude picks highlights → batch export shorts. */
async function autoRoughCutTool(ctx: BridgeContext, args: Args): Promise<ToolOut> {
  const folder = strOpt(args.folder);
  const mediaRefs = Array.isArray(args.mediaRefs) ? (args.mediaRefs as unknown[]).map(String).filter(Boolean) : undefined;
  const maxClipSeconds = numOpt(args.maxClipSeconds);
  const order = strOpt(args.order) === "as-is" ? ("as-is" as const) : ("name" as const);
  const music = args.music !== false;
  try {
    const res = await autoRoughCut(ctx.doc, { folder, mediaRefs, maxClipSeconds, music, order });
    await saveProject(ctx.doc.project);
    const lines = res.clips.map(
      (c, i) => `  ${i + 1}. ${c.name} — ${(c.timelineFrames / (ctx.doc.project.timeline.fps || 30)).toFixed(1)}s${c.trimStartFrames || c.trimEndFrames ? " (trimmed dead head/tail)" : ""}`,
    );
    const parts = [
      `Rough cut assembled: ${res.clips.length} clip${res.clips.length === 1 ? "" : "s"} on V1, ${res.totalSeconds.toFixed(1)}s total.`,
      ...lines,
      res.musicAsset ? `Music bed added on its own audio track (${res.musicAsset}).` : "No music bed added.",
      ...res.notes.map((n) => `Note: ${n}`),
      "This is a first cut — refine it (reorder, tighten with the transcript, add titles/transitions), then the user presses Export.",
    ];
    return ok(parts.join("\n"));
  } catch (e) {
    return fail(`auto_rough_cut failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/** Chapters from what's said: markers on the timeline + a description block ready to paste. */
async function autoChaptersTool(ctx: BridgeContext, args: Args): Promise<ToolOut> {
  const ref = strOpt(args.media);
  const a = ref ? (ctx.doc.asset(ref) ?? ctx.doc.project.media.find((m) => m.name === ref) ?? null) : null;
  if (!a) return fail(`Asset not found: ${ref ?? "(media is required — pass a library video's id or name)"}`);
  if (a.type !== "video" || !a.url) return fail("auto_chapters needs a VIDEO asset from the library.");
  try {
    const { chapters, language } = await detectChapters(a.url, {
      durationSeconds: a.durationSeconds ?? 0,
      language: strOpt(args.language),
      onProgress: (text) => emitProgress("auto_chapters", text),
    });
    const fps = ctx.doc.project.timeline.fps || 30;
    let placed = 0;
    if (args.addMarkers !== false) {
      for (const c of chapters) {
        const frame = Math.max(0, Math.round(c.startSeconds * fps));
        const r = TIMELINE_COMMANDS.add_marker?.(ctx.doc, { frame, note: c.title }, "agent");
        if (r) placed++;
      }
      if (placed) ctx.doc.notifyChanged();
    }
    const list = chapters.map((c) => `${chapterTimestamp(c.startSeconds)} ${c.title}`).join("\n");
    return ok(
      `${chapters.length} chapters (${language})${placed ? `, ${placed} markers placed on the timeline` : ""}:\n\n${list}`,
    );
  } catch (e) {
    return fail(e instanceof Error ? e.message : String(e));
  }
}

/** Shared shape for the local repair tools: resolve a library asset, render a fixed copy, register
 * it. They all leave the source untouched, so the user can always compare or fall back. */
async function enhanceTool(
  ctx: BridgeContext,
  args: Args,
  label: string,
  render: (src: string, progress: (t: string) => void) => Promise<{ file: string; note: string }>,
): Promise<ToolOut> {
  const ref = strOpt(args.media);
  const a = ref ? (ctx.doc.asset(ref) ?? ctx.doc.project.media.find((m) => m.name === ref) ?? null) : null;
  if (!a) return fail(`Asset not found: ${ref ?? "(media is required — pass a library asset's id or name)"}`);
  if (!a.url) return fail("That library asset has no file on disk.");
  try {
    const res = await render(a.url, (text) => emitProgress(label, text));
    const id = await registerRenderedAsset(ctx, res.file, `${a.name} (${label})`);
    return ok(`Rendered "${a.name} (${label})" — ${res.note} — and added it to the library.\nFile: ${res.file}\nAsset: ${id}`);
  } catch (e) {
    return fail(e instanceof Error ? e.message : String(e));
  }
}

/** Ducking needs two sources (music + voice), so it doesn't fit enhanceTool's single-asset shape. */
async function duckMusicTool(ctx: BridgeContext, args: Args): Promise<ToolOut> {
  const find = (ref?: string) => (ref ? (ctx.doc.asset(ref) ?? ctx.doc.project.media.find((m) => m.name === ref) ?? null) : null);
  const music = find(strOpt(args.music));
  const voice = find(strOpt(args.voice));
  if (!music?.url) return fail("Pass the MUSIC asset (id or exact name) in `music`.");
  if (!voice?.url) return fail("Pass the asset carrying the VOICE (id or exact name) in `voice`.");
  try {
    const res = await duckMusic(music.url, voice.url, {
      amount: numOpt(args.amount),
      onProgress: (text) => emitProgress("duck_music", text),
    });
    const id = await registerRenderedAsset(ctx, res.file, `${music.name} (ducked)`);
    return ok(`Rendered "${music.name} (ducked)" — ${res.note}. Use it in place of the original music.\nFile: ${res.file}\nAsset: ${id}`);
  } catch (e) {
    return fail(e instanceof Error ? e.message : String(e));
  }
}

/** Probe a freshly rendered file and put it in the library with thumbnail + audio proxy warmed. */
async function registerRenderedAsset(ctx: BridgeContext, file: string, name: string): Promise<string> {
  const probe = await probeMedia(file);
  const id = newId("asset");
  const isVideo = (probe.width ?? 0) > 0;
  ctx.doc.addAsset({
    id,
    type: isVideo ? "video" : "audio",
    name,
    url: file,
    durationSeconds: probe.durationSeconds,
    sourceWidth: probe.width,
    sourceHeight: probe.height,
    sourceFPS: probe.fps,
    hasAudio: probe.hasAudio,
    generationStatus: { kind: "none" },
  } as MediaAsset);
  void ensureThumbnail(file).catch(() => {});
  void ensureAudioProxy(file).catch(() => {});
  ctx.doc.notifyChanged();
  return id;
}

/** Cover every face in a library video and register the anonymised copy as a new asset. */
async function blurFacesTool(ctx: BridgeContext, args: Args): Promise<ToolOut> {
  const ref = strOpt(args.media);
  const a = ref ? (ctx.doc.asset(ref) ?? ctx.doc.project.media.find((m) => m.name === ref) ?? null) : null;
  if (!a) return fail(`Asset not found: ${ref ?? "(media is required — pass a library video's id or name)"}`);
  if (a.type !== "video" || !a.url) return fail("blur_faces needs a VIDEO asset from the library.");
  try {
    const res = await renderFaceBlur(a.url, {
      onProgress: (text) => emitProgress("blur_faces", text),
      mode: strOpt(args.mode) === "pixelate" ? "pixelate" : "blur",
      strength: numOpt(args.strength),
      everySeconds: numOpt(args.everySeconds),
      padding: numOpt(args.padding),
      durationSeconds: a.durationSeconds && a.durationSeconds > 0 ? a.durationSeconds : undefined,
    });
    const probe = await probeMedia(res.file);
    const id = newId("asset");
    ctx.doc.addAsset({
      id,
      type: "video",
      name: `${a.name} (faces blurred)`,
      url: res.file,
      durationSeconds: probe.durationSeconds,
      sourceWidth: probe.width,
      sourceHeight: probe.height,
      sourceFPS: probe.fps,
      hasAudio: probe.hasAudio,
      generationStatus: { kind: "none" },
    } as MediaAsset);
    void ensureThumbnail(res.file).catch(() => {});
    void ensureAudioProxy(res.file).catch(() => {});
    ctx.doc.notifyChanged();
    return ok(
      `Covered ${res.faces} face(s) across ${res.coveredSeconds}s and added "${a.name} (faces blurred)" to the library.
File: ${res.file}`,
    );
  } catch (e) {
    return fail(e instanceof Error ? e.message : String(e));
  }
}

async function autoClipsTool(ctx: BridgeContext, args: Args): Promise<ToolOut> {
  const ref = strOpt(args.media);
  const a = ref ? (ctx.doc.asset(ref) ?? ctx.doc.project.media.find((m) => m.name === ref) ?? null) : null;
  if (!a) return fail(`Asset not found: ${ref ?? "(media is required — pass a library video's id or name)"}`);
  if (a.type !== "video" || !a.url) return fail("auto_clips needs a VIDEO asset from the library.");
  const count = Math.max(1, Math.min(10, numOpt(args.count) ?? 3));
  const minSeconds = Math.max(3, numOpt(args.minSeconds) ?? 15);
  const maxSeconds = Math.max(minSeconds + 2, numOpt(args.maxSeconds) ?? 60);
  const aspect = strOpt(args.aspect) === "original" ? ("original" as const) : ("9:16" as const);
  const captions = args.captions !== false; // default ON — it's the short-form look
  const styleArg = strOpt(args.captionStyle);
  const captionStyle = (["karaoke", "clean", "boxed", "minimal"] as const).find((s) => s === styleArg) ?? "karaoke";
  const beepWords = Array.isArray(args.beepWords) ? (args.beepWords as unknown[]).map(String).filter(Boolean) : undefined;
  try {
    const res = await autoClips({
      // Surface the pipeline's phases to the UI — a long video spends minutes in transcribe/curate
      // and the dialog looked hung without this.
      onProgress: (text) => emitProgress("auto_clips", text),
      srcPath: a.url,
      durationSeconds: a.durationSeconds ?? 0,
      count,
      minSeconds,
      maxSeconds,
      aspect,
      captions,
      captionStyle,
      titleOverlay: args.titleOverlay !== false,
      beepWords,
      watermarkPath: strOpt(args.watermarkPath),
      watermarkOpacity: numOpt(args.watermarkOpacity),
      guidance: strOpt(args.prompt),
      visual: args.visual === true,
      language: strOpt(args.language),
    });
    // Register each clip in the library so they're immediately usable/previewable in the app.
    const assetIds: string[] = [];
    for (const c of res.clips) {
      const probe = await probeMedia(c.file);
      const id = newId("asset");
      assetIds.push(id);
      ctx.doc.addAsset({
        id,
        type: "video",
        name: c.title,
        url: c.file,
        durationSeconds: probe.durationSeconds,
        sourceWidth: probe.width,
        sourceHeight: probe.height,
        sourceFPS: probe.fps,
        hasAudio: probe.hasAudio,
        generationStatus: { kind: "none" },
      } as MediaAsset);
      void ensureThumbnail(c.file).catch(() => {});
      void ensureAudioProxy(c.file).catch(() => {});
    }
    ctx.doc.notifyChanged();
    const lines = res.clips.map(
      (c, i) =>
        `${i + 1}. "${c.title}" — score ${c.score}/100, ${c.startSeconds.toFixed(1)}s→${c.endSeconds.toFixed(1)}s\n   hook: ${c.hook}\n   file: ${c.file}`,
    );
    // Second text block: machine-readable payload the AI Clips dialog renders as rich result cards.
    const payload = JSON.stringify({
      clips: res.clips.map((c, i) => ({ ...c, assetId: assetIds[i] })),
      folder: res.folder,
    });
    return {
      content: [
        { type: "text", text: `Created ${res.clips.length} clip(s) in ${res.folder} (also added to the library):\n${lines.join("\n")}` },
        { type: "text", text: `AUTO_CLIPS_JSON:${payload}` },
      ],
      isError: false,
    };
  } catch (e) {
    return fail(e instanceof Error ? e.message : String(e));
  }
}

async function saveRangeAsMedia(ctx: BridgeContext, args: Args): Promise<ToolOut> {
  // saveRangeToFile renders the MAIN timeline; clip/frame coordinates given while a compound view
  // is open would be sub-timeline-relative and land on the wrong content — refuse the mix.
  if (ctx.doc.activeCompound) return fail("A compound is open — call close_compound first (save_range_as_media bakes ranges of the MAIN timeline).");
  let sf = numOpt(args.startFrame);
  let ef = numOpt(args.endFrame);
  const clipId = strOpt(args.clipId);
  if (clipId) {
    const loc = ctx.doc.findClip(clipId);
    if (!loc) return fail(`Clip not found: ${clipId}`);
    const c = ctx.doc.timeline.tracks[loc.trackIndex]!.clips[loc.clipIndex]!;
    sf = c.startFrame;
    ef = clipEndFrame(c);
  }
  if (sf == null || ef == null || ef <= sf) return fail("Provide clipId, or startFrame + endFrame (end > start).");
  const dest = mediaPathFor("mp4");
  if (!(await saveRangeToFile(ctx.doc, sf, ef, dest))) return fail("Could not render that range (is the timeline empty there?).");
  const probe = await probeMedia(dest);
  const asset: MediaAsset = {
    id: newId("asset"),
    type: "video",
    name: strOpt(args.name) ?? `Baked ${sf}–${ef}`,
    url: dest,
    durationSeconds: probe.durationSeconds,
    sourceWidth: probe.width,
    sourceHeight: probe.height,
    sourceFPS: probe.fps,
    hasAudio: probe.hasAudio,
    generationStatus: { kind: "none" },
  };
  ctx.doc.addAsset(asset);
  ctx.doc.notifyChanged();
  return ok(`Saved frames ${sf}–${ef} as ${asset.id} (added to the library).`);
}

async function relinkMedia(ctx: BridgeContext, args: Args): Promise<ToolOut> {
  const ref = strOpt(args.mediaRef);
  if (!ref) return fail("mediaRef is required");
  const a = ctx.doc.asset(ref);
  if (!a) return fail(`Asset not found: ${ref}`);
  const path = normalizeLocalPath(strOpt(args.path));
  if (!path) return fail("path is required");
  if (!(await Bun.file(path).exists())) return fail(`File not found: ${path}`);
  const probe = await probeMedia(path);
  a.url = path;
  if (probe.durationSeconds) a.durationSeconds = probe.durationSeconds;
  if (probe.width) a.sourceWidth = probe.width;
  if (probe.height) a.sourceHeight = probe.height;
  if (probe.fps) a.sourceFPS = probe.fps;
  a.hasAudio = probe.hasAudio;
  a.generationStatus = { kind: "none" };
  ctx.doc.notifyChanged();
  return ok(`Relinked ${ref} → ${path}.`);
}

// ── sync_audio (envelope cross-correlation) ──

const ENV_RATE = 100;
const clipSrcStartSec = (c: Clip, fps: number) => c.trimStartFrame / fps;
const clipVisibleDurSec = (c: Clip, fps: number) => (c.durationFrames * (c.speed > 0 ? c.speed : 1)) / fps;

/** Lag L (envelope samples) in [lagMin, lagMax] maximizing zero-normalized correlation of ref[i] vs tgt[i+L]. */
function bestLag(ref: Float32Array, tgt: Float32Array, lagMin: number, lagMax: number): { lag: number; confidence: number } {
  let best = -Infinity;
  let bestL = 0;
  let bestN = 0;
  // A perfect score over a tiny overlap is meaningless — near the search edges the common span
  // shrinks to ~1s, and any repeating sound (a beep, a musical bar) can line up EXACTLY there,
  // outscoring the true alignment. Require a meaningful common span before a lag may compete.
  const minOverlap = Math.max(2 * ENV_RATE, Math.round(0.15 * Math.min(ref.length, tgt.length)));
  // No lag beyond the combined lengths can overlap, whatever the requested window.
  const lim = ref.length + tgt.length;
  const lo = Math.max(lagMin, -lim);
  const hi = Math.min(lagMax, lim);
  for (let L = lo; L <= hi; L++) {
    const i0 = Math.max(0, -L);
    const i1 = Math.min(ref.length, tgt.length - L);
    const n = i1 - i0;
    if (n < minOverlap) continue;
    let sr = 0;
    let st = 0;
    for (let i = i0; i < i1; i++) {
      sr += ref[i]!;
      st += tgt[i + L]!;
    }
    const mr = sr / n;
    const mt = st / n;
    let num = 0;
    let dr = 0;
    let dt = 0;
    for (let i = i0; i < i1; i++) {
      const a = ref[i]! - mr;
      const b = tgt[i + L]! - mt;
      num += a * b;
      dr += a * a;
      dt += b * b;
    }
    const denom = Math.sqrt(dr * dt);
    const corr = denom > 0 ? num / denom : 0;
    // On numerically tied scores prefer the LARGER overlap — float jitter must not let a
    // barely-overlapping echo of the true peak win over the fully-overlapping alignment.
    if (corr > best + 1e-9 || (corr > best - 1e-9 && n > bestN)) {
      best = Math.max(best, corr);
      bestL = L;
      bestN = n;
    }
  }
  return { lag: bestL, confidence: Math.max(0, Math.min(1, best)) };
}

async function syncAudio(doc: EditorDocument, args: Args): Promise<ToolOut> {
  const refId = strOpt(args.referenceClipId);
  if (!refId) return fail("referenceClipId is required");
  const targets = [
    ...(strOpt(args.targetClipId) ? [strOpt(args.targetClipId)!] : []),
    ...(Array.isArray(args.targetClipIds) ? args.targetClipIds.filter((x): x is string => typeof x === "string") : []),
  ];
  if (targets.length === 0) return fail("Provide targetClipId or targetClipIds");
  const strategy = strOpt(args.strategy) ?? "auto";
  if (strategy !== "auto" && strategy !== "timecode" && strategy !== "audio") return fail("strategy must be 'auto', 'timecode', or 'audio'");
  const searchWindow = numOpt(args.searchWindowSeconds) ?? 30;
  const minConf = numOpt(args.minConfidence) ?? 0.5;
  const fps = doc.timeline.fps;

  const refClip = doc.getClip(refId);
  if (!refClip) return fail(`Reference clip not found: ${refId}`);
  const refAsset = doc.asset(refClip.mediaRef);
  if (!refAsset?.url) return fail("Reference clip has no media");
  const refUrl = refAsset.url; // capture: narrowing doesn't survive into the closure below
  const refMeta = strategy === "audio" ? null : await sourceTimecode(refUrl);
  // Lazy: pure timecode resolution never touches audio (its whole point — it works on footage
  // with unusable or non-overlapping sound), so the envelope decode only runs when needed.
  let refEnvJob: Promise<Float32Array | null> | null = null;
  const refEnvelope = () => (refEnvJob ??= audioEnvelope(refUrl, clipSrcStartSec(refClip, fps), clipVisibleDurSec(refClip, fps), "ref", ENV_RATE));

  // Timeline frame where the target must start so that identical wall-clock moments line up,
  // given the metadata start-time difference (target minus reference, in seconds). Each clip's
  // visible portion begins metaStart + trimStart into real time, and the reference anchors it.
  const alignedStart = (t: Clip, metaDeltaSec: number) =>
    Math.max(0, Math.round(refClip.startFrame + (metaDeltaSec - clipSrcStartSec(refClip, fps) + clipSrcStartSec(t, fps)) * fps));

  const results: Record<string, unknown>[] = [];
  const moves: { clipId: string; toTrack: number; toFrame: number }[] = [];
  let idx = 0;
  for (const tid of targets) {
    const t = doc.getClip(tid);
    if (!t) {
      results.push({ clipId: tid, error: "not found" });
      continue;
    }
    const ta = doc.asset(t.mediaRef);
    if (!ta?.url) {
      results.push({ clipId: tid, error: "no media" });
      continue;
    }
    const tMeta = strategy === "audio" ? null : await sourceTimecode(ta.url);

    // Timecode path: both sides embed a start timecode (jam-synced cameras / dual-system rigs) →
    // the offset is exact metadata arithmetic. Preferred over audio: no drift with distance/echo,
    // and it still works when one side has no usable audio at all.
    if (refMeta?.timecodeSeconds != null && tMeta?.timecodeSeconds != null) {
      const delta = tMeta.timecodeSeconds - refMeta.timecodeSeconds;
      const newStart = alignedStart(t, delta);
      const loc = doc.findClip(tid)!;
      moves.push({ clipId: tid, toTrack: loc.trackIndex, toFrame: newStart });
      results.push({ clipId: tid, strategy: "timecode", offsetFrames: newStart - t.startFrame, timecodeDeltaSeconds: Math.round(delta * 1000) / 1000, moved: true });
      continue;
    }
    if (strategy === "timecode") {
      results.push({ clipId: tid, moved: false, error: "no embedded timecode on both clips — use strategy 'auto' or 'audio'" });
      continue;
    }

    // creation_time seed: file-date stamps are coarse (~±1s trust, often whole seconds), so they
    // can't place the clip alone — but they NARROW the correlation search to ±3s around the
    // metadata offset instead of the full ±searchWindow, and audio then finds the exact lag.
    let lagMin = -Math.round(searchWindow * ENV_RATE);
    let lagMax = -lagMin;
    let resolvedBy: "audio" | "creation_time+audio" = "audio";
    if (refMeta?.creationTime != null && tMeta?.creationTime != null) {
      const seedLag = Math.round((refClip.startFrame - alignedStart(t, (tMeta.creationTime - refMeta.creationTime) / 1000)) * (ENV_RATE / fps));
      lagMin = seedLag - 3 * ENV_RATE;
      lagMax = seedLag + 3 * ENV_RATE;
      resolvedBy = "creation_time+audio";
    }

    const refEnv = await refEnvelope();
    if (!refEnv || refEnv.length < ENV_RATE) {
      results.push({ clipId: tid, error: "could not read reference audio (no usable track?)" });
      continue;
    }
    const tEnv = await audioEnvelope(ta.url, clipSrcStartSec(t, fps), clipVisibleDurSec(t, fps), `t${idx++}`, ENV_RATE);
    if (!tEnv || tEnv.length < ENV_RATE) {
      results.push({ clipId: tid, error: "no audio" });
      continue;
    }
    const { lag, confidence } = bestLag(refEnv, tEnv, lagMin, lagMax);
    if (confidence < minConf) {
      results.push({ clipId: tid, strategy: resolvedBy, confidence: Math.round(confidence * 100) / 100, moved: false, reason: "below minConfidence" });
      continue;
    }
    const newStart = Math.max(0, Math.round(refClip.startFrame - lag * (fps / ENV_RATE)));
    const loc = doc.findClip(tid)!;
    moves.push({ clipId: tid, toTrack: loc.trackIndex, toFrame: newStart });
    results.push({ clipId: tid, strategy: resolvedBy, offsetFrames: newStart - t.startFrame, confidence: Math.round(confidence * 100) / 100, moved: true });
  }
  if (moves.length) {
    // Expand to linked partners (same as the move_clips command): shifting only the video half of
    // a linked pair would silently desync it from its own audio — the exact thing this tool fixes.
    const seen = new Set(moves.map((m) => m.clipId));
    for (const m of [...moves]) {
      for (const pm of doc.partnerMoves(m.clipId, m.toFrame)) {
        if (seen.has(pm.clipId)) continue;
        seen.add(pm.clipId);
        const loc = doc.findClip(pm.clipId);
        if (loc) moves.push({ clipId: pm.clipId, toTrack: loc.trackIndex, toFrame: pm.toFrame });
      }
    }
    doc.mutate("Sync Audio", "agent", () => doc.moveClips(moves));
  }
  return okJson({ referenceClipId: refId, results });
}

// ── Higgsfield edit ops (CLI models: reframe / background-removal / outpaint / virality) ──

async function startMediaEdit(
  ctx: BridgeContext,
  kind: ClipType,
  model: string,
  sourceRef: string,
  role: "image" | "video",
  name: string,
  params: Record<string, string | number> = {},
): Promise<ToolOut> {
  if (!ctx.canGenerate()) return fail("Higgsfield CLI is not authenticated. Run `higgsfield auth login`, then retry.");
  const src = ctx.doc.asset(sourceRef);
  if (!src?.url || src.generationStatus.kind !== "none") return fail(`Source asset not ready or not found: ${sourceRef}`);
  const asset: MediaAsset = {
    id: newId("asset"),
    type: kind,
    name,
    durationSeconds: kind === "video" ? src.durationSeconds : 0,
    hasAudio: kind === "video" ? src.hasAudio : false,
    generationStatus: { kind: "generating" },
    generationInput: { kind: kind === "video" ? "video" : "image", model, references: [sourceRef] },
  };
  ctx.doc.addAsset(asset);
  ctx.doc.notifyChanged();
  const refs = role === "video" ? { video: src.url } : { image: src.url };
  void completeGeneration(ctx, asset, { model, params, ...refs });
  return ok(`Started ${model} on ${sourceRef} → ${asset.id} ('${name}'). Runs in the background; resolves in get_media.`);
}

async function reframeTool(ctx: BridgeContext, args: Args): Promise<ToolOut> {
  const ref = strOpt(args.mediaRef);
  if (!ref) return fail("mediaRef is required");
  const a = ctx.doc.asset(ref);
  if (!a) return fail(`Asset not found: ${ref}`);
  if (a.type !== "video") return fail("reframe takes a video asset");
  const ar = strOpt(args.aspectRatio);
  if (!ar) return fail("aspectRatio is required (e.g. '9:16')");
  return startMediaEdit(ctx, "video", "reframe", ref, "video", `${a.name} ${ar}`, { aspect_ratio: ar });
}

// track_motion (B6): follow a subject in a footage clip and pin an overlay clip to it via position
// keyframes — the "attach text/sticker to a moving thing" gesture, done locally (template matching).
async function trackMotionTool(ctx: BridgeContext, args: Args, source: EditSource): Promise<ToolOut> {
  const doc = ctx.doc;
  const fps = doc.timeline.fps;
  const clipId = strOpt(args.clipId);
  const attachId = strOpt(args.attachClipId);
  if (!clipId) return fail("clipId is required (the FOOTAGE clip to track the subject in).");
  if (!attachId) return fail("attachClipId is required (the overlay/text/sticker clip to pin to the subject).");
  const roiArg = args.roi as { x?: number; y?: number; w?: number; h?: number } | undefined;
  if (!roiArg || [roiArg.x, roiArg.y, roiArg.w, roiArg.h].some((v) => typeof v !== "number")) {
    return fail("roi is required: { x, y, w, h } as fractions 0..1 marking the thing to track in the first frame.");
  }
  let footage: Clip | undefined;
  let attach: Clip | undefined;
  for (const t of doc.timeline.tracks) {
    for (const c of t.clips) {
      if (c.id === clipId) footage = c;
      if (c.id === attachId) attach = c;
    }
  }
  if (!footage) return fail(`Footage clip not found: ${clipId}`);
  if (!attach) return fail(`Attach clip not found: ${attachId}`);
  const asset = doc.asset(footage.mediaRef);
  if (!asset?.url || (footage.mediaType !== "video" && footage.mediaType !== "image")) {
    return fail("The footage clip must be a video (or image) with a source file.");
  }
  const probe = await probeMedia(asset.url);
  const aspect = probe.width && probe.height ? probe.width / probe.height : doc.timeline.width / doc.timeline.height;

  // Sample the OVERLAP of the two clips (only there can the overlay follow), at ~8fps, capped.
  const startTL = Math.max(footage.startFrame, attach.startFrame);
  const endTL = Math.min(footage.startFrame + footage.durationFrames, attach.startFrame + attach.durationFrames);
  if (endTL <= startTL) return fail("The overlay clip doesn't overlap the footage clip in time — move them so they share frames.");
  const step = Math.max(1, Math.round(fps / 8));
  const tlFrames: number[] = [];
  for (let f = startTL; f < endTL; f += step) tlFrames.push(f);
  if (tlFrames.length > 160) {
    // subsample to keep tracking + keyframes bounded
    const keep: number[] = [];
    const stride = tlFrames.length / 160;
    for (let i = 0; i < 160; i++) keep.push(tlFrames[Math.floor(i * stride)]);
    tlFrames.length = 0;
    tlFrames.push(...keep);
  }
  // timeline frame → source seconds for the footage clip (honor trim + speed)
  const sampleSecs = tlFrames.map((f) => (footage!.trimStartFrame + (f - footage!.startFrame) * footage!.speed) / fps);

  let path;
  try {
    path = await trackMotion(asset.url, { x: roiArg.x!, y: roiArg.y!, w: roiArg.w!, h: roiArg.h! }, sampleSecs, aspect);
  } catch (e) {
    return fail(`track_motion failed: ${e instanceof Error ? e.message : String(e)}`);
  }

  // Center the overlay on each tracked point: position keyframe = top-left = (cx - w/2, cy - h/2),
  // where w/h are the overlay's normalized size (transform). Frames are attach-clip-relative.
  const ow = attach.transform?.width ?? 1;
  const oh = attach.transform?.height ?? 1;
  const rows = path.map((p, i) => {
    const rel = Math.max(0, tlFrames[i] - attach!.startFrame);
    const a = Math.max(-0.5, Math.min(1, p.cx - ow / 2));
    const b = Math.max(-0.5, Math.min(1, p.cy - oh / 2));
    return [rel, Math.round(a * 1000) / 1000, Math.round(b * 1000) / 1000] as [number, number, number];
  });
  const out = TIMELINE_COMMANDS.set_keyframes!(doc, { clipId: attachId, property: "position", keyframes: rows }, source);
  await saveProject(doc.project);
  return ok(
    `Tracked the subject across ${rows.length} points and pinned ${attachId} to it (position keyframes). Scrub to check the lock; re-run with a tighter roi if it drifts. ${out}`,
  );
}

async function separateStemsTool(ctx: BridgeContext, args: Args): Promise<ToolOut> {
  const ref = strOpt(args.mediaRef);
  if (!ref) return fail("mediaRef is required (a library asset with audio — video or audio)");
  const a = ctx.doc.asset(ref) ?? ctx.doc.project.media.find((m) => m.name === ref) ?? null;
  if (!a) return fail(`Asset not found: ${ref}`);
  if (!a.url || (a.type !== "audio" && a.type !== "video")) return fail("separate_stems takes an audio or video asset.");
  const want = strOpt(args.keep); // "voice" | "music" | undefined (both)
  try {
    await mkdir(mediaDir, { recursive: true });
    const prefix = `stems_${a.id}`;
    const { vocalsPath, musicPath } = await separateStems(a.url, mediaDir, prefix);
    const made: string[] = [];
    const register = async (path: string, label: string): Promise<string> => {
      const p = await probeMedia(path);
      const id = newId("asset");
      ctx.doc.addAsset({ id, type: "audio", name: `${a.name} — ${label}`, url: path, durationSeconds: p.durationSeconds, hasAudio: true } as MediaAsset);
      void ensureAudioProxy(path).catch(() => {});
      return id;
    };
    if (want !== "music") made.push(`Voice: ${await register(vocalsPath, "Voice")}`);
    else void rm(vocalsPath, { force: true }).catch(() => {});
    if (want !== "voice") made.push(`Music: ${await register(musicPath, "Music")}`);
    else void rm(musicPath, { force: true }).catch(() => {});
    ctx.doc.notifyChanged();
    await saveProject(ctx.doc.project);
    return ok(`Separated "${a.name}" into stems locally (sherpa spleeter) → ${made.join(", ")}. Add them with add_clips (own audio tracks).`);
  } catch (e) {
    return fail(`separate_stems failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}

async function smoothSlowMoTool(ctx: BridgeContext, args: Args): Promise<ToolOut> {
  const ref = strOpt(args.mediaRef);
  if (!ref) return fail("mediaRef is required (a library video's id or name)");
  const a = ctx.doc.asset(ref) ?? ctx.doc.project.media.find((m) => m.name === ref) ?? null;
  if (!a) return fail(`Asset not found: ${ref}`);
  if (a.type !== "video" || !a.url) return fail("smooth_slowmo takes a VIDEO asset from the library.");
  const factor = numOpt(args.factor) ?? 0.5;
  if (factor >= 1) return fail("factor must be < 1 (e.g. 0.5 = half speed / 2× longer, 0.25 = quarter speed).");
  try {
    const res = await smoothSlowMo(a.url, factor, { outFps: numOpt(args.outFps) });
    const probe = await probeMedia(res.path);
    const id = newId("asset");
    ctx.doc.addAsset({
      id,
      type: "video",
      name: `${a.name} (${Math.round(1 / res.factor)}× slow-mo)`,
      url: res.path,
      durationSeconds: probe.durationSeconds,
      sourceWidth: probe.width,
      sourceHeight: probe.height,
      sourceFPS: probe.fps,
      hasAudio: false,
    } as MediaAsset);
    void ensureThumbnail(res.path).catch(() => {});
    ctx.doc.notifyChanged();
    await saveProject(ctx.doc.project);
    return ok(
      `Smooth slow-mo done locally → new asset ${id} (${Math.round(1 / res.factor)}× slower, motion-interpolated at ${res.outFps}fps, ${res.durationSeconds.toFixed(1)}s). Silent by design — keep the original audio on its own track if you need it.`,
    );
  } catch (e) {
    return fail(`smooth_slowmo failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}

async function autoReframeTool(ctx: BridgeContext, args: Args): Promise<ToolOut> {
  const ref = strOpt(args.mediaRef);
  if (!ref) return fail("mediaRef is required (a library video's id or name)");
  const a = ctx.doc.asset(ref) ?? ctx.doc.project.media.find((m) => m.name === ref) ?? null;
  if (!a) return fail(`Asset not found: ${ref}`);
  if (a.type !== "video" || !a.url) return fail("auto_reframe takes a VIDEO asset from the library.");
  const ar = strOpt(args.aspectRatio) ?? "9:16";
  try {
    const res = await reframeLocal(a.url, ar, { smooth: args.smooth !== false });
    const probe = await probeMedia(res.path);
    const id = newId("asset");
    ctx.doc.addAsset({
      id,
      type: "video",
      name: `${a.name} (${ar})`,
      url: res.path,
      durationSeconds: probe.durationSeconds,
      sourceWidth: probe.width,
      sourceHeight: probe.height,
      sourceFPS: probe.fps,
      hasAudio: probe.hasAudio,
    } as MediaAsset);
    void ensureThumbnail(res.path).catch(() => {});
    void ensureAudioProxy(res.path).catch(() => {});
    ctx.doc.notifyChanged();
    await saveProject(ctx.doc.project);
    return ok(
      `Auto-reframed "${a.name}" to ${ar} locally → new asset ${id} (${res.width}×${res.height}, ${res.shots} shot${res.shots === 1 ? "" : "s"}, ${res.durationSeconds.toFixed(1)}s). Framing follows the subject per shot. Add it to the timeline, or use it as the source for a Shorts export. (For AI content-aware reframing instead, use the cloud 'reframe' tool.)`,
    );
  } catch (e) {
    return fail(`auto_reframe failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}

async function removeBackgroundTool(ctx: BridgeContext, args: Args): Promise<ToolOut> {
  const ref = strOpt(args.mediaRef);
  if (!ref) return fail("mediaRef is required");
  const a = ctx.doc.asset(ref);
  if (!a) return fail(`Asset not found: ${ref}`);
  if (a.type === "image") return startMediaEdit(ctx, "image", "image_background_remover", ref, "image", `${a.name} (no bg)`);
  if (a.type === "video") return startMediaEdit(ctx, "video", "video_background_remover", ref, "video", `${a.name} (no bg)`);
  return fail("remove_background takes an image or video asset");
}

async function outpaintTool(ctx: BridgeContext, args: Args): Promise<ToolOut> {
  const ref = strOpt(args.mediaRef);
  if (!ref) return fail("mediaRef is required");
  const a = ctx.doc.asset(ref);
  if (!a || a.type !== "image") return fail("outpaint_image takes an image asset");
  const params: Record<string, string | number> = {};
  if (strOpt(args.aspectRatio)) params.aspect_ratio = String(args.aspectRatio);
  return startMediaEdit(ctx, "image", "outpaint", ref, "image", `${a.name} (outpaint)`, params);
}

async function analyzeVideoTool(ctx: BridgeContext, args: Args): Promise<ToolOut> {
  if (!ctx.canGenerate()) return fail("Higgsfield CLI is not authenticated. Run `higgsfield auth login`, then retry.");
  const ref = strOpt(args.mediaRef);
  if (!ref) return fail("mediaRef is required");
  const a = ctx.doc.asset(ref);
  if (!a?.url || a.type !== "video") return fail("analyze_video takes a ready video asset");
  const res = await generate({ model: "brain_activity", video: a.url });
  if (!res.ok) return fail(res.error ?? "analysis failed");
  return ok(`Virality / attention analysis for ${ref}:\n${res.raw.slice(0, 4000)}`);
}

async function rememberTool(args: Args): Promise<ToolOut> {
  const note = strOpt(args.note);
  if (!note) return fail("note is required");
  const scope = strOpt(args.scope) === "global" ? "global" : "project";
  await appendMemory(scope, note);
  return ok(`Remembered (${scope}). Future sessions on this ${scope === "global" ? "machine" : "project"} will start knowing it.`);
}

async function importFromUrlTool(ctx: BridgeContext, args: Args, source: EditSource): Promise<ToolOut> {
  const url = strOpt(args.url);
  if (!url) return fail("url is required");
  const dl = await importFromUrl(url);
  if ("error" in dl) return fail(dl.error);
  // Reuse the exact local-path import flow so probing, asset registration, and proxy/thumbnail
  // warming stay identical to a manual file import.
  const imported = await executeTool(ctx, "import_media", { source: { path: dl.path } }, source);
  if (imported.isError) return imported;
  const title = dl.path.split(/[\\/]/).pop()?.replace(/\.[^.]+$/, "") ?? "video";
  const media = ctx.doc.project.media;
  let asset: MediaAsset | undefined;
  for (let i = media.length - 1; i >= 0; i--) {
    if (media[i]!.url === dl.path) { asset = media[i]; break; }
  }
  const dur = asset?.durationSeconds ? ` (${Math.round(asset.durationSeconds * 10) / 10}s)` : "";
  return ok(`Downloaded and imported "${title}"${asset ? ` as ${asset.id}` : ""}${dur}.`);
}

// ── dispatch ──

export async function executeTool(ctx: BridgeContext, name: string, rawArgs: Args, source: EditSource): Promise<ToolOut> {
  const args = expandIds(rawArgs ?? {}, idUniverse(ctx.doc)) as Args;
  try {
    switch (name) {
      case "get_timeline":
        return okJson(getTimeline(ctx.doc, { startFrame: numOpt(args.startFrame), endFrame: numOpt(args.endFrame), canGenerate: ctx.canGenerate() }));
      case "get_media":
        return okJson(getMedia(ctx.doc));
      case "list_folders":
        return okJson(listFolders(ctx.doc));
      case "list_models":
        return await listModelsTool(args);
      case "undo":
        // A user-initiated undo (the toolbar button) reverts the last edit whatever its source;
        // the agent's undo tool stays guarded to only revert the assistant's own edits.
        if (source === "user") {
          const done = ctx.doc.undo();
          return ok(done ? `Undid: ${done.actionName}.` : "Nothing to undo.");
        }
        return ok(undo(ctx.doc));
      case "redo": {
        const done = ctx.doc.redo();
        return ok(done ? `Redid: ${done.actionName}.` : "Nothing to redo.");
      }
      case "inspect_media":
        return await inspectMedia(ctx.doc, args);
      case "search_media":
        return await searchMedia(ctx.doc, args);
      case "get_transcript":
        return await getTranscriptTool(ctx.doc, args);
      case "add_captions":
        return await addCaptionsTool(ctx.doc, args);
      case "import_captions":
        return await importCaptionsTool(ctx.doc, args);
      case "export_captions":
        return await exportCaptionsTool(ctx, args);
      case "add_motion_graphic":
        return await addMotionGraphicTool(ctx, args, source);
      case "make_transition":
        return await makeTransitionTool(ctx, args, source);
      case "save_template":
        return await saveTemplateTool(ctx, args);
      case "apply_template":
        return await applyTemplateTool(ctx, args, source);
      case "list_templates":
        return await listTemplatesTool();
      case "save_version":
        return await saveVersionTool(ctx.doc, args);
      case "list_versions":
        return await listVersionsTool();
      case "restore_version":
        return await restoreVersionTool(ctx, args);
      case "translate_captions":
        return await translateCaptionsTool(ctx, args);
      case "dub_timeline":
        return await dubTimelineTool(ctx, args, source);
      case "record_start":
        return await recordStartTool(args);
      case "record_stop":
        return await recordStopTool(ctx, source);
      case "generate_speech":
        return await generateSpeechTool(ctx, args, source);
      case "inspect_timeline":
        return await inspectTimeline(ctx.doc, args);
      case "timeline_view":
        return await timelineView(ctx.doc, args);
      case "remove_words":
        return await removeWords(ctx.doc, args);
      case "merge_clips":
        return await mergeClips(ctx.doc, args);
      case "list_projects":
        return await listProjectsTool();
      case "open_project":
        return await openProjectTool(ctx, args);
      case "new_project":
        return await newProjectTool(ctx, args);
      case "add_matte":
        return await addMatte(ctx, args);
      case "inspect_color":
        return await inspectColor(ctx.doc, args);
      case "detect_silence":
        return await detectSilence(ctx.doc, args);
      case "analyze_footage":
        return await analyzeFootageTool(ctx.doc, args);
      case "capture_frame":
        return await captureFrame(ctx, args);
      case "auto_chapters":
        return await autoChaptersTool(ctx, args);
      case "stabilize_video":
        return await enhanceTool(ctx, args, "stabilized", (src, prog) => stabilizeVideo(src, { strength: numOpt(args.strength), onProgress: prog }));
      case "denoise_video":
        return await enhanceTool(ctx, args, "denoised", (src, prog) => denoiseVideo(src, { strength: numOpt(args.strength), onProgress: prog }));
      case "deflicker_video":
        return await enhanceTool(ctx, args, "deflickered", (src, prog) => deflickerVideo(src, { onProgress: prog }));
      case "enhance_audio":
        return await enhanceTool(ctx, args, "clean audio", (src, prog) =>
          enhanceAudio(src, {
            strength: numOpt(args.strength),
            removeHum: args.removeHum !== false,
            normalize: args.normalize !== false,
            onProgress: prog,
          }),
        );
      case "duck_music":
        return await duckMusicTool(ctx, args);
      case "blur_faces":
        return await blurFacesTool(ctx, args);
      case "auto_clips":
        return await autoClipsTool(ctx, args);
      case "auto_rough_cut":
        return await autoRoughCutTool(ctx, args);
      case "detect_beats":
        return await detectBeatsTool(ctx, args);
      case "identify_speakers":
        return await identifySpeakersTool(ctx, args);
      case "set_speaker_turns":
        return await setSpeakerTurnsTool(ctx, args);
      case "sync_to_beats":
        return await syncToBeatsTool(ctx, args);
      case "save_range_as_media":
        return await saveRangeAsMedia(ctx, args);
      case "relink_media":
        return await relinkMedia(ctx, args);
      case "sync_audio":
        return await syncAudio(ctx.doc, args);
      case "reframe":
        return await reframeTool(ctx, args);
      case "auto_reframe":
        return await autoReframeTool(ctx, args);
      case "smooth_slowmo":
        return await smoothSlowMoTool(ctx, args);
      case "separate_stems":
        return await separateStemsTool(ctx, args);
      case "track_motion":
        return await trackMotionTool(ctx, args, source);
      case "remove_background":
        return await removeBackgroundTool(ctx, args);
      case "outpaint_image":
        return await outpaintTool(ctx, args);
      case "analyze_video":
        return await analyzeVideoTool(ctx, args);
      case "remember":
        return await rememberTool(args);
      case "generate_image":
        return await startGeneration(ctx, "image", args);
      case "generate_video":
        return await startGeneration(ctx, "video", args);
      case "generate_audio":
        return await startGeneration(ctx, "audio", args);
      case "upscale_media":
        return await startUpscale(ctx, args);
      case "import_media":
        return await importMedia(ctx, args);
      case "import_from_url":
        return await importFromUrlTool(ctx, args, source);
      case "cancel_export":
        // Kills the tagged ffmpeg out-of-band; the in-flight export/merge call then unwinds on its
        // own with "Export cancelled." and deletes its partial file (see export.ts).
        return ok(killTagged("export") ? "Export cancelled." : "No export is running.");
      case "export_video": {
        // Exports are USER-initiated only (explicit product decision): the agent finishing a
        // montage must hand back control, not spend minutes rendering unasked. The Export button
        // and dialog are the only entry points; auto_clips/merge keep their internal renders.
        if (source === "agent") {
          return fail(
            "Exports are user-initiated: tell the user the edit is ready and to press the Export button (top right) to render it — do not export on their behalf.",
          );
        }
        const fmt = (strOpt(args.format) ?? "mp4_h264") as ExportFormat;
        const q = strOpt(args.quality);
        const quality = (["draft", "standard", "high", "max"].includes(q ?? "") ? q : "high") as ExportQuality;
        const ext = fmt === "prores" ? "mov" : fmt === "nle_xml" ? "xml" : fmt === "fcpxml" ? "fcpxml" : "mp4";
        const raw = strOpt(args.name) ?? `export.${ext}`;
        const base = raw.replace(/\.[^.]+$/, "").replace(/[^a-zA-Z0-9._-]/g, "_") || "export";
        const name = `${base}.${ext}`;
        const res = await exportTimeline(ctx.doc, name, fmt, quality);
        if (!res.ok) return fail(res.error ?? "Export failed");
        const outName = res.path ? res.path.split(/[\\/]/).pop()! : name;
        return ok(`Exported "${outName}" (${res.durationSeconds?.toFixed(1)}s). Download: http://127.0.0.1:${BRIDGE_PORT}/exports/${outName}`);
      }
      case "punch_in":
        return ok(
          punchIn(ctx.doc, {
            clipId: String(args.clipId ?? ""),
            targetX: numOpt(args.targetX),
            targetY: numOpt(args.targetY),
            scale: numOpt(args.scale),
            startFrame: numOpt(args.startFrame),
            endFrame: numOpt(args.endFrame),
            mode: args.mode === "smooth" ? "smooth" : "cut",
            rampFrames: numOpt(args.rampFrames),
            bw: args.bw === true,
            shake: args.shake === true,
            vignette: args.vignette === true,
          }),
        );
      case "magnify":
        return ok(
          magnify(ctx.doc, {
            clipId: String(args.clipId ?? ""),
            targetX: numOpt(args.targetX),
            targetY: numOpt(args.targetY),
            zoom: numOpt(args.zoom),
            radius: numOpt(args.radius),
            feather: numOpt(args.feather),
            startFrame: numOpt(args.startFrame),
            endFrame: numOpt(args.endFrame),
          }),
        );
      case "multicam_cut":
        return ok(
          multicamCut(ctx.doc, {
            angleClipIds: Array.isArray(args.angleClipIds) ? (args.angleClipIds as unknown[]).filter((x): x is string => typeof x === "string") : [],
            cuts: args.cuts,
            audioAngle: numOpt(args.audioAngle),
          }),
        );
      case "open_compound": {
        // Bridge-level (not a TIMELINE_COMMAND): the paired close needs the bake trigger below.
        const ref = strOpt(args.clipId) ?? strOpt(args.compoundId);
        if (!ref) return fail("Provide clipId (a compound clip from get_timeline) or compoundId.");
        const opened = ctx.doc.openCompound(ref);
        if (!opened) return fail(`No compound found for '${ref}' — pass a compound clip's clipId (it has a compoundId field in get_timeline).`);
        return ok(
          `Opened compound '${opened.name}' (${opened.id}). Every tool (get_timeline, add/split/move, effects…) now operates on ITS timeline; frames restart at 0. Call close_compound to return to the main timeline.`,
        );
      }
      case "close_compound": {
        const closed = ctx.doc.closeCompound();
        if (!closed) return ok("Already on the main timeline — no compound was open.");
        // Lazy rebake so the compound clip's preview (and the next export) reflect the edits made
        // inside. Fire-and-forget: an unchanged timeline is a cache hit and costs nothing.
        void ensureCompoundBake(ctx.doc, closed.id).catch(() => {});
        return ok(`Closed compound '${closed.name}' — back on the main timeline (frames are absolute again; re-read get_timeline).`);
      }
      default: {
        const cmd = TIMELINE_COMMANDS[name];
        if (cmd) return ok(cmd(ctx.doc, args, source));
        return fail(`Unknown tool: ${name}`);
      }
    }
  } catch (e) {
    return fail(e instanceof Error ? e.message : String(e));
  }
}

// ── translate_captions ──

/** Translate the timeline's spoken segments into another language: transcribe every audio/video
 * clip, map segments through trim/speed to project frames (get_transcript's mapping, at phrase
 * granularity), translate with Claude (translate.ts), then either place translated caption clips
 * (add_captions' mechanism: one captionGroupId, new top track) or write exports/subtitles-<lang>.srt. */
/** Export the timeline's SPOKEN dialogue as a standard subtitle file in the ORIGINAL language —
 * for platform uploads (YouTube accepts SRT) and external players. Times are timeline-mapped
 * (trim/speed-aware), same collection as translate_captions but without translating. */
async function exportCaptionsTool(ctx: BridgeContext, args: Args): Promise<ToolOut> {
  const doc = ctx.doc;
  const fps = doc.timeline.fps;
  const language = strOpt(args.language);
  const cues: { startSeconds: number; endSeconds: number; text: string }[] = [];
  // A video's linked audio clip references the SAME asset — collect each spoken source once or
  // every cue comes out duplicated.
  const videoLinkGroups = new Set(
    doc.timeline.tracks.flatMap((t) => t.clips.filter((c) => c.mediaType === "video" && c.linkGroupId).map((c) => c.linkGroupId!)),
  );
  for (const t of doc.timeline.tracks) {
    for (const c of t.clips) {
      if (c.mediaType !== "video" && c.mediaType !== "audio") continue;
      if (c.mediaType === "audio" && c.linkGroupId && videoLinkGroups.has(c.linkGroupId)) continue;
      const asset = doc.asset(c.mediaRef);
      if (!asset?.url) continue;
      const tr = await transcribe(asset.url, language);
      if (!tr) continue;
      for (const seg of tr.segments) {
        const sf = sourceToProjectFrame(c, seg.start, fps);
        if (sf == null) continue;
        const ef = sourceToProjectFrame(c, seg.end, fps) ?? sf + fps;
        const text = seg.text.trim();
        if (text) cues.push({ startSeconds: sf / fps, endSeconds: Math.max(sf + 1, ef) / fps, text });
      }
    }
  }
  if (!cues.length) return fail("No speech found on the timeline to export.");
  cues.sort((a, b) => a.startSeconds - b.startSeconds);
  const file = join(exportsDir, "subtitles-original.srt");
  await Bun.write(file, toSrt(cues));
  return ok(`Wrote ${cues.length} cues to ${file} (download: http://127.0.0.1:${BRIDGE_PORT}/exports/subtitles-original.srt).`);
}

// ── dub_timeline (A7): localized voice dubbing, fully local ──────────────────
// transcribe → translate (Claude) → Piper TTS per segment → time-fit each to its window (ffmpeg
// atempo) → place on a new "Dub <lang>" audio track, aligned to the original speech → duck (or
// mute) the original voice. CapCut region-locks its dubbing; this runs offline for any language
// Piper has a voice for.
async function dubTimelineTool(ctx: BridgeContext, args: Args, source: EditSource): Promise<ToolOut> {
  const doc = ctx.doc;
  const fps = doc.timeline.fps;
  const targetLanguage = strOpt(args.targetLanguage);
  if (!targetLanguage) return fail("targetLanguage is required (e.g. 'en', 'it', 'es').");
  const voice = strOpt(args.voice) ?? targetLanguage.slice(0, 2).toLowerCase();
  const muteOriginal = args.muteOriginal === true;
  const duckTo = Math.min(1, Math.max(0, numOpt(args.duckTo) ?? 0.2));

  // Collect spoken segments (project-frame windows + text), skipping a video's linked-audio twin.
  const segs: { startFrame: number; endFrame: number; text: string; clipId: string }[] = [];
  const spokenClipIds = new Set<string>();
  const vLinkGroups = new Set(
    doc.timeline.tracks.flatMap((t) => t.clips.filter((c) => c.mediaType === "video" && c.linkGroupId).map((c) => c.linkGroupId!)),
  );
  for (const t of doc.timeline.tracks) {
    for (const c of t.clips) {
      if (c.mediaType !== "video" && c.mediaType !== "audio") continue;
      if (c.mediaType === "audio" && c.linkGroupId && vLinkGroups.has(c.linkGroupId)) continue;
      const asset = doc.asset(c.mediaRef);
      if (!asset?.url) continue;
      const tr = await transcribe(asset.url);
      if (!tr) continue;
      let spoke = false;
      for (const seg of tr.segments) {
        const sf = sourceToProjectFrame(c, seg.start, fps);
        if (sf == null) continue;
        const ef = sourceToProjectFrame(c, seg.end, fps) ?? sf + fps;
        const text = seg.text.trim();
        if (text) {
          segs.push({ startFrame: sf, endFrame: Math.max(sf + 1, ef), text, clipId: c.id });
          spoke = true;
        }
      }
      if (spoke) spokenClipIds.add(c.id);
    }
  }
  if (segs.length === 0) return fail("No speech found on the timeline to dub.");
  segs.sort((a, b) => a.startFrame - b.startFrame);

  // Translate the whole batch at once (keeps Claude's cross-segment consistency).
  let translated: string[];
  try {
    translated = await translateSegments(segs.map((s) => s.text), targetLanguage);
  } catch (e) {
    return fail(`Translation failed: ${e instanceof Error ? e.message : String(e)}`);
  }

  // Synthesize + time-fit each segment.
  const entries: { mediaRef: string; startFrame: number; durationFrames: number }[] = [];
  let fitted = 0;
  for (let i = 0; i < segs.length; i++) {
    const text = (translated[i] ?? segs[i].text).trim();
    if (!text) continue;
    let wav: string | null;
    try {
      wav = await synthesizeSpeech(text, { voice });
    } catch (e) {
      return fail(`TTS failed (voice '${voice}'): ${e instanceof Error ? e.message : String(e)}`);
    }
    if (!wav) continue;
    const windowSec = (segs[i].endFrame - segs[i].startFrame) / fps;
    const probe = await probeMedia(wav);
    const synthSec = probe.durationSeconds || windowSec;
    // Fit to the window: if the dub overruns by >5%, speed it up (atempo) up to 1.6× so lip/timing
    // stay aligned; shorter dubs just leave a natural gap.
    let finalWav = wav;
    if (synthSec > windowSec * 1.05 && windowSec > 0.2) {
      const tempo = Math.min(1.6, synthSec / windowSec);
      const fittedPath = wav.replace(/\.wav$/i, `_fit.wav`);
      const { code } = await run(FFMPEG_BIN, ["-y", "-i", wav, "-filter:a", `atempo=${tempo.toFixed(3)}`, fittedPath]);
      if (code === 0 && (await Bun.file(fittedPath).exists())) {
        finalWav = fittedPath;
        void rm(wav, { force: true }).catch(() => {});
        fitted++;
      }
    }
    // Land in the media dir + register as an asset.
    const base = `dub_${targetLanguage}_${String(i).padStart(3, "0")}`;
    let dest = join(mediaDir, `${base}.wav`);
    for (let k = 2; await Bun.file(dest).exists(); k++) dest = join(mediaDir, `${base}-${k}.wav`);
    await mkdir(mediaDir, { recursive: true });
    await rename(finalWav, dest).catch(async () => {
      await Bun.write(dest, Bun.file(finalWav));
    });
    const dp = await probeMedia(dest);
    const id = newId("asset");
    doc.addAsset({
      id,
      type: "audio",
      name: `${base}`,
      url: dest,
      durationSeconds: dp.durationSeconds,
      hasAudio: true,
    } as MediaAsset);
    void ensureAudioProxy(dest).catch(() => {});
    entries.push({ mediaRef: id, startFrame: segs[i].startFrame, durationFrames: Math.max(1, Math.round((dp.durationSeconds || windowSec) * fps)) });
  }
  if (entries.length === 0) return fail("Nothing was synthesized — check the Piper voice for this language.");

  // Place all dub clips on one new audio track (omit trackIndex).
  TIMELINE_COMMANDS.add_clips!(doc, { entries }, source);

  // Duck or mute the original spoken clips.
  doc.mutate("Dub timeline", source, () => {
    for (const t of doc.timeline.tracks) {
      for (const c of t.clips) {
        if (!spokenClipIds.has(c.id)) continue;
        c.volume = muteOriginal ? 0 : duckTo;
      }
    }
  });
  await saveProject(doc.project);

  return ok(
    `Dubbed ${entries.length} segment${entries.length === 1 ? "" : "s"} to ${targetLanguage} (voice '${voice}') on a new audio track${
      fitted ? `, ${fitted} time-fitted to stay in sync` : ""
    }. Original voice ${muteOriginal ? "muted" : `ducked to ${Math.round(duckTo * 100)}%`}. Review it, then the user exports.`,
  );
}

async function translateCaptionsTool(ctx: BridgeContext, args: Args): Promise<ToolOut> {
  const doc = ctx.doc;
  const targetLanguage = strOpt(args.targetLanguage);
  if (!targetLanguage) return fail("targetLanguage is required (e.g. 'en', 'es', 'French').");
  const mode = strOpt(args.mode) === "srt" ? "srt" : "captions";
  const onlyIds = new Set((Array.isArray(args.clipIds) ? args.clipIds : []).filter((x): x is string => typeof x === "string"));
  const fps = doc.timeline.fps;

  const cues: { startFrame: number; endFrame: number; text: string }[] = [];
  const vLinkGroups = new Set(
    doc.timeline.tracks.flatMap((t) => t.clips.filter((c) => c.mediaType === "video" && c.linkGroupId).map((c) => c.linkGroupId!)),
  );
  for (const t of doc.timeline.tracks) {
    for (const c of t.clips) {
      if (c.mediaType !== "video" && c.mediaType !== "audio") continue;
      if (c.mediaType === "audio" && c.linkGroupId && vLinkGroups.has(c.linkGroupId)) continue; // linked twin: same asset, would duplicate cues
      if (onlyIds.size > 0 && !onlyIds.has(c.id)) continue;
      const asset = doc.asset(c.mediaRef);
      if (!asset?.url) continue;
      const tr = await transcribe(asset.url);
      if (!tr) continue;
      for (const seg of tr.segments) {
        const sf = sourceToProjectFrame(c, seg.start, fps);
        if (sf == null) continue;
        const ef = sourceToProjectFrame(c, seg.end, fps) ?? sf + fps;
        const text = seg.text.trim();
        if (text) cues.push({ startFrame: sf, endFrame: Math.max(sf + 1, ef), text });
      }
    }
  }
  if (cues.length === 0) return fail(onlyIds.size > 0 ? "No speech found in the given clips." : "No speech found on the timeline to translate.");
  cues.sort((a, b) => a.startFrame - b.startFrame);

  const translated = await translateSegments(cues.map((c) => c.text), targetLanguage);

  if (mode === "srt") {
    const lang = targetLanguage.toLowerCase().replace(/[^a-z0-9-]+/g, "") || "translated";
    const name = `subtitles-${lang}.srt`;
    const dest = join(exportsDir, name);
    await Bun.write(dest, toSrt(cues.map((c, i) => ({ startSeconds: c.startFrame / fps, endSeconds: c.endFrame / fps, text: translated[i]! }))));
    return ok(`Wrote ${cues.length} translated cue(s) to ${dest}. Download: http://127.0.0.1:${BRIDGE_PORT}/exports/${name}`);
  }

  const wordsPerCue = numOpt(args.wordsPerCue);
  const karaoke = args.karaoke === true || (wordsPerCue !== undefined && wordsPerCue > 0);
  const style = {
    fontName: "Helvetica-Bold",
    fontSize: 48,
    color: "#ffffff",
    highlightColor: karaoke ? (strOpt(args.highlightColor) ?? "#FFD400") : undefined,
  };
  const groupId = newId("cap");
  let captions: Clip[];
  if (karaoke) {
    // Karaoke on a TRANSLATION: whisper timed the SOURCE words, not the translated ones, so each
    // phrase's span is distributed across its translated words proportionally by character length
    // (proportionalCueWords) — an approximation, declared in the tool description. The synthetic
    // words then flow through the same line-chunking + cue-spec path add_captions uses.
    const n = Math.max(1, Math.round(wordsPerCue ?? 4));
    const chunked: KaraokeCueWords[] = [];
    for (let i = 0; i < cues.length; i++) {
      const words = proportionalCueWords(translated[i]!, cues[i]!.startFrame, cues[i]!.endFrame);
      // Break lines by count only: synthetic word times are contiguous, so there are no real
      // pauses inside a phrase to break on — phrase boundaries themselves force the break.
      for (let base = 0; base < words.length; base += n) chunked.push(words.slice(base, base + n));
    }
    captions = karaokeCueSpecs(chunked, fps).map((spec) =>
      makeCaption(spec.text, spec.startFrame, spec.durationFrames, groupId, style, 0.5, 0.9, spec.words),
    );
  } else {
    captions = cues.map((c, i) => makeCaption(translated[i]!, c.startFrame, Math.max(1, c.endFrame - c.startFrame), groupId, style, 0.5, 0.9));
  }
  if (captions.length === 0) return fail("Translation produced no caption text to place.");
  doc.mutate("Translate Captions", "agent", () => {
    const idx = doc.insertTrack(0, "video");
    const track = doc.timeline.tracks[idx]!;
    track.clips.push(...captions);
    track.clips.sort((a, b) => a.startFrame - b.startFrame);
  });
  const karaokeNote = karaoke ? " Karaoke word timing is proportional per phrase (translations have no true word timestamps)." : "";
  return ok(`Added ${captions.length} ${targetLanguage} caption clip${captions.length === 1 ? "" : "s"} on a new track (group ${groupId}).${karaokeNote}`);
}

// ── record_start / record_stop (recorder.ts owns the ffmpeg process) ──

async function recordStartTool(args: Args): Promise<ToolOut> {
  const source = strOpt(args.source);
  if (source !== "screen" && source !== "webcam") return fail("source must be 'screen' or 'webcam'.");
  const audio = args.audio !== false; // default true = default DirectShow microphone
  const res = await startRecording(source, audio);
  return ok(`Recording ${source}${res.note} → ${res.path}. Call record_stop to finish and import it into the library.`);
}

async function recordStopTool(ctx: BridgeContext, source: EditSource): Promise<ToolOut> {
  const rec = await stopRecording();
  // Reuse the exact local-path import flow so probing, asset registration, and proxy/thumbnail
  // warming stay identical to a manual file import.
  const imported = await executeTool(ctx, "import_media", { source: { path: rec.path } }, source);
  if (imported.isError) return imported;
  const media = ctx.doc.project.media;
  let asset: MediaAsset | undefined;
  for (let i = media.length - 1; i >= 0; i--) {
    if (media[i]!.url === rec.path) {
      asset = media[i];
      break;
    }
  }
  const dur = asset?.durationSeconds ? `${Math.round(asset.durationSeconds * 10) / 10}s` : `≈${rec.seconds}s`;
  const size = asset?.sourceWidth && asset.sourceHeight ? `, ${asset.sourceWidth}x${asset.sourceHeight}` : "";
  return ok(`Stopped the ${rec.source} recording (${dur}${size}) and imported it${asset ? ` as ${asset.id}` : ""} (${rec.path}).`);
}

// ── generate_speech (local Piper TTS — tts.ts owns the piper process) ──

async function generateSpeechTool(ctx: BridgeContext, args: Args, source: EditSource): Promise<ToolOut> {
  const text = strOpt(args.text);
  if (!text) return fail("text is required — the exact words to speak.");
  const voice = strOpt(args.voice) ?? "it";
  const speed = Math.min(2, Math.max(0.5, numOpt(args.speed) ?? 1));

  let wav: string | null;
  try {
    wav = await synthesizeSpeech(text, { voice, speed });
  } catch (e) {
    return fail(e instanceof Error ? e.message : String(e));
  }
  if (!wav) return fail("text is empty after trimming — nothing to speak.");

  // Land the wav in the media dir under a stable, human-readable name (piper wrote it to a
  // scratch path in exports/), then reuse the exact local-path import flow (same as record_stop)
  // so probing and asset registration stay identical to a manual file import.
  const ts = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
  const base = (strOpt(args.name) ?? `voiceover-${ts}`).replace(/[^\p{L}\p{N} _.-]+/gu, "").trim() || `voiceover-${ts}`;
  await mkdir(mediaDir, { recursive: true });
  let dest = join(mediaDir, `${base}.wav`);
  for (let i = 2; await Bun.file(dest).exists(); i++) dest = join(mediaDir, `${base}-${i}.wav`);
  await rename(wav, dest);

  const imported = await executeTool(ctx, "import_media", { source: { path: dest } }, source);
  if (imported.isError) return imported;
  const media = ctx.doc.project.media;
  let asset: MediaAsset | undefined;
  for (let i = media.length - 1; i >= 0; i--) {
    if (media[i]!.url === dest) {
      asset = media[i];
      break;
    }
  }
  const dur = asset?.durationSeconds ? `${Math.round(asset.durationSeconds * 10) / 10}s` : "unknown duration";
  return ok(`Generated speech (voice ${voice}, speed ${speed}) and imported it${asset ? ` as ${asset.id}` : ""} (${dur}, ${dest}). Add it with add_clips — omit trackIndex to get a fresh audio track.`);
}
