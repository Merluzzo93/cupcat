# CupCat — Roadmap & stato

> Tracker condiviso del progetto. CupCat = editor video AI-native per **Windows**: Claude monta
> la timeline via **MCP** (come Palmier Pro), Higgsfield genera i media via **CLI**. Base UI dal
> rewrite di OpenCut (TanStack Start + React 19 + Vite + Tailwind 4 + shadcn).

## Architettura (target)

```
Claude Code / Desktop ──MCP(http 127.0.0.1:19789/mcp)──▶ bridge (bun)
                                                          │  ├─ ToolExecutor (31 tool, porting palmier)
                                                          │  ├─ Higgsfield CLI (generate/upscale/import)
                                                          │  └─ ffmpeg (transcode/transcript/export)
                                                          ▼ WebSocket
                                              web editor (Vite) ── @cupcat/editor-core (modello+comandi+undo)
```

- **`packages/editor-core`** — TS puro, portabile: modello dati (porting 1:1 palmier) + comandi + undo + selettori. Gira nel browser ora, headless poi.
- **`apps/web`** — editor (timeline, preview, media panel, inspector). Store = wrapper di editor-core + client WS.
- **`apps/bridge`** — processo locale: server MCP + WS verso l'editor + Higgsfield CLI + ffmpeg.
- Più avanti: **Tauri** per impacchettare e spostare bridge/ffmpeg nel core nativo.

## Superficie MCP da replicare (31 tool, da palmier)
Lettura: `get_timeline` `get_media` `inspect_media` `get_transcript` `inspect_timeline` `search_media` `list_models`
Editing: `add_clips` `insert_clips` `remove_clips` `remove_tracks` `move_clips` `set_clip_properties` `set_keyframes` `split_clip` `ripple_delete_ranges` `sync_audio` `undo` `add_texts` `add_captions`
Generazione: `generate_video` `generate_image` `generate_audio` `upscale_media` `import_media`
Libreria: `list_folders` `create_folder` `move_to_folder` `rename_media` `rename_folder` `delete_media` `delete_folder`

## Fasi

- [x] **Fase 0 — Analisi & fondazione**
  - [x] Analisi OpenCut (rewrite = scheletro) e palmier (modello dati + 31 tool + transport MCP + agent)
  - [x] Decisioni (base, Higgsfield CLI, MCP locale, licenza GPLv3)
  - [x] Scaffold `cupcat` (shell OpenCut senza moon/proto/.git) + monorepo bun-workspaces
  - [x] `editor-core`: modello dati (`types.ts`), keyframe (`keyframes.ts`), id (`ids.ts`)
- [x] **Fase 1 — editor-core: comandi + undo + selettori** ✅ (typecheck + 7 smoke test verdi)
  - [x] `EditorDocument` (document.ts): place/clearRegion (overwrite), linked-audio, ripple insert/delete, split, move, link-group, undo a snapshot agent/user
  - [x] Comandi (commands.ts): addClips, insertClips, removeClips, removeTracks, moveClips, setClipProperties, setKeyframes, splitClip, rippleDeleteRanges, addTexts, undo + libreria (folders/rename/move/delete)
  - [x] Selettori (selectors.ts): `getTimeline` (omissione default + captionGroups + finestra), `getMedia`, `listFolders`
- [x] **Fase 2 — bridge locale (MCP + WS)** ✅ (smoke end-to-end verde: initialize → tools/list(32) → import → add_clips → get_timeline → add_texts → undo → list_models)
  - [x] Scaffold `apps/bridge` (bun) + config (porta 19789, project/media dir, bin override via env)
  - [x] Motore media: wrapper CLI Higgsfield (`listModels/getModel/uploadFile/generate/estimateCost`) + probe ffmpeg (`probeMedia/makeThumbnail`) — catalogo dal vivo (34 img / 31 video)
  - [x] Server MCP HTTP su `127.0.0.1:19789/mcp` (solo loopback, JSON-RPC hand-rolled su Bun.serve, origin-check)
  - [x] ToolDefinitions (32 tool) + AgentInstructions (porting da palmier → CupCat/Higgsfield)
  - [x] ToolExecutor: timeline/libreria → editor-core; generate/import/upscale/list_models → Higgsfield+ffmpeg (async placeholder→download→asset); espansione prefissi-id
  - [x] WS bridge↔editor (broadcast stato) + media HTTP server + persistenza project.json
  - [x] _Fase 5 chiusa_: get_transcript/add_captions/inspect_media/search/inspect_timeline + **sync_audio** implementati e validati. **Nessuno stub: parità palmier 32/32.** Extra: tool Higgsfield reframe/remove_background/outpaint_image/analyze_video.
- [~] **Fase 3 — web editor UI** — base funzionante e verificata nel browser (screenshot: preview composita video+testo, WS connesso, build+typecheck verdi)
  - [x] Store esterno + client WebSocket (sync stato dal bridge, `sendCommand` con source "user")
  - [x] Layout editor (Toolbar, MediaPanel, Preview, Timeline, Inspector); SPA-safe su TanStack Start
  - [x] Timeline: tracce/clip/righello/playhead/zoom + selezione clip
  - [x] Preview: compositore al playhead (layer video con seek/play, immagine, testo con transform) + clock di playback
  - [x] MediaPanel (libreria + stato generazione) · Inspector (opacity/speed/volume/testo) · Toolbar (split/delete/+text/play)
  - [x] Drag per spostare le clip + trim del bordo destro (pointer-drag → move_clips/set_clip_properties); bottone Export con link di download
  - [ ] Avanzato rimanente: trim sinistro, cambio traccia via drag, multi-selezione, corsie keyframe, snap, drop di media in timeline/libreria
- [x] **Fase 4 — Higgsfield (CLI)** ✅ executor: generate_image/video/audio, upscale, import, list_models via CLI (async placeholder→download→asset) — validato nello smoke
  - [ ] `list_models` ← mappa catalogo higgsfield (image/video/audio/upscale)
  - [ ] `generate_image/video/audio`, `upscale_media`: placeholder asset → job → download → libreria
  - [ ] `import_media` (url/path/bytes)
- [x] **Fase 5 — Trascrizione & compositing** ✅ (whisper.cpp/openai + ffmpeg) — tutti validati:
  - [x] `get_transcript`, `inspect_media` (transcript), `add_captions`, `search_media` (spoken) via whisper
  - [x] `inspect_timeline` — compositing-a-frame via ffmpeg (riuso del compositor di export), ritorna immagini MCP
- [x] **Fase 6 — Export (ffmpeg)** ✅ tool `export_video {name, format}` + endpoint `/exports` + **dialog UI con scelta formato**; composita layer video/immagine/testo + mix audio. **4 formati verificati** (file reali): `mp4_h264` (h264/aac), `mp4_h265` (hevc/aac), `prores` (.mov prores_ks+pcm), `nle_xml` (FCP7 xmeml per Premiere/Resolve). Audio del VO verificato udibile + intelligibile ri-trascrivendo l'export con whisper (regola ducking applicata).
- [ ] **Fase 7 — Desktop + Installer Windows self-contained** (cargo/rustc ✅) — deve installarsi su QUALSIASI Windows **senza** dipendenze pre-esistenti, pronto per GitHub:
  - [x] Shell **Tauri** (Rust) che avvia il bridge come sidecar e carica la SPA ✅ `cargo check` verde (tauri 2.11, 441 crate, 0 errori). `apps/desktop/src-tauri`: Cargo.toml, tauri.conf.json (NSIS + externalBin), main.rs spawn-sidecar, capabilities, icone da `brand/logo.png`, sidecar `cupcat-bridge-x86_64-pc-windows-msvc.exe`
  - [x] `tauri build` → **installer NSIS prodotto** ✅ `CupCat_0.1.0_x64-setup.exe` (30 MB). App validata: `cupcat.exe` lancia il bridge-sidecar (health OK su :19789) e mostra la SPA bundlata. 7c poi bundla ffmpeg/higgsfield/whisper
  - [x] **Bridge → .exe** con `bun build --compile` ✅ exe 98 MB validato: serve UI+MCP+WS standalone, zero bun/node sul target
  - [x] Sidecar bundlati come **risorse Tauri** (`sidecars/*`) + indirizzati via env dal `main.rs` (cargo check verde):
    - [x] **ffmpeg/ffprobe** (87 MB cad., da chocolatey) + **higgsfield** compilato in `.exe` con `bun build --compile` (validato: lista modelli, autenticato) → generazione + export self-contained
    - [x] **whisper.cpp v1.9.1 + ggml-base** (whisper-cli + dll CPU multi-arch + modello 148 MB); `transcribe.ts` dual-backend (openai/cpp) **validato sul vero whisper.cpp**; wired via env → trascrizione self-contained
  - [x] Frontend **statico/SPA** ✅ web convertito da TanStack-SSR a Vite SPA; il bridge serve `dist/` su `/` (verificato nel browser dall'exe)
  - [x] **Installer NSIS self-contained** ✅ `CupCat_0.1.0_x64-setup.exe` **222 MB** — bundla bridge + UI + ffmpeg/ffprobe + higgsfield + whisper.cpp+modello (staged in `resources/sidecars/`, verificato). Su Windows vergine funziona tutto senza preinstallare nulla.
  - [x] **Wizard primo avvio** ✅ banner setup: rileva Higgsfield non loggato (`canGenerate` via WS) → "Accedi a Higgsfield" (`auth login`) + comando "Collega Claude" copiabile (validato nel browser). _Da rigenerare l'installer per includerlo._
  - [x] Repo **GitHub-ready** (base): **GPLv3 completa** (35 KB da gnu.org) · `.gitignore` (esclude binari/target/node_modules) · `NOTICE` con licenze sidecar (ffmpeg GPL, whisper.cpp MIT) · README di build con i comandi per ricreare i sidecar. CI/release: opzionale
- [x] **Fase 8 — Chat AI in-app** ✅ `ChatPanel` + `apps/bridge/src/agent-chat.ts`: loop tool-use Anthropic (fetch, no SDK) su SSE `/agent/chat`, stesso executor dell'MCP → timeline live via WS. Selettore modello in basso a sx (Opus/Sonnet/Haiku), @-reference dalle selezioni in libreria, key Claude da Setup. _Loop verificato end-to-end; in questa macchina la key di test è senza credito → chiamata LLM bloccata da billing, non da codice._
- [x] **Fase 9 — Audit parità & integrazione** ✅ UI palmier completa a 4 pannelli (chat/media+generate/preview+transport/inspector); GeneratePanel I/V/A con first/last frame + **form parametri dinamico per-modello** (voce TTS ecc.); azioni Higgsfield in Inspector (upscale/reframe/remove-bg/regenerate); **niente costi in UI**. Verificato via Playwright (tutto realmente funzionante, non solo all'apparenza): selezione media/clip→inspector, edit proprietà, preview render, play, **split (Toolbar+blade)**, drag-move, undo, add-text, tab generazione + modelli audio, export 4 formati. Bug trovati e corretti: `split_clip` frame assoluto, CORS same-origin, audio ducking, audio models discovery.
- [x] **Fase 10 — UX/UI palmier completa** ✅ tutta la strumentazione dei demo (`D:\cupcat\*.mp4` + `doc.txt`): pannello chat in basso a sx, libreria con selezione + @-mention, generate I/V/A + first/last frame, transport + tool select/blade, inspector dual-mode, Export multi-formato, Help→istruzioni MCP. Prompt agente = porting fedele di `AgentInstructions.swift`.
- [x] **DX** — script root `build:core` / `dev:core` (watch) / `typecheck` aggregato; web+bridge ribuildano editor-core
- [x] **Brand** — logo CupCat integrato (favicon + toolbar; sorgente in `brand/logo.png` per l'icona Tauri)
- [~] **Trasversale** — ✅ GPLv3 completa + NOTICE + README; resta: più test unitari, CI

## Note macchina
- Toolchain: bun 1.3.14, pnpm 9.12, node v20.20.2 + v24.14.1, ffmpeg (chocolatey), git, higgsfield 0.1.33 (autenticata).
- `moon`/`proto` assenti → rimossi dal progetto (bun workspaces + script diretti).
- Cache bun puntata su `D:` (C: cronicamente pieno). Vedi `D:\Brain\memory\environment.md`.

## Fase 11 — Maratona 0.3→1.0 (29 giu – 4 lug 2026) ✅ TUTTO RILASCIATO E TESTATO
- [x] **Preview robusta**: elemento video persistente per-asset (fix flash neri ai tagli), seek-then-play (WebView2), playbackRate=speed (fix rallenty "a scatti"), audio proxy Opus (fix muto WebView2), HTTP Range sul media server, loading/⚠ mai infiniti (retry+badge)
- [x] **Colori PERFETTI**: pipeline bt709 esplicita in export (out_color_matrix+tag encoder), normalizzazione INPUT per-sorgente (untagged→setparams; PSNR 27.6→40.9), **HDR/Dolby Vision via libplacebo** (RPU per-frame applicati = look del telefono; scoperta ICD Vulkan non registrato→VK_DRIVER_FILES; fallback catena calibrata zscale+hable per PC senza Vulkan). ffmpeg sidecar → build BtbN completa (⚠ ffmpeg8: -filter_complex_script rimosso → -/filter_complex)
- [x] **Struttura edit**: linkGroup derivato per-taglio (fix propagazione "+3 linked"), speed-ripple, smart-cut lossless frame-accurate, speech-guard su detect_silence, merge_clips, Redo completo, nomi tracce stabili
- [x] **Trascrizione ITA top**: whisper **large-v3-turbo** bundled (A/B reale: "faccette all'arcata/direi fotonico" vs base storpiato), threads dinamici, modello risolto automaticamente col migliore presente
- [x] **AI Clips (OpusClip-parity)**: auto_clips = trascrizione→Claude curatore→export batch 9:16 (titolo overlay, 4 stili caption karaoke ASS, beep censura, watermark brand rotation-aware, loudnorm -14 LUFS misurato, card UI con virality score); regge video 1h+ (transcript fino ~100k char)
- [x] **Beat-sync CapCut**: detect_beats (novelty+autocorr+refine mediana; BPM esatto su audio reale) + sync_to_beats (ripple ai beat, partner audio incollati, musica bed intoccata, gate confidence)
- [x] **7 Look one-tap** con ricetta unica condivisa preview CSS ↔ export ffmpeg (zero mismatch) + **effetti voce** pitch/robot/echo/radio (misure spettrali) 
- [x] **Feedback button**: pacchetto diagnostico zip (screenshot+project+log ring-buffer+system) via POST /feedback
- [x] **Qualità**: 8 bug reali fixati da bug-hunt agent (desync audio beat-sync, apostrofi nei filtri ffmpeg, beep non-match, race temp file, griglia su silenzio, semaforo, speed anchor, durata 0) + 13 fix UX da audit Playwright live (158 azioni: toolbar responsive, +Matte rotto, Help vero, Split guidato, banner offline, 4K preset, icone tracce, dedup modelli, ...) + toast attività modifiche AI + progetti affidabili (accenti/duplicati-fantasma/clobber → 5/5 e2e)
- [x] **Protocollo di accettazione**: simulazione utente reale via chat (Opus/Sonnet) su footage vero — scenari passati, export verificati frame alla mano
- Storico release: 0.3.x preview/audio → 0.4.x parità Palmier → 0.5.x colori+integrazione 10 repo → 0.6-0.8 Dolby Vision+AI Clips → 0.9 sprint qualità → **1.0.0** deferred chiusi

## Fase 12 — Sprint 1.1.0 "niente mancanze" (completata, 4 lug)
- [x] Auto-cleanup proxy stale nell'app (28 orfani rimossi dal progetto reale al primo load)
- [x] Igiene: installer vecchi rimossi (12G→1.5G, tenute ultime 2)
- [x] UI manuale per look/voce/beat-sync + brand-kit preset (Inspector: griglia Look + Voice FX; BeatSyncDialog; preset brand in AiClipsDialog — 18 test payload)
- [x] Preview parity vignette/grain/shake + badge "export-only" per gli FX non replicabili in CSS
- [x] Import da URL (yt-dlp sidecar 2026.06.09, tool `import_from_url` + campo URL nel MediaPanel; testato su YouTube reale + mp4 diretto)
- [x] ClipAnything visivo (auto_clips `visual:true`: scene→frame→vision, ricompressione JPEG per il cap API; testato su 4K reale) + emoji monocromo strip in ASS
- [x] Transcript panel: editing testuale del video (¶ colonna destra, ripple_delete_ranges; 21 test)
- [x] Auto-reframe 9:16 con face tracking locale (MediaPipe wasm + BlazeFace bundled, keyframe di posizione; 30 test + detection reale verificata in Chromium headless)
- [x] Traduzione caption (`translate_captions`, Claude via OAuth; testata live IT→EN)
- [x] Recorder schermo/webcam (`record_start`/`record_stop`, gdigrab/dshow + mixer audio; registrazione reale 1080p importata come asset)
- [x] Publish assist (link diretti YouTube/TikTok/Instagram upload nel risultato export)
- [x] Tool MCP `redo` (parità con il pulsante UI; round-trip add→undo→redo verificato)
- [x] Capability matrix nel feedback bundle (placebo/whisper diagnostics)
- [x] NOTICE.md aggiornato (yt-dlp Unlicense, MediaPipe/BlazeFace Apache-2.0, whisper turbo)
- [x] Accettazione integrata su bridge dev 19790: typecheck 0×3, 69/69 vitest web, 7/7 editor-core, recorder e2e, UI serve modello BlazeFace same-origin

## Fase 13 — Hotfix 1.1.1 dal QA utente (6 lug): caption karaoke + frame neri
- [x] **Sincro parole reale**: whisper.cpp ora gira con `-ojf` (JSON full) → timestamp per-token attention, merge dei subword-token in parole (`tokensToWords`); prima i tempi erano il segmento diviso in parti uguali (`approximateWords`, ora solo fallback). Verificato sul footage reale: "terminato" a 6.08s = fine pausa misurata. ⚠️ `-dtw` NON usabile: disabilitato da flash-attn (default on), e con `-nfa` i tempi peggiorano.
- [x] **snapWordsToSpeech**: whisper comprime le prime parole del segmento dentro il silenzio iniziale (3.3s di errore misurati) → le parole cadute in silenzio vero (silencedetect) vengono spinte alla fine del silenzio (solo se dopo c'è parlato: le allucinazioni in coda restano al filtro). 9/9 test su fixture reale.
- [x] **Karaoke con evidenziazione VERA**: modello `Clip.karaokeWords` (frame relativi al clip) + `textStyle.highlightColor`; add_captions karaoke:true → cue di ≤4 parole (default, spezzate sulle pause) con la parola parlata colorata; Preview tinge gli span live; export brucia via libass `\k` (stessa resa; frame A/B verificati: metà cue gialla/bianca). Split di una caption ripartisce le parole (test unit).
- [x] **Frame neri ai tagli (export/merge)**: `trim` in secondi a 3 decimali + `overlay enable=between(...)` + `eof_action=pass` → quando l'arrotondamento lasciava lo stream corto di 1 frame, la finestra mostrava il fondo nero (riprodotto: confine 18.6667s). Fix: `tpad=stop_mode=clone` incondizionato (+2 frame oltre la finestra) in buildVisualGraph → 0 neri su repro identica, conteggio frame esatto (1162/1162).
- [x] Schema/istruzioni: add_captions highlightColor + wordsPerCue default 4 + raccomandazione language esplicita; guida karaoke nel prompt agente.
- [x] Regressioni: typecheck 0×3, editor-core 8/8, web 69/69, export con subtitles 0 frame neri.

## Fase 14 — Hotfix 1.1.2 dal QA utente (6 lug): cambio fps accorciava la timeline
- [x] **Causa**: set_project_format cambiava `timeline.fps` senza riscalare i campi in frame → 1232 frame importati a 30fps diventavano 20,5s a 60fps (il "video ~20,5s" visto in chat = i 41s del sorgente dimezzati) e il merge esportava solo metà video.
- [x] **Fix**: `rescaleClipFps` — al cambio di fps ogni campo in frame (startFrame/durationFrames per CONFINI così l'adiacenza resta esatta, trimStart/End, fade, karaokeWords, keyframe di tutte le track) viene riscalato per newFps/oldFps: i secondi restano identici. Unit test 30→60→30 round-trip (9/9).
- [x] **E2e con gli step esatti dell'utente**: import 41,07s → set 60fps → timeline ancora 41,07s (2464 frame) → detect_silence ≥0.8s trova solo l'intro [0,3.235] → ripple → merge = **37,8s INTERO a 60fps** (prima 17,3s) → caption karaoke (19 cue, prima a frame 6) → export 37,83s 60fps, 0 frame neri, frame verificato ("Hi guys," giallo / "di nuovo" bianco).

## Fase 15 — 1.2.0 dal QA chat "meme creepy" (6 lug): zoom in un tool, lente, memoria dei metodi
- [x] **Anteprima .mov grigia nel pannello dettagli**: ClipPreview (Inspector) usava l'URL sorgente — il webview non decodifica ProRes/HEVC → ora `?scrub=1` (proxy web-safe), come library e preview.
- [x] **`punch_in`** (zoom.ts): zoom verso un punto in UNA chiamata — split della finestra (audio linkato incluso), formula `center = 0.5+(0.5−p)·S`, **clamp del target a [0.5/S, 1−0.5/S]** (nero impossibile per costruzione, il messaggio spiega quanto ci si può avvicinare al bordo), pulizia dei keyframe fantasma, mode cut/smooth (rampa eased), opzioni bw/shake/vignette per-segmento. Sostituisce la danza split+transform+keyframes che in chat ha bruciato ~40 chiamate su segni e convenzioni.
- [x] **`magnify`** (lente d'ingrandimento): duplicato zoomato su traccia MUTA sopra (niente audio doppio) + mask ellittica sul punto (formula center = p(1−S)+S/2 tiene il target fermo sotto la lente); rimovibile cancellando il clip.
- [x] **Mask in preview**: boxStyle ora rende le mask rect/ellisse via clip-path (feather/invert restano export-only) — prima set_mask non mostrava nulla live.
- [x] **Preset export completi**: aggiunti 9:16 4K (2160×3840), 1:1 4K, 4:5 4K, 4:3, 21:9 nell'ExportDialog (il selettore progetto li aveva già).
- [x] **Istruzioni agente**: geometria zoom/transform documentata (+ keyframes TOP-LEFT e override del transform); punch_in/magnify come strada obbligata; musica bed volume 0.25–0.4 + duck (era "0.1–0.2" → inudibile, il bug "musica non si sente"); regola "agisci non chiedere" (mai chiudere con "vuoi che lo esporti?" — esporta tu con export_video); verifica post-batch con get_timeline; **regola memoria obbligatoria**: metodo trovato dopo ≥2 tentativi falliti → remember scope global PRIMA di continuare.
- [x] **Memoria globale seminata** (C:\Users\admin\CupCat\memory.md): convenzioni zoom coi tentativi falliti della chat, keyframe fantasma, punch_in/magnify, volume musica, stile meme dell'utente, "finisci il lavoro".
- [x] **E2e meme completo** (bridge dev, video reale, 9:16 4K 60fps): pause→merge 37,8s → karaoke 19 cue → punch_in sul caso "impossibile" della chat (y=0.88 @2.4x → clampato a 0.792, frame pieno) + b/w+shake + smooth+vignette (diff rampa 1.77→40.77) → magnify (diff dentro/fuori lente 21.05 vs 1.74) → musica 0.3+duck (+7,8dB banda firma nel mix) → pitch −5 → export 2160×3840@60 37,83s, **0 frame neri**, caption gialle in ogni frame.
- [x] Regressioni: typecheck 0×3, editor-core 9/9, web 69/69.

## Fase 16 — 1.2.1 (6 lug): mai più "Claude API error 413" + ragionamento adattivo
- [x] **Causa del 413**: ogni invio rimanda l'INTERA conversazione; i tool visivi (inspect_timeline/media, timeline_view) allegano frame PNG (~0.5–1.5MB l'uno) → dopo decine di ispezioni la richiesta supera il cap dell'API e OGNI messaggio successivo muore con 413.
- [x] **Fix 1 — immagini 10–20× più leggere**: tutti i frame destinati alla chat ora sono JPEG q5 (frameToBase64, renderFrames, renderFrameAndScopes, timeline_view — misurato 68KB vs ~700KB PNG); mimeType aggiornati.
- [x] **Fix 2 — potatura della cronologia** (pruneForRequest in agent-chat, 7/7 unit test): prima di OGNI chiamata restano solo le 6 immagini più recenti (le vecchie → stub testuale "re-run the tool"); cap duro 6MB con drop totale immagini + troncamento testi giganti; retry automatico con potatura aggressiva se l'API risponde comunque 413. Tocca SOLO i messaggi user (i blocchi thinking assistant sono firmati e vanno rimandati intatti).
- [x] **Ragionamento adattivo**: la chat in-app ora chiama Opus 4.8/Sonnet 4.6 con thinking adaptive (max_tokens 8192) — piani migliori, meno loop di tentativi; Haiku e le one-shot interne invariate.
- [x] E2e live su OAuth reale: chat con tool visivo (2 tool_use, frame JPEG 67KB, risposta corretta, zero errori) + seconda richiesta ("37,8 secondi" ✓).

## Fase 17 — 1.2.2 (6 lug): add_clips non cancella più la voce + chat che non si ferma a metà
- [x] **Guard anti-sovrascrittura in add_clips**: con trackIndex esplicito il clearRegion cancellava in silenzio ciò che c'era (la musica ha spazzato la voce nella chat reale, con catena di add_clips/remove_clips in rosso). Ora per l'agente una regione occupata è un ERRORE istruttivo ("track 0 already has clip_xxx … omit trackIndex to auto-create a fresh track … or pass replace:true"); replace:true = opt-in; la UI (drag&drop) mantiene la semantica overwrite. Unit 10/10 + e2e live (rifiuto verificato + traccia fresca creata).
- [x] **MAX_TURNS 16→40** con avviso esplicito al limite ("scrivi 'continua' e riprendo da dove sono rimasto") — prima la chat si spegneva muta a metà obiettivo (~18 tool = oltre il vecchio cap).
- [x] Schema/istruzioni: add_clips documenta il rifiuto + replace; regola "musica/overlay = trackIndex OMESSO".

## Fase 18 — 1.2.3 (6 lug): export 4K non muore più su Vulkan (VK_ERROR_INITIALIZATION_FAILED)
- [x] **Causa**: ogni input HDR nel graph = una istanza libplacebo = un device Vulkan; una timeline piena di segmenti punch_in sullo stesso sorgente HDR (il caso reale: `Parsed_libplacebo_79`!) supera il limite del driver → CreateDevice rifiutato → export morto e inspect_timeline rossi (stesso graph).
- [x] **Fix proattivo**: buildVisualGraph conta gli input HDR; >4 → catena CPU calibrata per TUTTO il graph (log esplicito). Il probe 64x64 passava ma non prediceva il caso multi-istanza.
- [x] **Fix reattivo**: qualunque fallimento ffmpeg con firma Vulkan/libplacebo → `disablePlacebo()` per il processo + UN retry automatico — in exportTimeline, saveRangeToFile, renderFrames (inspect), renderFrameAndScopes, renderFrameToFile. Un render non muore mai per il backend di tone-map (la CPU chain è l'approssimazione calibrata, qualità preservata).
- [x] **E2e sul caso reale**: 4 punch_in sull'HDR grezzo (9 segmenti) → export 9:16 4K 60fps RIUSCITO (41,1s) con log "9 HDR inputs > 4 — CPU chain", frame zoom verificato (colori giusti, zero nero), inspect_timeline di nuovo verde.

## Fase 19 — 1.3.0 (16 lug): modelli Claude 2026, versioni progetto, first-cut, import SRT, chat "build log"
- [x] **Modelli chat aggiornati** (ricerca online lineup lug 2026): Opus 4.8 (default) + **Fable 5** (thinking sempre-on, fallback server-side automatico su Opus per i refusal dei classificatori, stop_reason "refusal" gestito con messaggio chiaro) + **Sonnet 5** (uscito 30 giu) + Haiku 4.5. I nuovi testati LIVE via OAuth reale (risposte corrette sul progetto reale).
- [x] **Higgsfield già auto-aggiornante** by design: `higgsfield model list --json` interrogato live a ogni chiamata, zero cataloghi hardcoded (il ranking UI è solo euristica di preferenza sulla lista viva).
- [x] **save_version / list_versions / restore_version**: checkpoint dell'intero progetto con nome in .cupcat/versions/ — la rete di sicurezza per l'editing autonomo (pattern ChatCut). E2e su COPIA del progetto reale: save → remove_tracks → restore → 3 tracce + 72 caption ripristinate esatte.
- [x] **Ricetta "first cut"** nelle istruzioni: save_version → retakes+stutters → filler (liste it/en) → pause ≥0.8 → merge → riassunto quantificato. + Regola "chiudi ogni turno di editing con numeri".
- [x] **import_captions**: SRT/WebVTT → caption clips (parser tollerante: virgola/punto, VTT senza ore, tag inline, header WEBVTT). Testato: 3 cue, frame esatti.
- [x] **Chat "build log"** (pattern ChatCut): righe tool con pallino di stato (ambra pulsante → verde/rosso) + esito sintetico inline; placeholder "Tell the AI what to change…".
- [x] Ricognizione repo completata (3 agenti): **OpenCut** main = riscrittura da zero (GPUI Rust, vuota; roadmap converge su MCP/headless); il codice utile è in **opencut-classic** (MIT, archiviato). **Palmier Pro: 8 release dopo 0.5.2.** **ChatCut**: analisi completa funzioni+UI.

### Backlog documentato (dai 3 report — da prioritizzare nelle prossime release)
- Da **Palmier** (0.6.x): rework tool agente con mutation deltas strutturati (#263); timeline multiple/nesting (#255); undo centralizzato (#331); multicam v2 (#283); sync clip per timecode/audio (#269); **export HDR HEVC Main10 HLG** (#138); coda export cancellabile (#298); rich text styling per-range (#330); speech masks/diarizzazione speaker (#261).
- Da **opencut-classic** (MIT): MediaTime a tick interi 120000/s (uccide il drift float); mask a penna freeform + feathering GPU; graph editor bezier per keyframe; registry azioni/scorciatoie personalizzabili; effetti come elementi timeline standalone; font atlas AVIF; NumberField con scrubbing e math inline; compositor wgpu (crates MIT riusabili nativi in Tauri).
- Da **ChatCut**: **motion graphics AI** (Claude genera HTML/CSS/SVG → render a WebM alpha via webview — il loro differenziatore #1, perfetto per Claude); TTS locale (Piper/Kokoro); diarizzazione; export FCPXML/EDL (OpenTimelineIO); libreria prompt; @-mention autocomplete in chat.

## Fase 20 — 1.4.0 (16 lug): il winning product — Motion Graphics AI, voiceover locale, export cancellabile
- [x] **add_motion_graphic (AI MOTION GRAPHICS)** — il differenziatore: Claude scrive un'animazione HTML/CSS self-contained (prompt di design con testo esatto) → **Edge headless via CDP** (garantito su ogni Windows: è il runtime WebView2) la rasterizza a PNG TRASPARENTI frame-exact (document.getAnimations seek — deterministico, zero jitter) → ffmpeg impacchetta **WebM VP9 yuva420p** → clip overlay su nuova traccia top. Sorgente HTML salvato accanto all'asset (.mg.html) per re-edit conversazionali. Export: probe `alpha_mode=1` + decode `-c:v libvpx-vp9` per-input (il decoder nativo BUTTA l'alpha). .webm/.mkv aggiunti a clipTypeFromExtension. **Verificato sul progetto reale**: lower third "DOTT. DI CAPUA / Odontoiatra · White Philosophy" teal broadcast-quality composta in trasparenza perfetta sul footage (frame estratto e ispezionato).
- [x] **generate_speech (voiceover TTS locale)** — Piper sidecar (~159MB con voci it_IT-paola-medium + en_US-lessac-medium), gratis/offline; speed via length_scale; wav→asset via flusso import standard. **Round-trip whisper 100%** in entrambe le lingue; errori chiari su voce mancante; bundle Tauri verificato (glob `sidecars/*` NON include le directory: aggiunta entry esplicita `sidecars/piper`).
- [x] **cancel_export** — run() taggato + killTagged/consumeKilled in proc.ts; export/merge cancellabili (tool + POST /export/cancel + bottone Cancel nell'ExportDialog); parziale eliminato, il flag non inquina il run successivo, il kill NON innesca il retry Vulkan. E2e: cancel in 323ms, ffmpeg terminato, export successivo pulito.
- [x] Regressione totale: typecheck 0×3, editor-core 10/10, web 69/69, vite build ok.

## Fase 21 — 1.4.1 (16 lug): pulsante Continua, cartelle library da sottocartelle, filtro tipo
- [x] **"▶ Continua da dove sei rimasto"**: al limite del ciclo tool (alzato 40→60) il bridge emette {type:"limit"} + messaggio "pausa tecnica, nessun lavoro perso"; ChatPanel mostra il bottone ambra che manda "continua" — la cronologia e ogni edit persistono, la ripresa è esattamente dal punto raggiunto (zero rilavorazioni).
- [x] **Sottocartelle → cartelle library**: importFolderMedia mappa il primo segmento di sottocartella (sotto root/media) in una cartella library omonima (creata se manca) e ci assegna gli asset; scan ora anche ALL'AVVIO (prima solo su open_project). E2e: media/broll/clip1.mp4 → cartella "broll", media/musica/tema.wav → "musica", file root → root.
- [x] **Filtro per tipo in library**: chip All/Video/Audio/Image nel MediaPanel.
- [x] add_clips su timeline vuota con trackIndex esplicito → errore ISTRUTTIVO ("omit trackIndex, tracks are created automatically") invece di "out of range" secco (in entrambi i percorsi add/insert).
- [x] Lingua trascrizione: verificato il flusso (auto-detect whisper corretto by design; il campo language è visibile all'agente) + istruzione: transcript nella lingua "sbagliata" = segnale di misdetect → ripassare con language esplicita.

## Fase 22 — 1.4.2 (16 lug): export solo manuale + export_captions + Save Version in toolbar
- [x] **Export SOLO manuale (decisione di prodotto)**: export_video rifiuta le chiamate dell'agente con messaggio istruttivo ("tell the user to press the Export button"); istruzioni + descrizione tool + memoria globale app riscritte (prima dicevano l'opposto); auto_clips/merge mantengono i loro render interni. E2e: rifiuto verificato.
- [x] **export_captions** (dal backlog): SRT del parlato in lingua ORIGINALE, tempi timeline-mapped → exports/subtitles-original.srt + link download. Bug trovato dal test e FIXATO: il clip audio linkato (stesso asset del video) duplicava ogni cue → guardia linkGroup in export_captions E translate_captions. E2e reale: 5 cue pulite.
- [x] **⛨ Version in toolbar**: pulsante Save Version (nome via prompt) sopra il save_version esistente.

## Fase 23 — 1.5.0 (17 lug): il backlog Fase 19 realizzato — 8 feature maggiori in 3 ondate di agenti
### Ondata 1
- [x] **Export `hdr_hevc`** (HLG BT.2020, HEVC Main10): hdrInputFix zscale-only (HLG passthrough taggato, PQ→HLG remap), rifiuto istruttivo su timeline SDR/miste (mai colori indovinati), x265 10-bit con tag completi. Verifiche: ffprobe yuv420p10le/arib-std-b67/bt2020, YAVG Δ0.17–0.72 vs sorgente, PSNR round-trip HLG 44.8dB, testo bruciato a picco HLG 998/1023.
- [x] **Export `fcpxml` 1.11** (Resolve/Final Cut): resources+spine+lane, offset in razionali frame-esatti, title con text-style, srcEnable anti-doppio-audio; estensione .fcpxml (FCP rifiuta .xml). Validazione strutturale 49/49.
- [x] **sync_audio timecode-first** (#269): sourceTimecode (tmcd/creation_time, drop-frame ok), strategy auto/timecode/audio, seed creation_time→finestra ±3s. E2e: delta timecode 105 frame ESATTI; +2 bug preesistenti fixati (picchi degeneri di correlazione ai bordi finestra; desync audio linkato in syncAudio).
- [x] **Chat @-mention** (caret-aware, accent-insensitive, 17 test) + **✨ Prompt library** (15 prompt IT in 5 categorie).
### Ondata 2
- [x] **Adjustment layers**: ClipType "adjustment" (nessun media, applica color/effects a TUTTO il composite sotto nella sua finestra); export via split/trim/concat del composite (scelto su enable= per robustezza); preview backdrop-filter; blocco viola "ADJ" in timeline; Inspector con Look/Adjust. E2e frame-exact: SATAVG 105.5→1.0 (dentro, entrambi i clip sotto)→57.7 (fuori), split della adjustment senza cuciture, 0 frame neri. Fix: placeClip sceglie la traccia audio senza clobber (bug che distruggeva l'audio impilando angoli).
- [x] **Rich text styleRanges**: range per-substring (color/bold/italic/fontSizeScale) su UN clip di testo; splitter condiviso preview/export (richtext.ts, 10 test); export via ASS override tags ({\r\c\b\i\fs}); e2e pixel: 11.656 pixel rossi nel bbox giusto, "CIAO" corsivo 1.3×.
- [x] **Timeline UX**: ctrl/cmd+click toggle, shift+click range su traccia, marquee testato, GROUP MOVE con un solo move_clips multi-id (fixato stale-closure preesistente del drag + snap sul clip trascinato); chip easing Smooth/Linear/Hold per proprietà in Inspector (+ fix: aggiungere un keyframe non resetta più l'easing delle righe esistenti). 26 test nuovi (suite web 112).
### Ondata 3
- [x] **multicam_cut**: angoli sincati impilati + cut list [[frame,angolo]] → sequenza montata in UNA mutate (audio continuo dall'angolo scelto via detach del linkGroup, dedupe/sort dei tagli, errori istruttivi). E2e: layout esatto A/B/A/B, PSNR 33–40dB verso l'angolo giusto (4dB verso l'altro), audio 0 silenzi ai punti di switch.
- [x] **identify_speakers (EXPERIMENTAL)**: sherpa-onnx (build shared-MT, no VC-redist) + pyannote segmentation-3.0 + ERes2Net (~63MB sidecar); turni con etichette S1/S2…, get_transcript tagga le parole DOPO una diarizzazione esplicita. E2e onesto: confini ±0.03–0.09s, conteggio speaker corretto (1 sul girato reale), attribuzione perfetta su voci distinte (controllo pitch-shift 100%), debole su voci quasi identiche (due TTS stesso registro) — dichiarato nella descrizione del tool. RTF 0.15.
### Esclusioni motivate (invariati)
- MediaTime ticks e nested-timelines live: cambi di modello dati ad alto rischio regressivo su tutto il testato; il caso d'uso "sequenza annidata" è coperto da save_range_as_media (bake). Restano in backlog.
- [x] Regressione finale: typecheck 0×3, editor-core 21/21, web 112/112, vite build ok. NOTICE.md aggiornato (sherpa-onnx/pyannote/3D-Speaker).

## Fase 24 — 1.6.0 (17 lug): le esclusioni "impossibili" + rifiniture pro + limiti rimossi
### Ondata A (modello/bridge)
- [x] **Precisione tempo / NTSC** (mediatime.ts, 12 test): TICKS_PER_SECOND 120000, fpsRational (29.97→30000/1001…), frameToSeconds ESATTO (frame 30000@29.97 = 1001s letterale nel filtergraph; export reale 30300 frame / 1011.010000s); fps 29.97/23.976/59.94 end-to-end (bug fixato: int() li floorava a 29!); sf() esatto sostituisce s()=3 decimali in TUTTI i tempi frame-derivati; FCPXML/xmeml NTSC corretti. Nota onesta: NON è stato fatto lo swap totale a tick (rompe wire/memoria agente, zero benefici a fps interi) — i benefici (zero drift) sono consegnati.
- [x] **HDR decode-once** — cap >4 RIMOSSO: il design split=N in-graph è stato implementato, MISURATO (25GB RSS, framesync buffering) e SCARTATO; soluzione: bake DV-SDR per-sorgente (ensureDvSdrProxy, libplacebo per-frame DolbyVision, cache .dvsdr1.mp4) — 9 segmenti punch_in: 0 placebo in-graph, DV per-frame ovunque (YAVG 90.29 vs 94.63 della vecchia catena CPU), 0 frame neri, RAM piatta.
- [x] **Smart-cut lossless FRAME-EXACT**: prima 544/540 frame (+1 head, +2 B-frame overshoot); fix (sf() esatto, -frames:v, -bf 0, coda GOP ri-encodata) → 540/540, offset 0 su tutti e 4 i confini. Residuo solo audio (~21ms priming AAC), documentato.
- [x] **Timeline annidate LIVE (compound clips)**, 41/41: make_compound/open_compound/close_compound/uncompound; il trucco del getter doc.timeline → TUTTI i tool e la UI lavorano nella sub-timeline senza rewiring; export via bake cached per hash (effetti/speed del clip compound applicati sopra: durata dimezzata a speed 2, look b/w sopra il bake); undo attraverso i livelli; profondità 1 con guardie.
- [x] **Marker con note** (15/15, persistenza verificata) + **karaoke su traduzioni** (proporzionale per caratteri, 14/14, pixel gialli 26→2035) + **set_speaker_turns** (correzione umana della diarizzazione, 12/12, 144/144 parole ritaggate).
### Ondata B (editor pro)
- [x] **Bezier graph editor**: Keyframe con bezierOut/In, cubicBezierY stile CSS, densifyTrack per l'export (SOLO tracce bezier; tracce smooth: filtergraph IDENTICO + 61 frame framemd5-identici = zero regressioni); e2e centroide: errore max 0.16px su budget 2.0; editor SVG con punti e maniglie trascinabili + chip "custom"; fixati 3 punti export che PERDEVANO l'easing (volume, rotation, opacity → tutto ri-easato smooth).
- [x] **Pen mask + feather live**: MaskSpec "path" (points normalizzati, smooth Catmull-Rom, maskpath.ts condiviso); export via matte PNG renderizzata da Edge + boxblur + alphamerge (cache sha1, 4/4); e2e: dentro 100.00% / fuori 0.000%, rampa feather monotona 112px misurata, invert perfetto; preview: mask-image CSS per TUTTE le forme → feather e invert finalmente visibili live; UI penna sul canvas (✎) + sezione Mask nell'Inspector. 16 test.
- [x] **Scorciatoie personalizzabili** (registry 20 azioni, cattura tasti nell'Help, conflitti gestiti, localStorage; 14 test) + **NumberField** (scrub col drag + math parser sicuro "1920/2"; 14 test) + **7 font verificati** (Segoe UI/Semibold, Bahnschrift, Candara, Consolas, Constantia, Corbel — file export controllati, fallback runtime; picker con anteprime nella propria famiglia) + **parità preview**: ducking WebAudio (graph per-elemento, fallback silenzioso), chromakey WebGL2 (shader smoothstep su distanza croma), glow approssimato (drop-shadow), badge aggiornati.
### Registro limiti
RIMOSSI: cap HDR >4 (decode-once), lossless snap (frame-exact), feather/invert/ducking/chromakey solo-export (ora in preview). MITIGATI: attribuzione diarizzazione (set_speaker_turns, "l'ascolto umano vince"). ACCETTATI con motivazione: Edge per motion graphics (runtime WebView2 = presente ovunque CupCat giri); tick-swap totale (vedi sopra).
- [x] Regressione finale: typecheck 0×3, editor-core 51/51 (622 assert), web 172/172, vite build ok.

## Fase 25 — 1.6.1 (17 lug): audit UI/UX completo con screenshot reali
- [x] Trigger: l'utente ha colto un overflow nell'header chat (bottoni New/Clear fuori schermo dopo l'aggiunta di ✨ Prompts). Fix immediato (header a icone, select flessibile) + AUDIT SISTEMATICO: Chromium headless su bridge dev, 3 larghezze (1920/1440/1280), screenshot di ogni pannello/dialog/stato.
- [x] **10 difetti trovati e fixati** (4 HIGH): toolbar wrappava su 2 righe ANCHE a 1920 (header 76→44px); select cronologia chat collassata a 10px; traccia audio IRRAGGIUNGIBILE con 6+ tracce (ora scroll 2 assi con righello/intestazioni sticky, allineamento verificato 1034.0/1034.0); chip easing e curve editor clippati nei 256px dell'Inspector; **marquee disegnata scrollLeft px a destra del puntatore** (verificato empiricamente 700→1100, ora 700→700); context menu senza Escape e non clampati al viewport; griglia Actions con celle orfane (ora simmetrica per ogni tipo — regola layout-grid-symmetry); copy Connections senza Fable.
- [x] Aree verificate pulite con screenshot: tutti i dialog, dropdown prompt, popup @-mention, font picker, sezioni Inspector per ogni tipo di clip, breadcrumb compound, marker, badge FX.
- [x] Deferred motivati: stringhe miste IT/EN (decisione di prodotto — localizzazione completa è nel backlog distribuzione); transform numerico per clip testo.
- [x] Gate: typecheck 0×3, vitest 172/172, build verde. Lezione ISTITUZIONALIZZATA: ogni ondata di feature UI termina con un pass di verifica visiva a più larghezze.

## Fase 26 — 1.6.2 (17 lug): controllo delle conversazioni chat
- [x] **⏹ Stop**: il bottone send diventa STOP rosso durante un run; POST /agent/chat/stop → il loop agente si ferma al prossimo confine sicuro (turno o tool), le modifiche già applicate restano, messaggio "scrivi continua per riprendere". Flag resettato a inizio run (uno stop stantio non uccide il run successivo); i tool_use pendenti ricevono tool_result "Cancelled" così il transcript resta valido.
- [x] **Run legato alla conversazione d'origine**: gli eventi SSE mutano gli oggetti-turno del run (non la vista); cambio conversazione a metà run → niente sanguinamento di testo, la vista re-renderizza solo se si sta guardando la conversazione del run; tornare alla conversazione occupata mostra il transcript LIVE; a fine run il transcript si salva con id esplicito nella conversazione d'ORIGINE (saveChat(id) nel bridge). E2e: salvataggio verificato nella conversazione non attiva.
- [x] **Contesto cross-conversazione**: nuova conversazione nello stesso progetto → il system prompt include i riepiloghi delle ultime 3 altre conversazioni (titolo + ultimo messaggio assistant, "context only — DONE, do not redo"). conversationSummaries in chats.ts; chatId nel ChatRequest. E2e: sezione generata correttamente con i riepiloghi reali.
- [x] Gate: typecheck 0 (bridge+web), 172/172, build verde.

## Fase 27 — 1.6.3 (17 lug): hotfix — il pulsante Export mostrava il rifiuto anti-agente
- [x] Regressione della 1.4.2 scoperta dall'utente: l'ExportDialog chiamava export_video via mcpCall → endpoint MCP → source "agent" → il gate anti-agente respingeva anche il click UMANO sul pulsante. Fix: endpoint dedicato POST /export/run (source "user") usato dal dialog; il percorso MCP resta correttamente rifiutato. E2e: /export/run esporta (35,3s), MCP rifiuta.

## Fase 28 — 1.7.0 (17 lug): "Goal totale" — UI Palmier + 14 feature winning
Mandato utente (ricerca strategica → implementazione): UI stile Palmier Pro, integrazione estetica/funzionalità dai 5 demo Palmier, e A1–A8+B1–B6+AV1 "alla perfezione". Clausola: ogni feature 100% locale/gratis/perfetta, altrimenti Higgsfield. UNA sola build finale. Dettaglio operativo in `FASE28-PIANO.md`.
### UI stile Palmier (pass visivo 1920/1440/1280 verde)
- [x] **Libreria/cartelle**: griglia di tile cartella (icona macOS + badge conteggio), drill-down + breadcrumb + drag-to-folder, ricerca, media tile con badge AI + chip durata + underline blu selezione + hover 💬→@mention, doppio-click→tab sorgente, tile "Generating…" con barra indeterminata. Toolbar "+Import · New Folder · ✨ Generate · ✂ First Cut · Search".
- [x] **Chat**: textarea auto-grow (40→200px, scroll oltre) + pannello ridimensionabile 300–640px persistito; placeholder "Ask, or type @…".
- [x] **Timeline stile Palmier**: righello HH:MM:SS:FF adattivo, playhead a triangolo, header tracce con striscia colore (V=sky/A=teal) + icone SVG, clip arrotondate con filmstrip video (?thumb=1 repeat-x) + waveform teal/label top-left underline-on-select, palette per tipo, mini-toolbar (undo/redo/tools/snap) + zoom slider log, numerazione V bottom-up.
- [x] **Viewer**: tab sorgenti (Timeline + "sorgente ×" underline violeta, store openSourceIds), trasporto TC ambra a sx + chip 16:9·fps·FHD·Fit a dx.
- [x] **Generate panel**: footer modello + chip settings→popover Duration/Aspect + bottone tondo ↑.
### Feature (tutte typecheck 0×3, 223 test verdi, binario compilato = 104 tool)
- [x] **A1 auto_rough_cut** (roughcut.ts): cartella/lista→analyze black head/tail→V1 end-to-end+music bed. E2E OK.
- [x] **A2 Transcript** (esisteva): +rimozione filler one-click EN+IT (highlight amber, fillersToCuts per-traccia).
- [x] **A3 Shorts wizard** (esisteva AiClipsDialog=OpusClip): count/durata/9:16/4 stili caption/hook/virality/preset.
- [x] **A4 Template** (templates.ts): save/apply/list, slot tipizzati riempiti da media, global cross-project. E2E OK.
- [x] **A5 make_transition**: Claude scrive animazione alpha full-frame→renderMotionGraphic→piazzata sul taglio, riusabile.
- [x] **A6 Command palette** (CommandPalette.tsx): Ctrl+K globale, fuzzy azioni+pannelli+media, fallback→chat. Verificato browser.
- [x] **A7 dub_timeline**: transcript→translate→Piper per-segmento→atempo time-fit→track "Dub"→duck/mute originale.
- [x] **A8 CLI headless** (cli.ts): render/batch/list-projects, source user. Verificato (list + render AV1).
- [x] **B1 bg removal**: Higgsfield remove_background (fallback sancito dalla clausola).
- [x] **B2 auto_reframe LOCALE** (reframe-local.ts): saliency gradient-energy per-shot→crop 9:16 subject-aware→concat. E2E 608×1080.
- [x] **B3 separate_stems LOCALE** (separate.ts + sidecar sherpa spleeter 54MB): voce/musica, RTF 0.12 ~8× realtime. E2E OK.
- [x] **B4 smooth_slowmo LOCALE** (slowmo.ts): ffmpeg minterpolate mci/aobmc/vsbmc. Verificato (interpolazione reale). Upscale=HF.
- [x] **B5 ricerca semantica LOCALE**: search_media token-ranked su nome+prompt-generazione+transcript; visual-find via inspect_media/vision.
- [x] **B6 track_motion LOCALE** (track-local.ts): template matching SAD + refresh anti-drift→position keyframes (convenzione top-left VERIFICATA dal renderer). E2E 75 keyframe.
- [x] **AV1 export** (libsvtav1 10-bit): verificato CLI codec av1 1920×1080 yuv420p10le.
- [x] Sidecar nuovo `sidecars/separate` (sherpa source-separation exe+dll+2 modelli fp16) → main.rs env + tauri.conf resources.
- [x] Gate finale: editor-core 51/51, web 172/172, typecheck 0×3, bridge compile 48 moduli, pass visivo 3 larghezze. Build unica 1.7.0.
