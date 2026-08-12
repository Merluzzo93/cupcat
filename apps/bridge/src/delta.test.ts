// Updating in place is the one feature that can leave someone with no working app at all, so the
// parts that touch their files are tested against real directories rather than mocks: what gets
// downloaded, what gets moved where, and — the one that matters — what is left behind when a swap
// fails halfway.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { assetNameFor, changedFiles, FETCH_ATTEMPTS, fetchRetry, hashFile, localFiles, swapStaged, type Manifest, type ManifestFile } from "./delta";

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

// ---------------------------------------------------------------------------- flaky networks

// GitHub serves release assets from a different edge than its API, and that edge resets connections:
// measured on a real machine while publishing 1.10.1, roughly one request in two to
// `releases/download/...` came back ECONNRESET, while curl fetching the very same URL was fine and
// the next attempt seconds later succeeded. Before this, one reset cost the entire update — and on
// the check path it cost it SILENTLY, because every error there is swallowed into "no update".
describe("fetchRetry", () => {
  const real = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = real;
  });

  /** A fetch that fails the first `failures` times, then answers. Records what it was given. */
  function flaky(failures: number, error = new Error("The socket connection was closed unexpectedly")) {
    const calls: RequestInit[] = [];
    let n = 0;
    globalThis.fetch = ((_url: string, init: RequestInit = {}) => {
      calls.push(init);
      if (n++ < failures) return Promise.reject(error);
      return Promise.resolve(new Response("ok", { status: 200 }));
    }) as unknown as typeof fetch;
    return calls;
  }

  const noSleep = async () => {};

  test("a dropped connection is retried, and the answer that arrives is the one returned", async () => {
    const calls = flaky(1);
    const res = await fetchRetry("https://example.test/a", {}, FETCH_ATTEMPTS, noSleep);
    expect(res.status).toBe(200);
    expect(calls.length).toBe(2);
  });

  test("it survives everything short of the last attempt", async () => {
    const calls = flaky(FETCH_ATTEMPTS - 1);
    expect((await fetchRetry("https://example.test/a", {}, FETCH_ATTEMPTS, noSleep)).status).toBe(200);
    expect(calls.length).toBe(FETCH_ATTEMPTS);
  });

  test("and gives up honestly when the network really is gone", async () => {
    flaky(99, new Error("ECONNRESET"));
    await expect(fetchRetry("https://example.test/a", {}, 3, noSleep)).rejects.toThrow("ECONNRESET");
  });

  test("a 404 is an answer, not a flake — it comes straight back", async () => {
    let calls = 0;
    globalThis.fetch = (() => {
      calls++;
      return Promise.resolve(new Response("nope", { status: 404 }));
    }) as unknown as typeof fetch;
    expect((await fetchRetry("https://example.test/a", {}, FETCH_ATTEMPTS, noSleep)).status).toBe(404);
    expect(calls).toBe(1);
  });

  test("an update the user cancelled is not retried behind their back", async () => {
    const controller = new AbortController();
    let calls = 0;
    globalThis.fetch = (() => {
      calls++;
      controller.abort();
      return Promise.reject(new Error("aborted"));
    }) as unknown as typeof fetch;
    await expect(fetchRetry("https://example.test/a", { signal: controller.signal }, FETCH_ATTEMPTS, noSleep)).rejects.toThrow("aborted");
    expect(calls).toBe(1);
  });

  test("the wait between attempts grows", async () => {
    flaky(2);
    const waits: number[] = [];
    await fetchRetry("https://example.test/a", {}, FETCH_ATTEMPTS, async (ms) => {
      waits.push(ms);
    });
    expect(waits).toEqual([500, 1000]);
  });

  test("every attempt gets its own deadline — a spent signal would fail the retries instantly", async () => {
    const calls = flaky(2);
    await fetchRetry("https://example.test/a", { timeoutMs: 5_000 }, FETCH_ATTEMPTS, noSleep);
    const signals = calls.map((c) => c.signal);
    expect(signals.every((s) => s instanceof AbortSignal)).toBe(true);
    expect(new Set(signals).size).toBe(3);
    expect(calls.every((c) => !("timeoutMs" in c))).toBe(true); // never passed on to fetch
  });
});
