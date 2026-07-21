// Pure-logic tests for face blur: parsing the model's boxes, grouping them into tracks, and the
// ffmpeg expression. The rendering itself is verified end-to-end against real footage; these cover
// the decisions that are easy to get subtly wrong and impossible to eyeball in a rendered frame.

import { describe, expect, it } from "bun:test";
import { buildTracks, iou, padBox, parseBoxes, parseFrameBatch, supportsFilterScriptFromFile, trackExpr } from "./faceblur";

describe("parseBoxes", () => {
  it("reads a clean array", () => {
    const got = parseBoxes('[{"x":0.1,"y":0.2,"w":0.3,"h":0.4}]');
    expect(got).toEqual([{ x: 0.1, y: 0.2, w: 0.3, h: 0.4 }]);
  });

  it("tolerates prose and a code fence around the JSON", () => {
    const got = parseBoxes('Sure!\n```json\n[{"x":0.1,"y":0.2,"w":0.3,"h":0.4}]\n```');
    expect(got).toHaveLength(1);
  });

  it("returns nothing for an empty array or unparseable text", () => {
    expect(parseBoxes("[]")).toEqual([]);
    expect(parseBoxes("no faces here")).toEqual([]);
    expect(parseBoxes("[{broken")).toEqual([]);
  });

  it("drops degenerate boxes and full-frame hallucinations", () => {
    const got = parseBoxes('[{"x":0,"y":0,"w":0,"h":0.2},{"x":0,"y":0,"w":0.99,"h":0.99},{"x":0.4,"y":0.1,"w":0.2,"h":0.2}]');
    expect(got).toEqual([{ x: 0.4, y: 0.1, w: 0.2, h: 0.2 }]);
  });

  it("ignores entries with missing or non-numeric fields", () => {
    expect(parseBoxes('[{"x":0.1,"y":0.2,"w":0.3},{"x":"a","y":0.2,"w":0.3,"h":0.4}]')).toEqual([]);
  });
});

describe("padBox", () => {
  it("grows the box on every side", () => {
    const b = padBox({ x: 0.4, y: 0.4, w: 0.2, h: 0.2 }, 0.5);
    expect(b.x).toBeCloseTo(0.3);
    expect(b.w).toBeCloseTo(0.4);
  });

  it("never runs outside the frame", () => {
    const b = padBox({ x: 0.02, y: 0.9, w: 0.1, h: 0.1 }, 1);
    expect(b.x).toBe(0);
    expect(b.y + b.h).toBeLessThanOrEqual(1);
  });
});

describe("iou", () => {
  it("is 1 for identical boxes and 0 when apart", () => {
    const a = { x: 0.1, y: 0.1, w: 0.2, h: 0.2 };
    expect(iou(a, a)).toBeCloseTo(1);
    expect(iou(a, { x: 0.7, y: 0.7, w: 0.2, h: 0.2 })).toBe(0);
  });

  it("is partial for a shifted box", () => {
    const s = iou({ x: 0, y: 0, w: 0.2, h: 0.2 }, { x: 0.1, y: 0, w: 0.2, h: 0.2 });
    expect(s).toBeGreaterThan(0);
    expect(s).toBeLessThan(1);
  });
});

describe("buildTracks", () => {
  const f = (t: number, boxes: { x: number; y: number; w: number; h: number }[]) => ({ t, boxes });

  it("follows one face that drifts across frames", () => {
    const tracks = buildTracks([
      f(0, [{ x: 0.4, y: 0.1, w: 0.2, h: 0.2 }]),
      f(1, [{ x: 0.42, y: 0.1, w: 0.2, h: 0.2 }]),
      f(2, [{ x: 0.44, y: 0.1, w: 0.2, h: 0.2 }]),
    ]);
    expect(tracks).toHaveLength(1);
    expect(tracks[0]!.pts).toHaveLength(3);
  });

  it("keeps two people apart", () => {
    const tracks = buildTracks([
      f(0, [
        { x: 0.1, y: 0.1, w: 0.15, h: 0.15 },
        { x: 0.7, y: 0.1, w: 0.15, h: 0.15 },
      ]),
      f(1, [
        { x: 0.11, y: 0.1, w: 0.15, h: 0.15 },
        { x: 0.71, y: 0.1, w: 0.15, h: 0.15 },
      ]),
    ]);
    expect(tracks).toHaveLength(2);
    for (const tr of tracks) expect(tr.pts).toHaveLength(2);
  });

  it("ends a track when the face leaves the shot — no smear left behind", () => {
    const tracks = buildTracks([
      f(0, [{ x: 0.4, y: 0.1, w: 0.2, h: 0.2 }]),
      f(1, [{ x: 0.4, y: 0.1, w: 0.2, h: 0.2 }]),
      f(2, []), // cut away
      f(3, []),
    ]);
    expect(tracks).toHaveLength(1);
    expect(tracks[0]!.pts[tracks[0]!.pts.length - 1]!.t).toBe(1);
  });

  it("discards a single isolated hit as a false positive", () => {
    expect(buildTracks([f(0, [{ x: 0.4, y: 0.1, w: 0.2, h: 0.2 }]), f(1, [])])).toEqual([]);
  });

  it("starts a new track for a face that appears later", () => {
    const tracks = buildTracks([
      f(0, [{ x: 0.1, y: 0.1, w: 0.15, h: 0.15 }]),
      f(1, [{ x: 0.1, y: 0.1, w: 0.15, h: 0.15 }]),
      f(2, [
        { x: 0.1, y: 0.1, w: 0.15, h: 0.15 },
        { x: 0.8, y: 0.5, w: 0.15, h: 0.15 },
      ]),
      f(3, [
        { x: 0.1, y: 0.1, w: 0.15, h: 0.15 },
        { x: 0.8, y: 0.5, w: 0.15, h: 0.15 },
      ]),
    ]);
    expect(tracks).toHaveLength(2);
  });
});

describe("trackExpr", () => {
  const pts = [
    { t: 0, x: 0.1, y: 0, w: 0.2, h: 0.2 },
    { t: 1, x: 0.2, y: 0, w: 0.2, h: 0.2 },
  ];

  it("is a bare number for a single sample", () => {
    expect(trackExpr([pts[0]!], (b) => b.x, 100)).toBe("10");
  });

  it("interpolates between samples and holds the last value after the end", () => {
    const e = trackExpr(pts, (b) => b.x, 100);
    expect(e).toContain("if(lt(t,1.000)");
    expect(e).toContain("(10+(10)*(t-0.000)/1.000)");
    expect(e.endsWith(",20)")).toBe(true); // tail holds the final position
  });

  it("emits a constant instead of a division when the value doesn't move", () => {
    const flat = trackExpr(
      [
        { t: 0, x: 0.5, y: 0, w: 0.2, h: 0.2 },
        { t: 1, x: 0.5, y: 0, w: 0.2, h: 0.2 },
      ],
      (b) => b.x,
      100,
    );
    expect(flat).toBe("if(lt(t,1.000),50,50)");
  });

  it("never emits a zero denominator for samples at the same instant", () => {
    const e = trackExpr(
      [
        { t: 1, x: 0.1, y: 0, w: 0.2, h: 0.2 },
        { t: 1, x: 0.4, y: 0, w: 0.2, h: 0.2 },
      ],
      (b) => b.x,
      100,
    );
    expect(e).not.toContain("/0.000");
  });
});

describe("parseFrameBatch", () => {
  it("splits one array per image", () => {
    const got = parseFrameBatch('[[{"x":0.1,"y":0.1,"w":0.2,"h":0.2}],[],[{"x":0.5,"y":0.1,"w":0.2,"h":0.2},{"x":0.8,"y":0.1,"w":0.1,"h":0.1}]]', 3);
    expect(got).toHaveLength(3);
    expect(got[0]).toHaveLength(1);
    expect(got[1]).toHaveLength(0);
    expect(got[2]).toHaveLength(2);
  });

  it("pads a short reply so frames never shift onto the wrong timestamps", () => {
    const got = parseFrameBatch('[[{"x":0.1,"y":0.1,"w":0.2,"h":0.2}]]', 4);
    expect(got).toHaveLength(4);
    expect(got[3]).toEqual([]);
  });

  it("truncates a reply that returned too many arrays", () => {
    expect(parseFrameBatch("[[],[],[],[]]", 2)).toHaveLength(2);
  });

  it("accepts a flat array only when a single frame was requested", () => {
    expect(parseFrameBatch('[{"x":0.1,"y":0.1,"w":0.2,"h":0.2}]', 1)[0]).toHaveLength(1);
    expect(parseFrameBatch('[{"x":0.1,"y":0.1,"w":0.2,"h":0.2}]', 3)).toEqual([[], [], []]);
  });

  it("degrades to empties on unparseable text", () => {
    expect(parseFrameBatch("sorry, I cannot", 2)).toEqual([[], []]);
  });
});

describe("supportsFilterScriptFromFile", () => {
  it("probes the ffmpeg actually in use and caches the answer", async () => {
    // Regression guard. The graph is passed via a file because the expressions are too long for a
    // command line, but the spelling for that differs by version: `-filter_complex_script` was
    // removed in ffmpeg 8, which is what CupCat bundles. Testing against an older ffmpeg on PATH
    // hid the breakage — the shipped app failed with "Unrecognized option". Whatever this returns,
    // it must be a definite boolean so a caller always picks one spelling or the other.
    const a = await supportsFilterScriptFromFile();
    expect(typeof a).toBe("boolean");
    expect(await supportsFilterScriptFromFile()).toBe(a); // cached, no second probe
  });
});
