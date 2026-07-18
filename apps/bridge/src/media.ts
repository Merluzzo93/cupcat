// Project + media file IO: load/save the project document, download/copy media into the
// project's media dir, and infer asset types.

import { mkdir } from "node:fs/promises";
import { extname, join } from "node:path";
import { type ClipType, clipTypeFromExtension, makeProject, newId, type Project } from "@cupcat/editor-core";
import { exportsDir, mediaDir, projectFile } from "./config";
import { cleanupStaleProxies } from "./ffmpeg";

export async function ensureDirs(): Promise<void> {
  await mkdir(mediaDir, { recursive: true });
  await mkdir(exportsDir, { recursive: true });
}

export async function loadProject(): Promise<Project> {
  // Sweep superseded proxy generations in the background — version bumps used to leave orphan
  // .scrubvN/.thumbvN files next to the user's media forever.
  void cleanupStaleProxies(mediaDir).then((n) => {
    if (n > 0) console.log(`[proxies] removed ${n} stale proxy file(s)`);
  });
  const f = Bun.file(projectFile);
  if (await f.exists()) {
    try {
      const p = (await f.json()) as Project;
      reconcileStaleGenerations(p);
      return p;
    } catch {
      /* fall through to a fresh project */
    }
  }
  return makeProject({ name: "CupCat Project" });
}

/** A "generating"/"downloading"/"rendering" status on disk can never still be in flight — the promise
 * that would have completed it lived only in the previous process's memory (gone whether the bridge
 * restarted or the project was simply reloaded). Left alone this is an eternal, silent spinner with no
 * way to retry; surface it as a clear failure instead. */
function reconcileStaleGenerations(p: Project): void {
  for (const m of p.media) {
    if (m.generationStatus.kind !== "none" && m.generationStatus.kind !== "failed") {
      m.generationStatus = { kind: "failed", error: "Interrupted — CupCat was closed (or the project changed) while this was generating. Please retry." };
    }
  }
}

export async function saveProject(p: Project): Promise<void> {
  await Bun.write(projectFile, JSON.stringify(p, null, 2));
}

export function inferType(nameOrUrl: string, mimeType?: string): ClipType | null {
  if (mimeType) {
    if (mimeType.startsWith("video/")) return "video";
    if (mimeType.startsWith("audio/")) return "audio";
    if (mimeType.startsWith("image/")) return "image";
  }
  const clean = nameOrUrl.split(/[?#]/)[0] ?? nameOrUrl;
  return clipTypeFromExtension(extname(clean));
}

export function guessExt(url: string, type: ClipType): string {
  const clean = url.split(/[?#]/)[0] ?? url;
  const m = clean.match(/\.([a-z0-9]{2,5})$/i);
  if (m) return `.${m[1]!.toLowerCase()}`;
  return type === "image" ? ".png" : type === "audio" ? ".mp3" : ".mp4";
}

export function mediaPathFor(ext: string): string {
  const e = ext.startsWith(".") ? ext : `.${ext}`;
  return join(mediaDir, `${newId("m")}${e}`);
}

export async function downloadToFile(url: string, destPath: string): Promise<boolean> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 120_000); // never hang on a stalled CDN
  try {
    const res = await fetch(url, { signal: ctrl.signal, redirect: "follow" });
    if (!res.ok) {
      console.error(`[media] download HTTP ${res.status} for ${url}`);
      return false;
    }
    // Buffer fully (rather than streaming the Response) so the abort timeout can actually fire.
    await Bun.write(destPath, await res.arrayBuffer());
    return true;
  } catch (e) {
    console.error(`[media] download failed for ${url}: ${e instanceof Error ? e.message : String(e)}`);
    return false;
  } finally {
    clearTimeout(timer);
  }
}
