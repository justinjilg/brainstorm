/**
 * finalize-turn — pure decision for "how do we persist the assistant
 * bubble once the stream closes?"
 *
 * Extracted from useChat so the protocol-tier vitest suite can trap
 * the specific behavior that S5 of the Apr-2026 adversarial review
 * surfaced: a provider `error` event arriving AFTER some text-delta
 * events had already streamed was finalizing the partial reply as if
 * it were a complete, successful turn. The fix: treat backend-side
 * errors the same as a user abort for the purposes of the bubble's
 * `aborted` flag, so the UI's "— stopped" marker renders and the user
 * knows the response was cut short.
 */
import type { ChatMessage, ToolCallInfo } from "./chat-types.js";

export interface TurnState {
  accumulatedText: string;
  aborted: boolean;
  backendErrored: boolean;
  model?: string;
  provider?: string;
  turnCost: number;
  toolCalls: ToolCallInfo[];
  reasoning?: string;
}

export interface FinalizeOptions {
  /** Monotonic timestamp source. Injected so tests can pin the id. */
  now?: () => number;
}

/**
 * Decide whether (and how) to append an assistant message given the
 * end-of-turn state. Returns null when there's nothing to persist —
 * e.g. the user aborted before any text arrived.
 */
export function finalizeAssistantMessage(
  state: TurnState,
  opts: FinalizeOptions = {},
): ChatMessage | null {
  if (!state.accumulatedText) return null;
  const ts = (opts.now ?? Date.now)();
  return {
    id: `msg-${ts}-assistant`,
    role: "assistant",
    content: state.accumulatedText,
    model: state.model,
    provider: state.provider,
    cost: state.turnCost > 0 ? state.turnCost : undefined,
    timestamp: ts,
    toolCalls: state.toolCalls.length > 0 ? state.toolCalls : undefined,
    reasoning: state.reasoning,
    // User-abort OR backend-side error both yield an incomplete reply
    // the user should be warned about. Keeping them in one flag (vs.
    // adding a separate `errored` field) keeps the UI path simple: the
    // "— stopped" marker already exists and fits both cases.
    aborted: state.aborted || state.backendErrored || undefined,
  };
}
