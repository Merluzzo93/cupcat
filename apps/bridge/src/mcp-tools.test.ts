// The registry and the executor have to agree.
//
// Declaring a tool is one edit and handling it is another, and nothing links them: a tool that is
// advertised but has no `case` reaches the agent, gets called, and answers "Unknown tool" — a failure
// the user sees and no build step catches. The check is structural on purpose (it reads the executor's
// source rather than calling anything) because calling 150 tools to find out would export files,
// spend money and start renders.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { TIMELINE_COMMANDS } from "@cupcat/editor-core";
import { TOOL_DEFS, TOOL_NAMES } from "./mcp-tools";

const executorSrc = readFileSync(join(import.meta.dir, "executor.ts"), "utf8");
const handled = new Set([...executorSrc.matchAll(/case "([a-z0-9_]+)":/g)].map((m) => m[1]!));

describe("tool registry", () => {
  test("every declared tool is dispatched somewhere", () => {
    const orphans = TOOL_NAMES.filter((n) => !handled.has(n) && !(n in TIMELINE_COMMANDS));
    expect(orphans).toEqual([]);
  });

  test("no duplicate names", () => {
    expect(TOOL_NAMES.length).toBe(new Set(TOOL_NAMES).size);
  });

  test("every tool says what it is for, and every required argument exists in its schema", () => {
    for (const t of TOOL_DEFS) {
      expect(t.description.length).toBeGreaterThan(20);
      const schema = t.inputSchema as { properties?: Record<string, unknown>; required?: string[] };
      const props = Object.keys(schema.properties ?? {});
      for (const r of schema.required ?? []) expect(props).toContain(r);
    }
  });
});
