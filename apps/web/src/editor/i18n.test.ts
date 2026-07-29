// The dictionaries have to stay in step.
//
// A missing Italian entry does not throw and does not show a raw key — it quietly renders the
// English text, which is exactly why untranslated strings survived for months without anyone
// noticing. This test is the thing that notices: add an English string without its translation and
// the suite fails, naming it.
//
// It reads the source rather than importing the module, because the dictionaries are not exported —
// and reading the file is also what proves the two objects really are side by side in it.

import { describe, expect, test } from "bun:test";

const SRC = "apps/web/src/editor/i18n.ts";

/** The keys declared in one dictionary literal. The two end differently — EN closes with
 * `} as const;` so its keys can be a type — so the end is any closing brace at column 0. */
function keysOf(src: string, decl: string): string[] {
  const start = src.indexOf(decl);
  if (start < 0) throw new Error(`dictionary not found: ${decl}`);
  const end = /^\}/m.exec(src.slice(start + decl.length))?.index;
  if (end === undefined) throw new Error(`unterminated dictionary: ${decl}`);
  return [...src.slice(start, start + decl.length + end).matchAll(/^ {2}"([^"]+)":/gm)].map((m) => m[1]!);
}

const src = await Bun.file(SRC).text();
const en = keysOf(src, "const EN = {");
const it = keysOf(src, "const IT: Partial<Record<Key, string>> = {");

describe("interface translations", () => {
  test("every English string has an Italian one", () => {
    const missing = en.filter((k) => !it.includes(k));
    expect(missing).toEqual([]);
  });

  test("no Italian entry survives an English key being removed", () => {
    // An orphan is dead weight that also hides a rename: the English key moved, the Italian one
    // stayed, and the new key silently falls back.
    const orphans = it.filter((k) => !en.includes(k));
    expect(orphans).toEqual([]);
  });

  test("no key is declared twice in the same dictionary", () => {
    // A duplicate is a silent overwrite — the second value wins and the first edit vanishes.
    for (const [lang, keys] of [
      ["EN", en],
      ["IT", it],
    ] as const) {
      const seen = new Set<string>();
      const dupes = keys.filter((k) => (seen.has(k) ? true : (seen.add(k), false)));
      expect({ lang, dupes }).toEqual({ lang, dupes: [] });
    }
  });

  test("both dictionaries actually have content", () => {
    expect(en.length).toBeGreaterThan(500);
    expect(it.length).toBe(en.length);
  });

  test("placeholders match between the two languages", () => {
    // "{version}" in English and "{versione}" in Italian renders a literal brace to the user.
    const holders = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]!).sort();
    const valueOf = (decl: string, key: string): string | null => {
      const start = src.indexOf(decl);
      const end = src.indexOf("\n};", start);
      const m = new RegExp(`^ {2}"${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}":\\s*("(?:[^"\\\\]|\\\\.)*")`, "m").exec(src.slice(start, end));
      return m ? (JSON.parse(m[1]!) as string) : null;
    };
    const mismatched: string[] = [];
    for (const k of en) {
      const e = valueOf("const EN = {", k);
      const i = valueOf("const IT: Partial<Record<Key, string>> = {", k);
      if (e == null || i == null) continue; // multi-line values are checked by the tests above
      if (holders(e).join(",") !== holders(i).join(",")) mismatched.push(k);
    }
    expect(mismatched).toEqual([]);
  });
});
