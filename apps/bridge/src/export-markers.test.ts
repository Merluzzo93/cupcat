// What the handoff to an NLE carries.
//
// CupCat works out where the chapters are and lets you mark anything by hand, and then the FCPXML
// and Premiere exports threw all of it away: the editor opening the project somewhere else got the
// geometry of the cut and had to find every one of those points again. These render the real files
// and read them back, because "the XML has a marker element" and "the marker is at the right frame"
// are different claims.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EditorDocument, makeClip, makeTrack } from "@cupcat/editor-core";
import { projectRoot, setProjectDir } from "./config";
import { exportTimeline } from "./export";

let dir = "";
let previous = "";

beforeAll(() => {
  // Exports land in the project folder; point that somewhere disposable so a test run can never
  // write into whatever project the user has open.
  previous = projectRoot;
  dir = mkdtempSync(join(tmpdir(), "cupcat-markers-"));
  setProjectDir(dir);
});

afterAll(() => {
  // Put it back: projectRoot is process-wide, and a test file that quietly leaves it moved is a
  // trap for whichever file runs next.
  setProjectDir(previous);
  rmSync(dir, { recursive: true, force: true });
});

/** A one-video-clip timeline at 30 fps with the markers given, in frames. */
function docWithMarkers(markers: { frame: number; note?: string; color?: string }[]): EditorDocument {
  const doc = new EditorDocument();
  doc.project.name = "Marker Test";
  doc.project.media.push({
    id: "asset1",
    name: "shot.mp4",
    type: "video",
    url: "D:/media/shot.mp4",
    durationSeconds: 20,
    hasAudio: true,
    generationStatus: { kind: "none" },
  } as never);
  const track = makeTrack("video");
  track.clips.push(
    makeClip({
      mediaRef: "asset1",
      mediaType: "video",
      sourceClipType: "video",
      startFrame: 0,
      durationFrames: 600,
      trimStartFrame: 0,
    }),
  );
  doc.project.timeline.tracks.push(track);
  doc.project.timeline.fps = 30;
  doc.project.timeline.markers = markers.map((m, i) => ({ id: `m${i}`, frame: m.frame, color: m.color ?? "#FF0000", note: m.note }));
  return doc;
}

describe("FCPXML", () => {
  test("every timeline marker reaches the file, at its own frame", async () => {
    const doc = docWithMarkers([
      { frame: 0, note: "Apertura" },
      { frame: 150, note: "La figura bianca" },
      { frame: 450, note: "Il presidente sta arrivando" },
    ]);
    const res = await exportTimeline(doc, "markers", "fcpxml");
    expect(res.ok).toBe(true);
    const xml = readFileSync(res.path!, "utf8");

    const found = [...xml.matchAll(/<marker start="([^"]+)"[^>]*value="([^"]+)"/g)].map((m) => ({ start: m[1]!, value: m[2]! }));
    expect(found.map((f) => f.value)).toEqual(["Apertura", "La figura bianca", "Il presidente sta arrivando"]);
    // 30 fps writes the fps*100 denominator family: frame 150 = 150*100/3000 s = 5 s.
    expect(found[0]!.start).toBe("0/3000s");
    expect(found[1]!.start).toBe("15000/3000s");
    expect(found[2]!.start).toBe("45000/3000s");
  });

  test("a marker with no note still names itself rather than exporting empty", async () => {
    const res = await exportTimeline(docWithMarkers([{ frame: 30 }]), "unnamed", "fcpxml");
    expect(readFileSync(res.path!, "utf8")).toContain('value="Marker"');
  });

  test("markers come after the clips they are anchored to, as the format requires", async () => {
    const doc = docWithMarkers([{ frame: 60, note: "Stacco" }]);
    // A second video track becomes a connected clip on a lane; the marker must still be last.
    const extra = makeTrack("video");
    extra.clips.push(makeClip({ mediaRef: "asset1", mediaType: "video", sourceClipType: "video", startFrame: 30, durationFrames: 120, trimStartFrame: 0 }));
    doc.project.timeline.tracks.unshift(extra);
    const res = await exportTimeline(doc, "order", "fcpxml");
    const xml = readFileSync(res.path!, "utf8");
    expect(xml.indexOf("<marker ")).toBeGreaterThan(xml.indexOf("lane="));
  });

  test("a timeline with no markers is exactly what it was before — no empty elements", async () => {
    const res = await exportTimeline(docWithMarkers([]), "none", "fcpxml");
    expect(readFileSync(res.path!, "utf8")).not.toContain("<marker");
  });

  test("a marker past the end of the cut is left out rather than anchored to nothing", async () => {
    const res = await exportTimeline(docWithMarkers([{ frame: 99_999, note: "Fuori" }]), "past", "fcpxml");
    expect(readFileSync(res.path!, "utf8")).not.toContain("Fuori");
  });

  test("the note is escaped, so an ampersand cannot break the file", async () => {
    const res = await exportTimeline(docWithMarkers([{ frame: 30, note: 'Spiezia & "Meetaly" <2>' }]), "escape", "fcpxml");
    const xml = readFileSync(res.path!, "utf8");
    expect(xml).toContain("Spiezia &amp;");
    expect(xml).not.toContain('value="Spiezia & "');
  });
});

describe("the captions that go with the handoff", () => {
  /** Adds a caption track to a doc built by docWithMarkers. */
  function withCaptions(doc: EditorDocument, cues: { text: string; start: number; dur: number }[]): EditorDocument {
    const track = makeTrack("video");
    for (const c of cues) {
      track.clips.push(
        makeClip({
          mediaRef: "",
          mediaType: "text",
          sourceClipType: "text",
          startFrame: c.start,
          durationFrames: c.dur,
          captionGroupId: "cap1",
          textContent: c.text,
        }),
      );
    }
    doc.project.timeline.tracks.unshift(track);
    return doc;
  }

  test("an SRT lands beside the XML, timed to the timeline", async () => {
    const doc = withCaptions(docWithMarkers([]), [
      { text: "Il presidente sta arrivando", start: 30, dur: 60 },
      { text: "Nel capannone", start: 0, dur: 30 },
    ]);
    const res = await exportTimeline(doc, "withcaps", "fcpxml");
    expect(res.sidecarPath).toMatch(/withcaps\.srt$/);
    const srt = readFileSync(res.sidecarPath!, "utf8");
    // Ordered by time, not by track order: 30 frames at 30 fps is one second in.
    expect(srt.indexOf("Nel capannone")).toBeLessThan(srt.indexOf("Il presidente"));
    expect(srt).toContain("00:00:00,000 --> 00:00:01,000");
    expect(srt).toContain("00:00:01,000 --> 00:00:03,000");
  });

  test("a two-line caption stays two lines in the SRT", async () => {
    const doc = withCaptions(docWithMarkers([]), [{ text: "Prima riga\nSeconda riga", start: 0, dur: 30 }]);
    const res = await exportTimeline(doc, "twoline", "nle_xml");
    expect(readFileSync(res.sidecarPath!, "utf8")).toContain("Prima riga\nSeconda riga");
  });

  test("plain titles are not captions and are left out of it", async () => {
    const doc = docWithMarkers([]);
    const track = makeTrack("video");
    track.clips.push(makeClip({ mediaRef: "", mediaType: "text", sourceClipType: "text", startFrame: 0, durationFrames: 30, textContent: "Titolo" }));
    doc.project.timeline.tracks.unshift(track);
    const res = await exportTimeline(doc, "titleonly", "fcpxml");
    expect(res.sidecarPath).toBeUndefined();
  });

  test("no captions, no file — and the handoff itself still succeeds", async () => {
    const res = await exportTimeline(docWithMarkers([{ frame: 10, note: "X" }]), "nocaps", "fcpxml");
    expect(res.ok).toBe(true);
    expect(res.sidecarPath).toBeUndefined();
  });
});

describe("Premiere / FCP7 XML", () => {
  test("markers land on the sequence, in order, as point markers", async () => {
    const doc = docWithMarkers([
      { frame: 450, note: "Terzo" },
      { frame: 0, note: "Primo" },
      { frame: 150, note: "Secondo" },
    ]);
    const res = await exportTimeline(doc, "markers", "nle_xml");
    expect(res.ok).toBe(true);
    const xml = readFileSync(res.path!, "utf8");

    const names = [...xml.matchAll(/<marker>\s*<name>([^<]*)<\/name>/g)].map((m) => m[1]!);
    expect(names).toEqual(["Primo", "Secondo", "Terzo"]); // sorted by frame, not by insertion
    const ins = [...xml.matchAll(/<in>(\d+)<\/in>\s*<out>-1<\/out>/g)].map((m) => Number(m[1]));
    expect(ins).toEqual([0, 150, 450]);
  });

  test("markers sit inside the sequence, before its media", async () => {
    const res = await exportTimeline(docWithMarkers([{ frame: 10, note: "X" }]), "place", "nle_xml");
    const xml = readFileSync(res.path!, "utf8");
    expect(xml.indexOf("<marker>")).toBeGreaterThan(xml.indexOf("<sequence"));
    expect(xml.indexOf("<marker>")).toBeLessThan(xml.indexOf("<media>"));
  });

  test("no markers means no marker elements", async () => {
    const res = await exportTimeline(docWithMarkers([]), "none", "nle_xml");
    expect(readFileSync(res.path!, "utf8")).not.toContain("<marker>");
  });
});
