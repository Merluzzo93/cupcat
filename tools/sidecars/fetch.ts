#!/usr/bin/env bun
// Assemble apps/desktop/src-tauri/sidecars/ from pinned upstream sources.
//
//   bun run tools/sidecars/fetch.ts                     # into the real sidecars folder
//   bun run tools/sidecars/fetch.ts --out D:/tmp/side   # into a scratch folder, to compare
//   bun run tools/sidecars/fetch.ts --only tagging      # one group while iterating
//   bun run tools/sidecars/fetch.ts --pin               # download and PRINT the hashes to pin
//   bun run tools/sidecars/fetch.ts --check             # only verify an existing folder against the lock
//
// Two separate guarantees, and it is worth keeping them apart:
//
//   sources.ts holds the SHA-256 of every download — that is what makes "pinned" mean something,
//   and it fails loudly if an upstream file is ever replaced under the same URL.
//
//   sidecars.lock.json holds the SHA-256 of every file in the ASSEMBLED folder — that is what proves
//   this script rebuilds the exact tree CupCat has been shipping. Same idea as the installer manifest
//   and check-manifest.ts, applied one step earlier in the chain.
//
// Downloads are cached (688 MB of it is two Whisper models) so re-running is cheap.

import { createHash } from "node:crypto";
import {
  createReadStream,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { SOURCES, type Source } from "./sources";

const REPO = resolve(import.meta.dir, "../..");
const DEFAULT_OUT = join(REPO, "apps/desktop/src-tauri/sidecars");
const LOCK = join(import.meta.dir, "sidecars.lock.json");
const CACHE = process.env.CUPCAT_SIDECAR_CACHE ?? join(REPO, ".sidecar-cache");

/** Files the BUILD produces, not the download. Present in the folder, absent from the lock. */
const BUILT = new Set(["faces/cupcat-faces.exe"]);

// ── arguments ────────────────────────────────────────────────────────────────

const argv = process.argv.slice(2);
const flag = (name: string) => argv.includes(`--${name}`);
const value = (name: string) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
};

const OUT = resolve(value("out") ?? DEFAULT_OUT);
const ONLY = value("only")?.split(",").map((s) => s.trim()).filter(Boolean);
const PIN = flag("pin");
const CHECK_ONLY = flag("check");
const WRITE_LOCK = flag("write-lock");

// ── helpers ──────────────────────────────────────────────────────────────────

function sha256(path: string): Promise<string> {
  return new Promise((ok, bad) => {
    const h = createHash("sha256");
    createReadStream(path)
      .on("data", (c) => h.update(c))
      .on("error", bad)
      .on("end", () => ok(h.digest("hex")));
  });
}

const mb = (n: number) => `${(n / 1e6).toFixed(1)} MB`;

async function download(url: string, dest: string): Promise<void> {
  mkdirSync(dirname(dest), { recursive: true });
  const res = await fetch(url, { headers: { "user-agent": "CupCat-sidecars" } });
  if (!res.ok || !res.body) throw new Error(`${url}: HTTP ${res.status}`);
  const total = Number(res.headers.get("content-length") ?? 0);
  // Write to a .part file and rename at the end, so an interrupted run cannot leave a truncated
  // download looking like a cached one.
  const part = `${dest}.part`;
  const sink = Bun.file(part).writer();
  let done = 0;
  let announced = 0;
  for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
    sink.write(chunk);
    done += chunk.byteLength;
    if (done - announced > 25e6) {
      announced = done;
      const pct = total ? ` (${((done / total) * 100).toFixed(0)}%)` : "";
      process.stdout.write(`\r      ${mb(done)}${pct}   `);
    }
  }
  await sink.end();
  if (announced) process.stdout.write("\r");
  if (total && done !== total) throw new Error(`${url}: got ${done} of ${total} bytes`);
  rmSync(dest, { force: true });
  renameSync(part, dest);
}

/**
 * 7-Zip, not tar. Windows' own bsdtar is in System32 and reads .zip happily, but handed a .tar.bz2 it
 * HANGS — no error, no output, forever — and there is no bzip2 for it to shell out to. 7-Zip is
 * installed on GitHub's windows runners as well, and does both formats in half a second.
 */
const SEVENZIP = ["C:/Program Files/7-Zip/7z.exe", "C:/Program Files (x86)/7-Zip/7z.exe"].find(existsSync) ?? "7z";

function un7z(archive: string, into: string): void {
  mkdirSync(into, { recursive: true });
  const p = Bun.spawnSync([SEVENZIP, "x", "-y", `-o${into}`, archive], { stdout: "pipe", stderr: "pipe" });
  if (p.exitCode !== 0) {
    throw new Error(`7z x ${archive}: ${(p.stderr.toString() + p.stdout.toString()).trim().split("\n").slice(-3).join(" ")}`);
  }
}

async function extract(archive: string, into: string): Promise<void> {
  const marker = join(into, ".extracted");
  if (existsSync(marker)) return;
  rmSync(into, { recursive: true, force: true });
  // A .tar.bz2 or .tar.gz is two containers and 7-Zip unwraps one at a time. Detected by what comes
  // out rather than by the file extension, so a new archive format needs no change here.
  const mid = `${into}.unwrap`;
  rmSync(mid, { recursive: true, force: true });
  un7z(archive, mid);
  const tar = readdirSync(mid).find((f) => f.endsWith(".tar"));
  if (tar && readdirSync(mid).length === 1) {
    un7z(join(mid, tar), into);
    rmSync(mid, { recursive: true, force: true });
  } else {
    renameSync(mid, into);
  }
  writeFileSync(marker, "");
}

function copyTree(from: string, to: string): number {
  let n = 0;
  mkdirSync(to, { recursive: true });
  for (const e of readdirSync(from, { withFileTypes: true })) {
    if (e.isDirectory()) n += copyTree(join(from, e.name), join(to, e.name));
    else {
      copyFileSync(join(from, e.name), join(to, e.name));
      n++;
    }
  }
  return n;
}

function walk(dir: string, base = dir): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p, base));
    else out.push(relative(base, p).replaceAll("\\", "/"));
  }
  return out;
}

// ── fetch ────────────────────────────────────────────────────────────────────

interface Pinned {
  id: string;
  sha256: string;
}

async function provision(sources: Source[]): Promise<Pinned[]> {
  const pinned: Pinned[] = [];
  mkdirSync(CACHE, { recursive: true });

  for (const s of sources) {
    const name = `${s.id}-${s.url.split("/").pop()!.split("?")[0]}`;
    const cached = join(CACHE, name);

    if (!existsSync(cached)) {
      console.log(`  ↓ ${s.id}  ${s.url}`);
      await download(s.url, cached);
    }
    const got = await sha256(cached);
    const size = statSync(cached).size;

    if (!s.sha256) {
      if (!PIN) {
        throw new Error(
          `${s.id} has no pinned sha256. Run with --pin, check the values, then paste them into sources.ts.`,
        );
      }
      pinned.push({ id: s.id, sha256: got });
      console.log(`  · ${s.id}  ${mb(size)}  ${got}`);
    } else if (s.sha256 !== got) {
      throw new Error(
        `${s.id}: upstream file does not match its pin.\n` +
          `    expected ${s.sha256}\n    got      ${got}\n` +
          `  The URL now serves different bytes. Investigate before changing the pin.`,
      );
    } else {
      console.log(`  ✓ ${s.id}  ${mb(size)}`);
    }

    // Place the picks.
    let files = 0;
    for (const pick of s.picks) {
      const target = join(OUT, pick.to);
      mkdirSync(dirname(target), { recursive: true });
      if (s.kind === "file") {
        copyFileSync(cached, target);
        files++;
        continue;
      }
      const dir = join(CACHE, "x", s.id);
      await extract(cached, dir);
      const src = join(dir, pick.from!);
      if (!existsSync(src)) throw new Error(`${s.id}: "${pick.from}" is not in the archive`);
      if (pick.dir) files += copyTree(src, target);
      else {
        copyFileSync(src, target);
        files++;
      }
    }
    if (files > 1) console.log(`      ${files} files → ${s.picks.map((p) => p.to).join(", ").slice(0, 90)}`);
  }
  return pinned;
}

// ── lock ─────────────────────────────────────────────────────────────────────

interface LockEntry {
  path: string;
  size: number;
  sha256: string;
}

async function inventory(dir: string): Promise<LockEntry[]> {
  const out: LockEntry[] = [];
  for (const path of walk(dir).sort()) {
    if (BUILT.has(path)) continue;
    const full = join(dir, path);
    out.push({ path, size: statSync(full).size, sha256: await sha256(full) });
  }
  return out;
}

async function checkLock(dir: string): Promise<number> {
  if (!existsSync(LOCK)) {
    console.log("no sidecars.lock.json yet — run with --write-lock once the folder is right");
    return 0;
  }
  const lock = JSON.parse(readFileSync(LOCK, "utf8")) as { files: LockEntry[] };
  const have = new Map((await inventory(dir)).map((e) => [e.path, e]));
  let missing = 0;
  let wrong = 0;
  for (const want of lock.files) {
    const got = have.get(want.path);
    if (!got) {
      console.log(`  MISSING  ${want.path}`);
      missing++;
      continue;
    }
    have.delete(want.path);
    if (got.sha256 !== want.sha256) {
      console.log(`  DIFFERS  ${want.path}  (${mb(want.size)} → ${mb(got.size)})`);
      wrong++;
    }
  }
  const extra = [...have.keys()];
  for (const p of extra) console.log(`  EXTRA    ${p}`);
  console.log(
    `${lock.files.length} locked · ${missing} missing · ${wrong} different · ${extra.length} extra` +
      `  (${[...BUILT].length} built files not covered)`,
  );
  return missing + wrong + extra.length;
}

// ── main ─────────────────────────────────────────────────────────────────────

if (CHECK_ONLY) {
  process.exit((await checkLock(OUT)) === 0 ? 0 : 1);
}

const scope = ONLY ? SOURCES.filter((s) => ONLY.includes(s.group) || ONLY.includes(s.id)) : SOURCES;
if (!scope.length) throw new Error(`--only ${ONLY?.join(",")} matched nothing`);

console.log(`sidecars → ${OUT}`);
console.log(`cache    → ${CACHE}`);
console.log(`${scope.length} of ${SOURCES.length} sources\n`);

const pinned = await provision(scope);

if (pinned.length) {
  console.log("\nPaste into sources.ts (after checking each one is the file you meant):");
  for (const p of pinned) console.log(`  ${p.id}: "${p.sha256}"`);
  process.exit(0);
}

console.log();
if (WRITE_LOCK) {
  const files = await inventory(OUT);
  const bytes = files.reduce((n, f) => n + f.size, 0);
  writeFileSync(
    LOCK,
    `${JSON.stringify({ generated: "by tools/sidecars/fetch.ts --write-lock", files }, null, 2)}\n`,
  );
  console.log(`wrote sidecars.lock.json — ${files.length} files, ${mb(bytes)}`);
} else if (ONLY) {
  console.log("partial run — skipping the lock check (it covers the whole folder)");
} else {
  process.exit((await checkLock(OUT)) === 0 ? 0 : 1);
}
