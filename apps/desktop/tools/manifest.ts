// Build the manifest that lets CupCat update itself without downloading the whole thing again.
//
// Run after `tauri build`, against the files that were actually packaged. It writes:
//   - manifests/<version>.json — every installed file with its size, SHA-256, and the release whose
//     assets carry that content. Committed, because the next release needs it to know what changed.
//   - target/release/delta/ — the files that changed, named as they will be published.
//
// The "since" field is what keeps this cheap. A file is only re-uploaded when its content changes;
// everything else keeps pointing at the release it last changed in, so someone three versions behind
// still gets a complete update without any release having to carry 1.5 GB of unchanged tools.
//
//   bun run apps/desktop/tools/manifest.ts <version> [--tag <releaseTag>]
//
// `since` names the release TAG carrying a file's content, which is usually this version's own tag.
// Pass --tag to publish a small fix into a release that already exists: the version moves, the tag
// does not, and the release page — with its installer — stays where it is. That is what makes a fix
// shippable without a release of its own.
//
// The first release to ship one has no predecessor manifest to compare against; generate the
// previous version's from a real installation with `--from-install <dir> --from-version <v>`.

import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

interface ManifestFile {
  path: string;
  size: number;
  sha256: string;
  since: string;
  asset: string;
}
interface Manifest {
  version: string;
  files: ManifestFile[];
}

const FILE_ASSET_PREFIX = "file__";
const assetNameFor = (path: string) => FILE_ASSET_PREFIX + path.split("/").join("__");

const repoRoot = resolve(import.meta.dir, "..", "..", "..");
const desktop = join(repoRoot, "apps", "desktop");
const tauri = join(desktop, "src-tauri");
const manifestDir = join(desktop, "manifests");

function arg(name: string): string | null {
  const i = process.argv.indexOf(name);
  return i >= 0 ? (process.argv[i + 1] ?? null) : null;
}

async function sha256(path: string): Promise<string> {
  const h = createHash("sha256");
  for await (const chunk of Bun.file(path).stream()) h.update(chunk);
  return h.digest("hex");
}

/** Every file under a directory, as install-relative forward-slash paths. */
function walk(root: string, dir = root, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const abs = join(dir, e.name);
    const rel = abs.slice(root.length + 1).split("\\").join("/");
    const l = rel.toLowerCase();
    if (l === "uninstall.exe" || l === "manifest.json" || l.startsWith(".update/")) continue;
    if (e.isDirectory()) walk(root, abs, out);
    else if (e.isFile()) out.push(rel);
  }
  return out;
}

/**
 * The files as they land in the install, mapped from where the build leaves them.
 *
 * The layout is the installer's, not the repo's: the sidecar binary loses its target triple, the
 * app comes from the Rust build, and everything under sidecars/ is copied as-is.
 */
function packagedFiles(): Map<string, string> {
  const out = new Map<string, string>();
  const app = join(tauri, "target", "release", "cupcat.exe");
  if (!existsSync(app)) throw new Error(`cupcat.exe not found at ${app} — run tauri build first`);
  out.set("cupcat.exe", app);

  const bridge = join(tauri, "binaries", "cupcat-bridge-x86_64-pc-windows-msvc.exe");
  if (!existsSync(bridge)) throw new Error(`the engine is not staged at ${bridge}`);
  out.set("cupcat-bridge.exe", bridge);

  const sidecars = join(tauri, "sidecars");
  for (const rel of walk(sidecars)) out.set(`sidecars/${rel}`, join(sidecars, rel));
  return out;
}

/** Read the previous release's manifest, or build one from a real installation of it. */
async function previousManifest(): Promise<Manifest | null> {
  const fromInstall = arg("--from-install");
  const fromVersion = arg("--from-version");
  if (fromInstall && fromVersion) {
    const root = resolve(fromInstall);
    const files: ManifestFile[] = [];
    for (const rel of walk(root)) {
      const abs = join(root, rel);
      files.push({ path: rel, size: statSync(abs).size, sha256: await sha256(abs), since: fromVersion, asset: assetNameFor(rel) });
    }
    const m: Manifest = { version: fromVersion, files };
    mkdirSync(manifestDir, { recursive: true });
    writeFileSync(join(manifestDir, `${fromVersion}.json`), JSON.stringify(m, null, 2));
    console.log(`wrote manifests/${fromVersion}.json from ${root} (${files.length} files)`);
    return m;
  }
  // Otherwise: the newest manifest already committed.
  if (!existsSync(manifestDir)) return null;
  const rank = (v: string) => v.split(".").reduce((n, p) => n * 1000 + (Number.parseInt(p, 10) || 0), 0);
  const versions = readdirSync(manifestDir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => f.slice(0, -5))
    .sort((a, b) => rank(b) - rank(a));
  if (versions.length === 0) return null;
  return JSON.parse(readFileSync(join(manifestDir, `${versions[0]}.json`), "utf8")) as Manifest;
}

const version = process.argv[2];
if (!version || version.startsWith("-")) {
  console.error("usage: bun run apps/desktop/tools/manifest.ts <version> [--from-install <dir> --from-version <v>]");
  process.exit(1);
}

// Where the changed files will be uploaded. Defaults to this version's own tag; point it at an
// existing release to ship a fix without creating one.
const hostTag = (arg("--tag") ?? `v${version}`).replace(/^v?/, "v");

const prev = await previousManifest();
const prevByPath = new Map((prev?.files ?? []).map((f) => [f.path, f]));
if (prev) console.log(`comparing against ${prev.version} (${prev.files.length} files)`);
else console.log("no previous manifest — everything counts as new");

const deltaDir = join(tauri, "target", "release", "delta");
rmSync(deltaDir, { recursive: true, force: true });
mkdirSync(deltaDir, { recursive: true });

const files: ManifestFile[] = [];
const changed: ManifestFile[] = [];
const seenAssets = new Set<string>();
for (const [rel, abs] of [...packagedFiles()].sort((a, b) => a[0].localeCompare(b[0]))) {
  const asset = assetNameFor(rel);
  if (seenAssets.has(asset)) throw new Error(`two files map to the same asset name: ${asset}`);
  seenAssets.add(asset);
  const size = statSync(abs).size;
  const hash = await sha256(abs);
  const before = prevByPath.get(rel);
  const unchanged = before && before.sha256 === hash;
  const entry: ManifestFile = { path: rel, size, sha256: hash, since: unchanged ? before.since : hostTag, asset };
  files.push(entry);
  if (!unchanged) {
    copyFileSync(abs, join(deltaDir, asset));
    changed.push(entry);
  }
}

const manifest: Manifest = { version, files };
mkdirSync(manifestDir, { recursive: true });
writeFileSync(join(manifestDir, `${version}.json`), JSON.stringify(manifest, null, 2));
writeFileSync(join(deltaDir, "manifest.json"), JSON.stringify(manifest, null, 2));

const mb = (n: number) => `${(n / 1e6).toFixed(1)} MB`;
const total = files.reduce((n, f) => n + f.size, 0);
const delta = changed.reduce((n, f) => n + f.size, 0);
console.log(`\n${files.length} files, ${mb(total)} installed`);
console.log(`${changed.length} changed, ${mb(delta)} to publish:`);
for (const f of changed) console.log(`  ${f.path.padEnd(40)} ${mb(f.size).padStart(10)}  → ${f.asset}`);
console.log(`\nupload from ${deltaDir}`);
console.log(
  changed.length === 0
    ? "nothing changed — nothing to upload"
    : hostTag === `v${version}`
      ? `into a new release ${hostTag}`
      : `into the EXISTING release ${hostTag} — no new release, the page and its installer stay put`,
);
