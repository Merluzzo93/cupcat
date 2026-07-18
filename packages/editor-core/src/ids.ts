// Short, prefixed, reasonably-unique ids.
// Palmier's tool layer hands the model short id prefixes and requires them passed
// back verbatim — we generate short ids directly so the same contract holds.

const ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyz";

function rand(n: number): string {
  let s = "";
  for (let i = 0; i < n; i++) {
    s += ALPHABET[Math.floor(Math.random() * ALPHABET.length)];
  }
  return s;
}

/** e.g. `clip_a1b2c3d4`. Callers must pass ids back exactly as given. */
export function newId(prefix: string): string {
  return `${prefix}_${rand(8)}`;
}
