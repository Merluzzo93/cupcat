// Updating in place, downloading only what actually changed.
//
// A CupCat release is 1.5 GB installed, and 1.4 GB of that is tools and models that do not change
// between versions — ffmpeg, the speech model, the voices. Handing someone the whole installer to
// fix a bug in the timeline means re-downloading half a gigabyte of speech model that is already
// sitting on their disk. What actually differs from one release to the next is the app and the
// engine: about 110 MB.
//
// So: every release publishes a manifest (each installed file with its size and SHA-256) plus the
// individual files that changed, as their own assets. The app hashes what it has, asks for the
// difference, and downloads only that.
//
// Two Windows facts shape the rest:
//   - A running .exe cannot be overwritten. Both files we need to replace are running, so the swap
//     has to happen while nothing is running — hence the helper below, which waits for the app to
//     quit, swaps, and starts it again.
//   - A running .exe CAN be renamed. That is what makes a rollback possible: the old file is moved
//     aside rather than deleted, so a failure halfway through can be undone.
//
// Nothing here is allowed to leave the install broken. Every failure path either completes the swap
// or restores exactly what was there before, and the full installer on GitHub is always the way out.

import { createHash } from "node:crypto";
import { copyFileSync, type Dirent, existsSync, mkdirSync, openSync, closeSync, readdirSync, readFileSync, renameSync, rmSync, statSync, type Stats, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { spawn } from "node:child_process";
import { CUPCAT_VERSION, GITHUB_API, GITHUB_REPO } from "./config";

/** One installed file, as published. */
export interface ManifestFile {
  /** Install-relative, forward slashes: "cupcat.exe", "sidecars/piper/piper.exe". */
  path: string;
  size: number;
  sha256: string;
  /** The release TAG whose assets carry THIS content — not necessarily the newest one. A file that
   * last changed three releases ago is still downloadable, without every release having to re-upload
   * 1.5 GB of unchanged tools.
   *
   * A tag, not a version: a small fix can be published into the release that is already there, in
   * which case the version moves and the tag does not. They coincided until that became possible. */
  since: string;
  /** Exact asset name under that release. Stored rather than derived so no path-encoding scheme has
   * to be agreed on by two pieces of code. */
  asset: string;
}

export interface Manifest {
  version: string;
  files: ManifestFile[];
}

/** Asset name of the manifest itself, under every release that supports updating in place. */
export const MANIFEST_ASSET = "manifest.json";

/** Prefix for per-file assets, so they cannot collide with the installer or the manifest. */
export const FILE_ASSET_PREFIX = "file__";

/** Exit code meaning "swap staged, quit so the helper can take over". Code 3 is already "the port
 * was taken"; the shell reads both. */
export const EXIT_FOR_UPDATE = 7;

/** Argument that turns the engine binary into the swap helper. */
export const APPLY_FLAG = "--apply-update";

/** Files that are never part of an update. The uninstaller is written by the installer for this
 * machine — it is not ours to replace — and .update is our own scratch space. */
function isIgnored(rel: string): boolean {
  const l = rel.toLowerCase();
  return l === "uninstall.exe" || l === MANIFEST_ASSET || l.startsWith(".update/");
}

/** Turn an install-relative path into its asset name: "sidecars/piper/piper.exe" →
 * "file__sidecars__piper__piper.exe". GitHub only keeps letters, digits, dots, dashes and
 * underscores intact, so separators become a double underscore. */
export function assetNameFor(path: string): string {
  return FILE_ASSET_PREFIX + path.split("/").join("__");
}

// ---------------------------------------------------------------------------- where we are

let rootCache: string | null | undefined;

/**
 * The installation directory, or null when this is not a packaged install.
 *
 * Updating in place is only ever offered to the real thing: a dev checkout runs through bun.exe and
 * has no cupcat.exe beside it, and swapping files under a developer would be rude and wrong.
 */
export function installRoot(): string | null {
  if (rootCache === undefined) rootCache = detectRoot();
  return rootCache;
}

function detectRoot(): string | null {
  const forced = process.env.CUPCAT_INSTALL_DIR; // tests point this at a copy of an install
  if (forced) return existsSync(forced) ? forced : null;
  const exe = process.execPath;
  if (!/[\\/]cupcat-bridge\.exe$/i.test(exe)) return null;
  const dir = dirname(exe);
  return existsSync(join(dir, "cupcat.exe")) ? dir : null;
}

/** Our scratch space inside the install: staged downloads, backups, the hash cache, the helper. */
function updateDir(root: string): string {
  return join(root, ".update");
}

/** Can we actually replace files here? An install the user cannot write to (somewhere under
 * Program Files, say) can only be updated by running the installer as administrator. */
function isWritable(root: string): boolean {
  try {
    const dir = updateDir(root);
    mkdirSync(dir, { recursive: true });
    const probe = join(dir, "write-probe");
    writeFileSync(probe, "ok");
    rmSync(probe, { force: true });
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------- what we have

export async function hashFile(path: string): Promise<string> {
  const h = createHash("sha256");
  const stream = Bun.file(path).stream();
  for await (const chunk of stream) h.update(chunk);
  return h.digest("hex");
}

function walkFiles(root: string, dir = root, out: string[] = []): string[] {
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const abs = join(dir, e.name);
    const rel = abs.slice(root.length + 1).split("\\").join("/");
    if (isIgnored(rel)) continue;
    if (e.isDirectory()) walkFiles(root, abs, out);
    else if (e.isFile()) out.push(rel);
  }
  return out;
}

interface CacheEntry {
  size: number;
  mtimeMs: number;
  sha256: string;
}

/**
 * SHA-256 of every installed file, keyed by install-relative path.
 *
 * Hashing the whole tree costs about four seconds. Doing that on every update check would be four
 * seconds of disk grinding for an answer that is almost always "nothing moved", so the result is
 * remembered against each file's size and modification time — after the first pass it is instant,
 * and a file that changes on disk is picked up because its timestamp changed with it.
 */
export async function localFiles(root: string): Promise<Map<string, string>> {
  const cacheFile = join(updateDir(root), "hashes.json");
  let cache: Record<string, CacheEntry> = {};
  try {
    cache = JSON.parse(readFileSync(cacheFile, "utf8")) as Record<string, CacheEntry>;
  } catch {
    /* first run, or unreadable — hash everything */
  }
  const out = new Map<string, string>();
  const next: Record<string, CacheEntry> = {};
  let missed = false;
  for (const rel of walkFiles(root)) {
    let st: Stats;
    try {
      st = statSync(join(root, rel));
    } catch {
      continue; // vanished between listing and reading
    }
    const hit = cache[rel];
    let sha = hit && hit.size === st.size && hit.mtimeMs === st.mtimeMs ? hit.sha256 : "";
    if (!sha) {
      try {
        sha = await hashFile(join(root, rel));
      } catch {
        continue;
      }
      missed = true;
    }
    next[rel] = { size: st.size, mtimeMs: st.mtimeMs, sha256: sha };
    out.set(rel, sha);
  }
  if (missed || Object.keys(cache).length !== Object.keys(next).length) {
    try {
      mkdirSync(dirname(cacheFile), { recursive: true });
      writeFileSync(cacheFile, JSON.stringify(next));
    } catch {
      /* the cache is an optimisation; losing it only costs time */
    }
  }
  return out;
}

// ---------------------------------------------------------------------------- what is published

interface GhAsset {
  name?: string;
  browser_download_url?: string;
  size?: number;
}
interface GhRelease {
  tag_name?: string;
  draft?: boolean;
  assets?: GhAsset[];
}

const releases = new Map<string, GhRelease | null>();

/** How many times a request gets to fail before we believe it. */
export const FETCH_ATTEMPTS = 4;

/**
 * fetch, but a dropped connection is not the end of the update.
 *
 * GitHub serves release assets from a different edge than its API, and that edge resets connections:
 * measured here, roughly one request in two to `releases/download/...` came back ECONNRESET while
 * the very same URL fetched by curl was fine, and the next attempt seconds later succeeded. One
 * reset used to cost the whole update — either silently ("no update available", because every error
 * on the check path is swallowed) or 100 MB into a download. So: a few attempts with a growing wait,
 * and only for transport failures. A 404 is an answer and is returned as one.
 *
 * `sleep` is injectable so the tests do not actually wait.
 */
export async function fetchRetry(
  url: string,
  init: RequestInit & { timeoutMs?: number },
  attempts = FETCH_ATTEMPTS,
  sleep: (ms: number) => Promise<void> = (ms) => Bun.sleep(ms),
): Promise<Response> {
  let last: unknown;
  for (let i = 0; i < attempts; i++) {
    // A fresh deadline per attempt. One signal shared across all of them would be spent by the
    // first slow try, and every retry after it would fail instantly on an already-aborted signal.
    const { timeoutMs, ...rest } = init;
    try {
      return await fetch(url, timeoutMs ? { ...rest, signal: AbortSignal.timeout(timeoutMs) } : rest);
    } catch (e) {
      last = e;
      // An abort the CALLER asked for — a cancelled update — is a decision, not a flaky network.
      // A timeout of our own is retried: that is precisely the case worth retrying.
      if (init.signal?.aborted) throw e;
      if (i < attempts - 1) await sleep(500 * 2 ** i);
    }
  }
  throw last instanceof Error ? last : new Error(String(last));
}

/** A release by tag ("v1.7.22"), cached for the life of the process. */
async function getRelease(tag: string): Promise<GhRelease | null> {
  const hit = releases.get(tag);
  if (hit !== undefined) return hit;
  let rel: GhRelease | null = null;
  try {
    const res = await fetchRetry(`${GITHUB_API}/repos/${GITHUB_REPO}/releases/tags/${tag}`, {
      headers: { accept: "application/vnd.github+json", "user-agent": "CupCat-Updater" },
      timeoutMs: 10_000,
    });
    if (res.ok) rel = (await res.json()) as GhRelease;
  } catch {
    /* offline — no delta, the installer link still works */
  }
  // Only a real answer is worth remembering: caching a network failure for the life of the process
  // would turn one bad moment into "no updates exist" until CupCat is restarted.
  if (rel) releases.set(tag, rel);
  return rel;
}

function assetUrl(rel: GhRelease | null, name: string): string | null {
  return rel?.assets?.find((a) => a.name === name)?.browser_download_url ?? null;
}

/** The manifest published with a release, or null when that release predates in-place updating. */
export async function fetchManifest(tag: string): Promise<Manifest | null> {
  const rel = await getRelease(tagOf(tag));
  const url = assetUrl(rel, MANIFEST_ASSET);
  if (!url) return null;
  try {
    const res = await fetchRetry(url, { headers: { "user-agent": "CupCat-Updater" }, timeoutMs: 20_000 });
    if (!res.ok) return null;
    const m = (await res.json()) as Manifest;
    return Array.isArray(m?.files) && typeof m.version === "string" ? m : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------- the plan

export interface UpdatePlan {
  version: string;
  /** Only the files whose content differs from what is installed. */
  files: ManifestFile[];
  /** Bytes to download. */
  bytes: number;
  /** Bytes the full installer would have been, for the comparison the user actually cares about. */
  fullBytes: number;
  /** The release the manifest came from — where a file that names no other release is fetched. */
  hostTag: string;
}

/**
 * The published files whose content is not already on disk — by hash, not by version, so a file that
 * happens to be identical is never fetched again.
 *
 * Files that exist here but not in the release are deliberately left alone. The uninstaller and the
 * user's own leftovers live in the same folder, and a stale sidecar wastes disk where a wrongly
 * deleted one breaks the app.
 */
export function changedFiles(remote: Manifest, local: Map<string, string>): ManifestFile[] {
  return remote.files.filter((f) => local.get(f.path) !== f.sha256);
}

/** "1.7.28" and "v1.7.28" both mean the tag v1.7.28. Manifests written before tags and versions
 * could differ carry the bare version in `since`. */
function tagOf(s: string): string {
  return /^v/i.test(s) ? s : `v${s}`;
}

/**
 * What it would take to reach the published state, or null when updating in place is not possible —
 * a perfectly good answer: the caller falls back to the full installer, which always works.
 *
 * `hostTag` is the release the manifest came from, and is where a file whose entry names no other
 * release is looked for. Null happens when this is not a packaged install, when the install is not
 * writable, or when a file we need was last changed in a release that published no individual files.
 * Never when something merely went wrong.
 */
export async function planUpdate(remote: Manifest, hostTag: string): Promise<UpdatePlan | null> {
  const root = installRoot();
  if (!root || !isWritable(root)) return null;
  if (!remote || remote.files.length === 0) return null;

  const local = await localFiles(root);
  const need = changedFiles(remote, local);
  const fullBytes = remote.files.reduce((n, f) => n + f.size, 0);
  if (need.length === 0) return { version: remote.version, files: [], bytes: 0, fullBytes, hostTag };

  // Every file has to be reachable before anything is offered — half an update is worse than none.
  const where = (f: ManifestFile) => tagOf(f.since || hostTag);
  for (const tag of new Set(need.map(where))) await getRelease(tag);
  for (const f of need) {
    if (!assetUrl(releases.get(where(f)) ?? null, f.asset)) return null;
  }
  return { version: remote.version, files: need, bytes: need.reduce((n, f) => n + f.size, 0), fullBytes, hostTag };
}

// ---------------------------------------------------------------------------- doing it

export interface UpdateProgress {
  phase: "download" | "staged" | "restarting" | "error";
  /** What is being fetched, in the user's terms. */
  file?: string;
  bytesDone: number;
  bytesTotal: number;
  filesDone: number;
  filesTotal: number;
  error?: string;
}

function stagedPath(root: string, f: ManifestFile): string {
  return join(updateDir(root), "staged", f.asset);
}

/**
 * Download every file in the plan and check it against its published hash.
 *
 * Nothing is put in place here — a half-downloaded update must be indistinguishable from no update
 * at all, so everything lands in .update/staged and only moves once all of it has arrived intact.
 *
 * Exported so the download half of an update can be exercised on its own, against a real release and
 * a real copy of an install: `applyUpdate` ends by quitting the process, which is not something a
 * check can watch.
 */
export async function stageUpdate(root: string, plan: UpdatePlan, onProgress: (p: UpdateProgress) => void): Promise<void> {
  const dir = join(updateDir(root), "staged");
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });

  let bytesDone = 0;
  let filesDone = 0;
  let lastTick = 0;
  const tick = (file: string, force = false) => {
    const now = Date.now();
    if (!force && now - lastTick < 200) return;
    lastTick = now;
    onProgress({ phase: "download", file, bytesDone, bytesTotal: plan.bytes, filesDone, filesTotal: plan.files.length });
  };

  for (const f of plan.files) {
    const tag = tagOf(f.since || plan.hostTag);
    const url = assetUrl(releases.get(tag) ?? null, f.asset);
    if (!url) throw new Error(`${f.path} is not published in ${tag}`);

    // One attempt at one file, all of it: a connection that drops 90 MB into a 99 MB download throws
    // from inside the body loop, which no amount of retrying the *request* would have caught.
    const once = async (): Promise<void> => {
      const res = await fetch(url, { headers: { "user-agent": "CupCat-Updater" }, signal: AbortSignal.timeout(600_000) });
      if (!res.ok || !res.body) throw new Error(`couldn't download ${f.path} (${res.status})`);
      const dest = stagedPath(root, f);
      mkdirSync(dirname(dest), { recursive: true });
      const h = createHash("sha256");
      const w = Bun.file(dest).writer();
      let written = 0;
      try {
        for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
          h.update(chunk);
          w.write(chunk);
          written += chunk.length;
          bytesDone += chunk.length;
          tick(f.path);
        }
      } finally {
        await w.end();
      }
      // A truncated download that happens to stop on a chunk boundary is still a truncated download,
      // and a proxy that returns a login page instead of a binary is not one either. Both are caught
      // here, before anything is allowed near the install.
      if (written !== f.size) throw new Error(`${f.path} arrived ${written} bytes, expected ${f.size}`);
      if (h.digest("hex") !== f.sha256) throw new Error(`${f.path} did not match its published checksum`);
    };

    const startBytes = bytesDone;
    let failure: unknown;
    for (let attempt = 0; attempt < FETCH_ATTEMPTS; attempt++) {
      bytesDone = startBytes; // a retry re-downloads from the beginning; the bar must say so too
      try {
        await once();
        failure = undefined;
        break;
      } catch (e) {
        failure = e;
        if (attempt < FETCH_ATTEMPTS - 1) await Bun.sleep(500 * 2 ** attempt);
      }
    }
    if (failure) throw failure;
    filesDone += 1;
    tick(f.path, true);
  }
}

/**
 * Hand the swap to a helper and ask the shell to quit.
 *
 * The two files that change are the app and the engine, and both are running: Windows will not let
 * a running .exe be overwritten. So a copy of the engine is left in .update, told to wait until the
 * app has gone, and it does the swap on an install nobody is holding open — then starts CupCat
 * again. The copy is the NEW engine when the engine is part of the update, so the code doing the
 * swap is the code that was written for it.
 */
function launchHelper(root: string, plan: UpdatePlan): void {
  const dir = updateDir(root);
  const helper = join(dir, "apply.exe");
  const stagedBridge = plan.files.find((f) => f.path.toLowerCase() === "cupcat-bridge.exe");
  const source = stagedBridge ? stagedPath(root, stagedBridge) : process.execPath;
  rmSync(helper, { force: true });
  copyFileSync(source, helper);

  const child = spawn(helper, [APPLY_FLAG, root], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
    // Without this the helper inherits our environment, including the project dir and port — it
    // never starts a server, but there is no reason to hand it any of that.
    env: { PATH: process.env.PATH ?? "", SystemRoot: process.env.SystemRoot ?? "", TEMP: process.env.TEMP ?? "" },
  });
  child.unref();
}

/**
 * Download the update, then quit so it can be put in place. Resolves only if something went wrong —
 * on success the process exits.
 *
 * `releasePort` closes this process's listening socket before the helper is started, and it is not
 * optional: on Windows a child inherits its parent's socket handles, so the helper — and then the
 * CupCat it relaunches — kept the port bound on behalf of an engine that had already exited. The new
 * engine found its port taken, could never start, and the freshly updated app opened to "lost
 * contact with the engine".
 */
export async function applyUpdate(plan: UpdatePlan, onProgress: (p: UpdateProgress) => void, releasePort?: () => void): Promise<void> {
  const root = installRoot();
  if (!root) {
    onProgress({ phase: "error", bytesDone: 0, bytesTotal: 0, filesDone: 0, filesTotal: 0, error: "not a packaged install" });
    return;
  }
  try {
    await stageUpdate(root, plan, onProgress);
    writeFileSync(join(updateDir(root), "pending.json"), JSON.stringify({ version: plan.version, files: plan.files }, null, 2));
    onProgress({ phase: "staged", bytesDone: plan.bytes, bytesTotal: plan.bytes, filesDone: plan.files.length, filesTotal: plan.files.length });
    onProgress({ phase: "restarting", bytesDone: plan.bytes, bytesTotal: plan.bytes, filesDone: plan.files.length, filesTotal: plan.files.length });
    // Say it first, then let go of the port, and only then start the helper — anything still open
    // when it starts is inherited by it, and by the CupCat it goes on to launch.
    setTimeout(() => {
      releasePort?.();
      launchHelper(root, plan);
      process.exit(EXIT_FOR_UPDATE);
    }, 400);
  } catch (e) {
    try {
      rmSync(join(updateDir(root), "staged"), { recursive: true, force: true });
    } catch {
      /* leftovers are cleaned at the next start anyway */
    }
    onProgress({
      phase: "error",
      bytesDone: 0,
      bytesTotal: plan.bytes,
      filesDone: 0,
      filesTotal: plan.files.length,
      error: e instanceof Error ? e.message : String(e),
    });
  }
}

// ---------------------------------------------------------------------------- the helper

/** Is the file free to be replaced? A running .exe is open without write sharing, so this fails
 * for exactly as long as CupCat is still up — which is the question we need answered. */
function canWrite(path: string): boolean {
  if (!existsSync(path)) return true;
  try {
    const fd = openSync(path, "r+");
    closeSync(fd);
    return true;
  } catch {
    return false;
  }
}

/** Wait for CupCat to let go of its own files. Returns false if it never does. */
async function waitForExit(root: string, timeoutMs = 60_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  const app = join(root, "cupcat.exe");
  const bridge = join(root, "cupcat-bridge.exe");
  while (Date.now() < deadline) {
    if (canWrite(app) && canWrite(bridge)) return true;
    await Bun.sleep(250);
  }
  return false;
}

/**
 * Move every staged file into place, keeping what it replaced.
 *
 * All of it or none of it. The moment one move fails, the ones already made are undone from their
 * backups and the install is exactly what it was — an update that did not happen is a bad afternoon,
 * an install with a new app and an old engine is an app that does not start. Returns the failure, or
 * null when everything is in place.
 */
export function swapStaged(root: string, files: ManifestFile[]): Error | null {
  const dir = updateDir(root);
  const backupDir = join(dir, "backup");
  rmSync(backupDir, { recursive: true, force: true });
  mkdirSync(backupDir, { recursive: true });

  const done: { target: string; backup: string | null }[] = [];
  for (const f of files) {
    const target = join(root, ...f.path.split("/"));
    const staged = join(dir, "staged", f.asset);
    try {
      if (!existsSync(staged)) throw new Error(`${f.path} was not staged`);
      mkdirSync(dirname(target), { recursive: true });
      let backup: string | null = null;
      if (existsSync(target)) {
        backup = join(backupDir, f.asset);
        rmSync(backup, { force: true });
        renameSync(target, backup); // a running .exe can be renamed, which is what makes this undoable
      }
      renameSync(staged, target);
      done.push({ target, backup });
    } catch (e) {
      for (const d of done.reverse()) {
        try {
          rmSync(d.target, { force: true });
          if (d.backup) renameSync(d.backup, d.target);
        } catch {
          /* nothing further we can do from here; the full installer repairs any install */
        }
      }
      return e instanceof Error ? e : new Error(String(e));
    }
  }
  return null;
}

/**
 * Tell Windows the installed version changed.
 *
 * The installer writes it once and would otherwise keep claiming the version it installed forever —
 * Installed apps would show 1.7.22 next to an app that says 1.7.24, and, worse, the next full
 * installer decides what to replace by reading exactly this. Only touched when the entry really is
 * this installation, and a failure is ignored: a stale line in a control panel is not worth risking
 * anything over.
 */
function recordInstalledVersion(root: string, version: string): void {
  const key = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\CupCat";
  try {
    const shown = Bun.spawnSync(["reg", "query", key, "/v", "InstallLocation"]).stdout.toString();
    if (!shown.toLowerCase().includes(root.toLowerCase())) return; // some other installation's entry
    Bun.spawnSync(["reg", "add", key, "/v", "DisplayVersion", "/t", "REG_SZ", "/d", version, "/f"]);
  } catch {
    /* cosmetic */
  }
}

/**
 * Put the staged files in place, then start CupCat again.
 *
 * Runs as a separate process, from a copy of the engine in .update, with the app already gone.
 * Every replaced file is moved aside rather than deleted, so if any single move fails the ones
 * already done are undone and the install is exactly as it was — the update simply did not happen,
 * which the user survives; a half-swapped install they would not.
 */
export async function runApplyHelper(root: string): Promise<number> {
  const dir = updateDir(root);
  let plan: { version: string; files: ManifestFile[] };
  try {
    plan = JSON.parse(readFileSync(join(dir, "pending.json"), "utf8")) as { version: string; files: ManifestFile[] };
  } catch {
    return 1; // nothing staged — nothing to do
  }
  if (!(await waitForExit(root))) {
    // CupCat is still running after a minute: leave everything alone. The staged files are cleaned
    // up at the next start and the user can try again.
    return 2;
  }

  const failure = swapStaged(root, plan.files);
  if (!failure) recordInstalledVersion(root, plan.version);

  rmSync(join(dir, "pending.json"), { force: true });
  rmSync(join(dir, "staged"), { recursive: true, force: true });
  // The hash cache describes the old files; every path we touched now has a new size and time, so
  // it would be rebuilt anyway — dropping it is simpler than patching it.
  rmSync(join(dir, "hashes.json"), { force: true });

  try {
    const child = spawn(join(root, "cupcat.exe"), [], { detached: true, stdio: "ignore", windowsHide: false });
    child.unref();
  } catch {
    return 4; // swapped but could not relaunch: the user opens it themselves
  }
  return failure ? 3 : 0;
}

/**
 * Clear what an update left behind: the previous copies of the files it replaced, and the helper
 * that replaced them. Both are still in use at the moment they finish their job — the helper is
 * mid-relaunch and Windows holds the old images a little longer — so this runs at the next start,
 * when they are certainly free, and quietly does nothing when there is nothing to clear.
 */
export function cleanupAfterUpdate(): void {
  const root = installRoot();
  if (!root) return;
  const dir = updateDir(root);
  if (!existsSync(dir)) return;
  for (const leftover of ["backup", "staged"]) {
    try {
      rmSync(join(dir, leftover), { recursive: true, force: true });
    } catch {
      /* still held — the next start gets it */
    }
  }
  for (const leftover of ["apply.exe", "pending.json"]) {
    try {
      rmSync(join(dir, leftover), { force: true });
    } catch {
      /* as above */
    }
  }
}

/** The running version, for the manifest generator and the update check to agree on. */
export function currentVersion(): string {
  return CUPCAT_VERSION;
}
