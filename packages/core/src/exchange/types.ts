/**
 * The Exchange primitive — "models talking to models" made first-class.
 *
 * An Exchange is a persisted, streamable deliberation: N diverse participant
 * models propose, critique each other, and reconcile (vote / judge / owner) into
 * an adoptable resolution. It reuses the ensemble selection logic
 * (`agent/ensemble.ts`) and the critique pattern (`agent/self-review.ts`); the
 * only new machinery is the round structure and the streamed event spine.
 *
 * The model call is INJECTED ({@link ExchangeGenerate}) so the controller is
 * unit-testable with a fake generator; the IPC layer wires the real router/
 * provider path. Events are the shared `exchange.*` taxonomy so they flow on the
 * organism bus and light up Council with no adapter.
 */
import type { ExchangeEvent } from "@brainst0rm/shared";

export type { ExchangeEvent };

export interface ExchangeParticipant {
  /** Model id the router/provider understands. */
  model: string;
  provider?: string;
}

export type ExchangeRound = "propose" | "critique" | "reconcile";
export type ReconcilerKind = "vote" | "judge" | "owner";

export interface ExchangeSpec {
  /** The question the council deliberates. */
  prompt: string;
  /** Two or more participants — diversity is the point. */
  participants: ExchangeParticipant[];
  /** Which rounds to run; defaults to the full propose→critique→reconcile. */
  rounds?: ExchangeRound[];
  /** How the resolution is chosen. Default "vote". */
  reconciler?: ReconcilerKind;
  /** Optional per-exchange cost ceiling (USD); the controller stops early if hit. */
  budgetCap?: number;
  /** Stable id; generated if omitted. */
  exchangeId?: string;
}

/** One participant's completion for a round. Injected so the core stays testable. */
export type ExchangeGenerate = (args: {
  model: string;
  /** System framing for the round. */
  system: string;
  /** The user turn for this participant. */
  prompt: string;
  signal?: AbortSignal;
}) => Promise<{ text: string; cost?: number }>;

export interface ExchangeProposal {
  model: string;
  provider?: string;
  text: string;
  cost: number;
}

export interface ExchangeResult {
  exchangeId: string;
  resolution: string;
  method: ReconcilerKind;
  proposals: ExchangeProposal[];
  totalCost: number;
  aborted: boolean;
}
