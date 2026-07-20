// Bridge configuration. Paths and binaries are overridable via env so the desktop (Tauri)
// shell can point them at bundled tools later.

import { homedir } from "node:os";
import { join } from "node:path";

/** Same loopback port Palmier Pro uses, so Claude setup instructions are familiar. */
export const BRIDGE_PORT = Number(process.env.CUPCAT_PORT ?? 19789);

/** Base folder holding all projects (each a subfolder with its own project.json + media/exports). */
export const projectsBase = process.env.CUPCAT_PROJECTS_DIR ?? join(homedir(), "CupCat");

/** Where the CURRENT project lives. These are `let` so the project picker can switch projects at
 * runtime — ES module live bindings mean every importer that reads them at call time sees the update. */
export let projectRoot = process.env.CUPCAT_PROJECT_DIR ?? join(projectsBase, "default");
export let mediaDir = join(projectRoot, "media");
export let exportsDir = join(projectRoot, "exports");
export let projectFile = join(projectRoot, "project.json");

/** Point the bridge at a different project directory (used by switch/create project). */
export function setProjectDir(dir: string): void {
  projectRoot = dir;
  mediaDir = join(dir, "media");
  exportsDir = join(dir, "exports");
  projectFile = join(dir, "project.json");
}

/** Built web UI dir served at `/`. Set by the desktop shell; empty in pure-API/dev mode. */
export const webDir = process.env.CUPCAT_WEB_DIR ?? "";

export const HIGGSFIELD_BIN = process.env.CUPCAT_HIGGSFIELD_BIN ?? "higgsfield";
export const FFMPEG_BIN = process.env.CUPCAT_FFMPEG_BIN ?? "ffmpeg";
export const FFPROBE_BIN = process.env.CUPCAT_FFPROBE_BIN ?? "ffprobe";
export const YTDLP_BIN = process.env.CUPCAT_YTDLP_BIN ?? "yt-dlp";

/** App version — bumped with each release (kept in sync with apps/desktop/src-tauri/tauri.conf.json).
 * The Tauri shell may override it via CUPCAT_VERSION so the bridge always reports the shell's build. */
export const CUPCAT_VERSION = process.env.CUPCAT_VERSION ?? "1.7.4";

/** GitHub repo (owner/name) for the in-app update check. Works once the repo/releases are public. */
export const GITHUB_REPO = process.env.CUPCAT_GITHUB_REPO ?? "Merluzzo93/cupcat";
