// Headless CLI for the CupCat bridge binary: batch/render exports and project listing without the
// UI. This is the USER's automation surface (pattern that Palmier/OpenCut only promise) — invoking
// the CLI is a user action, so exports run at source "user"; the agent MCP export gate is separate
// and unchanged. Usage:
//   cupcat-bridge render [--project <name|path>] [--format mp4_h264|mp4_h265|mp4_av1|prores|…]
//                        [--quality draft|standard|high|max] [--out <file>]
//   cupcat-bridge batch <jobs.json>       # [{ project, format?, quality?, out? }, …]
//   cupcat-bridge list-projects

import { readdirSync, statSync } from "node:fs";
import { basename, isAbsolute, join } from "node:path";
import { EditorDocument } from "@cupcat/editor-core";
import { exportsDir, projectsBase, setProjectDir } from "./config";
import { type ExportFormat, type ExportQuality, exportTimeline } from "./export";
import { loadProject } from "./media";

interface RenderJob {
  project?: string;
  format?: ExportFormat;
  quality?: ExportQuality;
  out?: string;
}

function parseFlags(args: string[]): { positional: string[]; flags: Record<string, string> } {
  const positional: string[] = [];
  const flags: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = args[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        flags[key] = next;
        i++;
      } else flags[key] = "true";
    } else positional.push(a);
  }
  return { positional, flags };
}

/** Resolve a project reference (a folder name under projectsBase, or an absolute/relative path) to
 * an existing directory, and point the bridge config at it. Throws with a helpful message if absent. */
function selectProject(ref?: string): string {
  if (!ref) return join(projectsBase, "default");
  const dir = isAbsolute(ref) || ref.includes("/") || ref.includes("\\") ? ref : join(projectsBase, ref);
  const st = statSync(dir, { throwIfNoEntry: false });
  if (!st || !st.isDirectory()) throw new Error(`Project not found: ${ref} (looked in ${dir})`);
  return dir;
}

async function renderOne(job: RenderJob): Promise<{ ok: boolean; out: string }> {
  const dir = selectProject(job.project);
  setProjectDir(dir);
  const project = await loadProject();
  const doc = new EditorDocument(project);
  const format: ExportFormat = job.format ?? "mp4_h264";
  const quality: ExportQuality = job.quality ?? "high";
  const ext = format === "prores" ? "mov" : format === "nle_xml" ? "xml" : format === "fcpxml" ? "fcpxml" : "mp4";
  const outName = job.out ? basename(job.out) : `${project.name || "export"}.${ext}`;
  console.log(`[cupcat] rendering "${project.name}" → ${format}/${quality} …`);
  const res = await exportTimeline(doc, outName, format, quality);
  if (!res.ok) {
    console.error(`[cupcat] FAILED: ${res.error}`);
    return { ok: false, out: "" };
  }
  console.log(`[cupcat] done: ${res.path}${res.durationSeconds ? ` (${res.durationSeconds.toFixed(1)}s)` : ""}`);
  return { ok: true, out: res.path ?? join(exportsDir, outName) };
}

export async function runCli(args: string[]): Promise<void> {
  const [verb, ...rest] = args;
  const { positional, flags } = parseFlags(rest);

  if (verb === "list-projects" || verb === "--list-projects") {
    let names: string[] = [];
    try {
      names = readdirSync(projectsBase).filter((n) => {
        const st = statSync(join(projectsBase, n), { throwIfNoEntry: false });
        return st?.isDirectory() && statSync(join(projectsBase, n, "project.json"), { throwIfNoEntry: false });
      });
    } catch {
      /* base dir may not exist yet */
    }
    console.log(names.length ? names.join("\n") : "(no projects)");
    return;
  }

  if (verb === "render") {
    const r = await renderOne({
      project: flags.project,
      format: flags.format as ExportFormat | undefined,
      quality: flags.quality as ExportQuality | undefined,
      out: flags.out,
    });
    if (!r.ok) process.exitCode = 1;
    return;
  }

  if (verb === "batch") {
    const file = positional[0];
    if (!file) {
      console.error("Usage: cupcat-bridge batch <jobs.json>");
      process.exitCode = 1;
      return;
    }
    let jobs: RenderJob[];
    try {
      jobs = (await Bun.file(file).json()) as RenderJob[];
    } catch (e) {
      console.error(`Could not read jobs file ${file}: ${e instanceof Error ? e.message : String(e)}`);
      process.exitCode = 1;
      return;
    }
    if (!Array.isArray(jobs)) {
      console.error("Jobs file must be a JSON array of { project, format?, quality?, out? }.");
      process.exitCode = 1;
      return;
    }
    let failures = 0;
    for (let i = 0; i < jobs.length; i++) {
      console.log(`[cupcat] job ${i + 1}/${jobs.length}`);
      const r = await renderOne(jobs[i]);
      if (!r.ok) failures++;
    }
    console.log(`[cupcat] batch complete: ${jobs.length - failures}/${jobs.length} succeeded`);
    if (failures) process.exitCode = 1;
    return;
  }

  console.log(
    [
      "CupCat headless CLI",
      "",
      "  render [--project <name|path>] [--format <fmt>] [--quality <q>] [--out <file>]",
      "  batch <jobs.json>",
      "  list-projects",
      "",
      "  formats:  mp4_h264 (default) · mp4_h265 · mp4_av1 · hdr_hevc · prores · nle_xml · fcpxml · lossless",
      "  quality:  draft · standard · high (default) · max",
    ].join("\n"),
  );
}
