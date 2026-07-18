// Pure-logic tests for the chat @-mention typeahead: caret-aware token detection, accent- and
// case-insensitive asset filtering, and inline insertion that preserves surrounding text.
// Run with `bunx vitest run` (no DOM needed).
import { describe, expect, test } from "vitest";
import type { MediaAsset } from "@cupcat/editor-core";
import { assetTypeIcon, filterAssets, findMentionToken, insertMention } from "./chatMentions";

function asset(id: string, name: string, type: MediaAsset["type"] = "video"): MediaAsset {
  return { id, type, name, durationSeconds: 10, hasAudio: type !== "image", generationStatus: { kind: "none" } };
}

describe("findMentionToken", () => {
  test("token at the start of the text", () => {
    expect(findMentionToken("@dro", 4)).toEqual({ start: 0, end: 4, query: "dro" });
  });

  test("token in the middle of a sentence", () => {
    expect(findMentionToken("cut @dro then merge", 8)).toEqual({ start: 4, end: 8, query: "dro" });
  });

  test("no token once a space follows the @word", () => {
    // Caret after "bar": the space at index 4 closed the "@foo" token.
    expect(findMentionToken("@foo bar", 8)).toBeNull();
  });

  test("no token when the text has no @", () => {
    expect(findMentionToken("hello world", 11)).toBeNull();
  });

  test("no token for an email-like @ glued to a word", () => {
    expect(findMentionToken("mail me at a@b", 14)).toBeNull();
  });

  test("empty query right after typing @", () => {
    expect(findMentionToken("look @", 6)).toEqual({ start: 5, end: 6, query: "" });
  });

  test("query stops at the caret — text after it is ignored", () => {
    // "@dr|one rest": caret at 3, only "dr" is the query.
    expect(findMentionToken("@drone rest", 3)).toEqual({ start: 0, end: 3, query: "dr" });
  });

  test("newline also closes the token (whitespace rule)", () => {
    expect(findMentionToken("@foo\nbar", 8)).toBeNull();
  });
});

describe("filterAssets", () => {
  const media = [asset("asset_1", "Drone.MP4"), asset("asset_2", "Perché.mov"), asset("asset_3", "intro-musica", "audio")];

  test("case-insensitive name match", () => {
    expect(filterAssets(media, "drone").map((a) => a.id)).toEqual(["asset_1"]);
  });

  test("accent-insensitive: plain query matches accented name", () => {
    expect(filterAssets(media, "perche").map((a) => a.id)).toEqual(["asset_2"]);
  });

  test("accent-insensitive: accented query matches plain name", () => {
    expect(filterAssets([asset("asset_9", "citta-notte.mp4")], "CITTÀ").map((a) => a.id)).toEqual(["asset_9"]);
  });

  test("empty query returns everything (capped)", () => {
    expect(filterAssets(media, "")).toHaveLength(3);
  });

  test("caps results at 8", () => {
    const many = Array.from({ length: 12 }, (_, i) => asset(`asset_${i}`, `clip ${i}`));
    expect(filterAssets(many, "clip")).toHaveLength(8);
  });
});

describe("insertMention", () => {
  test("replaces a token at the start and appends a trailing space", () => {
    const token = findMentionToken("@dro", 4)!;
    expect(insertMention("@dro", token, "Drone.mp4", "asset_1")).toEqual({
      text: "@Drone.mp4 (asset_1) ",
      caret: 21,
    });
  });

  test("preserves text before the token and after the caret", () => {
    const text = "cut @dro then merge";
    const token = findMentionToken(text, 8)!;
    const out = insertMention(text, token, "Drone.mp4", "asset_1");
    expect(out.text).toBe("cut @Drone.mp4 (asset_1)  then merge");
    // Caret lands right after the inserted mention (before " then merge").
    expect(out.text.slice(0, out.caret)).toBe("cut @Drone.mp4 (asset_1) ");
  });

  test("mid-token caret: only the typed part is replaced, the tail stays", () => {
    // "@dr|one rest" — the user selects a suggestion while "one rest" sits after the caret.
    const text = "@drone rest";
    const token = findMentionToken(text, 3)!;
    const out = insertMention(text, token, "Drone.mp4", "asset_1");
    expect(out.text).toBe("@Drone.mp4 (asset_1) one rest");
    expect(out.caret).toBe(21);
  });
});

describe("assetTypeIcon", () => {
  test("maps video/audio/image to their glyphs", () => {
    expect(assetTypeIcon("video")).toBe("🎞");
    expect(assetTypeIcon("audio")).toBe("🎵");
    expect(assetTypeIcon("image")).toBe("🖼");
  });
});
