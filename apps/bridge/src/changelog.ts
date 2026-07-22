// What changed, per version — compiled into the bridge rather than fetched.
//
// It has to work on a machine that has just been updated and is offline, and it has to be the same
// text the release notes carry, so this is the single source: the "What's new" card reads it and the
// release notes are written from it. Newest first.

export interface ChangelogEntry {
  version: string;
  title: string;
  /** Short lines, in the user's terms. Not a commit log — someone who just double-clicked an
   * installer wants to know what they can now do, not which functions moved. */
  points: string[];
}

export const CHANGELOG: ChangelogEntry[] = [
  {
    version: "1.7.13",
    title: "Several cameras, and who is speaking",
    points: [
      "**Sync cameras** — pick two or more recordings of the same moment in the library and get them stacked on the timeline already lined up, matched on the sound they share. Different mic positions are fine.",
      "**Find speakers** now actually works. CupCat was shipping a voice model trained on Mandarin and running it on your Italian and English footage: two clearly different people came back as one. Fixed, and about three times faster.",
      "**Who is talking** is drawn along the bottom of the clip, a colour per person.",
      "**One track per speaker** — separate the voices onto their own tracks, so volume and clean-up can be per person.",
      "**Emphasise a speaker** — a gentle push-in onto whoever has the line. It picks the face whose mouth is moving, and when it cannot tell it says so instead of zooming onto the wrong person.",
      "**Intro and Outro slots** at the two ends of the timeline. They land as ordinary clips, so you can drag an edge to change the length or retype the words.",
      "**A brand kit** — your logo and colours, kept outside the app folder so updating CupCat never touches them. Intros and outros fill themselves from it.",
      "A short **tour on first run**, and this card, from now on, after every update.",
    ],
  },
  {
    version: "1.7.12",
    title: "Faces found on your own machine",
    points: [
      "**Face blur is about 12x faster** and steadier — the detector now runs on your PC instead of asking an AI model, so it looks twice as often and follows the face instead of guessing between glances.",
      "**Auto-reframe frames on people.** Making a video vertical used to aim at whatever had the most detail — often a bookshelf. Cropping to square or vertical no longer cuts anyone's head off.",
    ],
  },
];

/** The entry for a version, or null when there is nothing written for it. */
export function entryFor(version: string): ChangelogEntry | null {
  return CHANGELOG.find((c) => c.version === version) ?? null;
}

/**
 * Everything new between the version someone was running and the one they are running now.
 *
 * Skipping two releases at once should show BOTH, not just the newest — otherwise the middle
 * release's changes are never mentioned to anyone who skipped it.
 */
export function entriesBetween(seen: string, current: string): ChangelogEntry[] {
  const rank = (v: string) => {
    const p = v.split(".").map((n) => Number.parseInt(n, 10) || 0);
    return (p[0] ?? 0) * 1_000_000 + (p[1] ?? 0) * 1_000 + (p[2] ?? 0);
  };
  const from = rank(seen);
  const to = rank(current);
  if (!(to > from)) return [];
  return CHANGELOG.filter((c) => rank(c.version) > from && rank(c.version) <= to);
}
