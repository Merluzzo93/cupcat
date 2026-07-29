// Reading the tagger's output.
//
// The CLI prints one line per label and nothing machine-readable around it, so this parse is the
// only thing standing between the model and the captions. A silent parse failure would look exactly
// like "this recording contains no sounds" — the failure mode worth a test of its own.

import { describe, expect, test } from "bun:test";
import { parseTags } from "./audiotag";

const REAL_OUTPUT = `D:\\a\\sherpa-onnx\\csrc\\parse-options.cc:PrintUsage:415
Wave duration: 2.000
Elapsed seconds: 0.089 s
Real time factor (RTF): 0.089 / 2.000 = 0.044
AudioEvent(name="Speech", index=0, prob=0.886129)
AudioEvent(name="Music", index=137, prob=0.52279)
AudioEvent(name="Male speech, man speaking", index=1, prob=0.456401)
`;

describe("reading the tagger", () => {
  test("labels and probabilities come out of real CLI output", () => {
    expect(parseTags(REAL_OUTPUT)).toEqual([
      { name: "Speech", prob: 0.886129 },
      { name: "Music", prob: 0.52279 },
      { name: "Male speech, man speaking", prob: 0.456401 },
    ]);
  });

  test("a label containing a comma survives — several AudioSet names do", () => {
    const tags = parseTags(`AudioEvent(name="Gunshot, gunfire", index=427, prob=0.7)`);
    expect(tags).toEqual([{ name: "Gunshot, gunfire", prob: 0.7 }]);
  });

  test("scientific notation is a number, not a NaN", () => {
    expect(parseTags(`AudioEvent(name="Cat", index=81, prob=3.4e-05)`)).toEqual([{ name: "Cat", prob: 3.4e-5 }]);
  });

  test("output with no events yields an empty list, not a throw", () => {
    expect(parseTags("Wave duration: 2.000\n")).toEqual([]);
    expect(parseTags("")).toEqual([]);
  });

  test("a truncated line is skipped rather than half-read", () => {
    expect(parseTags(`AudioEvent(name="Applause", index=67, pro`)).toEqual([]);
  });
});
