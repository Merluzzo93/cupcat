// Reading the same sentence twice.
//
// Found by running get_transcript on real footage: a 120-second clip came back with 488 words, which
// is exactly twice the 244 it contains. The picture and its linked audio were both reporting the
// same speech at the same frames.

import { describe, expect, test } from "bun:test";
import { echoedByPicture, type SpeechClip } from "./speechclips";

const vid = (id: string, mediaRef: string, linkGroupId?: string): SpeechClip => ({ id, mediaType: "video", mediaRef, linkGroupId });
const aud = (id: string, mediaRef: string, linkGroupId?: string): SpeechClip => ({ id, mediaType: "audio", mediaRef, linkGroupId });
const tracks = (...clips: SpeechClip[][]) => clips.map((c) => ({ clips: c }));

describe("audio that only repeats the picture", () => {
  test("a video's own linked audio is an echo", () => {
    const t = tracks([vid("v1", "asset1", "link1")], [aud("a1", "asset1", "link1")]);
    expect([...echoedByPicture(t)]).toEqual(["a1"]);
  });

  test("a separate recording of the same take is NOT an echo", () => {
    // Dual-system sound: a recorder's file placed beside the camera's picture. Different asset, so
    // different words worth reading — this is the case that forbids the simpler rule.
    const t = tracks([vid("v1", "camera", "link1")], [aud("a1", "recorder", "link1")]);
    expect([...echoedByPicture(t)]).toEqual([]);
  });

  test("audio detached from its picture is left alone", () => {
    const t = tracks([vid("v1", "asset1", "link1")], [aud("a1", "asset1", undefined)]);
    expect([...echoedByPicture(t)]).toEqual([]);
  });

  test("a voiceover or music bed is never an echo", () => {
    const t = tracks([vid("v1", "asset1", "link1")], [aud("a1", "asset1", "link1")], [aud("music", "song", undefined)]);
    expect(echoedByPicture(t).has("music")).toBe(false);
  });

  test("every piece of a cut-up clip is caught, not only the first", () => {
    // After splitting, one link group holds several picture pieces and several audio pieces.
    const t = tracks(
      [vid("v1", "asset1", "link1"), vid("v2", "asset1", "link1")],
      [aud("a1", "asset1", "link1"), aud("a2", "asset1", "link1")],
    );
    expect([...echoedByPicture(t)].sort()).toEqual(["a1", "a2"]);
  });

  test("the picture is never dropped", () => {
    const t = tracks([vid("v1", "asset1", "link1")], [aud("a1", "asset1", "link1")]);
    expect(echoedByPicture(t).has("v1")).toBe(false);
  });

  test("two link groups of the same asset are handled independently", () => {
    // The same file placed twice, each with its own audio: both audio clips are echoes, and neither
    // group's membership leaks into the other.
    const t = tracks(
      [vid("v1", "asset1", "linkA"), vid("v2", "asset1", "linkB")],
      [aud("a1", "asset1", "linkA"), aud("a2", "asset1", "linkB"), aud("stray", "asset1", "linkC")],
    );
    expect([...echoedByPicture(t)].sort()).toEqual(["a1", "a2"]);
  });

  test("an empty timeline yields nothing rather than throwing", () => {
    expect([...echoedByPicture([])]).toEqual([]);
    expect([...echoedByPicture(tracks([]))]).toEqual([]);
  });
});
