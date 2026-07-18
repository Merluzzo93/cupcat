// Logic tests for the Transcript panel's pure model, against the REAL get_transcript wire format
// (okJson({ wordFormat: ["text","startFrame","endFrame"], clips: [{ clipId, trackIndex, words }] })
// from apps/bridge/src/executor.ts, words as [text, startFrame, endFrame] tuples).
// Run with `bun test` (bun re-maps the vitest import to bun:test) or `bunx vitest run`.
import { describe, expect, test } from "vitest";
import type { TranscriptWord } from "./transcriptModel";
import {
  MAX_SENTENCE_WORDS,
  formatTimestamp,
  groupTranscript,
  parseTranscript,
  selectionToCut,
  wordIndexAtFrame,
} from "./transcriptModel";

const FPS = 30;

function w(text: string, startFrame: number, endFrame: number, extra?: Partial<TranscriptWord>): TranscriptWord {
  return { text, startFrame, endFrame, clipId: "clip_a", trackIndex: 0, ...extra };
}

describe("parseTranscript", () => {
  test("parses the bridge wire format (per-clip word tuples)", () => {
    const payload = {
      wordFormat: ["text", "startFrame", "endFrame"],
      clips: [
        { clipId: "clip_a", trackIndex: 0, words: [[" Hello", 0, 8], [" world.", 9, 20]] },
        { clipId: "clip_b", trackIndex: 1, words: [[" Later", 300, 315]] },
      ],
    };
    const words = parseTranscript(JSON.stringify(payload));
    expect(words).toEqual([
      { text: "Hello", startFrame: 0, endFrame: 8, clipId: "clip_a", trackIndex: 0 },
      { text: "world.", startFrame: 9, endFrame: 20, clipId: "clip_a", trackIndex: 0 },
      { text: "Later", startFrame: 300, endFrame: 315, clipId: "clip_b", trackIndex: 1 },
    ]);
  });

  test("sorts words from interleaved clips by start frame", () => {
    const payload = {
      wordFormat: ["text", "startFrame", "endFrame"],
      clips: [
        { clipId: "clip_b", trackIndex: 0, words: [["second", 100, 110]] },
        { clipId: "clip_a", trackIndex: 0, words: [["first", 0, 10]] },
      ],
    };
    const words = parseTranscript(JSON.stringify(payload))!;
    expect(words.map((x) => x.text)).toEqual(["first", "second"]);
  });

  test("no speech → empty array (distinct from a bad payload)", () => {
    expect(parseTranscript(JSON.stringify({ wordFormat: ["text", "startFrame", "endFrame"], clips: [] }))).toEqual([]);
  });

  test("malformed JSON or wrong shape → null", () => {
    expect(parseTranscript("not json")).toBeNull();
    expect(parseTranscript(JSON.stringify({ nope: true }))).toBeNull();
    expect(parseTranscript(JSON.stringify(null))).toBeNull();
  });

  test("skips malformed tuples, blank words, and non-finite frames", () => {
    const payload = {
      clips: [
        {
          clipId: "clip_a",
          trackIndex: 0,
          words: [["ok", 0, 5], ["   ", 6, 8], [42, 9, 10], ["short"], ["bad", "x", 12], ["fine.", 20, 25]],
        },
      ],
    };
    const words = parseTranscript(JSON.stringify(payload))!;
    expect(words.map((x) => x.text)).toEqual(["ok", "fine."]);
  });

  test("missing trackIndex defaults to 0; end never precedes start", () => {
    const payload = { clips: [{ clipId: "clip_a", words: [["hi", 10, 4]] }] };
    const words = parseTranscript(JSON.stringify(payload))!;
    expect(words[0].trackIndex).toBe(0);
    expect(words[0].endFrame).toBe(10); // clamped up to startFrame
  });
});

describe("groupTranscript", () => {
  test("splits sentences on terminal punctuation", () => {
    const words = [w("Hi", 0, 5), w("there.", 6, 12), w("Next", 14, 20), w("one", 21, 26)];
    const paras = groupTranscript(words, FPS);
    expect(paras).toHaveLength(1);
    expect(paras[0].sentences.map((s) => [s.from, s.to])).toEqual([
      [0, 1],
      [2, 3],
    ]);
    expect(paras[0].from).toBe(0);
    expect(paras[0].to).toBe(3);
  });

  test("a long silence starts a new sentence, a longer one a new paragraph", () => {
    const words = [
      w("alpha", 0, 10),
      w("beta", 60, 70), // 50-frame gap (~1.7s) > sentence gap, < paragraph gap
      w("gamma", 200, 210), // 130-frame gap (~4.3s) > paragraph gap
    ];
    const paras = groupTranscript(words, FPS);
    expect(paras).toHaveLength(2);
    expect(paras[0].sentences.map((s) => [s.from, s.to])).toEqual([
      [0, 0],
      [1, 1],
    ]);
    expect(paras[1].sentences).toEqual([{ from: 2, to: 2, timestamp: null }]);
  });

  test("timestamp chips appear roughly every 10 seconds", () => {
    // Three sentences starting at 0s, 5s, 12s (30 fps).
    const words = [
      w("one.", 0, 10),
      w("two.", 150, 160),
      w("three.", 360, 370),
    ];
    const paras = groupTranscript(words, FPS);
    const stamps = paras.flatMap((p) => p.sentences).map((s) => s.timestamp);
    expect(stamps).toEqual(["0:00", null, "0:12"]);
  });

  test("unpunctuated speech still breaks into chunks (word cap)", () => {
    const words: TranscriptWord[] = [];
    for (let i = 0; i < MAX_SENTENCE_WORDS * 2; i++) words.push(w("uh", i * 10, i * 10 + 8));
    const sentences = groupTranscript(words, FPS).flatMap((p) => p.sentences);
    expect(sentences.length).toBe(2);
    expect(sentences[0].to - sentences[0].from + 1).toBe(MAX_SENTENCE_WORDS);
  });

  test("empty input → no paragraphs", () => {
    expect(groupTranscript([], FPS)).toEqual([]);
  });
});

describe("selectionToCut", () => {
  const words = [w("Hello", 0, 8), w("world", 9, 20), w("again", 22, 30), w("bye", 40, 55, { trackIndex: 2 })];

  test("maps a word range to [first word start, last word end]", () => {
    const cut = selectionToCut(words, 1, 2)!;
    expect(cut).toEqual({ startFrame: 9, endFrame: 30, trackIndex: 0, wordCount: 2, durationFrames: 21 });
  });

  test("normalizes a reversed (backwards drag) selection", () => {
    expect(selectionToCut(words, 2, 1)).toEqual(selectionToCut(words, 1, 2));
  });

  test("single-word selection", () => {
    const cut = selectionToCut(words, 0, 0)!;
    expect(cut.startFrame).toBe(0);
    expect(cut.endFrame).toBe(8);
    expect(cut.wordCount).toBe(1);
  });

  test("trackIndex comes from the first selected word", () => {
    expect(selectionToCut(words, 3, 3)!.trackIndex).toBe(2);
    expect(selectionToCut(words, 2, 3)!.trackIndex).toBe(0);
  });

  test("zero-length word still yields a cuttable range (end > start)", () => {
    const cut = selectionToCut([w("uh", 100, 100)], 0, 0)!;
    expect(cut.endFrame).toBe(101);
    expect(cut.durationFrames).toBe(1);
  });

  test("out-of-range indices clamp; empty word list → null", () => {
    const cut = selectionToCut(words, -5, 99)!;
    expect(cut.startFrame).toBe(0);
    expect(cut.endFrame).toBe(55);
    expect(cut.wordCount).toBe(4);
    expect(selectionToCut([], 0, 0)).toBeNull();
  });
});

describe("wordIndexAtFrame", () => {
  const words = [w("a", 5, 8), w("b", 9, 20), w("c", 50, 60)];

  test("frame inside a word → its index (start inclusive, end exclusive)", () => {
    expect(wordIndexAtFrame(words, 5)).toBe(0);
    expect(wordIndexAtFrame(words, 9)).toBe(1);
    expect(wordIndexAtFrame(words, 19)).toBe(1);
    expect(wordIndexAtFrame(words, 20)).toBe(-1); // end is exclusive, and 20..49 is silence
  });

  test("silence gaps and out-of-range frames → -1", () => {
    expect(wordIndexAtFrame(words, 30)).toBe(-1);
    expect(wordIndexAtFrame(words, 2)).toBe(-1);
    expect(wordIndexAtFrame(words, 1000)).toBe(-1);
    expect(wordIndexAtFrame([], 0)).toBe(-1);
  });

  test("zero-length word matches exactly at its frame", () => {
    expect(wordIndexAtFrame([w("uh", 10, 10)], 10)).toBe(0);
  });
});

describe("formatTimestamp", () => {
  test("m:ss for short times, h:mm:ss past an hour", () => {
    expect(formatTimestamp(0, 30)).toBe("0:00");
    expect(formatTimestamp(372, 30)).toBe("0:12");
    expect(formatTimestamp(90 * 30, 30)).toBe("1:30");
    expect(formatTimestamp(3661 * 30, 30)).toBe("1:01:01");
  });
});
