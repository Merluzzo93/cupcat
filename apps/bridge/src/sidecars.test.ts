// Every bundled tool has to carry its own runtime.
//
// This exists because of a bug nobody could see: cupcat-faces.exe shipped WITHOUT onnxruntime.dll
// beside it. Windows then resolved the name against C:\Windows\System32\onnxruntime.dll — a
// completely different library that Windows itself installs — and the detector died on startup with
// "OrtGetApiBase must be present". Every caller catches that failure and quietly falls back, so the
// app looked fine: blur_faces silently paid for the vision model instead, and auto_reframe silently
// framed on gradient energy instead of on people. It never once worked on a real machine.
//
// The lesson generalises past ONNX: a sidecar that finds a system-wide DLL of the same name does not
// fail loudly, it fails plausibly. So the rule is checked per folder rather than per known offender.

import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

const sidecars = resolve(import.meta.dir, "..", "..", "desktop", "src-tauri", "sidecars");
const present = existsSync(sidecars);

/**
 * Runtimes Windows also ships a same-named copy of, matched by a symbol rather than by the file name.
 *
 * The file name is not searchable: a Rust binary that loads the library dynamically builds the string
 * inline, so "onnxruntime.dll" appears in the executable as instruction-sized fragments and a byte
 * search for it finds nothing — which is how the first version of this test passed while the bug was
 * still there. The symbol it looks up survives as one contiguous string, so that is what is matched.
 */
const RUNTIMES = [{ dll: "onnxruntime.dll", marker: "OrtGetApiBase" }];

function mentions(exe: string, text: string): boolean {
  return readFileSync(exe).includes(Buffer.from(text, "ascii"));
}

describe.skipIf(!present)("bundled sidecars", () => {
  const folders = readdirSync(sidecars).filter((f) => statSync(join(sidecars, f)).isDirectory());

  test("there are sidecar folders to check", () => {
    expect(folders.length).toBeGreaterThan(0);
  });

  for (const folder of folders) {
    const dir = join(sidecars, folder);
    const exes = readdirSync(dir).filter((f) => f.toLowerCase().endsWith(".exe"));
    for (const exe of exes) {
      for (const { dll, marker } of RUNTIMES) {
        test(`${folder}/${exe} ships its own ${dll} if it needs one`, () => {
          if (!mentions(join(dir, exe), marker)) return; // doesn't use it — nothing to ship
          expect({ folder, exe, dll, shipped: existsSync(join(dir, dll)) }).toEqual({ folder, exe, dll, shipped: true });
        });
      }
    }
  }
});
