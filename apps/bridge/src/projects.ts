// Multi-project support: list / create / switch projects under projectsBase (~/CupCat/). Each
// project is a subfolder with its own project.json + media/ + exports/. Switching repoints the
// config path live-bindings and reloads the document in place.

import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { basename, isAbsolute, join } from "node:path";
import { type EditorDocument, makeProject } from "@cupcat/editor-core";
import { projectsBase, projectRoot, setProjectDir } from "./config";
import { ensureDirs, loadProject, saveProject } from "./media";

// ~/CupCat/memory.md is the global memory file; not a project folder.
const RESERVED = new Set(["memory.md"]);

/** Sanitize a user-supplied name into a safe folder name. Unicode letters/digits stay (Italian
 * names like "Città" must survive — ASCII-only stripping turned them into different folders). */
function safeName(name: string): string {
  return (
    name
      .trim()
      .replace(/[^\p{L}\p{N} _-]/gu, "")
      .replace(/\s+/g, " ")
      .slice(0, 60) || "untitled"
  );
}

/** Resolve a project reference (display name or path) against the KNOWN projects. Without this,
 * switching to a picker-created project by its list name silently created a fresh empty folder
 * under projectsBase — the project seemed to "lose" its content. */
async function resolveExisting(nameOrPath: string): Promise<string | null> {
  const norm = (p: string) => p.replace(/\\/g, "/").replace(/\/+$/, "");
  const wanted = norm(nameOrPath);
  for (const p of await listProjects()) {
    if (p.name === nameOrPath || norm(p.path) === wanted) return p.path;
  }
  return null;
}

export interface ProjectEntry {
  name: string;
  path: string;
  current: boolean;
}

// Folders opened from anywhere on disk (via the picker) are remembered here so they stay in the
// project list after you switch away — opening a folder makes a permanent project.
const registryFile = () => join(projectsBase, ".projects.json");
async function readRegistry(): Promise<string[]> {
  try {
    const d = JSON.parse(await readFile(registryFile(), "utf8"));
    return Array.isArray(d) ? (d as string[]) : [];
  } catch {
    return [];
  }
}
async function registerProject(dir: string): Promise<void> {
  try {
    const list = await readRegistry();
    if (!list.includes(dir)) {
      list.push(dir);
      await mkdir(projectsBase, { recursive: true });
      await writeFile(registryFile(), JSON.stringify(list));
    }
  } catch {
    /* best-effort */
  }
}

async function unregisterProject(dir: string): Promise<void> {
  try {
    const norm = dir.replace(/[\\/]+$/, "");
    const list = (await readRegistry()).filter((d) => d.replace(/[\\/]+$/, "") !== norm);
    await writeFile(registryFile(), JSON.stringify(list));
  } catch {
    /* best-effort */
  }
}

export async function listProjects(): Promise<ProjectEntry[]> {
  const out: ProjectEntry[] = [];
  const seen = new Set<string>();
  const norm = (p: string) => p.replace(/\\/g, "/").replace(/\/+$/, "");
  const rootN = norm(projectRoot);
  const add = (dir: string, name?: string) => {
    const key = norm(dir);
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ name: name ?? basename(dir), path: dir, current: key === rootN });
  };
  try {
    for (const name of await readdir(projectsBase)) {
      if (RESERVED.has(name) || name.startsWith(".")) continue;
      const dir = join(projectsBase, name);
      try {
        if ((await stat(dir)).isDirectory()) add(dir, name);
      } catch {
        /* skip */
      }
    }
  } catch {
    /* projectsBase may not exist yet */
  }
  for (const dir of await readRegistry()) {
    try {
      if ((await stat(dir)).isDirectory()) add(dir);
    } catch {
      /* stale registry entry */
    }
  }
  add(projectRoot); // always include the active project
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

/** Switch the bridge to a project folder (creating it empty if new), reloading the document. */
export async function switchProject(doc: EditorDocument, name: string): Promise<ProjectEntry[]> {
  const dir = (await resolveExisting(name)) ?? (isAbsolute(name) ? name : join(projectsBase, safeName(name)));
  await mkdir(dir, { recursive: true });
  setProjectDir(dir);
  await ensureDirs();
  await registerProject(dir);
  doc.reset(await loadProject());
  return listProjects();
}

/** Create a fresh project folder, write a starter project.json, and open it. If the target already
 * holds a project, OPEN it instead — "create" on an existing name must never clobber its data. */
export async function createProject(doc: EditorDocument, name: string): Promise<ProjectEntry[]> {
  const existing = await resolveExisting(name);
  const dir = existing ?? (isAbsolute(name) ? name : join(projectsBase, safeName(name)));
  setProjectDir(dir);
  await ensureDirs();
  await registerProject(dir);
  const hasProject = await readFile(join(dir, "project.json"), "utf8").then(
    () => true,
    () => false,
  );
  if (!hasProject) await saveProject(makeProject({ name: basename(dir) }));
  doc.reset(await loadProject());
  return listProjects();
}

/** Delete a project folder from disk. If it was the active project, opens another (or a fresh
 * default). Refuses to delete a drive root or the projects base itself. */
export async function deleteProject(doc: EditorDocument, name: string): Promise<ProjectEntry[]> {
  const resolved = (await resolveExisting(name)) ?? (isAbsolute(name) ? name : join(projectsBase, safeName(name)));
  const dir = resolved.replace(/[\\/]+$/, "");
  const baseNorm = projectsBase.replace(/[\\/]+$/, "");
  if (!dir || dir === baseNorm || /^[A-Za-z]:[\\/]?$/.test(dir)) return listProjects();
  const wasCurrent = dir === projectRoot.replace(/[\\/]+$/, "");
  await unregisterProject(dir); // always drop it from the remembered project list
  // Only delete files for CupCat-managed projects (inside projectsBase). A folder opened from
  // elsewhere is merely unlinked — never delete the user's own media.
  const n = (p: string) => p.replace(/\\/g, "/").replace(/\/+$/, "");
  if (n(dir) === `${n(baseNorm)}/${basename(dir)}` || n(dir).startsWith(`${n(baseNorm)}/`)) {
    try {
      await rm(dir, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  }
  if (wasCurrent) {
    const remaining = await listProjects();
    const next = remaining.find((p) => !p.current);
    await switchProject(doc, next ? next.path : join(projectsBase, "default"));
  }
  return listProjects();
}
