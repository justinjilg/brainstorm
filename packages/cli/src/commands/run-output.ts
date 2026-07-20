import type { AgentEvent, RunOutcome } from "@brainst0rm/shared";

type DoneEvent = Extract<AgentEvent, { type: "done" }>;
type ErrorEvent = Extract<AgentEvent, { type: "error" }>;

export interface RunOutputContext {
  text: string;
  observedModel: string;
  requestedModel?: string;
  strictModel: boolean;
  toolCalls: number;
}

export interface RunJsonResult {
  schemaVersion: 1;
  success: boolean;
  text: string;
  model: string;
  requestedModel: string | null;
  strictModel: boolean;
  fallbackUsed: boolean;
  cost: number;
  toolCalls: number;
  outcome: RunOutcome | null;
  error?: { name: string; message: string };
}

function serializedError(error: Error): { name: string; message: string } {
  return { name: error.name, message: error.message };
}

export function buildRunJsonResult(
  event: DoneEvent | ErrorEvent,
  context: RunOutputContext,
): RunJsonResult {
  if (event.type === "error") {
    return {
      schemaVersion: 1,
      success: false,
      text: context.text,
      model: context.observedModel,
      requestedModel: context.requestedModel ?? null,
      strictModel: context.strictModel,
      fallbackUsed: false,
      cost: 0,
      toolCalls: context.toolCalls,
      outcome: null,
      error: serializedError(event.error),
    };
  }

  const outcome = event.outcome ?? null;
  const finalModel = outcome?.finalModelId ?? context.observedModel;
  return {
    schemaVersion: 1,
    // A done event without its canonical outcome is not proof of success.
    success: outcome?.status === "succeeded",
    text: context.text,
    model: finalModel,
    requestedModel: context.requestedModel ?? null,
    strictModel: context.strictModel,
    fallbackUsed:
      outcome?.recovery?.includes("fallback") === true ||
      (context.requestedModel !== undefined &&
        finalModel !== context.requestedModel),
    cost: outcome?.costUsd ?? event.totalCost,
    toolCalls: context.toolCalls,
    outcome,
    ...(outcome === null
      ? {
          error: {
            name: "MissingRunOutcome",
            message: "Terminal done event omitted the canonical RunOutcome",
          },
        }
      : {}),
  };
}

/** Stable shell contract: success=0, terminal failure=1, partial=2. */
export function runExitCode(event: DoneEvent | ErrorEvent): 0 | 1 | 2 {
  if (event.type === "error") return 1;
  if (event.outcome?.status === "succeeded") return 0;
  if (event.outcome?.status === "partial") return 2;
  return 1;
}

/** Errors have no enumerable fields, so raw object spread loses diagnostics. */
export function serializeRunEvent(event: AgentEvent): Record<string, unknown> {
  if (event.type === "error") {
    return { ...event, error: serializedError(event.error) };
  }
  return event as unknown as Record<string, unknown>;
}
