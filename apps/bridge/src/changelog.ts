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
  /** The same entry in Italian. The English text is what the release notes on GitHub carry; this is
   * what someone running CupCat in Italian reads. Absent on old entries, which fall back to English
   * rather than showing nothing — a card in the wrong language beats no card. */
  it?: { title: string; points: string[] };
}

/** An entry rendered in one language, which is all the card ever needs. */
export interface LocalisedEntry {
  version: string;
  title: string;
  points: string[];
}

/** Pick the language, falling back to English when an entry has no translation. */
export function localise(e: ChangelogEntry, lang: string): LocalisedEntry {
  const t = lang === "it" ? e.it : undefined;
  return { version: e.version, title: t?.title ?? e.title, points: t?.points ?? e.points };
}

export const CHANGELOG: ChangelogEntry[] = [
  {
    version: "1.8.1",
    title: "A smaller CupCat, and a build anyone can check",
    points: [
      "**CupCat takes about 100 MB less room on your disk**, and does exactly the same things. One of the bundled tools was being shipped wrapped in a runtime it never needed — 98 MB where the official build is 9 — and four copies of the same library were four different builds. This update replaces eleven files and downloads 64 MB, not the whole installer.",
      "**One missing file came back.** A speech-synthesis data file had gone astray between its source and the installer, quietly, some releases ago. Nothing you would have noticed, and it is there now.",
      "**Face blurring loads the right library, by name rather than by luck.** It was reaching into another tool's folder for the runtime it needs. It now carries its own, so nothing breaks the day that folder changes.",
      "**Every bundled engine is now rebuilt from a pinned source with a checksum**, so what is inside the installer can be verified rather than trusted — and releases are built by a public workflow instead of on one laptop. That is also the groundwork for signing the installer, which is what makes Windows stop warning about it.",
    ],
    it: {
      title: "Un CupCat più leggero, e una build che chiunque può verificare",
      points: [
        "**CupCat occupa circa 100 MB in meno sul disco**, e fa esattamente le stesse cose. Uno degli strumenti inclusi veniva distribuito avvolto in un runtime di cui non aveva bisogno — 98 MB dove quello ufficiale ne pesa 9 — e quattro copie della stessa libreria erano quattro build diverse. Questo aggiornamento sostituisce undici file e scarica 64 MB, non l'installer intero.",
        "**È tornato un file che mancava.** Un file di dati per la sintesi vocale si era perso fra la sua origine e l'installer, in silenzio, qualche release fa. Niente che avresti notato, ma ora c'è.",
        "**La sfocatura dei volti carica la libreria giusta perché la nomina, non per fortuna.** Andava a prendere il runtime nella cartella di un altro strumento. Ora ha la sua, così non si rompe il giorno in cui quella cartella cambia.",
        "**Ogni motore incluso viene ora ricostruito da una fonte fissata, con un checksum**, quindi quello che c'è dentro l'installer si può verificare invece di darlo per buono — e le release sono costruite da un workflow pubblico anziché su un portatile. È anche la base per firmare l'installer, che è ciò che fa smettere Windows di avvisare.",
      ],
    },
  },
  {
    version: "1.8.0",
    title: "CupCat cuts the cameras, places the voices, and writes down the sounds",
    points: [
      "**Filmed a conversation with two or three cameras? CupCat can cut it for you.** Tell it who is who, and it builds the edit: it stays on whoever is speaking, holds a shot long enough not to feel twitchy, and when two people talk at once it either goes wide or puts them side by side on screen. Ask for a preview first and you get the plan — every shot, when it starts, and why that camera — before a single clip moves.",
      "**Each voice now comes from where its owner is standing.** On a fixed camera, CupCat looks at the picture to find where each person is, then places their lines across the stereo image to match. Anyone it cannot find twice in agreement is left in the centre rather than moved on a guess, and it tells you who. It is a small thing that makes a two-shot sound like a room instead of a recording.",
      "**Ask for a cover and CupCat looks at the frames instead of grabbing one.** It sweeps the video and measures every candidate for focus — which is what rejects the motion-blurred ones — plus exposure and contrast, skips anything sitting on a cut, then checks the shortlist for a readable face. You get a handful of genuinely different moments, full resolution, in the library.",
      "**Subtitles can now name what is HEARD, not only what is said.** (applausi), (risate), (sirena), (cane che abbaia) — the half of subtitling that every accessibility standard requires and no consumer editor generates. It runs on your machine, and it is deliberately reluctant: it says nothing where it mostly hears speech, it ignores anything running under the whole recording, and it drops a single uncertain guess. On an interview it finds nothing, which is the correct answer.",
      "**Blurring faces works. It did not before, and it failed in three separate ways.** The detector CupCat ships had never once run — a file was missing beside it, so every request quietly fell back to something weaker, which also means auto-reframe has been framing on brightness rather than on people. On top of that, the blur itself failed outright on any real clip: some of the patches reached past the edge of the frame, and the instructions describing a moving face grew longer than the video engine can read. All three are fixed, and it is now proven on real footage — thirty-six faces covered across four minutes, the blur sitting on the faces.",
      "**Speech is read once, in the language it was spoken.** Placing a video puts two things on the timeline — the picture and its sound — and CupCat was reading both, so every sentence appeared twice: the transcript panel showed doubled prose, and anything acting on it acted twice. Separately, the transcriber was defaulting to English rather than listening first, so Italian speech came back labelled English and chapter titles were written in English over Italian. Both fixed.",
      "**Everything on screen is in your language, these notes included.** Whole corners of CupCat were still English when set to Italian — the file picker, the export panel, the setup screens, and this card. They are translated now, and a test fails the build if a new English-only string ever slips in.",
    ],
    it: {
      title: "CupCat monta le camere, mette le voci al loro posto e scrive i suoni",
      points: [
        "**Hai ripreso una conversazione con due o tre camere? CupCat te la monta.** Digli chi è chi e costruisce il montaggio: resta su chi parla, tiene ogni inquadratura abbastanza da non sembrare nervosa, e quando parlano in due o va sul campo largo o li mette affiancati sullo schermo. Chiedi prima l'anteprima e ottieni il piano — ogni inquadratura, quando inizia e perché quella camera — senza che si muova una sola clip.",
        "**Ora ogni voce arriva da dove sta la persona.** Su una camera fissa CupCat guarda l'immagine per capire dove si trova ciascuno, poi colloca le sue battute nell'immagine stereo di conseguenza. Chi non riesce a ritrovare due volte in accordo resta al centro invece di essere spostato a caso, e te lo dice. È una piccola cosa che fa suonare un due-persone come una stanza invece che come una registrazione.",
        "**Se chiedi una copertina, CupCat guarda i fotogrammi invece di prenderne uno a caso.** Scorre il video e misura ogni candidato per messa a fuoco — è questo che scarta i mossi — più esposizione e contrasto, salta quelli a cavallo di uno stacco e poi cerca un volto leggibile fra i migliori. Ottieni una manciata di momenti davvero diversi, a piena risoluzione, nella libreria.",
        "**I sottotitoli possono ora scrivere ciò che si SENTE, non solo ciò che si dice.** (applausi), (risate), (sirena), (cane che abbaia) — la metà del sottotitolaggio che ogni norma di accessibilità richiede e che nessun editor per il pubblico genera. Gira sul tuo computer, ed è volutamente restio: tace dove sente soprattutto parlato, ignora ciò che scorre sotto tutta la registrazione e scarta l'ipotesi isolata e incerta. Su un'intervista non trova nulla, che è la risposta giusta.",
        "**Sfocare i volti funziona. Prima no, e falliva in tre modi diversi.** Il rilevatore che CupCat distribuisce non era mai partito nemmeno una volta — accanto gli mancava un file — quindi ogni richiesta ripiegava in silenzio su qualcosa di più debole; il che significa anche che la riquadratura automatica ha inquadrato sulla luminosità invece che sulle persone. In più la sfocatura falliva del tutto su qualsiasi clip vera: alcune toppe uscivano dal bordo del fotogramma e le istruzioni che descrivono un volto in movimento diventavano più lunghe di quanto il motore video sappia leggere. Tutti e tre risolti, e ora provato su girato vero: trentasei volti coperti su quattro minuti, con la sfocatura addosso ai volti.",
        "**Il parlato viene letto una volta sola, nella lingua in cui è stato detto.** Mettere un video sulla timeline ci appoggia due cose — l'immagine e il suo audio — e CupCat le leggeva entrambe, così ogni frase compariva due volte: il pannello del parlato mostrava il testo doppio e qualsiasi cosa agisse su di esso agiva due volte. A parte questo, la trascrizione partiva dall'inglese invece di ascoltare prima, così l'italiano tornava etichettato come inglese e i titoli dei capitoli venivano scritti in inglese sopra un parlato italiano. Entrambi risolti.",
        "**Tutto quello che si legge è nella tua lingua, queste note comprese.** Interi angoli di CupCat restavano in inglese anche impostato in italiano — il selettore dei file, il pannello di esportazione, le schermate di configurazione e questa scheda. Ora sono tradotti, e un test blocca la build se una nuova stringa solo-inglese si infila.",
      ],
    },
  },
  {
    version: "1.7.29",
    title: "Installing over an older CupCat works, and reports reach the developer",
    points: [
      "**\"Error opening file for writing: cupcat-bridge.exe\" during an install is fixed, and it was CupCat's fault twice over.** The editor engine is a second program, and when CupCat is force-closed — which is what an installer does — it never gets to stop it. The engine was left running with no window to serve, holding its own file open; the installer then could not overwrite that file and stopped halfway, leaving the app from one version beside the engine from another. Now the engine stops by itself the moment CupCat is gone, and the installer closes any engine still lingering from an older version before it writes anything.",
      "**You can send a report straight from CupCat.** Feedback has always built a file on your disk and left you to send it; there is now a tick-box to hand it to the developer directly. It is off unless you turn it on, and it says plainly what goes: your description, the log, the project, and a picture of your whole screen. If sending fails the file is still on your disk and CupCat says so.",
      "**A fresh install no longer looks out of date to itself.** The checksums published with a release described a build of the app that differed, byte for byte, from the one inside the installer — so an update could think a file needed fetching that was already correct. They are now taken from the installer itself, which is the only copy that matters.",
    ],
    it: {
      title: "Installare sopra una CupCat più vecchia funziona, e le segnalazioni arrivano allo sviluppatore",
      points: [
        "**L'errore «Error opening file for writing: cupcat-bridge.exe» durante l'installazione è risolto, ed era colpa di CupCat due volte.** Il motore dell'editor è un secondo programma, e quando CupCat viene chiuso a forza — che è ciò che fa un installer — non fa in tempo a fermarlo. Il motore restava vivo senza più una finestra da servire, tenendo aperto il proprio file; l'installer non riusciva a sovrascriverlo e si fermava a metà, lasciando l'app di una versione accanto al motore di un'altra. Ora il motore si spegne da solo appena CupCat non c'è più, e l'installer chiude qualunque motore rimasto da versioni precedenti prima di scrivere.",
        "**Puoi inviare una segnalazione direttamente da CupCat.** Il modulo feedback ha sempre creato un file sul tuo disco lasciandoti l'invio; ora c'è una casella per consegnarlo allo sviluppatore. È spenta finché non la accendi, e dice senza giri di parole cosa parte: la tua descrizione, il log, il progetto e una schermata di tutto lo schermo. Se l'invio fallisce il file resta sul disco e CupCat te lo dice.",
        "**Un'installazione nuova non si crede più da aggiornare.** Le impronte pubblicate con una versione descrivevano un'app diversa, byte per byte, da quella dentro l'installer — così un aggiornamento poteva credere di dover riscaricare un file che era già giusto. Ora si prendono dall'installer stesso, che è l'unica copia che conta.",
      ],
    },
  },
  {
    version: "1.7.28",
    title: "Dead air you can see, and the card that says what changed",
    points: [
      "**CupCat can now find dead air by LOOKING, not only by listening.** Removing pauses has always meant hearing them, which leaves out every kind of footage that has no speech in it — a screen recording, a locked-off camera, a phone left running on a tripod, timelapse, b-roll. Ask to tighten one of those and it now finds the stretches where the picture stops changing and cuts them the same way. On a speaker, it only cuts where the picture is still **and** nobody is talking: a motionless picture is also what a person looks like sitting still mid-sentence. Measured on real handheld footage it correctly finds nothing to cut, and on the same footage with a frame held it finds exactly the held part.",
      "**The \"What's new\" card no longer goes missing after an update.** It asked the engine which version was running exactly once, the moment the window appeared — and after an update in place the app restarts, so the window is ready before the engine is. The question fell into the void, the card gave up, and the one release nobody was told about was the one that had just installed itself. It now waits for the engine.",
      "**A small fix no longer needs a release of its own.** CupCat reads the version from what a release contains rather than from its name, so a one-line fix can be published to everyone already running it without a new download page appearing. Releases are for the updates worth reading about.",
    ],
    it: {
      title: "Il vuoto che si vede, e la scheda che dice cosa è cambiato",
      points: [
        "**CupCat sa trovare i tempi morti GUARDANDO, non solo ascoltando.** Togliere le pause ha sempre voluto dire sentirle, il che esclude tutto il girato senza parlato: una registrazione dello schermo, una camera fissa, un telefono lasciato acceso su un cavalletto, un timelapse, il b-roll. Ora, se chiedi di stringere uno di questi, trova i tratti in cui l'immagine smette di cambiare e li taglia allo stesso modo. Se c'è qualcuno che parla, taglia solo dove l'immagine è ferma **e** nessuno sta parlando: un'immagine immobile è anche l'aspetto di una persona ferma a metà frase. Misurato su riprese vere a mano non trova nulla da tagliare, giustamente; sulle stesse riprese con un fermo-immagine trova esattamente quel tratto.",
        "**La scheda «Novità» non si perde più dopo un aggiornamento.** Chiedeva al motore quale versione stesse girando una volta sola, nell'istante in cui compariva la finestra — e dopo un aggiornamento interno l'app riparte, quindi la finestra è pronta prima del motore. La domanda cadeva nel vuoto, la scheda rinunciava, e l'unica versione di cui nessuno veniva informato era proprio quella appena installata. Ora aspetta il motore.",
        "**Una correzione piccola non ha più bisogno di una versione tutta sua.** CupCat legge il numero di versione da ciò che una release contiene, non dal suo nome: così una correzione di una riga può raggiungere chi sta già usando CupCat senza che compaia una nuova pagina di download. Le release restano per gli aggiornamenti che vale la pena leggere.",
      ],
    },
  },
  {
    version: "1.7.27",
    title: "The update that proves the last one",
    points: [
      "**This is the first update where 1.7.26's port fix can actually do its job** — and if CupCat came back working without being closed and reopened by hand, it did. The fix belongs to the engine that *hands over*, not the one that arrives, so the update that carried it could not benefit from it: 1.7.25 handed over to 1.7.26 using 1.7.25's code. Worth knowing for any future fix to the handoff — it always takes effect one update later than it ships.",
      "**While an update downloads, it now says what it is fetching** — \"the editor engine\", \"the app\" — instead of a filename that means something to us and nothing to you.",
    ],
    it: {
      title: "L'aggiornamento che dimostra il precedente",
      points: [
        "**Questo è il primo aggiornamento in cui la correzione della porta della 1.7.26 può davvero agire** — e se CupCat è tornata su funzionante senza doverla chiudere e riaprire a mano, ha agito. La correzione appartiene al motore che *passa la mano*, non a quello che arriva: quindi l'aggiornamento che la trasportava non poteva beneficiarne, perché a passare la mano è stata la 1.7.25 col proprio codice. Vale per qualunque correzione futura al passaggio di consegne: entra in vigore un aggiornamento dopo quello che la porta.",
        "**Mentre un aggiornamento scarica, ora dice cosa sta prendendo** — «il motore dell'editor», «l'app» — invece di un nome di file che significa qualcosa per noi e niente per te.",
      ],
    },
  },
  {
    version: "1.7.26",
    title: "After an update, CupCat comes back working",
    points: [
      "**An update no longer comes back to \"lost contact with the engine\".** The update itself finished correctly — the right files, checked, in the right place — but the new engine could not start, because its port was still held by the engine that had just exited. On Windows a child process inherits its parent's open sockets, and the engine has two descendants: the helper that performs the swap, and the CupCat that helper starts. So the port stayed bound on behalf of a process that no longer existed, and only closing CupCat by hand cleared it. The engine now closes its port before handing over — nothing left open is nothing to inherit.",
    ],
    it: {
      title: "Dopo un aggiornamento, CupCat torna su funzionante",
      points: [
        "**Un aggiornamento non finisce più con «contatto perso con il motore».** L'aggiornamento in sé andava a buon fine — i file giusti, verificati, al posto giusto — ma il motore nuovo non riusciva a partire, perché la sua porta era ancora occupata dal motore appena uscito. Su Windows un processo figlio eredita le porte aperte del padre, e attraverso un aggiornamento il motore ne lascia due: l'aiutante che scambia i file, e la CupCat che l'aiutante riavvia. Così la porta restava occupata per conto di un processo che non esisteva più, e solo chiudendo CupCat a mano si liberava. Ora il motore chiude la porta prima di passare la mano: ciò che è già chiuso non si eredita.",
      ],
    },
  },
  {
    version: "1.7.25",
    title: "You can read what an update contains before installing it",
    points: [
      "**The update notice now shows what changes.** The release notes were already being fetched and then thrown away, so the only honest answer to \"what am I about to install?\" was to go and read the release page. Press **Cosa cambia** in the notice and they are there.",
      "**And this update installed itself** — downloading only the two files that actually differ, about 112 MB against a 1.4 GB installer, leaving the speech model, ffmpeg and the voices exactly where they were.",
    ],
    it: {
      title: "Puoi leggere cosa contiene un aggiornamento prima di installarlo",
      points: [
        "**L'avviso di aggiornamento ora mostra cosa cambia.** Le note della versione venivano già scaricate e poi buttate via, quindi l'unica risposta onesta a «cosa sto per installare?» era andare a leggere la pagina della release. Premi **Cosa cambia** nell'avviso e sono lì.",
        "**E questo aggiornamento si è installato da solo** — scaricando solo i due file che cambiano davvero, circa 112 MB contro un installer da 1,4 GB, lasciando il modello vocale, ffmpeg e le voci esattamente dov'erano.",
      ],
    },
  },
  {
    version: "1.7.24",
    title: "CupCat opens again when there is an update waiting",
    points: [
      "**A published update no longer opens CupCat to a black window.** The update notice asked React for one more piece of state than the render before it — legal-looking code that throws the instant a notice appears, and a throw with nothing to catch it empties the whole window. So CupCat worked perfectly until something newer existed, and then opened black for everyone. The notice now sets itself up before it decides whether to appear.",
      "**And a part of the interface failing can no longer take the window with it.** Whatever breaks, the window stays, says what happened and offers to reload — instead of a black rectangle that looks exactly like a broken install and says nothing. A black window has now had two unrelated causes; this closes the whole class.",
      "**CupCat keeps checking for updates while it is open.** Checking only at startup meant an editor left open all day never heard about a release until it was next launched.",
    ],
    it: {
      title: "CupCat si riapre anche quando c'è un aggiornamento in attesa",
      points: [
        "**Un aggiornamento pubblicato non apre più CupCat su una finestra nera.** L'avviso di aggiornamento chiedeva a React un pezzo di stato in più rispetto al passaggio precedente: codice che sembra legittimo ma va in errore nell'istante in cui l'avviso compare, e un errore che nessuno raccoglie svuota l'intera finestra. Così CupCat funzionava benissimo finché non esisteva niente di più nuovo, e poi si apriva nera per tutti insieme. Ora l'avviso si prepara prima di decidere se comparire.",
        "**E una parte dell'interfaccia che si rompe non porta più via la finestra.** Qualunque cosa si guasti, la finestra resta, dice cosa è successo e offre di ricaricare — invece di un rettangolo nero che sembra un'installazione rotta e non dice niente. La finestra nera ha già avuto due cause diverse: questo chiude la categoria.",
        "**CupCat continua a controllare gli aggiornamenti mentre è aperta.** Controllare solo all'avvio significava che un editor lasciato aperto tutto il giorno non sapeva di una versione nuova fino al lancio successivo.",
      ],
    },
  },
  {
    version: "1.7.22",
    title: "Updates install themselves, and download about a tenth of what they used to",
    points: [
      "**An update now installs itself, and only downloads what changed.** Every update so far meant fetching the whole 1 GB installer and reinstalling everything — including the 547 MB speech model, which has not changed in months and was already on your disk. CupCat now compares what it has against what the release contains, file by file, and fetches only the difference: **about 110 MB instead of 1.4 GB**. Press Install, watch the bar, and it restarts itself finished. The full installer is still there for a new machine, and still one click away if you would rather have it.",
      "**Nothing is put in place until all of it has arrived and been checked.** Each file is verified against the checksum published with the release, and the swap happens with CupCat closed — Windows will not overwrite a program while it runs. If any part of it fails, everything goes back exactly as it was, because a new app over an old engine is an app that does not open.",
    ],
    it: {
      title: "Gli aggiornamenti si installano da soli, e scaricano circa un decimo di prima",
      points: [
        "**Un aggiornamento ora si installa da solo, e scarica solo ciò che è cambiato.** Finora ogni aggiornamento voleva dire prendere l'installer intero da 1 GB e reinstallare tutto — compreso il modello vocale da 547 MB, che non cambia da mesi ed era già sul tuo disco. CupCat confronta ciò che ha con ciò che contiene la versione nuova, file per file, e prende solo la differenza: **circa 110 MB invece di 1,4 GB**. Premi Installa, guarda la barra, e si riavvia già finito. L'installer completo resta per una macchina nuova, ed è comunque a un clic di distanza.",
        "**Niente viene messo al suo posto finché non è arrivato tutto ed è stato verificato.** Ogni file è confrontato con l'impronta pubblicata insieme alla versione, e lo scambio avviene con CupCat chiusa — Windows non lascia sovrascrivere un programma mentre gira. Se una parte fallisce, torna tutto esattamente com'era: un'app nuova sopra un motore vecchio è un'app che non si apre.",
      ],
    },
  },
  {
    version: "1.7.21",
    title: "It opens again after an update, and a dissolve actually dissolves",
    points: [
      "**CupCat no longer opens to a black window.** An engine left behind by a previous install kept the port, so the new one could never start — it was restarted forever instead, and the window never got an engine of its own. Any engine CupCat did not start itself is now recognised as an orphan and moved aside.",
      "**A cross transition actually dissolves.** Two shots that merely touch cannot blend into each other, so what you got was a fade to black and back — a black blink at every cut, worse than the plain cut it was meant to soften. The outgoing shot now stays on screen while the next one fades in over it, the way it is done on a bench. Verified on a 32-minute recording: the join measured pure black before, and now carries both images at once.",
      "**The Stop button has room again.** The effort picker sat next to the model and squeezed it; how hard to think is the model's business, so it is gone and the model picker stays.",
    ],
    it: {
      title: "Si riapre dopo un aggiornamento, e una dissolvenza dissolve davvero",
      points: [
        "**CupCat non si apre più su una finestra nera.** Un motore lasciato indietro da un'installazione precedente teneva la porta, così quello nuovo non poteva partire: veniva riavviato all'infinito e la finestra non aveva mai un motore suo. Ora qualunque motore che CupCat non abbia avviato lei stessa viene riconosciuto come orfano e spostato di lato.",
        "**Una transizione «cross» ora dissolve davvero.** Due inquadrature che si toccano soltanto non possono fondersi l'una nell'altra, quindi quello che ottenevi era una dissolvenza al nero e ritorno — un lampo nero a ogni stacco, peggio dello stacco netto che doveva ammorbidire. Ora l'inquadratura uscente resta a schermo mentre la successiva compare sopra, come si fa al banco di montaggio. Verificato su una registrazione di 32 minuti: la giunzione prima misurava nero pieno, ora porta entrambe le immagini insieme.",
        "**Il pulsante Stop ha di nuovo spazio.** Il selettore dell'impegno stava accanto al modello e lo stringeva; quanto pensare è affare del modello, quindi è sparito e resta il selettore dei modelli.",
      ],
    },
  },
  {
    version: "1.7.20",
    title: "Installing tells you which drive is full, and the Higgsfield button opens the browser again",
    points: [
      "**\"Extract: error writing to file\" during installation now says what is actually wrong.** Installing to D: failed when **C:** was full — Windows does the install work in its temporary folder there — and the error named the biggest file instead of the drive that had no room. The installer now checks both drives before it starts and tells you which one is short.",
      "**The Higgsfield sign-in button opens the browser again.** It called on the window to open the link, and the desktop window silently drops external links — the same fault fixed for the update button in 1.7.15, which had never been applied here. The engine opens it now.",
      "**Signing in to Claude no longer opens two windows.** Three things were opening it: the official Claude tool, the engine, and the page. Only the first two do now, and the address stays on screen to click or copy.",
    ],
    it: {
      title: "L'installazione dice quale disco è pieno, e il pulsante Higgsfield riapre il browser",
      points: [
        "**«Extract: error writing to file» durante l'installazione ora dice cosa non va davvero.** Installare su D: falliva quando era **C:** a essere pieno — Windows fa il lavoro di installazione nella sua cartella temporanea lì — e l'errore nominava il file più grosso invece del disco senza spazio. Ora l'installer controlla entrambi i dischi prima di partire e dice quale dei due è corto.",
        "**Il pulsante di accesso a Higgsfield riapre il browser.** Chiedeva alla finestra di aprire il collegamento, e la finestra del desktop scarta in silenzio i collegamenti esterni — lo stesso difetto corretto per il pulsante di aggiornamento nella 1.7.15, che qui non era mai stato applicato. Ora lo apre il motore.",
        "**Accedere a Claude non apre più due finestre.** Ad aprirlo erano in tre: lo strumento ufficiale di Claude, il motore e la pagina. Ora lo fanno solo i primi due, e l'indirizzo resta a schermo da cliccare o copiare.",
      ],
    },
  },
  {
    version: "1.7.19",
    title: "The assistant cuts between people the way an editor does",
    points: [
      "**Quotes are cut whole, and joined with straight cuts.** Building a best-of from a 32-minute event recording showed what actually makes one readable: every quote a complete thought — cut on the speaker's first and last word, never mid-sentence — and ordered so each one continues the last. Between two talking heads a straight cut is the professional norm; a dissolve there is a dated look, for a jump in time or place.",
      "**The assistant no longer reaches for a \"cross\" transition between speakers**, because it does not do what its name says: clips on one track cannot overlap, so a cross is a fade to black followed by a fade back in — a black blink at every cut. A real cross-dissolve belongs in the render (overlapping the clips internally) and is not written yet; until it is, the assistant knows to leave it alone and to use a fade only at the very start and end of a piece.",
    ],
    it: {
      title: "L'assistente stacca fra le persone come farebbe un montatore",
      points: [
        "**Le frasi si tagliano intere, e si uniscono con stacchi netti.** Costruire un best-of da 32 minuti di registrazione ha mostrato cosa rende davvero leggibile un montaggio: ogni frase un pensiero completo — tagliata sulla prima e sull'ultima parola di chi parla, mai a metà — e ordinata in modo che ognuna continui la precedente. Fra due volti che parlano lo stacco netto è la norma professionale; una dissolvenza lì è un look datato, buono per un salto di tempo o di luogo.",
        "**L'assistente non usa più una transizione «cross» fra chi parla**, perché non fa quello che il nome promette: le clip su una traccia non possono sovrapporsi, quindi un cross è una dissolvenza al nero seguita da un ritorno — un lampo nero a ogni stacco. Una vera dissolvenza incrociata appartiene al rendering (sovrapponendo le clip internamente) e non è ancora scritta; finché non c'è, l'assistente sa di lasciarla stare e di usare una dissolvenza solo all'inizio e alla fine del pezzo.",
      ],
    },
  },
  {
    version: "1.7.18",
    title: "Looking at long footage stops eating the session",
    points: [
      "**Reading a long video is about 28x faster, and free the second time.** Asking what is in a 32-minute recording used to decode the whole file twice — around seven minutes of waiting, repeated from scratch every time the assistant was interrupted, which is how a whole session could go by without a single edit being made. It now reads the light preview copy in one pass and remembers the answer beside the file: **14.7 seconds the first time, 11 milliseconds after that**, with identical results.",
      "**The assistant knows when to stop looking and start cutting.** On interview and event footage the transcript is the map: it finds the structure in the words, checks a handful of specific moments against the picture, and builds the edit — instead of surveying the same file again after every interruption.",
    ],
    it: {
      title: "Guardare girato lungo smette di divorare la sessione",
      points: [
        "**Leggere un video lungo è circa 28 volte più veloce, e gratis la seconda volta.** Chiedere cosa c'è in una registrazione di 32 minuti significava decodificare il file intero due volte — circa sette minuti di attesa, da ricominciare da capo ogni volta che l'assistente veniva interrotto, ed è così che passava una sessione intera senza che venisse fatto un solo montaggio. Ora legge la copia leggera di anteprima in un passaggio solo e ricorda la risposta accanto al file: **14,7 secondi la prima volta, 11 millesimi di secondo dopo**, con risultati identici.",
        "**L'assistente sa quando smettere di guardare e iniziare a montare.** Su interviste ed eventi la trascrizione è la mappa: trova la struttura nelle parole, verifica una manciata di momenti precisi sull'immagine e costruisce il montaggio — invece di riesaminare lo stesso file dopo ogni interruzione.",
      ],
    },
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
    it: {
      title: "I file di camera grandi si vedono in anteprima, e più camere diventano una vista sola",
      points: [
        "**Un file di camera grande ora mostra un'immagine.** Mettere sulla timeline file 4K da mezz'ora lasciava l'anteprima nera e, un minuto dopo, portava giù il motore. Al motore veniva chiesto di tenere in memoria l'intero file da 19,8 GB per rispondere a un solo spostamento. Ora CupCat prepara una copia leggera del girato pesante, come fa qualunque montatore — dopodiché saltare in qualsiasi punto di un file da 19,8 GB disegna un fotogramma in **circa 30 millesimi di secondo**, dove prima non ne disegnava nessuno.",
        "**Puoi vedere che la sta preparando.** Le clip pesanti mostrano il proprio fotogramma di anteprima e una barra di avanzamento finché la copia non è pronta, invece di un rettangolo nero indistinguibile da un file rotto. La preparazione parte appena si apre il progetto, un file alla volta, per non litigare con la macchina.",
        "**Angoli — una vera vista multicamera.** Due o più camere che riprendono lo stesso momento compaiono affiancate, tutte allo stesso istante. Quella in onda è marcata; clicca un'altra (o premi il suo numero) per staccarci dal punto in cui sei. Funziona su qualunque cosa impilata su tracce video separate, che sia stata Sincronizza camere ad allinearla o tu.",
        "**L'assistente offre tutti i modelli che il tuo account Claude ha**, letti dall'account stesso invece che da un elenco fissato quando CupCat è stata compilata — ed è per questo che Claude Opus 5 non compariva. Ogni modello mostra la sua finestra di contesto.",
      ],
    },
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
    it: {
      title: "Il motore si riavvia da solo, e la sincronizzazione regge camere lontane minuti",
      points: [
        "**Se il motore si ferma, ora torna da solo.** L'app restava viva e senza motore — Riprova si limitava a riconnettersi a qualcosa che non c'era più, e Ricarica aggiornava soltanto la pagina. Ora l'app desktop sorveglia il motore e lo riavvia, e la finestra si riconnette da sola.",
        "**Una sola finestra di CupCat.** Riaprirla mette a fuoco quella già aperta, invece di far nascere una seconda finestra che prende in prestito il motore della prima e poi lo perde.",
        "**Sincronizzare camere partite molto lontane ora funziona.** La ricerca precedente guardava solo entro 30 secondi; girato vero in cui una camera era partita quasi un minuto prima dell'altra non si poteva allineare. Ora cerca largo e allarga ancora se la corrispondenza è debole — verificato su due camere da 30 minuti distanti 56 secondi.",
        "**Un file difettoso non può più portare giù il motore** — un errore in una singola operazione viene annotato e il motore continua a servire, e adesso resta un registro dei crash per la diagnosi.",
      ],
    },
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
    it: {
      title: "Il pulsante Aggiorna funziona, e una connessione persa torna",
      points: [
        "**Il pulsante Aggiorna scarica di nuovo.** Non faceva assolutamente nulla: la finestra del desktop ignora in silenzio le richieste di aprire un collegamento esterno, quindi il clic finiva nel vuoto. Ora lo apre il motore.",
        "**Una connessione persa si riprende da sola.** Se un tentativo di connessione restava appeso, bloccava tutti quelli successivi — compreso il pulsante Riprova, ed è per questo che premerlo non serviva a niente. Ora rinuncia a un tentativo bloccato e continua a provare, e si riconnette da solo appena il motore risponde.",
        "**Il motore manda un battito.** Durante un lavoro lungo non c'era niente da dire, quindi la connessione restava muta e poteva essere scartata come inattiva — e l'app dichiarava perso un motore che stava lavorando benissimo.",
        "**Una camera che non si lascia leggere non blocca più una sincronizzazione.** Se leggerne una richiede un tempo assurdo, quella camera viene segnalata e le altre proseguono.",
      ],
    },
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
    it: {
      title: "I file grandi smettono di mettere in ginocchio la macchina",
      points: [
        "**Sincronizzare due camere lunghe ora è questione di secondi invece che di minuti.** Due registrazioni da mezz'ora rendevano CupCat inutilizzabile e finivano per farle perdere il contatto col proprio motore. Ora legge solo l'audio che serve alla risposta, e la corrispondenza è passata da 6,6 secondi di app congelata a un decimo di secondo — con esattamente lo stesso risultato.",
        "**I video lunghi non scatenano più una ricodifica nascosta enorme.** Mettere un file da mezz'ora sulla timeline avviava in silenzio un lavoro che usava tutti i core per più di due minuti e scriveva gigabyte, due volte per due file. Semplicemente non si fa più per i video che già si riproducono.",
        "**Puoi vedere cosa sta lavorando, e fermarlo.** Tutto ciò che richiede tempo — trascrivere, trovare gli speaker, riparare l'audio, creare clip — mostra una barra con il proprio nome, da quanto sta andando, e un pulsante Ferma che ferma davvero.",
        "**Un lavoro pesante alla volta.** Avviarne un secondo mentre il primo è in corso viene rifiutato, dicendo cosa sta girando.",
        "**Le forme d'onda vengono ricordate** invece di essere ricalcolate dall'intero file a ogni apertura del progetto.",
        "**Se il contatto col motore si perde**, il messaggio ora offre Riprova e Ricarica invece di lasciarti bloccato.",
      ],
    },
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
    it: {
      title: "Più camere, e chi sta parlando",
      points: [
        "**Sincronizza camere** — scegli due o più registrazioni dello stesso momento nella libreria e le ottieni impilate sulla timeline già allineate, sul suono che hanno in comune. Posizioni diverse dei microfoni non sono un problema.",
        "**Trova gli speaker** ora funziona davvero. CupCat spediva un modello vocale addestrato sul mandarino e lo usava su girato italiano e inglese: due persone chiaramente diverse tornavano come una sola. Corretto, e circa tre volte più veloce.",
        "**Chi sta parlando** è disegnato lungo il bordo inferiore della clip, un colore per persona.",
        "**Una traccia per speaker** — separa le voci su tracce proprie, così volume e pulizia si possono fare per persona.",
        "**Enfatizza uno speaker** — una lenta stretta su chi ha la battuta. Sceglie il volto la cui bocca si muove, e quando non riesce a stabilirlo lo dice invece di zoomare sulla persona sbagliata.",
        "**Slot Intro e Outro** ai due estremi della timeline. Arrivano come clip normali, quindi puoi trascinarne il bordo per cambiarne la durata o riscriverne il testo.",
        "**Un brand kit** — il tuo logo e i tuoi colori, tenuti fuori dalla cartella dell'app così aggiornare CupCat non li tocca mai. Intro e outro si riempiono da soli attingendo da lì.",
        "Un breve **giro di presentazione** al primo avvio, e questa scheda, d'ora in poi, dopo ogni aggiornamento.",
      ],
    },
  },
  {
    version: "1.7.12",
    title: "Faces found on your own machine",
    points: [
      "**Face blur is about 12x faster** and steadier — the detector now runs on your PC instead of asking an AI model, so it looks twice as often and follows the face instead of guessing between glances.",
      "**Auto-reframe frames on people.** Making a video vertical used to aim at whatever had the most detail — often a bookshelf. Cropping to square or vertical no longer cuts anyone's head off.",
    ],
    it: {
      title: "Volti trovati sulla tua macchina",
      points: [
        "**La sfocatura dei volti è circa 12 volte più veloce** e più stabile — il rilevatore ora gira sul tuo PC invece di interrogare un modello AI, quindi guarda molto più spesso e segue il volto invece di indovinare fra un'occhiata e l'altra.",
        "**L'inquadratura automatica si aggancia alle persone.** Rendere verticale un video puntava a qualunque cosa avesse più dettaglio — spesso una libreria. Ritagliare in quadrato o verticale non taglia più la testa a nessuno.",
      ],
    },
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
