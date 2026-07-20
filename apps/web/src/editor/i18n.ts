// Interface language (English / Italian). Deliberately dependency-free: a flat dictionary keyed by
// English-ish ids, a `t()` lookup, and the chosen language persisted in localStorage so the picker
// shown on first run is only ever shown once.
//
// Adding a string: put the English text in EN, the translation in IT, call t("some.key").
// A missing IT entry falls back to EN rather than rendering a raw key — a half-translated build is
// still usable, an app full of "toolbar.split" is not.

export type Lang = "en" | "it";

const STORAGE_KEY = "cupcat.lang";

// `code` rather than a flag emoji on purpose: Windows ships no country-flag glyphs, so 🇬🇧 renders
// as a bare "GB" and looks like a broken image.
export const LANGUAGES: { id: Lang; label: string; code: string }[] = [
  { id: "en", label: "English", code: "EN" },
  { id: "it", label: "Italiano", code: "IT" },
];

const EN = {
  // ── generic ──
  "common.cancel": "Cancel",
  "common.close": "Close",
  "common.save": "Save",
  "common.delete": "Delete",
  "common.remove": "Remove",
  "common.back": "Back",
  "common.done": "Done",
  "common.working": "Working…",
  "common.optional": "optional",
  "common.none": "None",

  // ── language picker ──
  "lang.title": "Choose your language",
  "lang.subtitle": "You can change this later in Settings.",
  "lang.continue": "Continue",
  "lang.setting": "Language",
  "lang.settingHint": "Applies immediately.",

  // ── toolbar ──
  "toolbar.split": "Split",
  "toolbar.delete": "Delete",
  "toolbar.text": "+ Text",
  "toolbar.matte": "+ Matte",
  "toolbar.chat": "Chat",
  "toolbar.library": "Library",
  "toolbar.inspector": "Inspector",
  "toolbar.help": "Help",
  "toolbar.merge": "Merge",
  "toolbar.beatSync": "Beat Sync",
  "toolbar.aiClips": "AI Clips",
  "toolbar.export": "Export",
  "toolbar.undo": "Undo",
  "toolbar.redo": "Redo",
  "toolbar.settings": "Settings",
  "toolbar.projects": "Projects",
  "toolbar.connections": "Connections",
  "toolbar.feedback": "Feedback",

  // ── update banner ──
  "update.title": "Update",
  "update.available": "CupCat {version} is available. Update for the latest features and fixes.",
  "update.download": "Download the new version",
  "update.dismiss": "Dismiss",

  // ── setup banner ──
  "setup.title": "Setup",
  "setup.higgsfieldOff": "Higgsfield isn't connected — generation is disabled.",
  "setup.signIn": "Sign in to Higgsfield",
  "setup.opening": "Opening…",
  "setup.browserNotOpen": "Browser didn't open?",
  "setup.openLink": "open the sign-in link",
  "setup.connectClaude": "Connect Claude:",
  "setup.copy": "copy",
  "setup.copied": "copied ✓",

  // ── connections ──
  "conn.title": "Connections",
  "conn.recheck": "Re-check connections",
  "conn.checking": "Checking…",
  "conn.refreshNote": "Status refreshes automatically every 25s while the app is open.",
  "conn.connected": "Connected",
  "conn.notConnected": "Not connected",
  "conn.claudeSignIn": "Sign in to Claude",
  "conn.claudeSignedIn": "Signed in with your Claude subscription{when}. The models on your account are available in chat.",
  "conn.claudeHint":
    "Sign in with your Claude subscription — CupCat installs the official Claude Code for you if needed, then you just approve in the browser. Or paste an Anthropic API key.",
  "conn.useApiKey": "or use an Anthropic API key instead",
  "conn.pasteCode": "Paste the code from the browser",
  "conn.connect": "Connect",
  "conn.openSignInLink": "open the sign-in link",

  // ── AI clips ──
  "clips.title": "AI Clips — auto shorts from a long video",
  "clips.preset": "Style preset",
  "clips.savePreset": "Save as preset…",
  "clips.video": "Video",
  "clips.noVideos": "(no videos in the library)",
  "clips.howMany": "How many clips",
  "clips.shortest": "Shortest (sec)",
  "clips.longest": "Longest (sec)",
  "clips.format": "Format",
  "clips.formatVertical": "Vertical 9:16 — Shorts & Reels",
  "clips.formatOriginal": "Keep original shape",
  "clips.captionStyle": "Caption style",
  "clips.captions": "Captions",
  "clips.titleOverlay": "Title overlay",
  "clips.about": "What should the clips be about? (optional)",
  "clips.aboutPlaceholder": "Leave empty to find the most engaging moments",
  "clips.aboutHint": "For example: “only the parts about pricing”.",
  "clips.censor": "Words to censor (optional)",
  "clips.censorPlaceholder": "Separate with commas — e.g. brandname, competitor",
  "clips.censorHint": "Each one is covered with a beep.",
  "clips.logo": "Logo (optional)",
  "clips.chooseImage": "Choose image…",
  "clips.noLogo": "No logo — clips stay clean",
  "clips.logoHint": "Placed top-right on every clip.",
  "clips.create": "Create clips",
  "clips.creating": "Creating…",
  "clips.newBatch": "New batch",
  "clips.starting": "Starting…",
  "clips.backgroundNote": "You can keep working — this runs in the background.",
  "clips.landing": "Finished clips appear in your library, ready to use.",
  "clips.progressHint":
    "Transcribing the video, then picking the best moments, then exporting each clip. Long videos take a few minutes — the transcript is cached, so running this again on the same video is much faster.",
  "clips.savedIn": "Saved in",
  "clips.savedTail": "and added to the library — drag them to the timeline or export as-is.",
  "clips.failed": "Clip generation failed.",

  // ── feedback ──
  "feedback.title": "Feedback",
  "feedback.type": "Type",
  "feedback.description": "What happened?",
  "feedback.descriptionPlaceholder": "Describe what you expected and what happened instead.",
  "feedback.includes": "The package includes a screenshot, the project and logs — check it before sending.",
  "feedback.create": "Create feedback package",
  "feedback.creating": "Creating package…",
  "feedback.created": "Package created:",
  "feedback.copyPath": "Copy path",
  "feedback.copied": "Copied ✓",
  "feedback.failed": "Could not create the package — is the engine running?",

  // ── media panel ──
  "media.import": "+ Import",
  "media.firstCut": "First Cut",
  "media.search": "Search",
  "media.all": "All",
  "media.video": "Video",
  "media.audio": "Audio",
  "media.image": "Image",
  "media.empty": "No media yet — press + to import, or ✨ to generate.",
  "media.items": "{n} items",
  "media.newFolder": "New folder",
  "media.folderName": "Folder name:",
  "media.rename": "Rename",
  "media.generate": "Generate",

  // ── chat ──
  "chat.title": "Assistant",
  "chat.placeholder": "Ask, or type @ to reference media",
  "chat.empty": "Describe the shot or edit you want, in plain language.",
  "chat.emptyHint": "Select assets in the library to reference them with @.",
  "chat.stop": "Stop",
  "chat.continue": "Continue",
  "chat.newChat": "New chat",
  "chat.interrupted": "Interrupted at your request. Edits already applied are kept; type “continue” to pick up from here.",

  // ── timeline / preview ──
  "timeline.title": "Timeline",
  "timeline.noTracks": "no tracks",
  "preview.noMedia": "Asset not found",
  "details.title": "Details",
  "details.projectSettings": "Project settings",
  "details.resolution": "Resolution",
  "details.frameRate": "Frame rate",
  "details.selectHint": "Select a clip or asset to edit it.",
  "transcript.title": "Transcript",
} as const;

export type Key = keyof typeof EN;

const IT: Partial<Record<Key, string>> = {
  "common.cancel": "Annulla",
  "common.close": "Chiudi",
  "common.save": "Salva",
  "common.delete": "Elimina",
  "common.remove": "Rimuovi",
  "common.back": "Indietro",
  "common.done": "Fatto",
  "common.working": "Elaborazione…",
  "common.optional": "facoltativo",
  "common.none": "Nessuno",

  "lang.title": "Scegli la lingua",
  "lang.subtitle": "Potrai cambiarla in seguito dalle Impostazioni.",
  "lang.continue": "Continua",
  "lang.setting": "Lingua",
  "lang.settingHint": "Viene applicata subito.",

  "toolbar.split": "Dividi",
  "toolbar.delete": "Elimina",
  "toolbar.text": "+ Testo",
  "toolbar.matte": "+ Sfondo",
  "toolbar.chat": "Chat",
  "toolbar.library": "Libreria",
  "toolbar.inspector": "Dettagli",
  "toolbar.help": "Aiuto",
  "toolbar.merge": "Unisci",
  "toolbar.beatSync": "Sincronia beat",
  "toolbar.aiClips": "Clip AI",
  "toolbar.export": "Esporta",
  "toolbar.undo": "Annulla",
  "toolbar.redo": "Ripeti",
  "toolbar.settings": "Impostazioni",
  "toolbar.projects": "Progetti",
  "toolbar.connections": "Connessioni",
  "toolbar.feedback": "Feedback",

  "update.title": "Aggiornamento",
  "update.available": "È disponibile CupCat {version}. Aggiorna per avere le ultime novità e correzioni.",
  "update.download": "Scarica la nuova versione",
  "update.dismiss": "Chiudi",

  "setup.title": "Configurazione",
  "setup.higgsfieldOff": "Higgsfield non è collegato — la generazione è disattivata.",
  "setup.signIn": "Accedi a Higgsfield",
  "setup.opening": "Apertura…",
  "setup.browserNotOpen": "Il browser non si è aperto?",
  "setup.openLink": "apri il link di accesso",
  "setup.connectClaude": "Collega Claude:",
  "setup.copy": "copia",
  "setup.copied": "copiato ✓",

  "conn.title": "Connessioni",
  "conn.recheck": "Ricontrolla le connessioni",
  "conn.checking": "Controllo…",
  "conn.refreshNote": "Lo stato si aggiorna da solo ogni 25 secondi mentre l'app è aperta.",
  "conn.connected": "Collegato",
  "conn.notConnected": "Non collegato",
  "conn.claudeSignIn": "Accedi a Claude",
  "conn.claudeSignedIn": "Collegato con il tuo abbonamento Claude{when}. In chat trovi i modelli del tuo account.",
  "conn.claudeHint":
    "Accedi con il tuo abbonamento Claude — se serve, CupCat installa da sé il Claude Code ufficiale e a te basta approvare nel browser. Oppure incolla una chiave API Anthropic.",
  "conn.useApiKey": "oppure usa una chiave API Anthropic",
  "conn.pasteCode": "Incolla qui il codice del browser",
  "conn.connect": "Collega",
  "conn.openSignInLink": "apri il link di accesso",

  "clips.title": "Clip AI — short automatici da un video lungo",
  "clips.preset": "Preset di stile",
  "clips.savePreset": "Salva come preset…",
  "clips.video": "Video",
  "clips.noVideos": "(nessun video nella libreria)",
  "clips.howMany": "Quanti clip",
  "clips.shortest": "Più corto (sec)",
  "clips.longest": "Più lungo (sec)",
  "clips.format": "Formato",
  "clips.formatVertical": "Verticale 9:16 — Shorts e Reels",
  "clips.formatOriginal": "Mantieni il formato originale",
  "clips.captionStyle": "Stile sottotitoli",
  "clips.captions": "Sottotitoli",
  "clips.titleOverlay": "Titolo in sovrimpressione",
  "clips.about": "Di cosa devono parlare i clip? (facoltativo)",
  "clips.aboutPlaceholder": "Lascia vuoto per trovare i momenti più coinvolgenti",
  "clips.aboutHint": "Per esempio: “solo le parti sui prezzi”.",
  "clips.censor": "Parole da censurare (facoltativo)",
  "clips.censorPlaceholder": "Separale con virgole — es. nomemarchio, concorrente",
  "clips.censorHint": "Ognuna viene coperta con un bip.",
  "clips.logo": "Logo (facoltativo)",
  "clips.chooseImage": "Scegli immagine…",
  "clips.noLogo": "Nessun logo — i clip restano puliti",
  "clips.logoHint": "Posizionato in alto a destra su ogni clip.",
  "clips.create": "Crea i clip",
  "clips.creating": "Creazione…",
  "clips.newBatch": "Nuovo gruppo",
  "clips.starting": "Avvio…",
  "clips.backgroundNote": "Puoi continuare a lavorare — procede in background.",
  "clips.landing": "I clip finiti compaiono nella libreria, pronti all'uso.",
  "clips.progressHint":
    "Prima trascrive il video, poi sceglie i momenti migliori, poi esporta ogni clip. Sui video lunghi servono alcuni minuti — la trascrizione resta in memoria, quindi rifarlo sullo stesso video è molto più veloce.",
  "clips.savedIn": "Salvati in",
  "clips.savedTail": "e aggiunti alla libreria — trascinali sulla timeline o esportali così come sono.",
  "clips.failed": "Creazione dei clip non riuscita.",

  "feedback.title": "Feedback",
  "feedback.type": "Tipo",
  "feedback.description": "Cos'è successo?",
  "feedback.descriptionPlaceholder": "Descrivi cosa ti aspettavi e cosa è successo invece.",
  "feedback.includes": "Il pacchetto include uno screenshot, il progetto e i log — controllalo prima di inviarlo.",
  "feedback.create": "Crea pacchetto feedback",
  "feedback.creating": "Creazione pacchetto…",
  "feedback.created": "Pacchetto creato:",
  "feedback.copyPath": "Copia percorso",
  "feedback.copied": "Copiato ✓",
  "feedback.failed": "Creazione del pacchetto non riuscita — il motore è avviato?",

  "media.import": "+ Importa",
  "media.firstCut": "Primo montaggio",
  "media.search": "Cerca",
  "media.all": "Tutti",
  "media.video": "Video",
  "media.audio": "Audio",
  "media.image": "Immagini",
  "media.empty": "Ancora nessun media — premi + per importare, o ✨ per generare.",
  "media.items": "{n} elementi",
  "media.newFolder": "Nuova cartella",
  "media.folderName": "Nome cartella:",
  "media.rename": "Rinomina",
  "media.generate": "Genera",

  "chat.title": "Assistente",
  "chat.placeholder": "Chiedi, o scrivi @ per citare un media",
  "chat.empty": "Descrivi la scena o la modifica che vuoi, con parole tue.",
  "chat.emptyHint": "Seleziona elementi nella libreria per citarli con @.",
  "chat.stop": "Ferma",
  "chat.continue": "Continua",
  "chat.newChat": "Nuova chat",
  "chat.interrupted": "Interrotto su tua richiesta. Le modifiche già applicate restano; scrivi “continua” per riprendere da qui.",

  "timeline.title": "Timeline",
  "timeline.noTracks": "nessuna traccia",
  "preview.noMedia": "Media non trovato",
  "details.title": "Dettagli",
  "details.projectSettings": "Impostazioni progetto",
  "details.resolution": "Risoluzione",
  "details.frameRate": "Fotogrammi al secondo",
  "details.selectHint": "Seleziona una clip o un elemento per modificarlo.",
  "transcript.title": "Trascrizione",
};

const DICTS: Record<Lang, Partial<Record<Key, string>>> = { en: EN, it: IT };

/** Language chosen by the user, or null when they've never picked one (→ show the picker). */
export function storedLang(): Lang | null {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    return v === "en" || v === "it" ? v : null;
  } catch {
    return null;
  }
}

/** Best guess before the user chooses: the browser/OS language. */
export function detectLang(): Lang {
  try {
    return (navigator.language || "en").toLowerCase().startsWith("it") ? "it" : "en";
  } catch {
    return "en";
  }
}

let current: Lang = storedLang() ?? detectLang();

export function getLang(): Lang {
  return current;
}

export function setLang(l: Lang): void {
  current = l;
  try {
    localStorage.setItem(STORAGE_KEY, l);
  } catch {
    /* private mode — the choice just won't survive a restart */
  }
}

/**
 * Translate `key`, filling {placeholders} from `vars`. Falls back to English when a translation is
 * missing, and to the key itself only if it's unknown entirely (a bug, visible in dev).
 */
export function t(key: Key, vars?: Record<string, string | number>): string {
  const s = DICTS[current][key] ?? EN[key] ?? key;
  if (!vars) return s;
  return s.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m));
}
