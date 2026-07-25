// Which chat models exist, and how each one is called, is read from the Models API — never from a
// list baked into the build. That is the bug these tests pin: Claude Opus 5 shipped and could not
// appear in the picker no matter what the account had, because the code filtered a hardcoded array.
//
// The second half is about not sending a request the API will reject: effort levels differ per
// model (Sonnet 4.6 has no "xhigh" and answers a request for one with a 400), so a level carried
// over from another model has to be brought down rather than sent as-is.

import { describe, expect, it } from "bun:test";
import { type ApiModel, type ChatModel, clampEffort, toChatModel } from "./agent-chat";

/** Shape as returned by GET /v1/models today, trimmed to the fields we read. */
const OPUS_5: ApiModel = {
  id: "claude-opus-5",
  display_name: "Claude Opus 5",
  max_input_tokens: 1_000_000,
  max_tokens: 128_000,
  capabilities: {
    effort: {
      supported: true,
      low: { supported: true },
      medium: { supported: true },
      high: { supported: true },
      xhigh: { supported: true },
      max: { supported: true },
    },
    thinking: { types: { adaptive: { supported: true } } },
  },
};

const SONNET_4_6: ApiModel = {
  id: "claude-sonnet-4-6",
  display_name: "Claude Sonnet 4.6",
  max_input_tokens: 1_000_000,
  max_tokens: 128_000,
  capabilities: {
    effort: { supported: true, low: { supported: true }, medium: { supported: true }, high: { supported: true }, max: { supported: true } },
    thinking: { types: { adaptive: { supported: true } } },
  },
};

const HAIKU: ApiModel = {
  id: "claude-haiku-4-5-20251001",
  display_name: "Claude Haiku 4.5",
  max_input_tokens: 200_000,
  max_tokens: 64_000,
  capabilities: { thinking: { types: { adaptive: { supported: false } } } },
};

describe("reading a model from the Models API", () => {
  it("takes the account's own label and context window", () => {
    const m = toChatModel(OPUS_5)!;
    expect(m.id).toBe("claude-opus-5");
    expect(m.label).toBe("Claude Opus 5");
    expect(m.contextTokens).toBe(1_000_000);
    expect(m.maxOutput).toBe(128_000);
  });

  it("keeps only the effort levels the model actually reports", () => {
    expect(toChatModel(OPUS_5)!.effortLevels).toEqual(["low", "medium", "high", "xhigh", "max"]);
    // Sonnet 4.6 has no xhigh — and asking for one is a 400, not a silent downgrade.
    expect(toChatModel(SONNET_4_6)!.effortLevels).toEqual(["low", "medium", "high", "max"]);
  });

  it("gives a model with no effort control an empty list, not a guess", () => {
    const m = toChatModel(HAIKU)!;
    expect(m.effortLevels).toEqual([]);
    expect(m.adaptiveThinking).toBe(false);
  });

  it("reads adaptive thinking from the model rather than its name", () => {
    // The old code decided this with a startsWith() list, which is exactly why a model released
    // after the build was called without thinking.
    expect(toChatModel(OPUS_5)!.adaptiveThinking).toBe(true);
    expect(toChatModel(SONNET_4_6)!.adaptiveThinking).toBe(true);
  });

  it("ignores an entry with no id instead of inventing one", () => {
    expect(toChatModel({ display_name: "Nameless" })).toBeNull();
  });

  it("survives a response missing the capabilities block", () => {
    const m = toChatModel({ id: "claude-future-9" })!;
    expect(m.label).toBe("claude-future-9"); // falls back to the id rather than showing blank
    expect(m.effortLevels).toEqual([]);
    expect(m.adaptiveThinking).toBe(false);
  });
});

describe("choosing an effort level the model accepts", () => {
  const opus5 = toChatModel(OPUS_5)!;
  const sonnet46 = toChatModel(SONNET_4_6)!;
  const haiku = toChatModel(HAIKU)!;

  it("passes a supported level through", () => {
    expect(clampEffort("xhigh", opus5)).toBe("xhigh");
    expect(clampEffort("low", sonnet46)).toBe("low");
  });

  it("steps an unsupported level DOWN to the next one the model has", () => {
    // Switching Opus 5 → Sonnet 4.6 while set to "xhigh" used to fail the whole turn.
    expect(clampEffort("xhigh", sonnet46)).toBe("high");
  });

  it("sends nothing at all for a model without effort control", () => {
    expect(clampEffort("high", haiku)).toBeUndefined();
  });

  it("sends nothing when the user has not chosen a level", () => {
    expect(clampEffort(undefined, opus5)).toBeUndefined();
  });

  it("sends nothing when the model is unknown", () => {
    // Unknown model (e.g. the models list could not be fetched): a plain request always works,
    // a request with parameters the model may not accept does not.
    expect(clampEffort("max", null)).toBeUndefined();
  });

  it("never steps up past what was asked for", () => {
    const lowOnly: ChatModel = { ...opus5, effortLevels: ["high", "max"] };
    // "low" has nothing below it on this model, so the lowest available is used — not "max".
    expect(clampEffort("low", lowOnly)).toBe("high");
  });
});
