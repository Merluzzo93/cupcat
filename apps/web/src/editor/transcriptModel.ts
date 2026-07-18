// Pure logic for the Transcript panel (text-based editing, Descript-style).
// Parses the bridge's get_transcript payload ({ wordFormat: ["text","startFrame","endFrame"],
// clips: [{ clipId, trackIndex, words: [[text, startFrame, endFrame], …] }] }), groups the words
// into sentences/paragraphs with a timestamp chip roughly every 10s, and turns word selections
// into the frame ranges ripple_delete_ranges expects. Frames are PROJECT frames throughout (the
// bridge already maps source seconds through each clip's trim/speed).
// No React/store imports — unit-tested in transcriptModel.test.ts.

/** One spoken word, flattened out of the per-clip tuple arrays and sorted by start frame. */
export interface TranscriptWord {
  text: string;
  startFrame: number;
  endFrame: number;
  clipId: string;
  trackIndex: number;
}

/** A run of words rendered as one sentence. Indices are inclusive positions in the flat array. */
export interface TranscriptSentence {
  from: number;
  to: number;
  /** "m:ss" chip rendered before the sentence — set roughly every TIMESTAMP_EVERY_SECONDS. */
  timestamp: string | null;
}

export interface TranscriptParagraph {
  from: number;
  to: number;
  sentences: TranscriptSentence[];
}

/** A deletable timeline span derived from a word selection (endFrame exclusive, always > start). */
export interface CutRange {
  startFrame: number;
  endFrame: number;
  trackIndex: number;
  wordCount: number;
  durationFrames: number;
}

/** Silence between words longer than this starts a new sentence. */
export const SENTENCE_GAP_SECONDS = 1.25;
/** Silence between sentences longer than this starts a new paragraph. */
export const PARAGRAPH_GAP_SECONDS = 2.5;
/** Unpunctuated speech (some whisper models) still breaks into readable chunks. */
export const MAX_SENTENCE_WORDS = 40;
/** How often a timestamp chip appears in the prose. */
export const TIMESTAMP_EVERY_SECONDS = 10;

const SENTENCE_END_RE = /[.!?…]["'”’)\]]*$/u;

/** Parse the JSON text returned by the get_transcript tool into a flat, sorted word list.
 * Returns [] when there is simply no speech, null when the payload isn't in the expected shape. */
export function parseTranscript(text: string): TranscriptWord[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const clips = (parsed as { clips?: unknown }).clips;
  if (!Array.isArray(clips)) return null;

  const out: TranscriptWord[] = [];
  for (const c of clips) {
    if (typeof c !== "object" || c === null) continue;
    const clip = c as { clipId?: unknown; trackIndex?: unknown; words?: unknown };
    const clipId = typeof clip.clipId === "string" ? clip.clipId : "";
    const trackIndex = typeof clip.trackIndex === "number" && Number.isInteger(clip.trackIndex) ? clip.trackIndex : 0;
    if (!Array.isArray(clip.words)) continue;
    for (const tuple of clip.words) {
      if (!Array.isArray(tuple) || tuple.length < 3) continue;
      const [rawText, rawStart, rawEnd] = tuple as unknown[];
      if (typeof rawText !== "string") continue;
      const startFrame = Number(rawStart);
      const endFrame = Number(rawEnd);
      if (!Number.isFinite(startFrame) || !Number.isFinite(endFrame)) continue;
      const wordText = rawText.trim(); // whisper words often carry a leading space
      if (!wordText) continue;
      out.push({
        text: wordText,
        startFrame: Math.round(startFrame),
        endFrame: Math.round(Math.max(startFrame, endFrame)),
        clipId,
        trackIndex,
      });
    }
  }
  out.sort((a, b) => a.startFrame - b.startFrame || a.endFrame - b.endFrame);
  return out;
}

/** "m:ss" (or "h:mm:ss") for a project frame position. */
export function formatTimestamp(frame: number, fps: number): string {
  const safeFps = fps > 0 ? fps : 30;
  const total = Math.max(0, Math.floor(frame / safeFps));
  const s = total % 60;
  const m = Math.floor(total / 60) % 60;
  const h = Math.floor(total / 3600);
  const pad = (n: number) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

/** Group the flat word list into paragraphs of sentences. Sentences end on terminal punctuation,
 * a long silence, or MAX_SENTENCE_WORDS; a longer silence also ends the paragraph. A timestamp
 * chip is attached to a sentence whenever TIMESTAMP_EVERY_SECONDS have passed since the last one. */
export function groupTranscript(words: TranscriptWord[], fps: number): TranscriptParagraph[] {
  const out: TranscriptParagraph[] = [];
  if (words.length === 0) return out;
  const safeFps = fps > 0 ? fps : 30;
  const sentenceGap = SENTENCE_GAP_SECONDS * safeFps;
  const paragraphGap = PARAGRAPH_GAP_SECONDS * safeFps;
  const stampEvery = TIMESTAMP_EVERY_SECONDS * safeFps;

  let sentences: TranscriptSentence[] = [];
  let sentenceFrom = 0;
  let paraFrom = 0;
  let lastStamp = Number.NEGATIVE_INFINITY; // first sentence always gets a chip

  for (let i = 0; i < words.length; i++) {
    const cur = words[i];
    const next = words[i + 1];
    const gap = next ? next.startFrame - cur.endFrame : 0;
    const sentenceLen = i - sentenceFrom + 1;
    const endSentence = !next || SENTENCE_END_RE.test(cur.text) || gap > sentenceGap || sentenceLen >= MAX_SENTENCE_WORDS;
    if (!endSentence) continue;

    const startFrame = words[sentenceFrom].startFrame;
    let timestamp: string | null = null;
    if (startFrame - lastStamp >= stampEvery) {
      timestamp = formatTimestamp(startFrame, safeFps);
      lastStamp = startFrame;
    }
    sentences.push({ from: sentenceFrom, to: i, timestamp });
    sentenceFrom = i + 1;

    if (!next || gap > paragraphGap) {
      out.push({ from: paraFrom, to: i, sentences });
      sentences = [];
      paraFrom = i + 1;
    }
  }
  return out;
}

/** Map a word selection (anchor/focus indices, any order) to the timeline span to ripple-delete:
 * [start of the first selected word, end of the last]. The track is the first word's — cutting via
 * trackIndex ripples that track and shifts sync-locked siblings, which is what "delete this speech"
 * means. Guarantees end > start (ripple_delete_ranges rejects empty ranges). */
export function selectionToCut(words: TranscriptWord[], a: number, b: number): CutRange | null {
  if (words.length === 0 || !Number.isFinite(a) || !Number.isFinite(b)) return null;
  const lo = Math.max(0, Math.min(words.length - 1, Math.floor(Math.min(a, b))));
  const hi = Math.max(0, Math.min(words.length - 1, Math.floor(Math.max(a, b))));
  const first = words[lo];
  const last = words[hi];
  const startFrame = first.startFrame;
  const endFrame = Math.max(last.endFrame, startFrame + 1);
  return {
    startFrame,
    endFrame,
    trackIndex: first.trackIndex,
    wordCount: hi - lo + 1,
    durationFrames: endFrame - startFrame,
  };
}

/** Index of the word under a playhead frame ([start, end) containment), or -1 in silence.
 * Binary search — called on every playhead tick during playback. */
export function wordIndexAtFrame(words: TranscriptWord[], frame: number): number {
  let lo = 0;
  let hi = words.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (words[mid].startFrame <= frame) {
      ans = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  if (ans < 0) return -1;
  const w = words[ans];
  if (frame < w.endFrame) return ans;
  return w.endFrame === w.startFrame && frame === w.startFrame ? ans : -1;
}

/** Disfluencies to offer for one-click removal (EN + IT). Matched case-insensitively on the word
 * stripped of surrounding punctuation; multi-token fillers ("you know") are matched as bigrams. */
const FILLER_WORDS = new Set([
  "um", "uh", "erm", "ah", "eh", "hmm", "mm", "mmm", "uhh", "umm",
  "like", "basically", "literally", "actually", "honestly",
  "ehm", "eeh", "cioè", "tipo", "praticamente", "insomma", "diciamo", "allora", "boh",
]);
const FILLER_BIGRAMS = new Set(["you know", "i mean", "sort of", "kind of", "no vabbè", "hai capito"]);

function normalizeWord(s: string): string {
  return s.toLowerCase().replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "");
}

/** Word indices that are filler disfluencies, as a sorted list. Bigrams consume two indices. */
export function findFillerIndices(words: TranscriptWord[]): number[] {
  const out: number[] = [];
  for (let i = 0; i < words.length; i++) {
    const w = normalizeWord(words[i].text);
    if (!w) continue;
    if (i + 1 < words.length) {
      const bg = `${w} ${normalizeWord(words[i + 1].text)}`;
      if (FILLER_BIGRAMS.has(bg)) {
        out.push(i, i + 1);
        i++;
        continue;
      }
    }
    if (FILLER_WORDS.has(w)) out.push(i);
  }
  return out;
}

/** Merge filler word indices into contiguous cut ranges (adjacent indices coalesce so one ffmpeg
 * op removes "um uh" together). Ranges are returned newest-frame-last for safe sequential cutting. */
export function fillersToCuts(words: TranscriptWord[], indices: number[]): CutRange[] {
  if (indices.length === 0) return [];
  const sorted = [...new Set(indices)].sort((a, b) => a - b);
  const cuts: CutRange[] = [];
  let runStart = sorted[0];
  let prev = sorted[0];
  const flush = (lo: number, hi: number) => {
    const cut = selectionToCut(words, lo, hi);
    if (cut) cuts.push(cut);
  };
  for (let k = 1; k < sorted.length; k++) {
    const idx = sorted[k];
    // Coalesce only within the same track and when adjacent in the word stream.
    if (idx === prev + 1 && words[idx].trackIndex === words[runStart].trackIndex) {
      prev = idx;
    } else {
      flush(runStart, prev);
      runStart = idx;
      prev = idx;
    }
  }
  flush(runStart, prev);
  return cuts;
}
