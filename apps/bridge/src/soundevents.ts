// What a sound IS, and whether it is worth writing on screen.
//
// The audio tagger (sherpa-onnx + CED, trained on AudioSet) answers "what does this two seconds
// sound like" with 527 labels and a probability each. That is raw material, not a caption. This
// module holds the whole policy on top of it:
//
//   · which labels are speech            → never captioned; add_captions is what writes those words
//   · which labels describe a ROOM       → "Inside, large room", "Environmental noise", "Television":
//                                          true, useless, and never what a viewer needs told
//   · which labels earn a caption        → and under which single word, so eight AudioSet names for
//                                          laughing all become one "(risate)"
//   · when to stay quiet                 → a lone weak hit is a guess; a wrong caption burned into
//                                          someone's video is worse than no caption at all
//
// Kept apart from the process that runs the model so every one of those decisions can be tested on
// written-down probabilities instead of on a recording.

/** The word CupCat writes, per language. English is the fallback for anything else — a caption in
 * the wrong language is still readable, an invented one is not. `translate_captions` handles the
 * rest, and the tool result says so. */
export const SOUND_LABELS = {
  applause: { en: "applause", it: "applausi" },
  cheering: { en: "cheering", it: "acclamazioni" },
  crowd: { en: "crowd noise", it: "brusio" },
  laughter: { en: "laughter", it: "risate" },
  music: { en: "music", it: "musica" },
  singing: { en: "singing", it: "canto" },
  whistling: { en: "whistling", it: "fischio" },
  phone: { en: "phone ringing", it: "squillo di telefono" },
  doorbell: { en: "doorbell", it: "campanello" },
  knocking: { en: "knocking", it: "bussano alla porta" },
  alarm: { en: "alarm", it: "allarme" },
  siren: { en: "siren", it: "sirena" },
  engine: { en: "engine", it: "motore" },
  traffic: { en: "traffic", it: "traffico" },
  train: { en: "train", it: "treno" },
  aircraft: { en: "aircraft", it: "aereo" },
  dog: { en: "dog barking", it: "cane che abbaia" },
  cat: { en: "cat meowing", it: "miagolio" },
  birds: { en: "birdsong", it: "cinguettio" },
  baby: { en: "baby crying", it: "pianto di bambino" },
  crying: { en: "crying", it: "pianto" },
  coughing: { en: "coughing", it: "tosse" },
  sneezing: { en: "sneezing", it: "starnuto" },
  footsteps: { en: "footsteps", it: "passi" },
  typing: { en: "typing", it: "digitazione" },
  camera: { en: "camera shutter", it: "scatto fotografico" },
  glass: { en: "glass breaking", it: "vetro che si rompe" },
  explosion: { en: "explosion", it: "esplosione" },
  gunshot: { en: "gunshot", it: "sparo" },
  fireworks: { en: "fireworks", it: "fuochi d'artificio" },
  thunder: { en: "thunder", it: "tuono" },
  rain: { en: "rain", it: "pioggia" },
  wind: { en: "wind", it: "vento" },
  water: { en: "water", it: "acqua" },
  bell: { en: "bell", it: "campana" },
} as const;

export type SoundKey = keyof typeof SOUND_LABELS;

/** AudioSet labels that mean "somebody is talking". The tagger fires these constantly on ordinary
 * footage; a sound caption over speech would just duplicate the subtitle. */
export const SPEECH_LABELS = new Set([
  "speech",
  "male speech, man speaking",
  "female speech, woman speaking",
  "child speech, kid speaking",
  "conversation",
  "narration, monologue",
  "babbling",
  "speech synthesizer",
  "whispering",
  "chatter",
]);

/** True but not worth saying. Room tone, the recording medium, generic "noise" — captioning any of
 * these tells the viewer nothing they cannot already see. */
export const IGNORED_LABELS = new Set([
  "silence",
  "inside, small room",
  "inside, large room or hall",
  "inside, public space",
  "outside, urban or manmade",
  "outside, rural or natural",
  "environmental noise",
  "noise",
  "white noise",
  "pink noise",
  "static",
  "mains hum",
  "hum",
  "echo",
  "television",
  "radio",
  "field recording",
  "sound effect",
  "sine wave",
  "sampler",
  "musical instrument",
]);

/** AudioSet display name (lowercased) → the one word CupCat writes for it. */
const EVENT_MAP: Record<string, SoundKey> = {
  applause: "applause",
  clapping: "applause",
  cheering: "cheering",
  crowd: "crowd",
  "hubbub, speech noise, speech babble": "crowd",
  laughter: "laughter",
  "baby laughter": "laughter",
  giggle: "laughter",
  snicker: "laughter",
  "belly laugh": "laughter",
  "chuckle, chortle": "laughter",
  singing: "singing",
  choir: "singing",
  chant: "singing",
  "male singing": "singing",
  "female singing": "singing",
  "child singing": "singing",
  "synthetic singing": "singing",
  humming: "singing",
  "vocal music": "singing",
  "a capella": "singing",
  whistling: "whistling",
  whistle: "whistling",
  telephone: "phone",
  "telephone bell ringing": "phone",
  ringtone: "phone",
  "telephone dialing, dtmf": "phone",
  doorbell: "doorbell",
  "ding-dong": "doorbell",
  knock: "knocking",
  alarm: "alarm",
  "alarm clock": "alarm",
  buzzer: "alarm",
  "smoke detector, smoke alarm": "alarm",
  "fire alarm": "alarm",
  "car alarm": "alarm",
  siren: "siren",
  "civil defense siren": "siren",
  "police car (siren)": "siren",
  "ambulance (siren)": "siren",
  "fire engine, fire truck (siren)": "siren",
  "emergency vehicle": "siren",
  engine: "engine",
  "light engine (high frequency)": "engine",
  "medium engine (mid frequency)": "engine",
  "heavy engine (low frequency)": "engine",
  "engine starting": "engine",
  "engine knocking": "engine",
  motorcycle: "engine",
  car: "engine",
  truck: "engine",
  "motor vehicle (road)": "engine",
  "traffic noise, roadway noise": "traffic",
  train: "train",
  "train whistle": "train",
  "train horn": "train",
  "railroad car, train wagon": "train",
  aircraft: "aircraft",
  "aircraft engine": "aircraft",
  "jet engine": "aircraft",
  helicopter: "aircraft",
  "fixed-wing aircraft, airplane": "aircraft",
  dog: "dog",
  bark: "dog",
  howl: "dog",
  "bow-wow": "dog",
  growling: "dog",
  cat: "cat",
  meow: "cat",
  purr: "cat",
  bird: "birds",
  "bird vocalization, bird call, bird song": "birds",
  "chirp, tweet": "birds",
  "baby cry, infant cry": "baby",
  "crying, sobbing": "crying",
  whimper: "crying",
  cough: "coughing",
  "throat clearing": "coughing",
  sneeze: "sneezing",
  "walk, footsteps": "footsteps",
  typing: "typing",
  "computer keyboard": "typing",
  typewriter: "typing",
  camera: "camera",
  "single-lens reflex camera": "camera",
  glass: "glass",
  shatter: "glass",
  explosion: "explosion",
  boom: "explosion",
  "gunshot, gunfire": "gunshot",
  "machine gun": "gunshot",
  fireworks: "fireworks",
  firecracker: "fireworks",
  thunder: "thunder",
  thunderstorm: "thunder",
  rain: "rain",
  raindrop: "rain",
  "rain on surface": "rain",
  wind: "wind",
  "wind noise (microphone)": "wind",
  "rustling leaves": "wind",
  water: "water",
  stream: "water",
  ocean: "water",
  "waves, surf": "water",
  "splash, splatter": "water",
  bell: "bell",
  "church bell": "bell",
  "bicycle bell": "bell",
  chime: "bell",
  "wind chime": "bell",
  "jingle bell": "bell",
};

/** Instruments: hearing one means music is playing, whatever AudioSet chose to call it. */
const INSTRUMENTS = new Set([
  "guitar", "acoustic guitar", "electric guitar", "bass guitar", "steel guitar, slide guitar",
  "piano", "electric piano", "keyboard (musical)", "organ", "electronic organ", "hammond organ",
  "synthesizer", "harpsichord", "drum kit", "drum machine", "drum", "snare drum", "bass drum",
  "timpani", "tabla", "cymbal", "hi-hat", "percussion", "marimba, xylophone", "glockenspiel",
  "vibraphone", "steelpan", "orchestra", "brass instrument", "french horn", "trumpet", "trombone",
  "bowed string instrument", "string section", "violin, fiddle", "pizzicato", "cello",
  "double bass", "wind instrument, woodwind instrument", "flute", "saxophone", "clarinet",
  "harp", "harmonica", "accordion", "bagpipes", "didgeridoo", "banjo", "sitar", "mandolin",
  "zither", "ukulele", "plucked string instrument", "mallet percussion", "rattle (instrument)",
  "maraca", "gong", "tubular bells", "scratching (performance technique)",
]);

/** The single word CupCat writes for an AudioSet label, or null when the label earns no caption. */
export function soundKeyFor(label: string): SoundKey | null {
  const l = label.trim().toLowerCase();
  if (SPEECH_LABELS.has(l) || IGNORED_LABELS.has(l)) return null;
  const direct = EVENT_MAP[l];
  if (direct) return direct;
  if (INSTRUMENTS.has(l)) return "music";
  // "Pop music", "Background music", "Theme music", "Happy music" — thirty-odd labels that all mean
  // the same thing to a viewer. Checked AFTER the map so "Vocal music" can stay "singing".
  if (/\bmusic\b/.test(l)) return "music";
  return null;
}

export interface Tag {
  name: string;
  prob: number;
}

export interface WindowEvent {
  startSeconds: number;
  endSeconds: number;
  key: SoundKey;
  confidence: number;
}

export interface PickOptions {
  /** Below this the model is guessing. */
  minProb?: number;
}

/**
 * The one sound worth naming in a window's top-k tags, or null.
 *
 * Two rules do the work. A label must clear `minProb`, and it must beat every speech label in the
 * same window: if the model thinks it is hearing talking more than anything else, then it is, and
 * the words belong to add_captions. That single comparison is what keeps a faint music bed under an
 * interview from stamping "(musica)" over the whole conversation — measured at 0.5–0.8 on real
 * event footage where speech scored 0.8–0.9 throughout.
 */
export function pickEvent(tags: Tag[], opts: PickOptions = {}): { key: SoundKey; confidence: number } | null {
  const minProb = opts.minProb ?? 0.4;
  let speech = 0;
  for (const t of tags) if (SPEECH_LABELS.has(t.name.trim().toLowerCase())) speech = Math.max(speech, t.prob);
  let best: { key: SoundKey; confidence: number } | null = null;
  for (const t of tags) {
    const key = soundKeyFor(t.name);
    if (!key) continue;
    if (t.prob < minProb || t.prob <= speech) continue;
    if (!best || t.prob > best.confidence) best = { key, confidence: t.prob };
  }
  return best;
}

export interface BedOptions {
  /** The same floor pickEvent uses: below it the model is guessing. */
  minProb?: number;
  /** Above this share of the recording, a sound is the recording's character rather than an event. */
  share?: number;
  /** Never call something a bed on the strength of a handful of windows. */
  minWindows?: number;
}

export interface Bed {
  key: SoundKey;
  /** Fraction of the recording the model hears it in, 0-1. */
  share: number;
}

/**
 * Sounds the model asserts about the WHOLE recording, which must not be captioned as moments.
 *
 * This rule exists because of a measurement. On real event footage — a chef and a guest talking
 * outdoors through a PA — the tagger reported "Music" in 68% of windows at up to 0.86, and won
 * against speech in ten of them, so CupCat wrote ten scattered "(musica)" captions across a
 * continuous conversation. Separating the stems settled it: the non-vocal residue sits 16 dB below
 * the voice with no tonal structure at all. There is no music. The tagger simply hears amplified
 * outdoor speech as music, which is why "Radio" and "Television" also appear in its top six.
 *
 * The same rule handles the honest case identically: a promo with a real music bed scores 100%, and
 * a bed is not an event either — a subtitler marks music when it STARTS or when it is the only thing
 * playing, never as a caption every few seconds under narration.
 *
 * A short clip is exempt: five windows of applause is a clip OF applause, not a recording
 * characterised by it.
 */
export function findBeds(windows: { tags: Tag[] }[], opts: BedOptions = {}): Bed[] {
  const minProb = opts.minProb ?? 0.4;
  const share = opts.share ?? 0.5;
  const minWindows = opts.minWindows ?? 8;
  if (windows.length === 0) return [];
  const counts = new Map<SoundKey, number>();
  for (const w of windows) {
    const seen = new Set<SoundKey>();
    for (const t of w.tags) {
      if (t.prob < minProb) continue;
      const key = soundKeyFor(t.name);
      if (key) seen.add(key);
    }
    for (const key of seen) counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const beds: Bed[] = [];
  for (const [key, n] of counts) {
    if (n >= minWindows && n / windows.length >= share) beds.push({ key, share: n / windows.length });
  }
  return beds.sort((a, b) => b.share - a.share);
}

export interface MergeOptions {
  /** A single window this confident stands on its own. */
  strongProb?: number;
  /** Windows of the same sound this far apart still belong to one caption. */
  gapSeconds?: number;
}

/**
 * Turn per-window verdicts into captions.
 *
 * Consecutive windows naming the same sound become one caption — applause runs four seconds, not
 * two, and a viewer should see one line rather than two identical ones. A run of a single window
 * survives only when the model was confident about it: on a two-second grid, one borderline hit
 * surrounded by silence is the shape a false positive has.
 */
export function mergeEvents(windows: WindowEvent[], opts: MergeOptions = {}): WindowEvent[] {
  const strongProb = opts.strongProb ?? 0.55;
  const gapSeconds = opts.gapSeconds ?? 0.25;
  const sorted = [...windows].sort((a, b) => a.startSeconds - b.startSeconds);
  const runs: WindowEvent[][] = [];
  for (const w of sorted) {
    const run = runs[runs.length - 1];
    const last = run?.[run.length - 1];
    if (run && last && last.key === w.key && w.startSeconds - last.endSeconds <= gapSeconds) run.push(w);
    else runs.push([w]);
  }
  const out: WindowEvent[] = [];
  for (const run of runs) {
    const confidence = Math.max(...run.map((w) => w.confidence));
    if (run.length < 2 && confidence < strongProb) continue;
    out.push({
      startSeconds: run[0]!.startSeconds,
      endSeconds: run[run.length - 1]!.endSeconds,
      key: run[0]!.key,
      confidence,
    });
  }
  return out;
}

/**
 * The caption text, parentheses included.
 *
 * CupCat ships the words in its own two languages. For anything else the CALLER supplies them:
 * the agent reading this result speaks the language, and one word per sound is a far smaller ask
 * than a translation table nobody here can check. Anything not supplied falls back to English —
 * readable, and honest about being English.
 */
export function captionFor(key: SoundKey, language?: string, words?: Partial<Record<SoundKey, string>>): string {
  const given = words?.[key];
  if (given && given.trim()) return `(${given.trim()})`;
  const entry = SOUND_LABELS[key];
  const lang = (language ?? "").slice(0, 2).toLowerCase();
  return `(${lang === "it" ? entry.it : entry.en})`;
}

/** Keep only the entries that name a sound CupCat actually captions, so a typo cannot invent one. */
export function sanitizeWords(raw: unknown): Partial<Record<SoundKey, string>> {
  const out: Partial<Record<SoundKey, string>> = {};
  if (!raw || typeof raw !== "object") return out;
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (key in SOUND_LABELS && typeof value === "string" && value.trim()) out[key as SoundKey] = value.trim();
  }
  return out;
}

/** True when CupCat has the words for this language and will not fall back to English. */
export function speaksLanguage(language?: string): boolean {
  const lang = (language ?? "").slice(0, 2).toLowerCase();
  return lang === "it" || lang === "en";
}
