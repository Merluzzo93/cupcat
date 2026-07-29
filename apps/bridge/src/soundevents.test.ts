// When to write a sound down, and when to keep quiet.
//
// The probabilities in these tests are the shapes the tagger actually produces. The speech-beats-
// everything rule in particular comes from real footage: an outdoor event where a faint music bed
// scored 0.5-0.8 for the whole two minutes while speech scored 0.8-0.9 throughout. Without that
// rule CupCat would have stamped "(musica)" across an entire conversation.

import { describe, expect, test } from "bun:test";
import {
  captionFor,
  findBeds,
  mergeEvents,
  pickEvent,
  sanitizeWords,
  soundKeyFor,
  SOUND_LABELS,
  speaksLanguage,
  type WindowEvent,
} from "./soundevents";

const tag = (name: string, prob: number) => ({ name, prob });
const win = (startSeconds: number, endSeconds: number, key: keyof typeof SOUND_LABELS, confidence: number): WindowEvent =>
  ({ startSeconds, endSeconds, key, confidence });

describe("naming a sound", () => {
  test("the eight ways AudioSet says laughing all become one word", () => {
    for (const l of ["Laughter", "Giggle", "Snicker", "Belly laugh", "Chuckle, chortle", "Baby laughter"]) {
      expect(soundKeyFor(l)).toBe("laughter");
    }
  });

  test("every flavour of music is music", () => {
    for (const l of ["Music", "Pop music", "Background music", "Theme music", "Happy music", "Christmas music"]) {
      expect(soundKeyFor(l)).toBe("music");
    }
  });

  test("an instrument means music, whatever it is called", () => {
    expect(soundKeyFor("Piano")).toBe("music");
    expect(soundKeyFor("Violin, fiddle")).toBe("music");
    expect(soundKeyFor("Drum kit")).toBe("music");
  });

  test("'Vocal music' is singing, not the music bed — the map wins over the word 'music'", () => {
    expect(soundKeyFor("Vocal music")).toBe("singing");
    expect(soundKeyFor("A capella")).toBe("singing");
    expect(soundKeyFor("Choir")).toBe("singing");
  });

  test("speech is never a sound caption", () => {
    for (const l of ["Speech", "Male speech, man speaking", "Conversation", "Narration, monologue", "Whispering"]) {
      expect(soundKeyFor(l)).toBeNull();
    }
  });

  test("room tone and the recording medium are true and useless", () => {
    for (const l of ["Silence", "Inside, large room or hall", "Environmental noise", "Television", "Radio", "Mains hum"]) {
      expect(soundKeyFor(l)).toBeNull();
    }
  });

  test("'Musical instrument' alone is too vague to caption", () => {
    // It fires alongside a real instrument name; on its own it says only "something musical".
    expect(soundKeyFor("Musical instrument")).toBeNull();
  });

  test("an unknown label earns no caption rather than a wrong one", () => {
    expect(soundKeyFor("Zither harp thing")).toBeNull();
    expect(soundKeyFor("")).toBeNull();
  });

  test("labels match regardless of case or stray spacing", () => {
    expect(soundKeyFor("  APPLAUSE ")).toBe("applause");
  });
});

describe("choosing one sound per window", () => {
  test("clear applause is captioned", () => {
    expect(pickEvent([tag("Applause", 0.83), tag("Cheering", 0.4)])).toEqual({ key: "applause", confidence: 0.83 });
  });

  test("a music bed under an interview is NOT captioned", () => {
    // Measured on real event footage: this exact shape, window after window, for two minutes.
    expect(pickEvent([tag("Speech", 0.87), tag("Music", 0.65), tag("Female speech, woman speaking", 0.31)])).toBeNull();
  });

  test("music with nobody talking IS captioned", () => {
    expect(pickEvent([tag("Music", 0.85), tag("Speech", 0.2)])).toEqual({ key: "music", confidence: 0.85 });
  });

  test("a guess below the threshold is left alone", () => {
    expect(pickEvent([tag("Applause", 0.22)])).toBeNull();
    expect(pickEvent([tag("Applause", 0.22)], { minProb: 0.2 })).toEqual({ key: "applause", confidence: 0.22 });
  });

  test("the strongest captionable sound wins, not the first listed", () => {
    expect(pickEvent([tag("Music", 0.45), tag("Applause", 0.79)])).toEqual({ key: "applause", confidence: 0.79 });
  });

  test("speech that ties with a sound still counts as speech", () => {
    expect(pickEvent([tag("Speech", 0.6), tag("Applause", 0.6)])).toBeNull();
  });

  test("silence yields nothing", () => {
    expect(pickEvent([tag("Silence", 0.95)])).toBeNull();
    expect(pickEvent([])).toBeNull();
  });
});

describe("turning windows into captions", () => {
  test("consecutive windows of the same sound become one caption", () => {
    const out = mergeEvents([win(10, 12, "applause", 0.7), win(12, 14, "applause", 0.8), win(14, 16, "applause", 0.6)]);
    expect(out).toEqual([{ startSeconds: 10, endSeconds: 16, key: "applause", confidence: 0.8 }]);
  });

  test("a lone borderline window is dropped — that is the shape of a false positive", () => {
    expect(mergeEvents([win(30, 32, "dog", 0.44)])).toEqual([]);
  });

  test("a lone CONFIDENT window survives", () => {
    expect(mergeEvents([win(30, 32, "dog", 0.72)])).toHaveLength(1);
  });

  test("two weak windows in a row are enough — the model heard it twice", () => {
    expect(mergeEvents([win(30, 32, "dog", 0.42), win(32, 34, "dog", 0.45)])).toHaveLength(1);
  });

  test("different sounds never merge, even back to back", () => {
    const out = mergeEvents([win(0, 2, "applause", 0.8), win(2, 4, "laughter", 0.8)]);
    expect(out.map((e) => e.key)).toEqual(["applause", "laughter"]);
  });

  test("the same sound after a gap is a second caption", () => {
    const out = mergeEvents([win(0, 2, "applause", 0.8), win(20, 22, "applause", 0.8)]);
    expect(out).toHaveLength(2);
  });

  test("windows arriving out of order still merge", () => {
    const out = mergeEvents([win(12, 14, "applause", 0.5), win(10, 12, "applause", 0.5)]);
    expect(out).toEqual([{ startSeconds: 10, endSeconds: 14, key: "applause", confidence: 0.5 }]);
  });

  test("nothing in, nothing out", () => {
    expect(mergeEvents([])).toEqual([]);
  });
});

describe("a bed is not an event", () => {
  const windows = (n: number, tags: { name: string; prob: number }[][]) =>
    Array.from({ length: n }, (_, i) => ({ tags: tags[i % tags.length]! }));

  test("the false positive that forced this rule", () => {
    // Real event footage: the tagger reported Music in 68% of 60 windows, up to 0.86, and separating
    // the stems proved there is no music in it at all.
    const w = windows(60, [
      [tag("Speech", 0.8), tag("Music", 0.55)],
      [tag("Music", 0.78), tag("Speech", 0.6)],
      [tag("Speech", 0.85), tag("Music", 0.43)],
    ]);
    const beds = findBeds(w);
    expect(beds.map((b) => b.key)).toEqual(["music"]);
    expect(beds[0]!.share).toBeCloseTo(1, 5);
  });

  test("a genuine music bed is treated the same way — it is still not a moment", () => {
    const beds = findBeds(windows(52, [[tag("Music", 0.87)]]));
    expect(beds.map((b) => b.key)).toEqual(["music"]);
  });

  test("applause at a ceremony is an event, not a bed", () => {
    const w = windows(60, [[tag("Speech", 0.9)]]);
    for (let i = 0; i < 4; i++) w[10 + i] = { tags: [tag("Applause", 0.8)] };
    expect(findBeds(w)).toEqual([]);
  });

  test("a short clip OF a sound is never called a bed", () => {
    // Five windows of applause is a ten-second applause clip; suppressing it would be absurd.
    expect(findBeds(windows(5, [[tag("Applause", 0.9)]]))).toEqual([]);
  });

  test("presence counts, not winning: a sound loud under speech all the way through is still a bed", () => {
    // Speech beats it in every single window, so pickEvent never fires — but the moment speech dips
    // it would, and those are the scattered captions this rule exists to prevent.
    const beds = findBeds(windows(40, [[tag("Speech", 0.9), tag("Music", 0.6)]]));
    expect(beds.map((b) => b.key)).toEqual(["music"]);
  });

  test("weak background hits do not make a bed", () => {
    expect(findBeds(windows(40, [[tag("Speech", 0.9), tag("Music", 0.25)]]))).toEqual([]);
  });

  test("no windows, no beds", () => {
    expect(findBeds([])).toEqual([]);
  });
});

describe("the words themselves", () => {
  test("the caption is parenthesised and in the speech's language", () => {
    expect(captionFor("applause", "it")).toBe("(applausi)");
    expect(captionFor("applause", "en")).toBe("(applause)");
  });

  test("a language CupCat has no words for falls back to English rather than inventing them", () => {
    expect(captionFor("applause", "ja")).toBe("(applause)");
    expect(captionFor("applause", undefined)).toBe("(applause)");
    expect(speaksLanguage("ja")).toBe(false);
    expect(speaksLanguage("it")).toBe(true);
    expect(speaksLanguage("it-IT")).toBe(true);
  });

  test("a word the caller supplies wins over both", () => {
    expect(captionFor("applause", "es", { applause: "aplausos" })).toBe("(aplausos)");
    expect(captionFor("laughter", "es", { applause: "aplausos" })).toBe("(laughter)");
  });

  test("supplied words are checked against the sounds that exist", () => {
    expect(sanitizeWords({ applause: "aplausos", nonsense: "x", laughter: 7, music: "  " })).toEqual({
      applause: "aplausos",
    });
    expect(sanitizeWords(null)).toEqual({});
    expect(sanitizeWords("aplausos")).toEqual({});
  });

  test("every sound has both words, so no caption can render blank", () => {
    for (const [key, words] of Object.entries(SOUND_LABELS)) {
      expect(words.en.length, `${key} en`).toBeGreaterThan(0);
      expect(words.it.length, `${key} it`).toBeGreaterThan(0);
    }
  });
});
