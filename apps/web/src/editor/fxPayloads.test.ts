// Payload-shape tests for the manual Look / Voice FX / Beat Sync / Brand kit controls: the UI must
// emit EXACTLY the tool payloads the bridge expects (apply_effect, set_clip_properties, …).
// Run with `bun test` (bun re-maps the vitest import to bun:test) or `bunx vitest run`.
import { describe, expect, test } from "vitest";
import { lookApplyPayload, lookRemovePayload, voiceFxPayload } from "./Inspector";
import { parseBeatDetection, parseBrandKits } from "./Toolbar";

describe("look payloads (apply_effect)", () => {
  test("apply sets a single look effect with name + amount params", () => {
    expect(lookApplyPayload("clip_1", "cinematic", 0.8)).toEqual({
      clipIds: ["clip_1"],
      effects: [{ type: "look", params: { name: "cinematic", amount: 0.8 } }],
    });
  });
  test("remove uses the remove list", () => {
    expect(lookRemovePayload("clip_1")).toEqual({ clipIds: ["clip_1"], remove: ["look"] });
  });
});

describe("voice fx payloads (set_clip_properties)", () => {
  test("pitch carries semitones in amount", () => {
    expect(voiceFxPayload("clip_1", "pitch", 4)).toEqual({ clipIds: ["clip_1"], audioFx: { type: "pitch", amount: 4 } });
  });
  test("echo carries delay seconds in amount", () => {
    expect(voiceFxPayload("clip_1", "echo", 0.25)).toEqual({ clipIds: ["clip_1"], audioFx: { type: "echo", amount: 0.25 } });
  });
  test("robot and radio have no amount (even if one is passed)", () => {
    expect(voiceFxPayload("clip_1", "robot")).toEqual({ clipIds: ["clip_1"], audioFx: { type: "robot" } });
    expect(voiceFxPayload("clip_1", "radio", 3)).toEqual({ clipIds: ["clip_1"], audioFx: { type: "radio" } });
  });
  test("none removes with audioFx: null", () => {
    expect(voiceFxPayload("clip_1", "none")).toEqual({ clipIds: ["clip_1"], audioFx: null });
  });
});

describe("beat detection parsing (detect_beats output)", () => {
  test("parses the JSON text payload", () => {
    expect(parseBeatDetection('{"bpm":128,"confidence":0.42,"beatCount":210,"beats":[0.1,0.6]}')).toEqual({
      bpm: 128,
      confidence: 0.42,
      beatCount: 210,
    });
  });
  test("non-JSON or wrong shape → null", () => {
    expect(parseBeatDetection("Asset not found: xyz")).toBeNull();
    expect(parseBeatDetection('{"bpm":"fast"}')).toBeNull();
  });
});

describe("brand kit persistence (cupcat.brandkits)", () => {
  test("corrupt / missing / non-array JSON degrades to []", () => {
    expect(parseBrandKits("{oops")).toEqual([]);
    expect(parseBrandKits(null)).toEqual([]);
    expect(parseBrandKits('{"not":"an array"}')).toEqual([]);
  });
  test("keeps valid entries, drops junk rows", () => {
    const kits = parseBrandKits(
      '[{"name":"Acme","captionStyle":"boxed","titleOverlay":false,"aspect":"9:16","watermarkPath":"D:/logo.png","watermarkOpacity":0.5},{"bad":true},null]',
    );
    expect(kits).toHaveLength(1);
    expect(kits[0]).toMatchObject({ name: "Acme", watermarkOpacity: 0.5 });
  });
});
