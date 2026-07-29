// Does the published manifest describe the file set the installer actually carries?
//
// The manifest is a promise: "install this and you will have exactly these bytes". A wrong entry is
// invisible until an update tries to reconcile the two and decides a correct file needs replacing —
// or worse, that a wrong one does not. 1.7.28 shipped exactly that, because the hash was taken from
// a build-directory copy rather than from the installer.
//
// Point it at the installer's payload — `7z x -o<dir> CupCat_<v>_x64-setup.exe`, minus $PLUGINSDIR —
// and it fails unless all 406 files agree with the manifest byte for byte. Point it at an OLDER
// install instead and the same output reads as the update plan: every MISMATCH plus every "described
// but not shipped" is a file that release has to carry.
//
// bun run apps/desktop/tools/check-manifest.ts <manifest.json> <install-dir>

import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const manifest = JSON.parse(readFileSync(process.argv[2]!, "utf8")) as {
  version: string;
  files: { path: string; size: number; sha256: string; since: string }[];
};
const root = process.argv[3]!;

function walk(dir: string, base = dir, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const abs = join(dir, e.name);
    if (e.isDirectory()) walk(abs, base, out);
    else out.push(abs.slice(base.length + 1).split("\\").join("/"));
  }
  return out;
}

// uninstall.exe is written by NSIS at install time and .update/ is the updater's own scratch space;
// neither is part of what a release publishes, which is why the manifest never lists them.
const onDisk = new Set(
  walk(root).filter((p) => p.toLowerCase() !== "uninstall.exe" && !p.toLowerCase().startsWith(".update/")),
);
const inManifest = new Set(manifest.files.map((f) => f.path));

const missing = [...inManifest].filter((p) => !onDisk.has(p));
const extra = [...onDisk].filter((p) => !inManifest.has(p));

let bad = 0;
for (const f of manifest.files) {
  if (!onDisk.has(f.path)) continue;
  const buf = readFileSync(join(root, ...f.path.split("/")));
  const sha = createHash("sha256").update(buf).digest("hex");
  if (sha !== f.sha256 || buf.length !== f.size) {
    bad++;
    console.log(`MISMATCH ${f.path}\n  manifest ${f.sha256} ${f.size}\n  installer ${sha} ${buf.length}`);
  }
}

console.log(`\nmanifest ${manifest.version}: ${manifest.files.length} files`);
console.log(`installer: ${onDisk.size} files`);
console.log(`described but not shipped: ${missing.length}${missing.length ? ` — ${missing.join(", ")}` : ""}`);
console.log(`shipped but not described: ${extra.length}${extra.length ? ` — ${extra.join(", ")}` : ""}`);
console.log(`hash mismatches: ${bad}`);
process.exit(missing.length || extra.length || bad ? 1 : 0);
