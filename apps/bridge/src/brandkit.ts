// The brand kit: the logo and colours reused across every project.
//
// It lives in the projects folder, NOT in the install folder, for one reason that matters to the
// person using it: an update replaces the app, and anything kept beside the app goes with it. A logo
// someone set once should still be there next year, after any number of updates — same place the
// templates already live, for the same reason.

import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { projectsBase } from "./config";
import { type BrandKit, DEFAULT_BRAND } from "./openers";

const BRAND_DIR = join(projectsBase, "_brand");
const BRAND_FILE = join(BRAND_DIR, "brand.json");

const HEX = /^#[0-9a-fA-F]{6}$/;

/** Read the kit, falling back to the defaults. Never throws: a corrupt file must not stop the app,
 * and the defaults are a perfectly usable kit. */
export async function loadBrandKit(): Promise<BrandKit> {
  try {
    const raw = (await Bun.file(BRAND_FILE).json()) as Partial<BrandKit>;
    return {
      background: HEX.test(raw.background ?? "") ? raw.background! : DEFAULT_BRAND.background,
      accent: HEX.test(raw.accent ?? "") ? raw.accent! : DEFAULT_BRAND.accent,
      ...(typeof raw.logoRef === "string" && raw.logoRef ? { logoRef: raw.logoRef } : {}),
      ...(typeof raw.fontName === "string" && raw.fontName ? { fontName: raw.fontName } : {}),
    };
  } catch {
    return { ...DEFAULT_BRAND };
  }
}

/** Merge changes into the kit and persist. Returns what the kit now is. */
export async function saveBrandKit(patch: Partial<BrandKit>): Promise<BrandKit> {
  const current = await loadBrandKit();
  const next: BrandKit = {
    background: HEX.test(patch.background ?? "") ? patch.background! : current.background,
    accent: HEX.test(patch.accent ?? "") ? patch.accent! : current.accent,
    ...(patch.logoRef !== undefined ? (patch.logoRef ? { logoRef: patch.logoRef } : {}) : current.logoRef ? { logoRef: current.logoRef } : {}),
    ...(patch.fontName !== undefined ? (patch.fontName ? { fontName: patch.fontName } : {}) : current.fontName ? { fontName: current.fontName } : {}),
  };
  await mkdir(BRAND_DIR, { recursive: true });
  await Bun.write(BRAND_FILE, JSON.stringify(next, null, 2));
  return next;
}

export { BRAND_FILE };
