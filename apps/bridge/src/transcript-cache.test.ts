// A fix that cannot reach what is already on disk is not a fix.
//
// whisper.cpp's default language is ENGLISH, not auto-detect. Every transcript CupCat made before
// 1.8.0 was therefore decoded as English and labelled "en" whatever was actually spoken. Passing
// -l auto repairs new transcriptions, and repairs nothing at all for a user who has already
// transcribed their footage — the disk cache would keep serving the old, wrong result on a build
// that had just been fixed. The recipe token in the cache key is what makes the fix land, and this
// test exists so it cannot be tidied away as "a constant that never changes".

import { describe, expect, test } from "bun:test";
import { transcriptCacheKey } from "./transcribe";

describe("what the transcript cache is keyed to", () => {
  test("a change in HOW CupCat transcribes invalidates old entries", () => {
    // The shape written before 1.8.0. It must not match today's key for the same file and model.
    const before = "cpp::ggml-large-v3-turbo-q5.bin::";
    expect(transcriptCacheKey("cpp", "ggml-large-v3-turbo-q5.bin", undefined)).not.toBe(before);
    expect(transcriptCacheKey("cpp", "ggml-large-v3-turbo-q5.bin", undefined).startsWith(before)).toBe(true);
  });

  test("the model still separates entries — a bigger model is a different transcript", () => {
    expect(transcriptCacheKey("cpp", "ggml-base.bin")).not.toBe(transcriptCacheKey("cpp", "ggml-large-v3-turbo-q5.bin"));
  });

  test("an explicitly requested language is part of the key", () => {
    expect(transcriptCacheKey("cpp", "m", "it")).not.toBe(transcriptCacheKey("cpp", "m", "en"));
    expect(transcriptCacheKey("cpp", "m", undefined)).not.toBe(transcriptCacheKey("cpp", "m", "it"));
  });

  test("the backend separates entries", () => {
    expect(transcriptCacheKey("cpp", "m")).not.toBe(transcriptCacheKey("openai", "m"));
  });

  test("the same request twice is the same key, or nothing would ever be reused", () => {
    expect(transcriptCacheKey("cpp", "m", "it")).toBe(transcriptCacheKey("cpp", "m", "it"));
  });
});
