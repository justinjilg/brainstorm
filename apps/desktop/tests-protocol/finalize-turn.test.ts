/**
 * Protocol-tier trap for useChat's end-of-turn finalize decision.
 *
 * Background (Apr-2026 adversarial review, S5): a provider `error`
 * event arriving mid-stream — AFTER some `text-delta` events had
 * already appended to `accumulatedText` — used to finalize the
 * partial reply with `aborted: undefined`, so the UI rendered it as
 * if the turn had completed normally. The user would see a truncated
 * answer with no indication it had been cut short.
 *
 * The fix moved the `aborted` flag computation to a pure module so
 * this vitest suite can pin the decision matrix without launching
 * Electron. If a regression ever drops `backendErrored` from the
 * OR'd flag, the "partial + backend-error" case below flips and
 * this spec fails.
 */

import { describe, it, expect } from "vitest";
import { finalizeAssistantMessage } from "../src/hooks/finalize-turn.js";
import type { ToolCallInfo } from "../src/hooks/chat-types.js";

const BASE = {
  model: "gpt-5.4",
  provider: "openai" as const,
  turnCost: 0,
  toolCalls: [] as ToolCallInfo[],
  reasoning: undefined,
};

const nowStub = () => 1_700_000_000_000;

describe("finalizeAssistantMessage", () => {
  it("returns null when no text streamed (clean abort before first delta)", () => {
    // User hits stop before the model emits anything. Nothing worth
    // persisting — don't leave an empty bubble in the transcript.
    const msg = finalizeAssistantMessage(
      {
        ...BASE,
        accumulatedText: "",
        aborted: true,
        backendErrored: false,
      },
      { now: nowStub },
    );
    expect(msg).toBeNull();
  });

  it("persists a complete reply with aborted=undefined when no error or abort", () => {
    // Golden path. If this line ever changes to `aborted: false`, the
    // UI renders a "— stopped" marker on healthy replies. That's a
    // regression — keep the flag strictly `undefined` on success.
    const msg = finalizeAssistantMessage(
      {
        ...BASE,
        accumulatedText: "hello world",
        aborted: false,
        backendErrored: false,
        turnCost: 0.0042,
      },
      { now: nowStub },
    );
    expect(msg).not.toBeNull();
    expect(msg!.aborted).toBeUndefined();
    expect(msg!.content).toBe("hello world");
    expect(msg!.cost).toBe(0.0042);
  });

  it("marks partial reply as aborted when user cancelled mid-stream", () => {
    const msg = finalizeAssistantMessage(
      {
        ...BASE,
        accumulatedText: "half an answ",
        aborted: true,
        backendErrored: false,
      },
      { now: nowStub },
    );
    expect(msg!.aborted).toBe(true);
  });

  it("marks partial reply as aborted when backend error arrives mid-stream (S5 trap)", () => {
    // This is the exact regression the S5 review surfaced: some text
    // streamed before the provider fired an `error` event. Pre-fix,
    // `aborted` was driven only by the user-cancel signal, so the
    // bubble landed as if it were a clean completion. Flipping the
    // assertion below to `.toBeUndefined()` is the regression shape.
    const msg = finalizeAssistantMessage(
      {
        ...BASE,
        accumulatedText: "partial reply then 5xx",
        aborted: false,
        backendErrored: true,
      },
      { now: nowStub },
    );
    expect(msg!.aborted).toBe(true);
  });

  it("marks aborted when BOTH user cancel and backend error fire", () => {
    // A provider error and a user abort racing is unusual but real —
    // e.g. a slow 5xx lands just as the user hits stop. Either signal
    // alone should warn the user, and both together should still do
    // so (no weird state where they cancel out).
    const msg = finalizeAssistantMessage(
      {
        ...BASE,
        accumulatedText: "x",
        aborted: true,
        backendErrored: true,
      },
      { now: nowStub },
    );
    expect(msg!.aborted).toBe(true);
  });

  it("omits cost when turnCost is zero (don't render a $0.00 pill)", () => {
    const msg = finalizeAssistantMessage(
      {
        ...BASE,
        accumulatedText: "free turn",
        aborted: false,
        backendErrored: false,
        turnCost: 0,
      },
      { now: nowStub },
    );
    expect(msg!.cost).toBeUndefined();
  });

  it("inlines toolCalls only when non-empty", () => {
    const tcs: ToolCallInfo[] = [
      { id: "tc-1", name: "read_file", status: "success" },
    ];
    const withTools = finalizeAssistantMessage(
      {
        ...BASE,
        accumulatedText: "done",
        aborted: false,
        backendErrored: false,
        toolCalls: tcs,
      },
      { now: nowStub },
    );
    expect(withTools!.toolCalls).toEqual(tcs);

    const withoutTools = finalizeAssistantMessage(
      {
        ...BASE,
        accumulatedText: "done",
        aborted: false,
        backendErrored: false,
        toolCalls: [],
      },
      { now: nowStub },
    );
    expect(withoutTools!.toolCalls).toBeUndefined();
  });
});
