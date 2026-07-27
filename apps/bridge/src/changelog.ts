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
    version: "1.7.19",
    title: "The assistant cuts between people the way an editor does",
    points: [
      "**Quotes are cut whole, and joined with straight cuts.** Building a best-of from a 32-minute event recording showed what actually makes one readable: every quote a complete thought — cut on the speaker's first and last word, never mid-sentence — and ordered so each one continues the last. Between two talking heads a straight cut is the professional norm; a dissolve there is a dated look, for a jump in time or place.",
      "**The assistant no longer reaches for a \"cross\" transition between speakers**, because it does not do what its name says: clips on one track cannot overlap, so a cross is a fade to black followed by a fade back in — a black blink at every cut. A real cross-dissolve belongs in the render (overlapping the clips internally) and is not written yet; until it is, the assistant knows to leave it alone and to use a fade only at the very start and end of a piece.",
    ],
  },
  {
    version: "1.7.18",
    title: "Looking at long footage stops eating the session",
    points: [
      "**Reading a long video is about 28x faster, and free the second time.** Asking what is in a 32-minute recording used to decode the whole file twice — around seven minutes of waiting, repeated from scratch every time the assistant was interrupted, which is how a whole session could go by without a single edit being made. It now reads the light preview copy in one pass and remembers the answer beside the file: **14.7 seconds the first time, 11 milliseconds after that**, with identical results.",
      "**The assistant knows when to stop looking and start cutting.** On interview and event footage the transcript is the map: it finds the structure in the words, checks a handful of specific moments against the picture, and builds the edit — instead of surveying the same file again after every interruption.",
    ],
  },
  {
    version: "1.7.17",
    title: "Big camera files play in the preview, and several cameras become one view",
    points: [
      "**A big camera file now shows a picture.** Dropping half-hour 4K files on the timeline left the preview black and, a minute later, took the engine down with it. The engine was being asked to hold the whole 19.8 GB file in memory to answer a single seek. CupCat now prepares a light copy of heavy footage, the way every editor does — after that, jumping anywhere in a 19.8 GB file draws a frame in **about 30 milliseconds**, where before it never drew one at all.",
      "**You can see it being prepared.** Heavy clips show their own poster frame and a progress bar until their preview copy is ready, instead of a black rectangle you cannot tell from a broken file. Preparation starts as soon as the project opens, one file at a time, so it does not fight for the machine.",
      "**Angles — a proper multicam view.** Two or more cameras covering the same moment now appear side by side, all showing the same instant. The one on air is marked; click another (or press its number) to cut to it from the playhead onwards. It works on anything stacked on separate video tracks, whether Sync cameras lined it up or you did.",
      "**The assistant offers every model your Claude account has**, read from the account itself rather than a list fixed when CupCat was built — which is why Claude Opus 5 was missing. Each model shows its context window, and where a model supports it you can also choose how hard it thinks.",
    ],
  },
  {
    version: "1.7.16",
    title: "The engine restarts itself, and sync handles cameras minutes apart",
    points: [
      "**If the engine ever stops, it now comes back on its own.** The app used to be left alive but engine-less — Try again only reconnected to something that was gone, and Reload just refreshed the page. The desktop app now watches the engine and restarts it, and the window reconnects by itself.",
      "**Only one CupCat window now.** Opening it again focuses the window already open, instead of a second window quietly borrowing the first one’s engine and then losing it.",
      "**Syncing cameras that started far apart now works.** The old search only looked within 30 seconds; real footage where one camera rolled nearly a minute before the other could not be matched. It now searches wide and widens further if the match is weak — verified on two 30-minute cameras 56 seconds apart.",
      "**One bad file can no longer take the engine down** — an error in a single operation is logged and the engine keeps running, and a crash log is now kept for diagnosis.",
    ],
  },
  {
    version: "1.7.15",
    title: "The Update button works, and a lost connection comes back",
    points: [
      "**The Update button downloads again.** It did nothing at all: the desktop window silently ignores requests to open an external link, so the click went nowhere. The engine opens it now.",
      "**A lost connection recovers by itself.** If a connection attempt hung, it wedged every later attempt — including the Try again button, which is why pressing it did nothing. It now gives up on a stalled attempt and keeps trying, and reconnects on its own the moment the engine answers.",
      "**The engine sends a heartbeat.** While a long job runs there was nothing to say, so the connection sat silent and could be dropped as idle — the app reported the engine lost while it was working perfectly well.",
      "**A camera that will not be read no longer hangs a sync.** If reading one takes absurdly long, that camera is reported and the rest carry on.",
    ],
  },
  {
    version: "1.7.14",
    title: "Big files stop bringing the machine to its knees",
    points: [
      "**Syncing two long cameras is now seconds instead of minutes.** Two half-hour recordings used to make CupCat unusable and eventually lose contact with its own engine. It reads only as much audio as the answer needs, and the matching itself went from 6.6 seconds of a frozen app to a tenth of a second — with exactly the same result.",
      "**Long videos no longer trigger a huge hidden re-encode.** Dropping a half-hour file on the timeline quietly started a job that used every core for over two minutes and wrote gigabytes, twice over for two files. It is simply not done any more for videos that already play.",
      "**You can see what is working, and stop it.** Anything that takes a while — transcribing, finding speakers, repairing audio, making clips — now shows a bar with its name, how long it has been going, and a Stop button that really stops it.",
      "**One heavy job at a time.** Starting a second one while the first is still going is refused, with a message saying what is running.",
      "**Waveforms are remembered** instead of being recomputed from the whole file every time you open a project.",
      "**If contact with the engine is lost**, the message now offers Try again and Reload instead of leaving you stuck.",
    ],
  },
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
