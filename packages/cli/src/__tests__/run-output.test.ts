import { describe, expect, it } from "vitest";
import type { AgentEvent, RunOutcome } from "@brainst0rm/shared";
import {
  buildRunJsonResult,
  runExitCode,
  serializeRunEvent,
} from "../commands/run-output.js";

const outcome: RunOutcome = {
  status: "succeeded",
  attempts: [
    {
      modelId: "local/primary",
      taskType: "code-generation",
      status: "failed",
      stopCause: "empty_output",
      latencyMs: 100,
      costUsd: 0,
    },
    {
      modelId: "local/fallback",
      taskType: "code-generation",
      status: "succeeded",
      stopCause: "natural_stop",
      latencyMs: 200,
      costUsd: 0,
    },
  ],
  finalModelId: "local/fallback",
  initialStopCause: "empty_output",
  recovery: ["fallback"],
  hasFinalResponse: true,
  verification: "not_run",
  security: "not_run",
  judge: "not_run",
  costUsd: 0,
};

describe("run JSON output", () => {
  it("exposes the canonical outcome and requested-versus-final model", () => {
    const event: Extract<AgentEvent, { type: "done" }> = {
      type: "done",
      totalCost: 0,
      outcome,
    };
    const result = buildRunJsonResult(event, {
      text: "Recovered answer",
      observedModel: "Fallback",
      requestedModel: "local/primary",
      strictModel: false,
      toolCalls: 2,
    });

    expect(result).toMatchObject({
      schemaVersion: 1,
      success: true,
      model: "local/fallback",
      requestedModel: "local/primary",
      fallbackUsed: true,
      outcome,
    });
    expect(runExitCode(event)).toBe(0);
  });

  it("does not call a done event successful when RunOutcome is missing", () => {
    const event: Extract<AgentEvent, { type: "done" }> = {
      type: "done",
      totalCost: 0,
    };
    const result = buildRunJsonResult(event, {
      text: "plausible text",
      observedModel: "unknown",
      strictModel: false,
      toolCalls: 0,
    });

    expect(result.success).toBe(false);
    expect(result.error?.name).toBe("MissingRunOutcome");
    expect(runExitCode(event)).toBe(1);
  });

  it.each([
    ["failed", 1],
    ["aborted", 1],
    ["partial", 2],
  ] as const)("maps %s outcomes to a nonzero exit", (status, exitCode) => {
    const event: Extract<AgentEvent, { type: "done" }> = {
      type: "done",
      totalCost: 0,
      outcome: { ...outcome, status },
    };
    expect(runExitCode(event)).toBe(exitCode);
  });

  it("preserves error diagnostics in JSONL event mode", () => {
    const event: AgentEvent = {
      type: "error",
      error: new TypeError("provider unavailable"),
      category: "model-api",
    };

    expect(serializeRunEvent(event)).toEqual({
      type: "error",
      category: "model-api",
      error: { name: "TypeError", message: "provider unavailable" },
    });
    expect(runExitCode(event)).toBe(1);
  });
});
