/**
 * Phase 7 — tool-use-enforcement DETECTOR unit tests.
 *
 * The loop supplies the STRUCTURAL preconditions (zero tool calls, self-stop,
 * tools available); `detectNarratedToolIntent` is the SEMANTIC gate on the
 * text. Its cardinal rule is hard-constraint (b): NEVER flag a legitimate final
 * answer. The polite-closer corpus below is the exact false-positive class the
 * naive `.{0,40}` window mis-fired on ("let me know if you'd like me to run …")
 * and is a regression guard for that fix.
 */

import { describe, it, expect } from "vitest";
import {
  detectNarratedToolIntent,
  buildToolUseCorrection,
} from "../agent/tool-use-enforcement.js";

describe("detectNarratedToolIntent — narrated intents (should flag)", () => {
  const narrations = [
    "Let me read config.ts to find the setting.",
    "I'll search for the handler now.",
    "Now I will grep for the pattern.",
    "Let me quickly read the file.",
    "I will now open the config and edit it.",
    "Let me check the logs.",
    "going to run the build",
    "I'm going to look at the schema.",
    "Next, I edit the loop.",
  ];
  for (const text of narrations) {
    it(`flags: ${JSON.stringify(text)}`, () => {
      expect(detectNarratedToolIntent(text)).toBe(true);
    });
  }
});

describe("detectNarratedToolIntent — fake-tool artifacts (should flag)", () => {
  const artifacts = [
    "[TOOL BLOCKED] file_read",
    'Here: ```json\n{"tool_name": "file_read"}\n```',
    "I emitted a tool_call for you.",
  ];
  for (const text of artifacts) {
    it(`flags: ${JSON.stringify(text)}`, () => {
      expect(detectNarratedToolIntent(text)).toBe(true);
    });
  }
});

describe("detectNarratedToolIntent — legitimate finishes (must NOT flag)", () => {
  // The polite-closer corpus: offers/deferrals to the user that share a
  // lead-in word with a narration but carry NO self-declared tool intent.
  const legitimate = [
    "The answer is 42.",
    "Let me know if you want me to run the tests.",
    "Let me know if you'd like me to update the docs.",
    "Let me know if that works, and I can check the logs.",
    "Let me know if you'd like me to explore other options.",
    "I can update the docs if you like.",
    "If you want, I can check the logs.",
    "I would recommend you run the tests before merging.",
    "Let me explain how the router works.",
    "The config now enables verify mode.",
    "",
    "   ",
  ];
  for (const text of legitimate) {
    it(`does NOT flag: ${JSON.stringify(text)}`, () => {
      expect(detectNarratedToolIntent(text)).toBe(false);
    });
  }
});

describe("buildToolUseCorrection", () => {
  it("produces a tagged, actionable user-role nudge with an escape hatch", () => {
    const msg = buildToolUseCorrection();
    expect(msg).toContain("[tool-enforcement]");
    expect(msg.toLowerCase()).toContain("function-call");
    // Gives a legitimate finisher a way out instead of forcing a bogus call.
    expect(msg.toLowerCase()).toContain("finished");
  });
});
