// Taking out CupCat's own rubbish.
//
// Rendering leaves working files behind in the project's `exports/` folder: a subtitle file per text
// clip per export, a JPEG every time the agent looks at a frame, a browser profile per motion
// graphic. Every one of them is written, read once and never wanted again — but nothing ever deleted
// them, so they piled up next to the user's finished videos. A single teaser project had 5,397 of
// them and 47 MB of dead browser profiles by the time anyone counted.
//
// So: anything matching a name CupCat itself writes, and old enough that no live render could still
// be reading it, goes. Age is what keeps this safe — a long export writes its subtitle files at the
// start and reads them until the last frame, and a second project can be exporting at the same time.

import { readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { exportsDir } from "./config";

/** Names CupCat writes for its own use. `_comp_` is deliberately not here: compound bakes are a
 * cache that gets read back, and they already sweep their own superseded hashes. */
const SCRATCH = /^_(richtext_|text_|frame_|inspect_|mgprofile_|cdptest|lossless_concat)/;

/** Six hours. A render that has been going that long has bigger problems than disk hygiene. */
export const STALE_MS = 6 * 60 * 60 * 1000;

export function isScratchName(name: string): boolean {
  return SCRATCH.test(name);
}

/** Delete stale working files from `exports/`. Never throws, never touches a user's export, and
 * returns how many entries it removed. Safe to call at any time, including while exporting. */
export async function sweepScratch(opts: { dir?: string; now?: number; maxAgeMs?: number } = {}): Promise<number> {
  const dir = opts.dir ?? exportsDir;
  const now = opts.now ?? Date.now();
  const maxAge = opts.maxAgeMs ?? STALE_MS;
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return 0; // no exports folder yet — nothing to sweep
  }
  let removed = 0;
  for (const name of names) {
    if (!isScratchName(name)) continue;
    const full = join(dir, name);
    try {
      const s = await stat(full);
      if (now - s.mtimeMs < maxAge) continue;
      await rm(full, { recursive: true, force: true });
      removed++;
    } catch {
      /* locked by another process, or already gone — either way, not ours to fix */
    }
  }
  return removed;
}
