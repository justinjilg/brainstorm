// Lifecycle state machine for dispatch commands per protocol-v1 §7.
//
// Authoritative state owner is the relay (per §7 last paragraph). Endpoint
// emits state transitions via CommandAck / ProgressEvent / CommandResult /
// ErrorEvent; relay's audit log + this in-memory manager are canonical.
//
// State diagram:
//
//   pending                   ← reserve_command_id (relay-internal)
//     ↓ relay sends CommandEnvelope
//   dispatched
//     ↓ endpoint emits CommandAck (v3 explicit)
//   started
//     ↓ ProgressEvent w/ fraction
//   progress (re-entrant)
//     ↓ CommandResult
//   completed | failed
//
//   At any non-terminal state:
//     - relay-side deadline → timed_out
//     - endpoint ErrorEvent (reject-before-start, e.g. SIGNATURE_INVALID,
//       ENVELOPE_EXPIRED, etc.) from dispatched → failed
//
//   Late arrivals after terminal state are recorded with `late_arrival`
//   audit flag but do NOT change row state.

import type { LifecycleState } from "./types.js";

export type LifecycleTransitionInput =
  | { kind: "reserve" }
  | { kind: "dispatch_sent" }
  | { kind: "ack_received" }
  | { kind: "progress_received"; has_fraction: boolean }
  | { kind: "result_completed" }
  | { kind: "result_failed" }
  | { kind: "endpoint_error" }
  | { kind: "ack_timeout" }
  | { kind: "deadline_exceeded" }
  | { kind: "endpoint_disconnected_before_ack" };

export type LifecycleTransitionResult =
  | { ok: true; from: LifecycleState | null; to: LifecycleState }
  | {
      ok: false;
      reason: "late_arrival" | "invalid_transition" | "unknown_command";
      from: LifecycleState | null;
      attempted_input: LifecycleTransitionInput;
    };

const TERMINAL_STATES: ReadonlySet<LifecycleState> = new Set<LifecycleState>([
  "completed",
  "failed",
  "timed_out",
]);

interface StateRecord {
  command_id: string;
  state: LifecycleState;
  history: Array<{
    from: LifecycleState | null;
    to: LifecycleState;
    ts: string;
  }>;
}

export class LifecycleManager {
  private readonly states = new Map<string, StateRecord>();

  /**
   * Reserve a fresh command_id (transition: none → pending).
   * Throws if command_id already exists.
   */
  reserve(command_id: string): LifecycleTransitionResult {
    if (this.states.has(command_id)) {
      return {
        ok: false,
        reason: "invalid_transition",
        from: this.states.get(command_id)!.state,
        attempted_input: { kind: "reserve" },
      };
    }
    const record: StateRecord = {
      command_id,
      state: "pending",
      history: [{ from: null, to: "pending", ts: new Date().toISOString() }],
    };
    this.states.set(command_id, record);
    return { ok: true, from: null, to: "pending" };
  }

  /**
   * Apply a transition input to a command_id. Returns the resulting
   * transition. Late arrivals (terminal-state input) are non-fatal and
   * recorded as `late_arrival`.
   */
  transition(
    command_id: string,
    input: LifecycleTransitionInput,
  ): LifecycleTransitionResult {
    const record = this.states.get(command_id);
    if (record === undefined) {
      // Reserve is the only valid input for an unknown command_id, and we
      // handle that via reserve() not transition().
      return {
        ok: false,
        reason: "unknown_command",
        from: null,
        attempted_input: input,
      };
    }
    const from = record.state;
    if (TERMINAL_STATES.has(from)) {
      // Late arrival: input arrived after the command already terminated.
      // Per protocol §7, do NOT change state; record as audit flag.
      return {
        ok: false,
        reason: "late_arrival",
        from,
        attempted_input: input,
      };
    }
    const to = nextState(from, input);
    if (to === null) {
      return {
        ok: false,
        reason: "invalid_transition",
        from,
        attempted_input: input,
      };
    }
    record.state = to;
    record.history.push({ from, to, ts: new Date().toISOString() });
    return { ok: true, from, to };
  }

  getState(command_id: string): LifecycleState | undefined {
    return this.states.get(command_id)?.state;
  }

  getHistory(
    command_id: string,
  ):
    | ReadonlyArray<{
        from: LifecycleState | null;
        to: LifecycleState;
        ts: string;
      }>
    | undefined {
    return this.states.get(command_id)?.history;
  }

  isTerminal(command_id: string): boolean {
    const s = this.states.get(command_id)?.state;
    return s !== undefined && TERMINAL_STATES.has(s);
  }

  /**
   * Drop a record from the in-memory manager. Use after the audit log has
   * persisted the terminal state, to bound memory growth on long-running
   * relays. Audit log is the durable source of truth.
   */
  forget(command_id: string): void {
    this.states.delete(command_id);
  }

  count(): number {
    return this.states.size;
  }
}

/**
 * Pure transition function — given current state + input, returns the
 * new state OR null for invalid transition.
 *
 * Exported for testability and to make the state machine readable as data.
 */
export function nextState(
  current: LifecycleState,
  input: LifecycleTransitionInput,
): LifecycleState | null {
  switch (current) {
    case "pending":
      if (input.kind === "dispatch_sent") return "dispatched";
      return null;

    case "dispatched":
      if (input.kind === "ack_received") return "started";
      if (input.kind === "endpoint_error") return "failed";
      if (input.kind === "endpoint_disconnected_before_ack") return "failed";
      if (input.kind === "ack_timeout") return "timed_out";
      if (input.kind === "deadline_exceeded") return "timed_out";
      return null;

    case "started":
      if (input.kind === "progress_received" && input.has_fraction)
        return "progress";
      if (input.kind === "result_completed") return "completed";
      if (input.kind === "result_failed") return "failed";
      if (input.kind === "endpoint_error") return "failed";
      if (input.kind === "deadline_exceeded") return "timed_out";
      // started → started on ProgressEvent without fraction is allowed but
      // produces no state change; not reached because no transition is
      // requested in that case (caller handles it).
      return null;

    case "progress":
      // re-entrant on subsequent ProgressEvents — caller does not call
      // transition() in that case; the state stays `progress` while
      // metadata fields churn.
      if (input.kind === "result_completed") return "completed";
      if (input.kind === "result_failed") return "failed";
      if (input.kind === "endpoint_error") return "failed";
      if (input.kind === "deadline_exceeded") return "timed_out";
      return null;

    case "completed":
    case "failed":
    case "timed_out":
      // Terminal states — handled in transition() as late_arrival.
      return null;

    default:
      // exhaustive guard
      return null;
  }
}
