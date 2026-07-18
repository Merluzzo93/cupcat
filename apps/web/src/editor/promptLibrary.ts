// Curated ready-made prompts for the "✨ Prompts" dropdown in the ChatPanel. Plain data on
// purpose: adding a prompt (or a category) is a one-line edit here, no UI changes needed.
// Prompts are in Italian to match the app's audience; [placeholders] are meant to be filled
// by the user after the prompt lands in the input (clicking never auto-sends).

export interface PromptCategory {
  category: string;
  prompts: string[];
}

export const promptLibrary: PromptCategory[] = [
  {
    category: "Montaggio",
    prompts: [
      "Rimuovi le pause e unisci in una clip",
      "Fai un primo montaggio pulito del girato",
      "Dividi il video in clip a ogni cambio di scena",
    ],
  },
  {
    category: "Stile",
    prompts: [
      "Sottotitoli karaoke gialli in basso",
      "Look cinematografico caldo",
      "Zoom meme sul volto quando dice qualcosa di assurdo",
      "Bianco e nero con grana da pellicola",
    ],
  },
  {
    category: "Grafiche",
    prompts: [
      "Lower third animata con [nome]",
      "Titolo animato d'apertura con [testo]",
    ],
  },
  {
    category: "Audio",
    prompts: [
      "Musica di sottofondo [genere] duckata sotto la voce",
      "Voiceover che dice: [testo]",
      "Rimuovi il rumore di fondo",
    ],
  },
  {
    category: "Consegna",
    prompts: [
      "Prepara versione 9:16 per TikTok",
      "Sottotitoli SRT da caricare su YouTube",
      "Esporta 3 short verticali con i momenti migliori",
    ],
  },
];
