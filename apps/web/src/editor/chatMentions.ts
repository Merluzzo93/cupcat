// Pure logic for the chat @-mention typeahead: token detection around the caret, asset filtering
// and inline insertion. Kept DOM-free so it's unit-testable (chatMentions.test.ts) and the
// ChatPanel component stays thin. Mentions are inserted INLINE as "@Name (asset_id)" — the agent
// resolves asset ids natively, so the reference survives copy/paste and library deselection.

import type { MediaAsset } from "@cupcat/editor-core";

export interface MentionToken {
  /** Index of the "@" character in the text. */
  start: number;
  /** End of the token (= caret position); the query never extends past the caret. */
  end: number;
  /** Text between "@" and the caret, e.g. "@dro|" → "dro". */
  query: string;
}

/**
 * Find the active "@token" the caret sits in, or null.
 * Rules: the "@" must be at the start of the text or preceded by whitespace (so emails like
 * "a@b.com" never trigger), and no whitespace may appear between "@" and the caret (a space
 * closes the token). Text after the caret is ignored — typing mid-sentence works.
 */
export function findMentionToken(text: string, caret: number): MentionToken | null {
  for (let i = caret - 1; i >= 0; i--) {
    const ch = text[i];
    if (ch === "@") {
      if (i > 0 && !/\s/.test(text[i - 1])) return null; // "@" glued to a word → not a mention
      return { start: i, end: caret, query: text.slice(i + 1, caret) };
    }
    if (/\s/.test(ch)) return null; // whitespace before finding "@" → caret is outside any token
  }
  return null;
}

/** Lowercase + strip diacritics so "perche" matches "Perché" (Italian asset names are common). */
function fold(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

/** Case- and accent-insensitive name match, capped for a compact popup. */
export function filterAssets(assets: MediaAsset[], query: string, max = 8): MediaAsset[] {
  const q = fold(query);
  return assets.filter((a) => fold(a.name).includes(q)).slice(0, max);
}

/**
 * Replace the active @token with "@Name (asset_id) " and return the new text plus the caret
 * position right after the inserted mention. Text before the token and after the caret is
 * preserved untouched.
 */
export function insertMention(
  text: string,
  token: MentionToken,
  name: string,
  id: string,
): { text: string; caret: number } {
  const mention = `@${name} (${id}) `;
  return {
    text: text.slice(0, token.start) + mention + text.slice(token.end),
    caret: token.start + mention.length,
  };
}

/** Small type glyph for the suggestion rows (defaults to the film frame for video-like types). */
export function assetTypeIcon(type: MediaAsset["type"]): string {
  if (type === "audio") return "🎵";
  if (type === "image") return "🖼";
  return "🎞";
}
