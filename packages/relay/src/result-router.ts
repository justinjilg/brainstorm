// Result router — given an endpoint-side frame (CommandAck, ProgressEvent,
// CommandResult, endpoint ErrorEvent), look up which operator session has
// the command_id in flight and forward the appropriate operator-side frame
// back. Implements the result/progress fanout from §9 audit chain.
//
// Maintains command_id → operator_session_id mapping. Created when relay
// successfully sends a CommandEnvelope; removed when terminal state reached
// (or operator session closes).

import type {
  CommandAck,
  CommandResult,
  ProgressEventEndpointSide,
  ErrorEventEndpointToRelay,
  ProgressEventOperatorSide,
  ResultEvent,
  ErrorEventRelayToOperator,
} from "./types.js";
import type { SessionStore } from "./session-store.js";
import type { LifecycleManager } from "./lifecycle.js";
import type { AuditLog } from "./audit.js";
import type {
  BrOutcomeReporter,
  DispatchOutcome,
} from "./br-outcome-reporter.js";

export interface InflightDispatch {
  command_id: string;
  request_id: string; // operator's original request_id
  operator_session_id: string;
  endpoint_id: string;
  endpoint_session_id: string;
  dispatch_request: { tool: string }; // minimal context for fanout
  /** Correlation id from the operator DispatchRequest. Forwarded as the
   *  Idempotency-Key in BR outcome reports + threaded through audit. */
  correlation_id: string;
  /** ISO8601 timestamp the relay registered the dispatch (envelope sent).
   *  Used to compute duration_ms in BR outcome reports. */
  started_at: string;
  /** Size in bytes of operator's params (for BR's payload_size_in metric). */
  payload_size_in: number;
}

export interface ResultRouterOptions {
  sessions: SessionStore;
  lifecycle: LifecycleManager;
  audit: AuditLog;
  /**
   * Optional BR outcome reporter. When supplied, every terminal command
   * lifecycle (completed/failed/timed_out) triggers a fire-and-forget POST
   * to BR's `/v1/agents/${agentId}/dispatch-outcomes` endpoint. The
   * reporter's failures are logged + dropped; this path does NOT block the
   * audit chain or operator fanout.
   */
  brOutcomeReporter?: BrOutcomeReporter;
  now?: () => Date;
}

export class ResultRouter {
  private readonly opts: ResultRouterOptions;
  private readonly now: () => Date;
  private readonly inflight = new Map<string, InflightDispatch>();

  constructor(opts: ResultRouterOptions) {
    this.opts = opts;
    this.now = opts.now ?? (() => new Date());
  }

  /**
   * Register a command_id as in-flight to a particular operator session.
   * Called by the dispatch orchestrator after produceEnvelope() succeeds
   * AND the envelope has been WS-written to the endpoint.
   */
  registerInflight(d: InflightDispatch): void {
    if (this.inflight.has(d.command_id)) {
      throw new Error(
        `ResultRouter: command_id ${d.command_id} already inflight`,
      );
    }
    if (
      typeof d.correlation_id !== "string" ||
      !/^[\x21-\x7e]{1,256}$/.test(d.correlation_id)
    ) {
      throw new Error(
        "ResultRouter: valid correlation_id is required for inflight dispatch",
      );
    }
    if (typeof d.started_at !== "string" || d.started_at.length === 0) {
      throw new Error(
        "ResultRouter: started_at is required for inflight dispatch",
      );
    }
    if (
      typeof d.payload_size_in !== "number" ||
      !Number.isFinite(d.payload_size_in)
    ) {
      throw new Error(
        "ResultRouter: payload_size_in is required for inflight dispatch",
      );
    }
    this.inflight.set(d.command_id, d);
  }

  /**
   * Process a CommandAck from an endpoint. Returns the ProgressEvent to
   * forward to the operator (lifecycle_state: "started"), OR an ErrorEvent
   * if the routing fails (unknown command_id, stale session, etc.).
   *
   * Caller is responsible for sending the returned frame to the operator's
   * transport.
   */
  handleCommandAck(ack: CommandAck): RoutingResult<ProgressEventOperatorSide> {
    return this.routeEndpointFrame(ack, "CommandAck", (inflight) => {
      // Lifecycle: dispatched → started
      const t = this.opts.lifecycle.transition(ack.command_id, {
        kind: "ack_received",
      });
      if (!t.ok) {
        if (t.reason === "late_arrival") {
          return null; // late ACK after timeout; recorded as audit, no operator event
        }
        return {
          kind: "error",
          error: this.makeOperatorError(
            inflight.request_id,
            ack.command_id,
            "RELAY_INTERNAL_ERROR",
            `Lifecycle transition failed on CommandAck: ${t.reason}`,
          ),
        };
      }
      // Audit: endpoint-origin CommandAck
      this.opts.audit.appendCanonical({
        command_id: ack.command_id,
        ts: this.now().toISOString(),
        channel_of_origin: "endpoint",
        message_type: "CommandAck",
        payload: ack,
        endpoint_id: ack.endpoint_id,
        session_id: ack.session_id,
      });
      // Forward as ProgressEvent (lifecycle_state: "started") to operator
      const op: ProgressEventOperatorSide = {
        type: "ProgressEvent",
        request_id: inflight.request_id,
        command_id: ack.command_id,
        lifecycle_state: "started",
        ts: this.now().toISOString(),
      };
      return { kind: "operator_event", frame: op };
    });
  }

  /**
   * Process a ProgressEvent from an endpoint. Forwards to operator with
   * the operator-side schema shape (request_id-keyed, no endpoint_id).
   */
  handleProgressEvent(
    evt: ProgressEventEndpointSide,
  ): RoutingResult<ProgressEventOperatorSide> {
    return this.routeEndpointFrame(evt, "ProgressEvent", (inflight) => {
      // Re-entrant transition: only request a state change if has_fraction
      // makes the started → progress transition; otherwise stay on
      // current state and forward.
      const has_fraction =
        evt.progress?.fraction !== undefined && evt.progress.fraction !== null;
      if (
        this.opts.lifecycle.getState(evt.command_id) === "started" &&
        has_fraction
      ) {
        const t = this.opts.lifecycle.transition(evt.command_id, {
          kind: "progress_received",
          has_fraction: true,
        });
        if (!t.ok && t.reason === "late_arrival") {
          return null;
        }
      }
      this.opts.audit.appendCanonical({
        command_id: evt.command_id,
        ts: this.now().toISOString(),
        channel_of_origin: "endpoint",
        message_type: "ProgressEvent",
        payload: evt,
        endpoint_id: evt.endpoint_id,
        session_id: evt.session_id,
      });
      const op: ProgressEventOperatorSide = {
        type: "ProgressEvent",
        request_id: inflight.request_id,
        command_id: evt.command_id,
        lifecycle_state: evt.lifecycle_state,
        progress: evt.progress,
        ts: evt.ts,
      };
      return { kind: "operator_event", frame: op };
    });
  }

  /**
   * Process a terminal CommandResult from an endpoint. Returns the
   * ResultEvent to forward to the operator. Removes the command_id from
   * the in-flight map.
   */
  handleCommandResult(result: CommandResult): RoutingResult<ResultEvent> {
    return this.routeEndpointFrame(result, "CommandResult", (inflight) => {
      const transitionInput =
        result.lifecycle_state === "completed"
          ? { kind: "result_completed" as const }
          : { kind: "result_failed" as const };
      const t = this.opts.lifecycle.transition(
        result.command_id,
        transitionInput,
      );
      if (!t.ok) {
        if (t.reason === "late_arrival") {
          // Late result after relay-side timeout; record audit, drop
          this.opts.audit.appendCanonical({
            command_id: result.command_id,
            ts: this.now().toISOString(),
            channel_of_origin: "endpoint",
            message_type: "CommandResult",
            payload: result,
            metadata_sidecar: { late_arrival: true },
            endpoint_id: result.endpoint_id,
            session_id: result.session_id,
          });
          return null;
        }
        return {
          kind: "error",
          error: this.makeOperatorError(
            inflight.request_id,
            result.command_id,
            "RELAY_INTERNAL_ERROR",
            `Lifecycle transition failed on CommandResult: ${t.reason}`,
          ),
        };
      }
      this.opts.audit.appendCanonical({
        command_id: result.command_id,
        ts: this.now().toISOString(),
        channel_of_origin: "endpoint",
        message_type: "CommandResult",
        payload: result,
        endpoint_id: result.endpoint_id,
        session_id: result.session_id,
      });
      // Build ResultEvent for operator
      const op: ResultEvent = {
        type: "ResultEvent",
        request_id: inflight.request_id,
        command_id: result.command_id,
        lifecycle_state: result.lifecycle_state,
        payload: result.lifecycle_state === "completed" ? result.payload : null,
        error: result.lifecycle_state === "failed" ? result.error : null,
        evidence_hash: result.evidence_hash,
        ts: result.ts,
      };
      // Fire-and-forget BR outcome report (terminal lifecycle).
      this.reportToBr(inflight, {
        outcome:
          result.lifecycle_state === "completed" ? "completed" : "failed",
        completed_at: result.ts,
        success: result.lifecycle_state === "completed",
        payload_size_out: estimatePayloadSize(
          result.lifecycle_state === "completed" ? result.payload : null,
        ),
        error_class:
          result.lifecycle_state === "failed" ? result.error.code : undefined,
      });
      // Cleanup
      this.inflight.delete(result.command_id);
      return { kind: "operator_event", frame: op };
    });
  }

  /**
   * Process a reject-before-start ErrorEvent from an endpoint
   * (per F3 fix: endpoint emits ErrorEvent for SIGNATURE_INVALID,
   * NONCE_REPLAY, ENVELOPE_EXPIRED, WRONG_AUDIENCE, etc).
   *
   * Transitions lifecycle dispatched → failed; emits operator-side
   * ErrorEvent.
   */
  handleEndpointError(
    err: ErrorEventEndpointToRelay,
  ): RoutingResult<ErrorEventRelayToOperator> {
    return this.routeEndpointFrame(err, "ErrorEvent", (inflight) => {
      const t = this.opts.lifecycle.transition(err.command_id, {
        kind: "endpoint_error",
      });
      if (!t.ok && t.reason === "late_arrival") {
        // Audit only, no operator event
        this.opts.audit.appendCanonical({
          command_id: err.command_id,
          ts: this.now().toISOString(),
          channel_of_origin: "endpoint",
          message_type: "ErrorEvent",
          payload: err,
          metadata_sidecar: { late_arrival: true },
          endpoint_id: err.endpoint_id,
          session_id: err.session_id,
        });
        return null;
      }
      this.opts.audit.appendCanonical({
        command_id: err.command_id,
        ts: this.now().toISOString(),
        channel_of_origin: "endpoint",
        message_type: "ErrorEvent",
        payload: err,
        endpoint_id: err.endpoint_id,
        session_id: err.session_id,
      });
      const op: ErrorEventRelayToOperator = {
        type: "ErrorEvent",
        request_id: inflight.request_id,
        command_id: err.command_id,
        code: err.code,
        message: err.message,
        ts: err.ts,
      };
      // Fire-and-forget BR outcome report — endpoint-side reject-before-start
      // is a `failed` terminal state from BR's analytics POV.
      this.reportToBr(inflight, {
        outcome: "failed",
        completed_at: err.ts,
        success: false,
        payload_size_out: 0,
        error_class: err.code,
      });
      this.inflight.delete(err.command_id);
      return { kind: "operator_event", frame: op };
    });
  }

  /**
   * Mark a command_id as terminated due to ACK timeout. Called by the
   * ack-timeout manager when its 5s timer fires.
   */
  handleAckTimeout(
    command_id: string,
  ): RoutingResult<ErrorEventRelayToOperator> {
    const inflight = this.inflight.get(command_id);
    if (inflight === undefined) {
      return { kind: "no_inflight" };
    }
    const t = this.opts.lifecycle.transition(command_id, {
      kind: "ack_timeout",
    });
    if (!t.ok) {
      if (t.reason === "late_arrival") {
        return { kind: "no_inflight" }; // already terminal
      }
      return {
        kind: "error",
        target_operator_session_id: inflight.operator_session_id,
        error: this.makeOperatorError(
          inflight.request_id,
          command_id,
          "RELAY_INTERNAL_ERROR",
          `Lifecycle transition failed on ack_timeout: ${t.reason}`,
        ),
      };
    }
    const ackTimeoutTs = this.now().toISOString();
    const op: ErrorEventRelayToOperator = {
      type: "ErrorEvent",
      request_id: inflight.request_id,
      command_id,
      code: "ENDPOINT_NO_ACK",
      message: "Endpoint did not ACK the CommandEnvelope within T_ack_timeout",
      ts: ackTimeoutTs,
    };
    // Fire-and-forget BR outcome report — ack-timeout is the canonical
    // `timed_out` terminal state.
    this.reportToBr(inflight, {
      outcome: "timed_out",
      completed_at: ackTimeoutTs,
      success: false,
      payload_size_out: 0,
      error_class: "ENDPOINT_NO_ACK",
    });
    const target_operator_session_id = inflight.operator_session_id;
    this.inflight.delete(command_id);
    return {
      kind: "operator_event",
      frame: op,
      target_operator_session_id,
    };
  }

  /**
   * Build + fire a BR outcome report. No-op when no reporter configured.
   * Failures are silent (logged inside the reporter); never throws.
   *
   * The agentId we report to is the endpoint_id — that's the agent
   * identity in BR's federation model (per 12xnwqbb's design lock).
   */
  private reportToBr(
    inflight: InflightDispatch,
    args: {
      outcome: DispatchOutcome;
      completed_at: string;
      success: boolean;
      payload_size_out: number;
      error_class?: string;
    },
  ): void {
    const reporter = this.opts.brOutcomeReporter;
    if (reporter === undefined) return;
    const startedAt = inflight.started_at;
    const startedMs = new Date(startedAt).getTime();
    const completedMs = new Date(args.completed_at).getTime();
    const duration_ms = Math.max(
      0,
      Number.isFinite(completedMs - startedMs) ? completedMs - startedMs : 0,
    );
    // Fire-and-forget: do NOT await. The reporter handles its own errors.
    void reporter.report({
      agentId: inflight.endpoint_id,
      correlation_id: inflight.correlation_id,
      outcome: args.outcome,
      started_at: startedAt,
      completed_at: args.completed_at,
      duration_ms,
      success: args.success,
      payload_size_in: inflight.payload_size_in,
      payload_size_out: args.payload_size_out,
      ...(args.error_class !== undefined
        ? { error_class: args.error_class }
        : {}),
    });
  }

  /**
   * Snapshot of in-flight count (for observability + tests).
   */
  inflightCount(): number {
    return this.inflight.size;
  }

  // --- internals ------------------------------------------------------------

  private routeEndpointFrame<F>(
    frame: { command_id: string; endpoint_id: string; session_id: string },
    _frame_kind: string,
    inner: (inflight: InflightDispatch) => RoutingInner<F>,
  ): RoutingResult<F> {
    const inflight = this.inflight.get(frame.command_id);
    if (inflight === undefined) {
      return { kind: "no_inflight" };
    }
    // Stale-session check — incoming frame's session_id must be the
    // currently-active session for the endpoint.
    if (
      !this.opts.sessions.isCurrentSession(frame.endpoint_id, frame.session_id)
    ) {
      return {
        kind: "error",
        target_operator_session_id: inflight.operator_session_id,
        error: this.makeOperatorError(
          inflight.request_id,
          frame.command_id,
          "ENDPOINT_SESSION_STALE",
          "Frame arrived from a stale endpoint session",
        ),
      };
    }
    // Endpoint identity binding (F13): frame's endpoint_id must match
    // what we dispatched to.
    if (frame.endpoint_id !== inflight.endpoint_id) {
      return {
        kind: "error",
        target_operator_session_id: inflight.operator_session_id,
        error: this.makeOperatorError(
          inflight.request_id,
          frame.command_id,
          "RELAY_ENDPOINT_MISMATCH",
          `Frame endpoint_id ${frame.endpoint_id} does not match dispatched endpoint ${inflight.endpoint_id}`,
        ),
      };
    }
    const result = inner(inflight);
    if (result === null) {
      return { kind: "ack_only" }; // late_arrival or progress without state change
    }
    if (result.kind === "operator_event") {
      return {
        kind: "operator_event",
        frame: result.frame,
        target_operator_session_id: inflight.operator_session_id,
      };
    }
    // result.kind === "error"
    return {
      kind: "error",
      error: result.error,
      target_operator_session_id: inflight.operator_session_id,
    };
  }

  private makeOperatorError(
    request_id: string,
    command_id: string | null,
    code: string,
    message: string,
  ): ErrorEventRelayToOperator {
    return {
      type: "ErrorEvent",
      request_id,
      command_id,
      code,
      message,
      ts: this.now().toISOString(),
    };
  }
}

// ---------------------------------------------------------------------------

type RoutingInner<F> =
  | { kind: "operator_event"; frame: F }
  | { kind: "error"; error: ErrorEventRelayToOperator }
  | null;

/**
 * Best-effort byte-size estimate of a payload object for BR's
 * `payload_size_out` metric. JSON-stringified UTF-8 length. Returns 0 for
 * null/undefined (the spec uses 0 to mean "no payload"). Catches stringify
 * failures (e.g. circular refs) and returns 0 + logs would happen at the
 * caller's logger if surfaced, but here we silently fall back since this
 * metric is non-critical.
 */
function estimatePayloadSize(p: unknown): number {
  if (p === null || p === undefined) return 0;
  try {
    return Buffer.byteLength(JSON.stringify(p), "utf-8");
  } catch {
    return 0;
  }
}

export type RoutingResult<F> =
  | {
      kind: "operator_event";
      frame: F;
      /** Target operator session — caller looks up in SessionStore + sends to its transport. */
      target_operator_session_id: string;
    }
  | {
      kind: "error";
      error: ErrorEventRelayToOperator;
      /** Target operator session — caller looks up in SessionStore + sends to its transport. */
      target_operator_session_id: string;
    }
  | { kind: "no_inflight" }
  | { kind: "ack_only" };
