// Safe arithmetic for inspector number fields ("1920/2", "0.5+0.25"). A tiny recursive-descent
// parser over digits + - * / ( ) . and whitespace only — no eval, no identifiers, no surprises.
// Returns null on any syntax error or non-finite result so the caller keeps the old value.

export function evaluateExpr(src: string): number | null {
  // Reject anything outside the whitelist up front (cheap, and gives the parser a clean alphabet).
  if (!/^[\d+\-*/().\s]*$/.test(src)) return null;
  let pos = 0;
  const s = src;

  const skipWs = () => {
    while (pos < s.length && (s[pos] === " " || s[pos] === "\t")) pos++;
  };
  const peek = (): string => {
    skipWs();
    return pos < s.length ? s[pos]! : "";
  };

  // number := digits [ "." digits ] | "." digits  — a lone "." or "1..2" is a syntax error
  const parseNumber = (): number | null => {
    skipWs();
    const start = pos;
    while (pos < s.length && s[pos]! >= "0" && s[pos]! <= "9") pos++;
    if (pos < s.length && s[pos] === ".") {
      pos++;
      const fracStart = pos;
      while (pos < s.length && s[pos]! >= "0" && s[pos]! <= "9") pos++;
      if (pos === fracStart && start === pos - 1) return null; // just "."
    }
    if (pos === start && !(pos > 0 && s[pos - 1] === ".")) return null; // no digits consumed
    const text = s.slice(start, pos);
    if (!/^(\d+\.?\d*|\.\d+)$/.test(text)) return null; // e.g. "1." is fine, "1..2" is not
    return Number(text);
  };

  // factor := [ "+" | "-" ] ( number | "(" expr ")" )
  const parseFactor = (): number | null => {
    const c = peek();
    if (c === "+" || c === "-") {
      pos++;
      const v = parseFactor();
      return v === null ? null : c === "-" ? -v : v;
    }
    if (c === "(") {
      pos++;
      const v = parseExpr();
      if (v === null || peek() !== ")") return null;
      pos++;
      return v;
    }
    return parseNumber();
  };

  // term := factor { ( "*" | "/" ) factor }
  const parseTerm = (): number | null => {
    let v = parseFactor();
    if (v === null) return null;
    for (;;) {
      const c = peek();
      if (c !== "*" && c !== "/") return v;
      pos++;
      const rhs = parseFactor();
      if (rhs === null) return null;
      v = c === "*" ? v * rhs : v / rhs;
    }
  };

  // expr := term { ( "+" | "-" ) term }
  const parseExpr = (): number | null => {
    let v = parseTerm();
    if (v === null) return null;
    for (;;) {
      const c = peek();
      if (c !== "+" && c !== "-") return v;
      pos++;
      const rhs = parseTerm();
      if (rhs === null) return null;
      v = c === "+" ? v + rhs : v - rhs;
    }
  };

  const result = parseExpr();
  skipWs();
  if (result === null || pos !== s.length) return null; // trailing junk = reject
  return Number.isFinite(result) ? result : null; // 1/0 → Infinity → reject
}
