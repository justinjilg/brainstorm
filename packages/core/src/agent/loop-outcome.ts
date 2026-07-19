/**
 * Pure construction of the aggregate {@link RunOutcome} from a turn's parts.
 *
 * This is the first strangler seam pulled out of the ~2000-line `runAgentLoop`:
 * the outcome-aggregation logic that stitches per-attempt outcomes, the ordered
 * recovery sequence, and the run-level status/cost into the two-level contract.
 * It was the site of Codex finding #8 (attempts ordering + synthesis
 * double-count) — exactly the kind of bug-prone data transformation that
 * benefits from being a pure, directly unit-testable function instead of inline
 * loop state. The loop keeps the side effects (momentum recording, `done`
 * emission); this only builds the value.
 */

import type {
  ModelAttemptOutcome,
  RunOutcome,
  StopCause,
} from "@brainst0rm/shared";

type RecoveryAction = NonNullable<RunOutcome["recovery"]>[number];

export interface BuildRunOutcomeInput {
  /** Failed/superseded attempts carried in from upstream fallback/nudge/verify
   *  recursions, in the order they happened. */
  upstreamAttempts: ModelAttemptOutcome[];
  /** This terminal turn's main model attempt. */
  thisAttempt: ModelAttemptOutcome;
  /** The forced-synthesis attempt, if this turn synthesized (a distinct model
   *  invocation appended after the main attempt). */
  synthAttempt: ModelAttemptOutcome | null;
  /** Recovery actions already taken upstream, in order. */
  upstreamRecovery: RecoveryAction[];
  /** Whether THIS terminal turn ran forced synthesis. */
  didSynthesize: boolean;
  /** Whether this turn's accepted result is a success. */
  turnSuccess: boolean;
  /** The model that produced this turn's result (credited only on success). */
  finalModelId: string;
  /** This turn's own classified stop cause — the fallback when there are no
   *  upstream attempts to source the FIRST cause from. */
  initialStopCause: StopCause;
  hasFinalResponse: boolean;
  madeChanges: boolean;
  /** Run-level cost DELTA (not the cumulative session total), pre-computed by
   *  the caller against the run baseline. */
  costUsd: number;
}

/**
 * Build the aggregate run outcome. Ordering rules (each guards a fixed #8-class
 * bug):
 * - `attempts` = upstream attempts, then this turn's main call, then the
 *   synthesis call if it ran — every model invocation appears, in order.
 * - `recovery` = upstream actions, then `forced_synthesis` if this turn
 *   synthesized — preserves e.g. `["fallback","forced_synthesis"]` rather than a
 *   single tag that erased the fallback. Absent when empty (clean run).
 * - `initialStopCause` = the FIRST attempt's cause (upstream if this is a
 *   fallback re-entry), so a recovered run doesn't masquerade as a clean stop.
 * - `finalModelId` set only on success.
 */
export function buildRunOutcome(input: BuildRunOutcomeInput): RunOutcome {
  const allAttempts = [
    ...input.upstreamAttempts,
    input.thisAttempt,
    ...(input.synthAttempt ? [input.synthAttempt] : []),
  ];

  const recoverySeq: RecoveryAction[] = [
    ...input.upstreamRecovery,
    ...(input.didSynthesize ? (["forced_synthesis"] as const) : []),
  ];

  return {
    status: input.turnSuccess ? "succeeded" : "failed",
    attempts: allAttempts,
    finalModelId: input.turnSuccess ? input.finalModelId : undefined,
    initialStopCause: allAttempts[0]?.stopCause ?? input.initialStopCause,
    recovery: recoverySeq.length > 0 ? recoverySeq : undefined,
    hasFinalResponse: input.hasFinalResponse,
    madeChanges: input.madeChanges,
    // verification/security/judge are left not_run here; wiring their live
    // results into the outcome is a follow-on (the contract + termination /
    // recovery / cost are what this seam owns).
    verification: "not_run",
    security: "not_run",
    judge: "not_run",
    costUsd: input.costUsd,
  };
}
