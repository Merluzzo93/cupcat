// Updating in place is the one feature that can leave someone with no working app at all, so the
// parts that touch their files are tested against real directories rather than mocks: what gets
// downloaded, what gets moved where, and — the one that matters — what is left behind when a swap
// fails halfway.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { assetNameFor, changedFiles, hashFile, localFiles, swapStaged, type Manifest, type ManifestFile } from "./delta";

let root = "";

/** A throwaway install: a few files in a tree shaped like the real one. */
function makeInstall(files: Record<string, string>): string {
  const dir = join(tmpdir(), `cupcat-delta-${Date.now()}-${Math.floor(Math.random() * 1e6)}`);
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(dir, ...rel.split("/"));
    mkdirSync(join(abs, ".."), { recursive: true });
    writeFileSync(abs, content);
  }
  return dir;
}

function stage(r: string, asset: string, content: string): void {
  const dir = join(r, ".update", "staged");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, asset), content);
}

function entry(path: string, content: string, since = "1.7.22"): ManifestFile {
  return { path, size: Buffer.byteLength(content), sha256: "", since, asset: assetNameFor(path) };
}

afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
  root = "";
});

describe("asset names", () => {
  test("a path becomes one flat, GitHub-safe asset name", () => {
    expect(assetNameFor("cupcat.exe")).toBe("file__cupcat.exe");
    expect(assetNameFor("sidecars/piper/piper.exe")).toBe("file__sidecars__piper__piper.exe");
  });

  test("different paths never collide", () => {
    const paths = ["cupcat.exe", "cupcat-bridge.exe", "sidecars/ffmpeg.exe", "sidecars/piper/piper.exe", "sidecars/faces/yunet.onnx"];
    expect(new Set(paths.map(assetNameFor)).size).toBe(paths.length);
  });
});

describe("what needs downloading", () => {
  const remote: Manifest = {
    version: "1.7.22",
    files: [entry("cupcat.exe", "new app"), entry("cupcat-bridge.exe", "new engine"), { ...entry("sidecars/ffmpeg.exe", "ffmpeg"), since: "1.7.0" }],
  };
  for (const f of remote.files) f.sha256 = `hash-of-${f.path}`;

  test("only files whose content differs", () => {
    const local = new Map([
      ["cupcat.exe", "old"],
      ["cupcat-bridge.exe", "old"],
      ["sidecars/ffmpeg.exe", "hash-of-sidecars/ffmpeg.exe"], // unchanged since 1.7.0
    ]);
    const need = changedFiles(remote, local);
    expect(need.map((f) => f.path)).toEqual(["cupcat.exe", "cupcat-bridge.exe"]);
  });

  test("a file that is missing entirely is fetched", () => {
    const need = changedFiles(remote, new Map([["cupcat.exe", "hash-of-cupcat.exe"]]));
    expect(need.map((f) => f.path)).toEqual(["cupcat-bridge.exe", "sidecars/ffmpeg.exe"]);
  });

  test("nothing to do when every hash already matches", () => {
    const local = new Map(remote.files.map((f) => [f.path, f.sha256]));
    expect(changedFiles(remote, local)).toEqual([]);
  });

  test("the heavy sidecars are what the saving is made of", () => {
    // The point of the whole feature: what changes is the app and the engine, and the 1.3 GB of
    // models and tools underneath them is left alone.
    const local = new Map([["sidecars/ffmpeg.exe", "hash-of-sidecars/ffmpeg.exe"]]);
    expect(changedFiles(remote, local).some((f) => f.path.startsWith("sidecars/"))).toBe(false);
  });
});

describe("reading what is installed", () => {
  test("hashes every file, and skips the uninstaller and our own scratch", async () => {
    root = makeInstall({
      "cupcat.exe": "app",
      "sidecars/ffmpeg.exe": "tool",
      "uninstall.exe": "written by the installer for this machine",
      ".update/staged/file__cupcat.exe": "mid-update leftovers",
    });
    const files = await localFiles(root);
    expect([...files.keys()].sort()).toEqual(["cupcat.exe", "sidecars/ffmpeg.exe"]);
    expect(files.get("cupcat.exe")).toBe(await hashFile(join(root, "cupcat.exe")));
  });

  test("the second read comes from the cache, and a changed file is re-read", async () => {
    root = makeInstall({ "cupcat.exe": "app" });
    const first = await localFiles(root);
    expect(existsSync(join(root, ".update", "hashes.json"))).toBe(true);

    // Same bytes, same answer.
    expect((await localFiles(root)).get("cupcat.exe")).toBe(first.get("cupcat.exe"));

    // Different bytes and a different timestamp: the cache must not be believed.
    writeFileSync(join(root, "cupcat.exe"), "app, but newer");
    const later = new Date(Date.now() + 60_000);
    utimesSync(join(root, "cupcat.exe"), later, later);
    expect((await localFiles(root)).get("cupcat.exe")).not.toBe(first.get("cupcat.exe"));
  });
});

describe("putting the files in place", () => {
  test("every staged file replaces its target, and the old one is kept", () => {
    root = makeInstall({ "cupcat.exe": "old app", "cupcat-bridge.exe": "old engine" });
    stage(root, assetNameFor("cupcat.exe"), "new app");
    stage(root, assetNameFor("cupcat-bridge.exe"), "new engine");

    const failure = swapStaged(root, [entry("cupcat.exe", "new app"), entry("cupcat-bridge.exe", "new engine")]);

    expect(failure).toBeNull();
    expect(readFileSync(join(root, "cupcat.exe"), "utf8")).toBe("new app");
    expect(readFileSync(join(root, "cupcat-bridge.exe"), "utf8")).toBe("new engine");
    expect(readFileSync(join(root, ".update", "backup", assetNameFor("cupcat.exe")), "utf8")).toBe("old app");
  });

  test("a file the release adds is created, folders and all", () => {
    root = makeInstall({ "cupcat.exe": "app" });
    stage(root, assetNameFor("sidecars/new/tool.exe"), "a tool that did not exist before");

    expect(swapStaged(root, [entry("sidecars/new/tool.exe", "a tool that did not exist before")])).toBeNull();
    expect(readFileSync(join(root, "sidecars", "new", "tool.exe"), "utf8")).toBe("a tool that did not exist before");
  });

  test("one bad file undoes the whole swap — no half-updated install", () => {
    // The engine arrives, the app does not. Left alone, that is a new engine under an old app:
    // exactly the mismatch that stops CupCat opening. It has to come back as it was.
    root = makeInstall({ "cupcat.exe": "old app", "cupcat-bridge.exe": "old engine" });
    stage(root, assetNameFor("cupcat-bridge.exe"), "new engine");
    // cupcat.exe is never staged.

    const failure = swapStaged(root, [entry("cupcat-bridge.exe", "new engine"), entry("cupcat.exe", "new app")]);

    expect(failure).not.toBeNull();
    expect(failure?.message).toContain("cupcat.exe");
    expect(readFileSync(join(root, "cupcat-bridge.exe"), "utf8")).toBe("old engine");
    expect(readFileSync(join(root, "cupcat.exe"), "utf8")).toBe("old app");
  });

  test("swapping nothing is not an error", () => {
    root = makeInstall({ "cupcat.exe": "app" });
    expect(swapStaged(root, [])).toBeNull();
    expect(readFileSync(join(root, "cupcat.exe"), "utf8")).toBe("app");
  });
});
