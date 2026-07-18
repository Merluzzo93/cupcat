// The inspector's inline-math evaluator: valid arithmetic evaluates, everything else returns null
// (the field then keeps its old value — a typo must never commit garbage).
import { describe, expect, test } from "vitest";
import { evaluateExpr } from "./mathExpr";

describe("evaluateExpr — valid expressions", () => {
  test("plain numbers pass through", () => {
    expect(evaluateExpr("42")).toBe(42);
    expect(evaluateExpr("0.75")).toBe(0.75);
    expect(evaluateExpr(".5")).toBe(0.5);
  });

  test("division: 1920/2", () => {
    expect(evaluateExpr("1920/2")).toBe(960);
  });

  test("addition with decimals: 0.5+0.25", () => {
    expect(evaluateExpr("0.5+0.25")).toBe(0.75);
  });

  test("operator precedence: 2+3*4", () => {
    expect(evaluateExpr("2+3*4")).toBe(14);
  });

  test("parens override precedence: (2+3)*4", () => {
    expect(evaluateExpr("(2+3)*4")).toBe(20);
  });

  test("nested parens: ((2))*(3+(4-1))", () => {
    expect(evaluateExpr("((2))*(3+(4-1))")).toBe(12);
  });

  test("unary minus and chains: -5+2*-3", () => {
    expect(evaluateExpr("-5+2*-3")).toBe(-11);
  });

  test("whitespace is tolerated: ' 1920 / 2 '", () => {
    expect(evaluateExpr(" 1920 / 2 ")).toBe(960);
  });
});

describe("evaluateExpr — junk is rejected (returns null)", () => {
  test("identifiers and disallowed characters", () => {
    expect(evaluateExpr("abc")).toBeNull();
    expect(evaluateExpr("2^3")).toBeNull();
    expect(evaluateExpr("1e3")).toBeNull(); // exponent notation is outside the whitelist
    expect(evaluateExpr("alert(1)")).toBeNull();
  });

  test("dangling operators and empty input", () => {
    expect(evaluateExpr("")).toBeNull();
    expect(evaluateExpr("1+")).toBeNull();
    expect(evaluateExpr("*2")).toBeNull();
  });

  test("malformed numbers", () => {
    expect(evaluateExpr("1..2")).toBeNull();
    expect(evaluateExpr(".")).toBeNull();
  });

  test("unbalanced parens", () => {
    expect(evaluateExpr("(1+2")).toBeNull();
    expect(evaluateExpr("1+2)")).toBeNull();
  });

  test("trailing junk after a valid expression", () => {
    expect(evaluateExpr("1+2 3")).toBeNull();
  });

  test("non-finite results: 1/0", () => {
    expect(evaluateExpr("1/0")).toBeNull();
    expect(evaluateExpr("0/0")).toBeNull();
  });
});
