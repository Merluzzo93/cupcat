// Pure-logic tests for face blur: parsing the model's boxes, grouping them into tracks, and the
// ffmpeg expression. The rendering itself is verified end-to-end against real footage; these cover
// the decisions that are easy to get subtly wrong and impossible to eyeball in a rendered frame.

import { describe, expect, it } from "bun:test";
import { buildTracks, iou, padBox, parseBoxes, parseFrameBatch, parseSidecarLine, simplifyTrack, supportsFilterScriptFromFile, trackExpr } from "./faceblur";

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

  /** Evaluate the expression the way ffmpeg does. Checking the STRING would only prove it looks
   *  like the last version of itself; checking the path proves the patch lands on the face. */
  const at = (expr: string, t: number): number =>
    (new Function("t", "clip", `return ${expr};`) as (t: number, clip: (x: number, a: number, b: number) => number) => number)(
      t,
      (x, a, c) => Math.max(a, Math.min(c, x)),
    );

  it("is a bare number for a single sample", () => {
    expect(trackExpr([pts[0]!], (b) => b.x, 100)).toBe("10");
  });

  it("interpolates between samples", () => {
    const e = trackExpr(pts, (b) => b.x, 100);
    expect(at(e, 0)).toBeCloseTo(10, 3);
    expect(at(e, 0.5)).toBeCloseTo(15, 3);
    expect(at(e, 1)).toBeCloseTo(20, 3);
  });

  it("holds the first value before the track starts and the last after it ends", () => {
    const e = trackExpr(pts, (b) => b.x, 100);
    expect(at(e, -5)).toBeCloseTo(10, 3);
    expect(at(e, 99)).toBeCloseTo(20, 3);
  });

  it("emits a constant when the value doesn't move", () => {
    const flat = trackExpr(
      [
        { t: 0, x: 0.5, y: 0, w: 0.2, h: 0.2 },
        { t: 1, x: 0.5, y: 0, w: 0.2, h: 0.2 },
      ],
      (b) => b.x,
      100,
    );
    expect(flat).toBe("50");
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
    expect(e).not.toContain("Infinity");
    expect(at(e, 1)).toBeCloseTo(10, 3);
  });

  it("stays FLAT however many samples there are", () => {
    // The bug this replaced: one nested if() per sample, and ffmpeg's parser gives up past a certain
    // depth with "Missing ')' or too many args". A face followed for two minutes produced 109
    // samples and blur_faces failed on every attempt. Nothing here nests.
    const many = Array.from({ length: 120 }, (_, i) => ({ t: i * 0.5, x: 0.1 + (i % 7) * 0.02, y: 0, w: 0.2, h: 0.2 }));
    const e = trackExpr(many, (b) => b.x, 1000);
    expect(e).not.toContain("if(");
    let depth = 0;
    let deepest = 0;
    for (const ch of e) {
      if (ch === "(") deepest = Math.max(deepest, ++depth);
      else if (ch === ")") depth--;
    }
    expect(deepest).toBeLessThanOrEqual(2);
  });

  it("follows a long path accurately, sample by sample", () => {
    const many = Array.from({ length: 60 }, (_, i) => ({ t: i * 0.5, x: 0.1 + Math.sin(i) * 0.05, y: 0, w: 0.2, h: 0.2 }));
    const e = trackExpr(many, (b) => b.x, 1000);
    for (const p of many) expect(at(e, p.t)).toBeCloseTo(Math.round(p.x * 1000), 2);
  });
});

describe("simplifyTrack", () => {
  const path = (n: number, f: (i: number) => number) =>
    Array.from({ length: n }, (_, i) => ({ t: i * 0.5, x: f(i), y: 0.5, w: 0.2, h: 0.2 }));

  it("leaves a short track exactly as it is", () => {
    const p = path(10, (i) => 0.1 + i * 0.01);
    expect(simplifyTrack(p, 60)).toEqual(p);
  });

  it("brings a long track inside the limit", () => {
    const p = path(300, (i) => 0.3 + Math.sin(i / 5) * 0.2);
    expect(simplifyTrack(p, 60).length).toBeLessThanOrEqual(60);
  });

  it("keeps the ends, so the patch still starts and stops where the face does", () => {
    const p = path(300, (i) => 0.3 + Math.sin(i / 5) * 0.2);
    const s = simplifyTrack(p, 60);
    expect(s[0]).toEqual(p[0]!);
    expect(s[s.length - 1]).toEqual(p[p.length - 1]!);
  });

  it("stays in time order and never invents a sample", () => {
    const p = path(300, (i) => 0.3 + Math.sin(i / 5) * 0.2);
    const s = simplifyTrack(p, 60);
    for (let i = 1; i < s.length; i++) expect(s[i]!.t).toBeGreaterThan(s[i - 1]!.t);
    for (const k of s) expect(p).toContain(k);
  });

  it("collapses a straight line to its two ends", () => {
    // Nothing is lost by dropping the middle of a constant-velocity move, and this is what makes
    // room for the moments that do change.
    expect(simplifyTrack(path(200, (i) => 0.1 + i * 0.001), 60)).toHaveLength(2);
  });

  it("spends its budget where the movement is, not evenly", () => {
    // Still for the first half, darting about in the second. Dropping every other sample would
    // treat both halves alike and smear exactly the part where the patch has to keep up.
    const p = path(200, (i) => (i < 100 ? 0.2 : 0.2 + Math.sin(i) * 0.15));
    const s = simplifyTrack(p, 40);
    const late = s.filter((k) => k.t >= 50).length;
    expect(late).toBeGreaterThan(s.length * 0.7);
  });

  it("follows the original path closely, not just approximately", () => {
    const p = path(300, (i) => 0.3 + Math.sin(i / 5) * 0.2);
    const s = simplifyTrack(p, 60);
    const at = (t: number) => {
      for (let i = 1; i < s.length; i++) {
        if (s[i]!.t >= t) {
          const a = s[i - 1]!;
          const b = s[i]!;
          return a.x + ((b.x - a.x) * (t - a.t)) / (b.t - a.t);
        }
      }
      return s[s.length - 1]!.x;
    };
    // Worst deviation as a fraction of frame width. The patch's padding is far wider than this.
    const worst = Math.max(...p.map((k) => Math.abs(at(k.t) - k.x)));
    expect(worst).toBeLessThan(0.03);
  });

  it("a degenerate request is refused rather than returning nothing", () => {
    const p = path(100, (i) => i * 0.001);
    expect(simplifyTrack(p, 1)).toEqual(p);
    expect(simplifyTrack([], 60)).toEqual([]);
  });
});

describe("parseFrameBatch — indexed replies", () => {
  it("places each frame's faces by its own index", () => {
    const got = parseFrameBatch('[{"i":0,"faces":[{"x":0.1,"y":0.1,"w":0.2,"h":0.2}]},{"i":1,"faces":[]},{"i":2,"faces":[{"x":0.5,"y":0.2,"w":0.1,"h":0.1}]}]', 3);
    expect(got.map((g) => g.length)).toEqual([1, 0, 1]);
  });

  it("re-aligns a reply that came back out of order", () => {
    // The whole reason for the index. Trusting position would stamp one moment's face onto another
    // moment's timestamp — a blurred face pasted where nobody is standing.
    const got = parseFrameBatch('[{"i":2,"faces":[{"x":0.5,"y":0.2,"w":0.1,"h":0.1}]},{"i":0,"faces":[{"x":0.1,"y":0.1,"w":0.2,"h":0.2}]}]', 3);
    expect(got[0]).toHaveLength(1);
    expect(got[1]).toHaveLength(0);
    expect(got[2]).toHaveLength(1);
    expect(got[0]![0]!.x).toBeCloseTo(0.1);
    expect(got[2]![0]!.x).toBeCloseTo(0.5);
  });

  it("drops an out-of-range index instead of shifting everything", () => {
    const got = parseFrameBatch('[{"i":9,"faces":[{"x":0.1,"y":0.1,"w":0.2,"h":0.2}]},{"i":0,"faces":[{"x":0.3,"y":0.1,"w":0.2,"h":0.2}]}]', 2);
    expect(got[0]).toHaveLength(1);
    expect(got[0]![0]!.x).toBeCloseTo(0.3);
    expect(got[1]).toHaveLength(0);
  });

  it("always returns exactly one entry per requested frame", () => {
    expect(parseFrameBatch('[{"i":0,"faces":[]}]', 5)).toHaveLength(5);
    expect(parseFrameBatch("nonsense", 4)).toHaveLength(4);
  });
});

describe("parseFrameBatch — legacy array replies", () => {
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

// The local face detector is a separate process, so everything it says arrives as text. These tests
// pin the reading of that text: a malformed line must never take down a blur job, and a box that
// would be meaningless must never become a blur patch on someone's video.

describe("parseSidecarLine", () => {
  it("reads a detection into fractional boxes", () => {
    const r = parseSidecarLine('{"file":"a.jpg","w":720,"h":1280,"faces":[{"x":0.37,"y":0.02,"w":0.16,"h":0.11,"score":0.93}]}');
    expect(r?.file).toBe("a.jpg");
    expect(r?.faces).toEqual([{ x: 0.37, y: 0.02, w: 0.16, h: 0.11 }]);
  });

  it("reads a frame with no face as an empty list, not as a failure", () => {
    // The distinction matters: null means "the detector broke, fall back to vision", while an empty
    // list means "there is genuinely nobody here" and the frame must be left untouched.
    expect(parseSidecarLine('{"file":"a.jpg","w":720,"h":1280,"faces":[]}')).toEqual({ file: "a.jpg", faces: [] });
  });

  it("keeps every face when several are in shot", () => {
    const r = parseSidecarLine(
      '{"file":"a.jpg","faces":[{"x":0.1,"y":0.1,"w":0.1,"h":0.1,"score":0.9},{"x":0.6,"y":0.1,"w":0.1,"h":0.1,"score":0.8}]}',
    );
    expect(r?.faces).toHaveLength(2);
  });

  it("survives Windows paths, which are full of backslashes", () => {
    const r = parseSidecarLine('{"file":"D:\\\\exports\\\\_faces\\\\f00001.jpg","faces":[]}');
    expect(r?.file).toBe("D:\\exports\\_faces\\f00001.jpg");
  });

  it("returns null on anything that isn't a detection line", () => {
    for (const bad of ["", "not json", "{}", '{"file":"a.jpg"}', '{"faces":[]}', '{"file":42,"faces":[]}']) {
      expect(parseSidecarLine(bad)).toBeNull();
    }
  });

  it("drops boxes with missing or non-numeric coordinates rather than blurring at NaN", () => {
    const r = parseSidecarLine('{"file":"a.jpg","faces":[{"x":0.1,"y":0.1,"w":0.1},{"x":"a","y":0.1,"w":0.1,"h":0.1},{"x":0.1,"y":0.1,"w":0.1,"h":0.1}]}');
    expect(r?.faces).toEqual([{ x: 0.1, y: 0.1, w: 0.1, h: 0.1 }]);
  });

  it("drops degenerate boxes — a sub-pixel patch is noise, not a face", () => {
    const r = parseSidecarLine('{"file":"a.jpg","faces":[{"x":0.5,"y":0.5,"w":0.001,"h":0.001,"score":0.7}]}');
    expect(r?.faces).toEqual([]);
  });
});
