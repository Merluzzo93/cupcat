import type { MediaAsset, MediaFolder } from "@cupcat/editor-core";
import { t } from "./i18n";
import { useEffect, useRef, useState } from "react";
import { importFiles, mcpCall, mediaUrl, ui, useEditor } from "./store";

/** Library video thumbnail with a spinner while the playable proxy loads — heavy or non-mp4 sources
 * (a 100 MB .mov) take a moment on first view, and a silent black tile reads as "broken".
 * A load error (proxy generation failed, or a source the webview can't decode got served) is
 * retried with backoff — the proxy may simply not be ready yet — then shown as ⚠ instead of an
 * infinite spinner. */
function VideoThumb({ assetId, className }: { assetId: string; className?: string }) {
  const [loading, setLoading] = useState(true);
  const [attempt, setAttempt] = useState(0);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    setLoading(true);
    setFailed(false);
    setAttempt(0);
  }, [assetId]);
  return (
    <div className="relative h-full w-full">
      {/* A static frame (?thumb=1), not the full scrub video proxy — thumbnails don't need per-frame
       * seeking, and requesting the heavy proxy just to paint a still image was what made opening a
       * library of several HDR .mov files spike ffmpeg CPU and take forever to show anything. */}
      <img
        src={mediaUrl(assetId) + "?thumb=1&r=" + attempt}
        className={className ?? "h-full w-full object-cover"}
        alt=""
        onLoad={() => setLoading(false)}
        onError={() => {
          if (attempt < 3) setTimeout(() => setAttempt((a) => a + 1), 2000 * (attempt + 1));
          else {
            setLoading(false);
            setFailed(true);
          }
        }}
      />
      {failed && (
        <div
          className="absolute inset-0 flex items-center justify-center bg-neutral-900/70 text-sm text-amber-400"
          title={t("media.previewUnavailable")}
        >
          ⚠
        </div>
      )}
      {loading && !failed && (
        <div className="absolute inset-0 flex items-center justify-center bg-neutral-900/70">
          <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-neutral-600 border-t-neutral-200" />
        </div>
      )}
    </div>
  );
}

// ── types ────────────────────────────────────────────────────────────────────

type GenTab = "image" | "video" | "audio";

interface ModelEntry {
  id: string;
  name: string;
  type: string;
}

interface ModelParam {
  name: string;
  type?: string;
  default?: unknown;
  required?: boolean;
}

// ── helpers ──────────────────────────────────────────────────────────────────

function isLocalPath(s: string): boolean {
  return /^[A-Za-z]:[/\\]/.test(s) || s.startsWith("/") || s.startsWith("\\\\");
}

// Human-friendly labels for raw model param names (e.g. "is_humanoid" → "Humanoid character?").
const PARAM_LABELS: Record<string, string> = {
  frame_count: "Number of frames",
  frame_size: "Frame size (px)",
  is_humanoid: "Humanoid character?",
  remove_bg: "Remove background?",
  video_tier: "Quality",
  with_sound: "Generate sound?",
  with_audio: "Generate sound?",
  voice: "Voice",
  voice_id: "Voice",
  lyrics: "Lyrics",
  instrumental: "Instrumental only?",
  negative_prompt: "Things to avoid",
  seed: "Seed (repeatability)",
  cfg_scale: "Prompt adherence",
  guidance_scale: "Prompt adherence",
  steps: "Detail steps",
  num_steps: "Detail steps",
  motion: "Motion strength",
  motion_strength: "Motion strength",
  strength: "Effect strength",
  fps: "Frames per second",
  loop: "Loop the clip?",
  enhance_prompt: "Auto-enhance prompt?",
  upscale: "Upscale?",
  style: "Style",
  quality: "Quality",
};

/** Turn a raw param name into a readable label: known mappings first, then snake/camel → Sentence case. */
function humanizeParam(name: string): string {
  if (PARAM_LABELS[name]) return PARAM_LABELS[name];
  const words = name
    .replace(/_/g, " ")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** A param that should be a Yes/No toggle rather than a free-text field. */
function isBooleanParam(p: ModelParam): boolean {
  if (p.type === "boolean") return true;
  const d = p.default;
  return d === true || d === false || d === "true" || d === "false";
}

// params already covered by dedicated UI controls (prompt textarea, settings row, reference/frame
// slots) or managed internally by the bridge — skip these in the dynamic per-model form.
const HANDLED_PARAMS = new Set([
  "prompt",
  "aspect_ratio",
  "resolution",
  "duration",
  "quality",
  "folder_id",
  "kind",
  "name",
  "image_url",
  "start_image",
  "start_image_url",
  "end_image",
  "end_image_url",
  "video_url",
  "audio_url",
  "source_video_url",
  "reference_image_url",
  "reference_video_url",
]);

function isHandledParam(name: string): boolean {
  return HANDLED_PARAMS.has(name.toLowerCase());
}

// ── MediaPanel (exported) ─────────────────────────────────────────────────────

export function MediaPanel() {
  const { project, selectedAssetIds } = useEditor();
  // Type filter: big libraries mix footage/beds/covers — one tap narrows the grid.
  const [typeFilter, setTypeFilter] = useState<"all" | "video" | "audio" | "image">("all");
  const media = (project?.media ?? []).filter((m) => typeFilter === "all" || m.type === typeFilter);
  const folders = project?.folders ?? [];
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; id: string } | null>(null);
  // Drill-down navigation: one level at a time (folder tiles + this level's media), instead of
  // every folder flattened into labeled sections. Search overrides navigation with a flat result grid.
  const [currentFolderId, setCurrentFolderId] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [folderCtx, setFolderCtx] = useState<{ x: number; y: number; id: string } | null>(null);
  // Generate is a toggleable card (✨) rather than a permanent block eating panel height.
  const [genOpen, setGenOpen] = useState<boolean>(() => localStorage.getItem("cupcat.genOpen") === "1");
  const toggleGen = () =>
    setGenOpen((v) => {
      localStorage.setItem("cupcat.genOpen", v ? "0" : "1");
      return !v;
    });

  const [roughBusy, setRoughBusy] = useState(false);
  // First Cut: assemble the current folder's footage into an editable draft (auto_rough_cut).
  const firstCut = async () => {
    if (roughBusy) return;
    setRoughBusy(true);
    try {
      await mcpCall("auto_rough_cut", { ...(currentFolderId ? { folder: currentFolderId } : {}) });
    } finally {
      setRoughBusy(false);
    }
  };

  // If the current folder vanished (deleted by the agent or another window), render root.
  const currentFolder = folders.find((f) => f.id === currentFolderId) ?? null;
  const curId = currentFolder?.id ?? null;
  const path: MediaFolder[] = [];
  for (let f: MediaFolder | null = currentFolder; f; ) {
    path.unshift(f);
    const pid: string | undefined = f.parentFolderId;
    f = pid ? (folders.find((x) => x.id === pid) ?? null) : null;
  }

  const q = search.trim().toLowerCase();
  const searching = q.length > 0;
  const subFolders = folders.filter((f) => (f.parentFolderId ?? null) === curId);
  const levelMedia = media.filter((a) => (a.folderId ?? null) === curId);
  const results = searching ? media.filter((a) => a.name.toLowerCase().includes(q)) : levelMedia;

  // Folder tile badge = direct children (all types, ignoring the type filter), like Palmier's count.
  const allMedia = project?.media ?? [];
  const folderCount = (id: string) =>
    allMedia.filter((a) => a.folderId === id).length + folders.filter((f) => f.parentFolderId === id).length;

  const dropToFolder = (folderId: string | null, e: React.DragEvent) => {
    const multi = e.dataTransfer.getData("application/x-cupcat-assets");
    const single = e.dataTransfer.getData("application/x-cupcat-asset");
    let ids: string[] = [];
    try {
      ids = multi ? (JSON.parse(multi) as string[]) : single ? [single] : [];
    } catch {
      ids = single ? [single] : [];
    }
    if (ids.length) void mcpCall("move_to_folder", { assetIds: ids, ...(folderId ? { folderId } : {}) });
  };

  const handleNewFolder = () => {
    const name = window.prompt("Folder name:", "");
    if (name && name.trim())
      void mcpCall("create_folder", { name: name.trim(), ...(curId ? { parentFolderId: curId } : {}) });
  };

  const renameFolderFromCtx = () => {
    const cur = folders.find((f) => f.id === folderCtx?.id);
    const name = window.prompt("Rename folder to:", cur?.name ?? "");
    if (name && name.trim() && folderCtx) void mcpCall("rename_folder", { folderId: folderCtx.id, name: name.trim() });
    setFolderCtx(null);
  };
  const deleteFolderFromCtx = () => {
    if (folderCtx) void mcpCall("delete_folder", { folderIds: [folderCtx.id] });
    setFolderCtx(null);
  };
  // Right-click → delete: if the clicked asset is part of a multi-selection, delete the whole set.
  const ctxIds = ctxMenu
    ? selectedAssetIds.includes(ctxMenu.id) && selectedAssetIds.length > 1
      ? selectedAssetIds
      : [ctxMenu.id]
    : [];
  // Privacy pass on a single video: the bridge finds the faces, follows them and renders an
  // anonymised copy into the library. Progress streams into the same tool-progress line the AI
  // Clips dialog uses, so a long clip doesn't look stuck.
  // Local repair passes. Each renders a NEW library asset and leaves the source alone, so the user
  // can always compare or fall back; progress streams on the shared tool-progress line.
  const runOnAsset = (tool: string) => {
    const id = ctxMenu?.id;
    setCtxMenu(null);
    if (!id) return;
    void mcpCall(tool, { media: id });
  };

  const blurFacesFromCtx = () => {
    const id = ctxMenu?.id;
    setCtxMenu(null);
    if (!id) return;
    void mcpCall("blur_faces", { media: id });
  };

  const deleteFromCtx = () => {
    if (ctxIds.length) void mcpCall("delete_media", { assetIds: ctxIds });
    setCtxMenu(null);
  };
  const renameFromCtx = () => {
    const cur = project?.media.find((m) => m.id === ctxMenu?.id);
    const name = window.prompt("Rename to:", cur?.name ?? "");
    if (name && name.trim() && ctxMenu) void mcpCall("rename_media", { mediaRef: ctxMenu.id, name: name.trim() });
    setCtxMenu(null);
  };
  const duplicateFromCtx = () => {
    if (ctxMenu) void mcpCall("duplicate_media", { mediaRef: ctxMenu.id });
    setCtxMenu(null);
  };

  // Escape closes whichever context menu is open, matching the timeline's menu behavior.
  useEffect(() => {
    if (!ctxMenu && !folderCtx) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setCtxMenu(null);
        setFolderCtx(null);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [ctxMenu, folderCtx]);

  return (
    <aside className="flex w-64 shrink-0 flex-col border-r border-neutral-800 bg-neutral-950">
      <style>{"@keyframes cc-indet { 0% { left: -35% } 100% { left: 105% } }"}</style>
      {/* ── 1) Toolbar: Import · New Folder · Generate · First Cut · Search ── */}
      <LibraryToolbar
        search={search}
        setSearch={setSearch}
        onNewFolder={handleNewFolder}
        genOpen={genOpen}
        onToggleGen={toggleGen}
        onFirstCut={firstCut}
        firstCutBusy={roughBusy}
        canFirstCut={(project?.media ?? []).some((m) => m.type === "video" && m.generationStatus.kind === "none")}
      />

      {/* ── item count + type filter chips ── */}
      <div className="flex items-center gap-1 border-b border-neutral-800 px-2 py-1.5">
        <span className="mr-auto whitespace-nowrap pl-0.5 text-[10px] tabular-nums text-neutral-500">
          {searching ? `${results.length} results` : t("media.items", { n: subFolders.length + levelMedia.length })}
        </span>
        {(["all", "video", "audio", "image"] as const).map((kind) => (
          <button
            key={kind}
            type="button"
            onClick={() => setTypeFilter(kind)}
            className={`rounded-full px-2 py-0.5 text-[10px] ${
              typeFilter === kind ? "bg-neutral-200 font-medium text-neutral-900" : "text-neutral-400 hover:bg-neutral-800"
            }`}
          >
            {t(`media.${kind}` as Parameters<typeof t>[0])}
          </button>
        ))}
      </div>

      {/* ── breadcrumb (inside a folder; also the "move to root" drop target) ── */}
      {!searching && path.length > 0 && (
        <div className="flex items-center gap-0.5 border-b border-neutral-800 px-2 py-1 text-[11px]">
          <button
            type="button"
            onClick={() => setCurrentFolderId(null)}
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => {
              e.preventDefault();
              dropToFolder(null, e);
            }}
            className="shrink-0 rounded px-1 py-0.5 text-neutral-400 hover:bg-neutral-800 hover:text-neutral-200"
            title={t("media.rootDrop")}
          >
            ‹ All
          </button>
          {path.map((f, i) => (
            <span key={f.id} className="flex min-w-0 items-center gap-0.5">
              <span className="text-neutral-600">/</span>
              {i === path.length - 1 ? (
                <span className="truncate px-1 text-neutral-200">{f.name}</span>
              ) : (
                <button
                  type="button"
                  onClick={() => setCurrentFolderId(f.id)}
                  onDragOver={(e) => e.preventDefault()}
                  onDrop={(e) => {
                    e.preventDefault();
                    dropToFolder(f.id, e);
                  }}
                  className="truncate rounded px-1 py-0.5 text-neutral-400 hover:bg-neutral-800 hover:text-neutral-200"
                >
                  {f.name}
                </button>
              )}
            </span>
          ))}
        </div>
      )}

      {/* ── 2) Scrollable level: folder tiles + media grid (or flat search results) ── */}
      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        {searching ? (
          results.length > 0 ? (
            <Grid
              assets={results}
              selectedIds={selectedAssetIds}
              onToggle={ui.toggleAsset}
              onContext={(id, x, y) => setCtxMenu({ id, x, y })}
            />
          ) : (
            <p className="px-1 py-2 text-xs leading-relaxed text-neutral-500">No media matches “{search}”.</p>
          )
        ) : (
          <>
            {subFolders.length > 0 && (
              <div className="mb-2 grid grid-cols-2 content-start gap-2">
                {subFolders.map((f) => (
                  <FolderTile
                    key={f.id}
                    folder={f}
                    count={folderCount(f.id)}
                    onOpen={() => setCurrentFolderId(f.id)}
                    onContext={(x, y) => setFolderCtx({ id: f.id, x, y })}
                    onDropAssets={(e) => dropToFolder(f.id, e)}
                  />
                ))}
              </div>
            )}
            {levelMedia.length > 0 && (
              <Grid
                assets={levelMedia}
                selectedIds={selectedAssetIds}
                onToggle={ui.toggleAsset}
                onContext={(id, x, y) => setCtxMenu({ id, x, y })}
              />
            )}
            {subFolders.length === 0 && levelMedia.length === 0 && (
              <p className="px-1 py-2 text-xs leading-relaxed text-neutral-500">
                {curId
                  ? "This folder is empty — drag media onto its tile to move files in."
                  : t("media.empty")}
              </p>
            )}
          </>
        )}
      </div>

      {/* ── 3) Generate panel (toggled by ✨) ── */}
      {genOpen && <GeneratePanel selectedAssetIds={selectedAssetIds} media={media} />}

      {ctxMenu && (
        <>
          <div
            className="fixed inset-0 z-40"
            onClick={() => setCtxMenu(null)}
            onContextMenu={(e) => {
              e.preventDefault();
              setCtxMenu(null);
            }}
          />
          <div
            className="fixed z-50 rounded-md border border-neutral-700 bg-neutral-900 py-1 text-xs shadow-xl"
            // clamped: a right-click near the bottom/right window edge must not push items off-screen
            style={{
              left: Math.max(0, Math.min(ctxMenu.x, window.innerWidth - 130)),
              top: Math.max(0, Math.min(ctxMenu.y, window.innerHeight - (ctxIds.length <= 1 ? 100 : 40))),
            }}
          >
            {ctxIds.length <= 1 && (
              <>
                <button
                  onClick={renameFromCtx}
                  className="block w-full whitespace-nowrap px-3 py-1.5 text-left text-neutral-200 hover:bg-neutral-800"
                >
                  {t("media.renameItem")}
                </button>
                <button
                  onClick={duplicateFromCtx}
                  className="block w-full whitespace-nowrap px-3 py-1.5 text-left text-neutral-200 hover:bg-neutral-800"
                >
                  {t("media.duplicate")}
                </button>
                {(() => {
                  const asset = (project?.media ?? []).find((m) => m.id === ctxMenu.id);
                  if (!asset) return null;
                  const isVideo = asset.type === "video";
                  const hasAudio = isVideo ? asset.hasAudio !== false : asset.type === "audio";
                  const Item = ({ tool, label, hint }: { tool: string; label: string; hint: string }) => (
                    <button
                      onClick={() => runOnAsset(tool)}
                      title={hint}
                      className="block w-full whitespace-nowrap px-3 py-1.5 text-left text-neutral-200 hover:bg-neutral-800"
                    >
                      {label}
                    </button>
                  );
                  return (
                    <>
                      <div className="my-1 border-t border-neutral-800" />
                      {isVideo && (
                        <button
                          onClick={blurFacesFromCtx}
                          title={t("media.blurFacesHint")}
                          className="block w-full whitespace-nowrap px-3 py-1.5 text-left text-neutral-200 hover:bg-neutral-800"
                        >
                          {t("media.blurFaces")}
                        </button>
                      )}
                      {isVideo && <Item tool="stabilize_video" label={t("media.stabilize")} hint={t("media.stabilizeHint")} />}
                      {isVideo && <Item tool="denoise_video" label={t("media.removeGrain")} hint={t("media.removeGrainHint")} />}
                      {hasAudio && <Item tool="enhance_audio" label={t("media.cleanAudio")} hint={t("media.cleanAudioHint")} />}
                      {isVideo && hasAudio && <Item tool="auto_chapters" label={t("media.chapters")} hint={t("media.chaptersHint")} />}
                    </>
                  );
                })()}
              </>
            )}
            <button
              onClick={deleteFromCtx}
              className="block w-full whitespace-nowrap px-3 py-1.5 text-left text-red-400 hover:bg-neutral-800"
            >
              {ctxIds.length > 1 ? t("media.deleteN", { n: ctxIds.length }) : t("common.delete")}
            </button>
          </div>
        </>
      )}

      {folderCtx && (
        <>
          <div
            className="fixed inset-0 z-40"
            onClick={() => setFolderCtx(null)}
            onContextMenu={(e) => {
              e.preventDefault();
              setFolderCtx(null);
            }}
          />
          <div
            className="fixed z-50 rounded-md border border-neutral-700 bg-neutral-900 py-1 text-xs shadow-xl"
            style={{
              left: Math.max(0, Math.min(folderCtx.x, window.innerWidth - 130)),
              top: Math.max(0, Math.min(folderCtx.y, window.innerHeight - 100)),
            }}
          >
            <button
              onClick={() => {
                setCurrentFolderId(folderCtx.id);
                setFolderCtx(null);
              }}
              className="block w-full whitespace-nowrap px-3 py-1.5 text-left text-neutral-200 hover:bg-neutral-800"
            >
              Open
            </button>
            <button
              onClick={renameFolderFromCtx}
              className="block w-full whitespace-nowrap px-3 py-1.5 text-left text-neutral-200 hover:bg-neutral-800"
            >
              Rename…
            </button>
            <button
              onClick={deleteFolderFromCtx}
              className="block w-full whitespace-nowrap px-3 py-1.5 text-left text-red-400 hover:bg-neutral-800"
            >
              Delete folder
            </button>
          </div>
        </>
      )}
    </aside>
  );
}

// ── LibraryToolbar ────────────────────────────────────────────────────────────
// Palmier-style single row: {t("media.import")} · new-folder · ✨ generate toggle · search.
// The import pickers (files / folder / path / URL) live in the collapsible section below it.

function LibraryToolbar({
  search,
  setSearch,
  onNewFolder,
  genOpen,
  onToggleGen,
  onFirstCut,
  firstCutBusy,
  canFirstCut,
}: {
  search: string;
  setSearch: (v: string) => void;
  onNewFolder: () => void;
  genOpen: boolean;
  onToggleGen: () => void;
  onFirstCut: () => void;
  firstCutBusy: boolean;
  canFirstCut: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [source, setSource] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) setTimeout(() => inputRef.current?.focus(), 50);
  }, [open]);

  async function handleImport() {
    const trimmed = source.trim();
    if (!trimmed) return;
    setBusy(true);
    setError(null);
    try {
      const src = isLocalPath(trimmed) ? { path: trimmed } : { url: trimmed };
      const res = await mcpCall("import_media", { source: src });
      if (res.isError) {
        setError(res.text);
      } else {
        setSource("");
        setOpen(false);
      }
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  const [videoUrl, setVideoUrl] = useState("");
  const [urlBusy, setUrlBusy] = useState(false);
  const [urlError, setUrlError] = useState<string | null>(null);

  async function handleUrlImport() {
    const u = videoUrl.trim();
    if (!u || urlBusy) return;
    setUrlBusy(true);
    setUrlError(null);
    try {
      const res = await mcpCall("import_from_url", { url: u });
      if (res.isError) {
        setUrlError(res.text);
      } else {
        setVideoUrl("");
        setOpen(false);
      }
    } catch (e) {
      setUrlError(String(e));
    } finally {
      setUrlBusy(false);
    }
  }

  const fileRef = useRef<HTMLInputElement>(null);
  const folderRef = useRef<HTMLInputElement>(null);
  // webkitdirectory isn't a typed React attribute — set it on the DOM node.
  useEffect(() => {
    folderRef.current?.setAttribute("webkitdirectory", "");
  }, []);

  async function handleFiles(list: FileList | null) {
    if (!list || !list.length) return;
    setBusy(true);
    setError(null);
    const n = await importFiles(list);
    setBusy(false);
    if (n > 0) setOpen(false);
    else setError("Could not import the selected files.");
  }

  return (
    <div className="shrink-0 border-b border-neutral-800">
      <div className="flex items-center gap-1 px-2 py-1.5">
        <button
          onClick={() => {
            setOpen((v) => !v);
            setError(null);
          }}
          title={t("media.importHint")}
          className={`shrink-0 rounded px-1.5 py-1 text-[11px] transition-colors ${
            open ? "bg-neutral-800 text-neutral-100" : "text-neutral-400 hover:bg-neutral-800 hover:text-neutral-200"
          }`}
        >
          {t("media.import")}
        </button>
        <button
          onClick={onNewFolder}
          title={t("media.newFolder")}
          className="shrink-0 rounded p-1 text-neutral-400 transition-colors hover:bg-neutral-800 hover:text-neutral-200"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <path d="M4 20h16a1 1 0 0 0 1-1V8a1 1 0 0 0-1-1h-8.6a1 1 0 0 1-.8-.4L9.2 4.9a1 1 0 0 0-.8-.4H4a1 1 0 0 0-1 1V19a1 1 0 0 0 1 1Z" />
            <path d="M12 11v6M9 14h6" />
          </svg>
        </button>
        <button
          onClick={onToggleGen}
          title={genOpen ? "Hide the Generate panel" : "Generate media (Higgsfield)"}
          className={`shrink-0 rounded p-1 transition-colors ${
            genOpen ? "bg-neutral-800 text-amber-300" : "text-neutral-400 hover:bg-neutral-800 hover:text-neutral-200"
          }`}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
            <path d="M12 2.5l1.8 5.4 5.4 1.8-5.4 1.8L12 16.9l-1.8-5.4-5.4-1.8 5.4-1.8L12 2.5zM19 14l.9 2.6L22.5 18l-2.6.9L19 21.5l-.9-2.6-2.6-.9 2.6-.9L19 14zM5 15l.7 2 2 .7-2 .7-.7 2-.7-2-2-.7 2-.7.7-2z" />
          </svg>
        </button>
        {canFirstCut && (
          <button
            onClick={onFirstCut}
            disabled={firstCutBusy}
            title={t("media.firstCutHint")}
            className="shrink-0 whitespace-nowrap rounded px-1.5 py-1 text-[11px] text-neutral-400 transition-colors hover:bg-neutral-800 hover:text-neutral-200 disabled:opacity-50"
          >
            {firstCutBusy ? t("media.cutting") : `✂ ${t("media.firstCut")}`}
          </button>
        )}
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder={t("media.search")}
          className="min-w-0 flex-1 rounded-md border border-neutral-800 bg-neutral-900 px-2 py-1 text-[11px] text-neutral-200 placeholder-neutral-600 outline-none focus:border-neutral-600"
        />
      </div>

      {open && (
        <div className="px-3 pb-3 space-y-1.5">
          <div className="flex gap-1.5">
            <button
              onClick={() => fileRef.current?.click()}
              disabled={busy}
              className="flex-1 rounded-md bg-neutral-800 py-1 text-xs text-neutral-200 hover:bg-neutral-700 disabled:opacity-40 transition-colors"
            >
              {busy ? "Adding…" : "Choose files"}
            </button>
            <button
              onClick={() => folderRef.current?.click()}
              disabled={busy}
              className="flex-1 rounded-md bg-neutral-800 py-1 text-xs text-neutral-200 hover:bg-neutral-700 disabled:opacity-40 transition-colors"
            >
              Choose folder
            </button>
          </div>
          <input
            ref={fileRef}
            type="file"
            multiple
            accept="image/*,video/*,audio/*"
            className="hidden"
            onChange={(e) => {
              void handleFiles(e.target.files);
              e.currentTarget.value = "";
            }}
          />
          <input
            ref={folderRef}
            type="file"
            multiple
            className="hidden"
            onChange={(e) => {
              void handleFiles(e.target.files);
              e.currentTarget.value = "";
            }}
          />
          <p className="text-[10px] text-neutral-600">or paste a file path / URL:</p>
          <input
            ref={inputRef}
            value={source}
            onChange={(e) => setSource(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleImport()}
            placeholder={t("media.pathOrUrl")}
            className="w-full rounded-md border border-neutral-700 bg-neutral-900 px-2 py-1 text-xs text-neutral-200 placeholder-neutral-600 outline-none focus:border-neutral-500"
          />
          {error && <p className="text-[11px] text-red-400">{error}</p>}
          <button
            onClick={handleImport}
            disabled={busy || !source.trim()}
            className="w-full rounded-md bg-neutral-800 py-1 text-xs text-neutral-200 hover:bg-neutral-700 disabled:opacity-40 transition-colors"
          >
            {busy ? "Adding…" : "Add"}
          </button>
          <p className="text-[10px] text-neutral-600">or download from the web (YouTube, Vimeo…):</p>
          <div className="flex gap-1.5">
            <input
              value={videoUrl}
              onChange={(e) => setVideoUrl(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && void handleUrlImport()}
              disabled={urlBusy}
              placeholder={t("media.pasteUrl")}
              className="min-w-0 flex-1 rounded-md border border-neutral-700 bg-neutral-900 px-2 py-1 text-xs text-neutral-200 placeholder-neutral-600 outline-none focus:border-neutral-500 disabled:opacity-40"
            />
            <button
              onClick={() => void handleUrlImport()}
              disabled={urlBusy || !videoUrl.trim()}
              title={t("media.downloadImport")}
              className="shrink-0 rounded-md bg-neutral-800 px-2 py-1 text-xs text-neutral-200 hover:bg-neutral-700 disabled:opacity-40 transition-colors"
            >
              {urlBusy ? "…" : "⤓"}
            </button>
          </div>
          {urlBusy && <p className="text-[10px] text-neutral-500">{t("media.downloading")}</p>}
          {urlError && <p className="text-[11px] text-red-400">{urlError}</p>}
        </div>
      )}
    </div>
  );
}

// ── Grid + MediaCard ──────────────────────────────────────────────────────────

function Grid({
  assets,
  selectedIds,
  onToggle,
  onContext,
}: {
  assets: MediaAsset[];
  selectedIds: string[];
  onToggle: (id: string, additive: boolean) => void;
  onContext: (id: string, x: number, y: number) => void;
}) {
  return (
    <div className="grid grid-cols-2 content-start gap-2">
      {assets.map((a) => (
        <MediaCard
          key={a.id}
          asset={a}
          selected={selectedIds.includes(a.id)}
          selectedIds={selectedIds}
          onToggle={onToggle}
          onContext={onContext}
        />
      ))}
    </div>
  );
}

/** mm:ss chip text for the tile corner (empty for stills / unknown). */
function fmtDur(s: number): string {
  if (!s || !Number.isFinite(s) || s <= 0) return "";
  const t = Math.round(s);
  const m = Math.floor(t / 60);
  const sec = t % 60;
  return `${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
}

function MediaCard({
  asset,
  selected,
  selectedIds,
  onToggle,
  onContext,
}: {
  asset: MediaAsset;
  selected: boolean;
  selectedIds: string[];
  onToggle: (id: string, additive: boolean) => void;
  onContext: (id: string, x: number, y: number) => void;
}) {
  const status = asset.generationStatus.kind;
  const ready = status === "none";

  return (
    <div
      onClick={(e) => onToggle(asset.id, e.metaKey || e.ctrlKey || e.shiftKey)}
      onDoubleClick={() => {
        if (ready) ui.openSource(asset.id); // opens as a source tab above the monitor
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        onContext(asset.id, e.clientX, e.clientY);
      }}
      draggable={ready}
      onDragStart={(e) => {
        // Drag onto the timeline (single id) or into the chat. If this card is part of a multi-
        // selection, carry ALL selected ids so the whole set drops into the assistant at once.
        const ids = selected && selectedIds.length > 1 ? selectedIds : [asset.id];
        e.dataTransfer.setData("application/x-cupcat-asset", asset.id); // single (timeline)
        e.dataTransfer.setData("application/x-cupcat-assets", JSON.stringify(ids)); // multi (chat)
        e.dataTransfer.setData("text/plain", asset.id);
        e.dataTransfer.effectAllowed = "copy";
      }}
      className="group cursor-pointer text-[11px]"
    >
      {/* thumbnail card — selection is the Palmier blue bar flush with the bottom edge */}
      <div
        className={[
          "relative flex aspect-video items-center justify-center overflow-hidden rounded-md bg-neutral-900 transition-shadow",
          selected ? "ring-1 ring-sky-400/70" : "ring-1 ring-neutral-800 group-hover:ring-neutral-600",
        ].join(" ")}
      >
        {ready && asset.type === "image" && (
          <img src={mediaUrl(asset.id)} alt={asset.name} className="h-full w-full object-cover" />
        )}
        {ready && asset.type === "video" && <VideoThumb assetId={asset.id} />}
        {ready && asset.type === "audio" && <span className="text-lg text-neutral-500">♪</span>}
        {!ready && (
          <div className="flex w-full flex-col items-center gap-1.5 px-2">
            <span
              className={`text-center text-[10px] leading-snug ${
                status === "failed" ? "text-red-400" : "text-neutral-300"
              }`}
            >
              {status === "failed" ? "Failed" : "Generating…"}
            </span>
            {status !== "failed" && (
              <span className="relative block h-0.5 w-3/4 overflow-hidden rounded bg-neutral-700">
                <span
                  className="absolute inset-y-0 w-1/3 rounded bg-neutral-200"
                  style={{ animation: "cc-indet 1.2s ease-in-out infinite" }}
                />
              </span>
            )}
          </div>
        )}

        {/* AI badge */}
        {asset.generationInput && (
          <span className="absolute left-1 top-1 rounded bg-neutral-950/80 px-1 py-0.5 text-[9px] leading-none text-neutral-200">
            AI
          </span>
        )}

        {/* duration chip */}
        {ready && asset.type !== "image" && fmtDur(asset.durationSeconds) && (
          <span className="absolute bottom-1 right-1 rounded bg-neutral-950/80 px-1 py-0.5 text-[9px] leading-none tabular-nums text-neutral-200">
            {fmtDur(asset.durationSeconds)}
          </span>
        )}

        {/* hover: add as chat reference */}
        {ready && (
          <button
            type="button"
            title={t("media.addAsRef")}
            onClick={(e) => {
              e.stopPropagation();
              if (!selected) onToggle(asset.id, true);
            }}
            className="absolute right-1 top-1 rounded bg-neutral-950/80 p-1 leading-none text-neutral-300 opacity-0 transition-opacity hover:text-neutral-100 group-hover:opacity-100"
          >
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 11.5a8.4 8.4 0 0 1-8.5 8.3 8.7 8.7 0 0 1-3.7-.8L3 21l2-5.4a8.1 8.1 0 0 1-1-3.9A8.4 8.4 0 0 1 12.5 3.4 8.4 8.4 0 0 1 21 11.5Z" />
            </svg>
          </button>
        )}

        {/* selection bar */}
        {selected && <span className="absolute inset-x-0 bottom-0 h-[3px] bg-sky-400" />}
      </div>

      {/* name */}
      <div
        className={`truncate px-1 pt-1 text-center text-[10px] ${selected ? "text-neutral-100" : "text-neutral-400"}`}
        title={asset.name}
      >
        {asset.name}
      </div>
    </div>
  );
}

// ── FolderTile ────────────────────────────────────────────────────────────────
// Palmier-style folder tile: macOS-like glyph, item-count badge, name below.
// Click opens the folder; assets can be dragged onto it to move them in.

function FolderTile({
  folder,
  count,
  onOpen,
  onContext,
  onDropAssets,
}: {
  folder: MediaFolder;
  count: number;
  onOpen: () => void;
  onContext: (x: number, y: number) => void;
  onDropAssets: (e: React.DragEvent) => void;
}) {
  const [dragOver, setDragOver] = useState(false);
  return (
    <button
      type="button"
      onClick={onOpen}
      onContextMenu={(e) => {
        e.preventDefault();
        onContext(e.clientX, e.clientY);
      }}
      onDragOver={(e) => {
        e.preventDefault();
        setDragOver(true);
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragOver(false);
        onDropAssets(e);
      }}
      className={`relative flex flex-col items-center rounded-md px-1 pb-1.5 pt-2 transition-colors ${
        dragOver ? "bg-sky-500/15 ring-1 ring-sky-400/60" : "hover:bg-neutral-900"
      }`}
      title={folder.name}
    >
      <span className="absolute right-1.5 top-1 text-[9px] tabular-nums text-neutral-500">{count}</span>
      <svg width="44" height="36" viewBox="0 0 44 36" aria-hidden="true">
        <path
          d="M3 7a3 3 0 0 1 3-3h9.3a3 3 0 0 1 2.2 1l2 2.1H38a3 3 0 0 1 3 3V29a3 3 0 0 1-3 3H6a3 3 0 0 1-3-3V7Z"
          fill="#cfc5b4"
        />
        <path d="M3 13h38v16a3 3 0 0 1-3 3H6a3 3 0 0 1-3-3V13Z" fill="#e6ddcd" />
      </svg>
      <span className="mt-1 w-full truncate text-center text-[10px] text-neutral-300">{folder.name}</span>
    </button>
  );
}

// ── GeneratePanel ─────────────────────────────────────────────────────────────

const ASPECT_RATIOS = ["16:9", "9:16", "1:1", "4:5"] as const;
const DURATIONS = [4, 6, 8] as const;

function GeneratePanel({
  selectedAssetIds,
  media,
}: {
  selectedAssetIds: string[];
  media: MediaAsset[];
}) {
  const { canGenerate } = useEditor();

  const [tab, setTab] = useState<GenTab>("image");
  const [prompt, setPrompt] = useState("");
  const [name, setName] = useState("");
  const [aspectRatio, setAspectRatio] = useState<string>("16:9");
  const [duration, setDuration] = useState<number>(4);
  const [modelId, setModelId] = useState<string>("");
  const [models, setModels] = useState<ModelEntry[]>([]);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [modelsCache, setModelsCache] = useState<Partial<Record<GenTab, ModelEntry[]>>>({});

  // dynamic per-model params (voice, voice_id, lyrics, instrumental, …)
  const [modelParams, setModelParams] = useState<ModelParam[]>([]);
  const [paramValues, setParamValues] = useState<Record<string, string | number>>({});
  const [paramsLoading, setParamsLoading] = useState(false);

  // video frame refs
  const [firstFrameId, setFirstFrameId] = useState<string | null>(null);
  const [lastFrameId, setLastFrameId] = useState<string | null>(null);

  const [busy, setBusy] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false); // duration/aspect chip popover

  // The raw Higgsfield catalog is noisy: literal duplicate labels and an alphabetical order that
  // puts oddities first ("AutoSprite Animation" as the image default, an UPSCALER as the video
  // default). Dedup by label and float a sensible flagship to the top per tab.
  const curateModels = (list: ModelEntry[], forTab: string): ModelEntry[] => {
    const seen = new Set<string>();
    const deduped = list.filter((m) => {
      const key = (m.name ?? m.id).trim().toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    const preferred: Record<string, string[]> = {
      image: ["gpt image", "nano banana", "soul"],
      video: ["seedance", "kling", "veo"],
      audio: ["speech", "voice", "music"],
    };
    const prefs = preferred[forTab] ?? [];
    const rank = (m: ModelEntry) => {
      const l = (m.name ?? m.id).toLowerCase();
      const i = prefs.findIndex((p) => l.includes(p));
      const penalty = /upscale|reframe|sprite/.test(l) ? 100 : 0; // utilities never default
      return (i === -1 ? prefs.length : i) + penalty;
    };
    return [...deduped].sort((a, b) => rank(a) - rank(b));
  };

  // load models on tab change
  useEffect(() => {
    let cancelled = false;

    async function load() {
      if (modelsCache[tab]) {
        const cached = modelsCache[tab]!;
        setModels(cached);
        setModelId(cached[0]?.id ?? "");
        return;
      }
      setModelsLoading(true);
      setModels([]);
      setModelId("");
      try {
        const res = await mcpCall("list_models", { type: tab });
        if (cancelled) return;
        let list: ModelEntry[] = [];
        try {
          const parsed = JSON.parse(res.text) as { models?: ModelEntry[] };
          list = parsed.models ?? [];
        } catch {
          list = [];
        }
        // if audio returned nothing, try unfiltered and filter by type=audio
        if (tab === "audio" && list.length === 0) {
          const res2 = await mcpCall("list_models", {});
          if (!cancelled) {
            try {
              const parsed2 = JSON.parse(res2.text) as { models?: ModelEntry[] };
              list = (parsed2.models ?? []).filter((m) => m.type === "audio");
            } catch {
              list = [];
            }
          }
        }
        if (cancelled) return;
        list = curateModels(list, tab);
        setModelsCache((prev) => ({ ...prev, [tab]: list }));
        setModels(list);
        setModelId(list[0]?.id ?? "");
      } catch {
        if (!cancelled) setModels([]);
      } finally {
        if (!cancelled) setModelsLoading(false);
      }
    }

    load();
    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab]);

  // clear frame refs when switching away from video
  useEffect(() => {
    if (tab !== "video") {
      setFirstFrameId(null);
      setLastFrameId(null);
    }
  }, [tab]);

  // when the selected model changes, fetch its param spec and reset values
  useEffect(() => {
    let cancelled = false;
    setModelParams([]);
    setParamValues({});
    if (!modelId) {
      setParamsLoading(false);
      return;
    }
    setParamsLoading(true);

    (async () => {
      try {
        const res = await mcpCall("list_models", { model: modelId });
        if (cancelled) return;
        let params: ModelParam[] = [];
        try {
          const parsed = JSON.parse(res.text) as { params?: ModelParam[] };
          params = Array.isArray(parsed.params) ? parsed.params : [];
        } catch {
          params = [];
        }
        const extra = params.filter((p) => p?.name && !isHandledParam(p.name));
        if (cancelled) return;
        setModelParams(extra);
        // seed values from non-null defaults
        const seed: Record<string, string | number> = {};
        for (const p of extra) {
          if (p.default !== null && p.default !== undefined) {
            seed[p.name] = p.type === "number" ? Number(p.default) : String(p.default);
          }
        }
        setParamValues(seed);
      } catch {
        if (!cancelled) setModelParams([]);
      } finally {
        if (!cancelled) setParamsLoading(false);
      }
    })();

    return () => { cancelled = true; };
  }, [modelId]);

  // required model params (other than prompt, which the textarea covers) that are still empty
  const missingRequired = modelParams
    .filter((p) => p.required && !isHandledParam(p.name))
    .filter((p) => {
      const v = paramValues[p.name];
      return v === undefined || v === "" || (typeof v === "number" && Number.isNaN(v));
    })
    .map((p) => p.name);

  const selectedAssets = selectedAssetIds
    .map((id) => media.find((a) => a.id === id))
    .filter((a): a is MediaAsset => a !== undefined);

  // for image: all selected = referenceMediaRefs
  // for video: first/last frame are pinned; remaining selected = referenceImageMediaRefs
  const videoRefs = selectedAssets.filter(
    (a) => a.id !== firstFrameId && a.id !== lastFrameId,
  );

  async function handleGenerate() {
    if (busy || !prompt.trim()) return;
    setBusy(true);
    setErrorMsg(null);
    try {
      const toolName =
        tab === "image"
          ? "generate_image"
          : tab === "video"
          ? "generate_video"
          : "generate_audio";

      // collected model-specific params (voice, voice_id, lyrics, …)
      const params: Record<string, string | number> = { ...paramValues };

      const baseArgs: Record<string, unknown> = {
        prompt: prompt.trim(),
        ...(name.trim() ? { name: name.trim() } : {}),
        ...(modelId ? { model: modelId } : {}),
      };

      if (tab === "image") {
        baseArgs.aspectRatio = aspectRatio;
        const refs = selectedAssets.map((a) => a.id);
        if (refs.length) baseArgs.referenceMediaRefs = refs;
      } else if (tab === "video") {
        baseArgs.aspectRatio = aspectRatio;
        baseArgs.duration = duration;
        if (firstFrameId) baseArgs.startFrameMediaRef = firstFrameId;
        if (lastFrameId) baseArgs.endFrameMediaRef = lastFrameId;
        const refs = videoRefs.map((a) => a.id);
        if (refs.length) baseArgs.referenceImageMediaRefs = refs;
      } else {
        // audio — no frame refs, no aspect ratio
        baseArgs.duration = duration;
      }

      // always include the dynamic model params object
      baseArgs.params = params;

      const res = await mcpCall(toolName, baseArgs);
      if (res.isError) {
        setErrorMsg(res.text);
      } else {
        setPrompt("");
        setName("");
      }
    } catch (e) {
      setErrorMsg(String(e));
    } finally {
      setBusy(false);
    }
  }

  const canSubmit =
    canGenerate && !!prompt.trim() && !busy && !!modelId && missingRequired.length === 0;

  return (
    <div className="shrink-0 border-t border-neutral-800 bg-neutral-950">
      {/* tabs */}
      <div className="flex border-b border-neutral-800">
        {(["image", "video", "audio"] as GenTab[]).map((t) => (
          <button
            key={t}
            onClick={() => { setTab(t); setErrorMsg(null); }}
            className={[
              "flex-1 py-1.5 text-[11px] font-medium capitalize transition-colors",
              tab === t
                ? "border-b-2 border-neutral-200 text-neutral-100"
                : "text-neutral-500 hover:text-neutral-300",
            ].join(" ")}
          >
            {t}
          </button>
        ))}
      </div>

      <div className="space-y-2 p-2.5">
        {/* ── references ── */}
        {tab === "image" && selectedAssets.length > 0 && (
          <div className="space-y-1">
            <span className="text-[10px] text-neutral-500">{t("media.references")}</span>
            <RefStrip assets={selectedAssets} />
          </div>
        )}

        {tab === "video" && (
          <div className="space-y-1.5">
            {/* first / last frame */}
            <div className="flex gap-1.5">
              <FrameSlot
                label={t("lb.firstFrame")}
                assetId={firstFrameId}
                media={media}
                onSet={() => {
                  const id = selectedAssets[0]?.id ?? null;
                  setFirstFrameId((prev) => (prev === id ? null : id));
                }}
                onClear={() => setFirstFrameId(null)}
              />
              <FrameSlot
                label={t("lb.lastFrame")}
                assetId={lastFrameId}
                media={media}
                onSet={() => {
                  const id = selectedAssets[0]?.id ?? null;
                  setLastFrameId((prev) => (prev === id ? null : id));
                }}
                onClear={() => setLastFrameId(null)}
              />
            </div>
            {/* remaining refs */}
            {videoRefs.length > 0 && (
              <div className="space-y-1">
                <span className="text-[10px] text-neutral-500">{t("media.references")}</span>
                <RefStrip assets={videoRefs} />
              </div>
            )}
          </div>
        )}

        {/* name */}
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={t("media.nameOptional")}
          className="w-full rounded-md border border-neutral-800 bg-neutral-900 px-2 py-1 text-xs text-neutral-200 placeholder-neutral-600 outline-none focus:border-neutral-600"
        />

        {/* prompt */}
        {tab === "audio" && (
          <span className="block text-[10px] text-neutral-500">{t("media.textToSpeak")}</span>
        )}
        <textarea
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          placeholder={
            tab === "image"
              ? "Describe the image…"
              : tab === "video"
              ? "Describe the video…"
              : "Describe the sound or enter lyrics/text…"
          }
          rows={3}
          className="w-full resize-none rounded-md border border-neutral-800 bg-neutral-900 px-2 py-1.5 text-xs text-neutral-200 placeholder-neutral-600 outline-none focus:border-neutral-600"
        />

        {/* dynamic per-model params (voice, voice_id, lyrics, instrumental, …) */}
        {paramsLoading && (
          <p className="text-[10px] text-neutral-600">{t("media.loadingSettings")}</p>
        )}
        {!paramsLoading && modelParams.length > 0 && (
          <div className="space-y-1.5">
            {modelParams.map((p) => {
              const isNumber = p.type === "number";
              const isBool = isBooleanParam(p);
              const raw = paramValues[p.name];
              const setVal = (v: string) =>
                setParamValues((prev) => {
                  const next = { ...prev };
                  if (v === "") delete next[p.name];
                  else next[p.name] = isNumber ? Number(v) : v;
                  return next;
                });
              const label = humanizeParam(p.name);
              return (
                <div key={p.name} className="space-y-0.5">
                  <label className="block text-[10px] text-neutral-500">
                    {label}
                    {p.required && <span className="text-red-400"> *</span>}
                  </label>
                  {isBool ? (
                    <select
                      value={raw === undefined ? "" : String(raw)}
                      onChange={(e) => setVal(e.target.value)}
                      className="w-full rounded-md border border-neutral-800 bg-neutral-900 px-2 py-1 text-[11px] text-neutral-200 outline-none focus:border-neutral-600"
                    >
                      <option value="true">{t("common.yes")}</option>
                      <option value="false">No</option>
                    </select>
                  ) : (
                    <input
                      type={isNumber ? "number" : "text"}
                      value={raw === undefined ? "" : String(raw)}
                      onChange={(e) => setVal(e.target.value)}
                      placeholder={label}
                      className="w-full rounded-md border border-neutral-800 bg-neutral-900 px-2 py-1 text-[11px] text-neutral-200 placeholder-neutral-600 outline-none focus:border-neutral-600"
                    />
                  )}
                </div>
              );
            })}
          </div>
        )}

        {/* missing-required hint */}
        {missingRequired.length > 0 && (
          <p className="text-[11px] leading-snug text-neutral-500">
            Required: {missingRequired.map((n) => humanizeParam(n)).join(", ")}
          </p>
        )}

        {/* error */}
        {errorMsg && (
          <p className="text-[11px] leading-snug text-red-400">{errorMsg}</p>
        )}

        {/* not-signed-in hint */}
        {!canGenerate && (
          <p className="text-[11px] leading-snug text-neutral-500">
            Sign in to Higgsfield to generate.
          </p>
        )}

        {/* footer — Palmier-style: model ⌄ · settings summary (chip popover) · round ↑ submit */}
        <div className="relative flex items-center gap-1.5 pt-0.5">
          {settingsOpen && (
            <>
              <div className="fixed inset-0 z-30" onClick={() => setSettingsOpen(false)} />
              <div className="absolute bottom-full left-0 z-40 mb-1.5 w-60 rounded-lg border border-neutral-700 bg-neutral-900 p-2.5 shadow-2xl">
                {(tab === "video" || tab === "audio") && (
                  <div className="mb-2">
                    <div className="mb-1 text-[10px] font-medium uppercase tracking-wide text-neutral-500">{t("media.duration")}</div>
                    <div className="flex flex-wrap gap-1">
                      {DURATIONS.map((d) => (
                        <button
                          key={d}
                          type="button"
                          onClick={() => setDuration(d)}
                          className={`rounded-md px-2.5 py-1 text-[11px] transition-colors ${
                            duration === d
                              ? "bg-neutral-200 font-medium text-neutral-900"
                              : "bg-neutral-800 text-neutral-300 hover:bg-neutral-700"
                          }`}
                        >
                          {d}s
                        </button>
                      ))}
                    </div>
                  </div>
                )}
                {(tab === "image" || tab === "video") && (
                  <div>
                    <div className="mb-1 text-[10px] font-medium uppercase tracking-wide text-neutral-500">{t("media.aspect")}</div>
                    <div className="flex flex-wrap gap-1">
                      {ASPECT_RATIOS.map((r) => (
                        <button
                          key={r}
                          type="button"
                          onClick={() => setAspectRatio(r)}
                          className={`rounded-md px-2.5 py-1 text-[11px] tabular-nums transition-colors ${
                            aspectRatio === r
                              ? "bg-neutral-200 font-medium text-neutral-900"
                              : "bg-neutral-800 text-neutral-300 hover:bg-neutral-700"
                          }`}
                        >
                          {r}
                        </button>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            </>
          )}
          <select
            value={modelId}
            onChange={(e) => setModelId(e.target.value)}
            disabled={modelsLoading || models.length === 0}
            className="min-w-0 flex-1 rounded-md border border-neutral-800 bg-neutral-900 px-1.5 py-1 text-[11px] text-neutral-300 outline-none focus:border-neutral-600 disabled:opacity-50"
          >
            {modelsLoading && <option value="">{t("media.loadingModels")}</option>}
            {!modelsLoading && models.length === 0 && <option value="">{t("media.noModels")}</option>}
            {models.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
              </option>
            ))}
          </select>
          <button
            type="button"
            onClick={() => setSettingsOpen((v) => !v)}
            title={t("media.genSettings")}
            className={`shrink-0 rounded-md border px-1.5 py-1 text-[10px] tabular-nums transition-colors ${
              settingsOpen
                ? "border-neutral-500 bg-neutral-800 text-neutral-200"
                : "border-neutral-800 bg-neutral-900 text-neutral-400 hover:border-neutral-600"
            }`}
          >
            {tab === "image" ? aspectRatio : tab === "video" ? `${aspectRatio} · ${duration}s` : `${duration}s`}
          </button>
          <button
            onClick={handleGenerate}
            disabled={!canSubmit}
            title={t("media.generate")}
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-neutral-200 text-neutral-900 transition hover:bg-white disabled:cursor-not-allowed disabled:bg-neutral-700 disabled:text-neutral-500"
          >
            {busy ? <Spinner /> : <span className="text-sm leading-none">↑</span>}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── RefStrip ──────────────────────────────────────────────────────────────────

function RefStrip({ assets }: { assets: MediaAsset[] }) {
  return (
    <div className="flex flex-wrap gap-1">
      {assets.map((a) => (
        <div
          key={a.id}
          className="h-9 w-9 overflow-hidden rounded border border-neutral-700 bg-neutral-900"
          title={a.name}
        >
          {a.type === "image" && (
            <img src={mediaUrl(a.id)} alt={a.name} className="h-full w-full object-cover" />
          )}
          {a.type === "video" && (
            <VideoThumb assetId={a.id} />
          )}
          {a.type === "audio" && (
            <span className="flex h-full w-full items-center justify-center text-sm text-neutral-500">
              ♪
            </span>
          )}
        </div>
      ))}
    </div>
  );
}

// ── FrameSlot ─────────────────────────────────────────────────────────────────

function FrameSlot({
  label,
  assetId,
  media,
  onSet,
  onClear,
}: {
  label: string;
  assetId: string | null;
  media: MediaAsset[];
  onSet: () => void;
  onClear: () => void;
}) {
  const asset = assetId ? media.find((a) => a.id === assetId) : null;

  return (
    <button
      onClick={asset ? onClear : onSet}
      className="flex flex-1 flex-col items-center gap-0.5 overflow-hidden rounded-md border border-neutral-800 bg-neutral-900 p-1 text-[10px] text-neutral-500 transition-colors hover:border-neutral-600"
      title={asset ? `Clear ${label}` : `Set ${label} from selection`}
    >
      <div className="flex h-9 w-full items-center justify-center overflow-hidden rounded bg-neutral-800">
        {asset ? (
          asset.type === "image" ? (
            <img src={mediaUrl(asset.id)} alt={asset.name} className="h-full w-full object-cover" />
          ) : asset.type === "video" ? (
            <VideoThumb assetId={asset.id} />
          ) : (
            <span className="text-neutral-500">♪</span>
          )
        ) : (
          <span className="text-neutral-700">+</span>
        )}
      </div>
      <span className="truncate w-full text-center">{label}</span>
    </button>
  );
}

// ── Spinner ───────────────────────────────────────────────────────────────────

function Spinner() {
  return (
    <svg
      className="h-3 w-3 animate-spin text-neutral-600"
      xmlns="http://www.w3.org/2000/svg"
      fill="none"
      viewBox="0 0 24 24"
    >
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
      <path
        className="opacity-75"
        fill="currentColor"
        d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z"
      />
    </svg>
  );
}
