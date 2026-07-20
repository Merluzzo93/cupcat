// Chapter parsing rules that are easy to get wrong and impossible to spot in a description block:
// YouTube silently ignores a chapter list whose first entry isn't 00:00, and duplicate/out-of-range
// timestamps come back from the model often enough to matter.

import { describe, expect, it } from "bun:test";
import { chapterTimestamp, parseChapters } from "./chapters";

describe("chapterTimestamp", () => {
  it("uses m:ss under an hour", () => {
    expect(chapterTimestamp(0)).toBe("0:00");
    expect(chapterTimestamp(7)).toBe("0:07");
    expect(chapterTimestamp(75)).toBe("1:15");
    expect(chapterTimestamp(599)).toBe("9:59");
  });

  it("switches to h:mm:ss past an hour", () => {
    expect(chapterTimestamp(3600)).toBe("1:00:00");
    expect(chapterTimestamp(3725)).toBe("1:02:05");
  });

  it("never emits a negative timestamp", () => {
    expect(chapterTimestamp(-5)).toBe("0:00");
  });
});

describe("parseChapters", () => {
  it("reads a clean array and sorts by time", () => {
    const got = parseChapters('[{"t":60,"title":"Second"},{"t":0,"title":"First"}]', 300);
    expect(got.map((c) => c.title)).toEqual(["First", "Second"]);
  });

  it("forces the first chapter to 0 — YouTube rejects a list that starts later", () => {
    const got = parseChapters('[{"t":7.5,"title":"Intro"},{"t":90,"title":"Topic"}]', 300);
    expect(got[0]!.startSeconds).toBe(0);
    expect(got[1]!.startSeconds).toBe(90);
  });

  it("tolerates prose and a code fence", () => {
    expect(parseChapters('Here you go:\n```json\n[{"t":0,"title":"Intro"}]\n```', 100)).toHaveLength(1);
  });

  it("drops entries past the video duration", () => {
    const got = parseChapters('[{"t":0,"title":"Intro"},{"t":9999,"title":"Beyond the end"}]', 300);
    expect(got).toHaveLength(1);
  });

  it("drops malformed entries instead of failing the whole list", () => {
    const got = parseChapters('[{"t":0,"title":"Intro"},{"t":"x","title":"Bad"},{"t":60},{"t":90,"title":""},{"t":120,"title":"Good"}]', 300);
    expect(got.map((c) => c.title)).toEqual(["Intro", "Good"]);
  });

  it("collapses chapters landing on the same second", () => {
    const got = parseChapters('[{"t":0,"title":"Intro"},{"t":0.4,"title":"Duplicate"},{"t":60,"title":"Next"}]', 300);
    expect(got).toHaveLength(2);
  });

  it("returns nothing for unparseable text or an empty list", () => {
    expect(parseChapters("no chapters here", 100)).toEqual([]);
    expect(parseChapters("[]", 100)).toEqual([]);
  });
});
