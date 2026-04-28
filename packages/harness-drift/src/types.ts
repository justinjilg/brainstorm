/**
 * Drift detection + ChangeSet primitives.
 *
 * Per Decision #9 (revised after Round 2 Attack #12): the spec retains a
 * single implementation primitive (`DriftDetector` library) but splits the
 * user-facing surface into FOUR typed drift classes with distinct UIs and
 * reconciliation semantics. This module defines the contracts; concrete
 * detectors implement them in adjacent files.
 *
 * | field_class    | Authority                            | UI surface                                        |
 * | -------------- | ------------------------------------ | ------------------------------------------------- |
 * | "intent"       | File is authoritative                | "Runtime needs update" panel                       |
 * | "observation"  | Runtime is authoritative             | Background reconciliation; never blocks user      |
 * | "bilateral"    | Either side; reconcile via human     | Two-column diff with explicit choice              |
 * | "index"        | Internal correctness primitive       | Never surfaces in user-facing panels (silent fix) |
 */

export type FieldClass = "intent" | "observation" | "bilateral" | "index";

/** Severity surfaced to the user (intent/bilateral classes only). */
export type DriftSeverity =
  | "informational"
  | "low"
  | "medium"
  | "high"
  | "critical"
  | "incident-required";

/** A detected drift instance. Identity is `id`; same drift across runs of
 *  the same detector should produce the same id (idempotent re-detection). */
export interface Drift {
  id: string;
  field_class: FieldClass;
  /** Path to the artifact this drift is *about* (relative to harness root). */
  relative_path: string;
  /** Dotted field path inside the artifact, e.g. "mrr_intent" or "*". */
  field_path: string;
  /** What the canonical side says. NULL when not applicable (e.g. file
   *  missing for observation-class). */
  intent_value: string | null;
  /** What the observed side says. */
  observed_value: string | null;
  /** Detector that produced this drift. */
  detector_name: string;
  detected_at: number;
  severity: DriftSeverity;
}

/** A detector — produces a list of current drifts for one slice of the
 *  harness. Multiple detectors can run in parallel; results are unioned. */
export interface DriftDetector {
  /** Unique identifier; written to drift records. */
  readonly name: string;
  /** Which field_class this detector emits. */
  readonly field_class: FieldClass;
  /** Run the detector once. Implementations should be deterministic w.r.t.
   *  the harness state at call time so the same drift produces the same id. */
  detect(): Promise<Drift[]> | Drift[];
}

/** Categorical intent of a ChangeSet — drives the desktop UI variant. */
export type ChangeSetKind =
  | "rebuild-index-entry" // index-class: silent
  | "apply-intent-to-runtime" // intent-class: file → runtime
  | "refresh-observation-from-runtime" // observation-class: runtime → file
  | "human-reconcile-bilateral" // bilateral: human picks
  | "incident"; // bilateral with high severity

export type ChangeSetState = "proposed" | "applied" | "reverted" | "expired";

/** A proposed reconciliation. simulate() must be safe to call; apply()
 *  is the side-effecting action; revert() undoes apply when possible. */
export interface ChangeSet {
  readonly id: string;
  readonly kind: ChangeSetKind;
  readonly state: ChangeSetState;
  readonly drift: Drift;
  readonly actor_ref: string;
  readonly created_at: number;
  readonly applied_at?: number;
  readonly reverted_at?: number;

  /** Free-form payload the apply() routine reads. Persisted as JSON. */
  readonly payload: Record<string, unknown>;

  /** Describe what apply() would do. Pure; safe to call repeatedly. */
  simulate(): Promise<ChangeSetSimulation> | ChangeSetSimulation;

  /** Side-effect: perform the change. Implementations must be idempotent
   *  where possible. */
  apply(): Promise<ChangeSetResult> | ChangeSetResult;

  /** Best-effort revert. Some changes (calls to external systems) may not
   *  be reversible. Implementations return ok=false in that case. */
  revert(): Promise<ChangeSetResult> | ChangeSetResult;
}

export interface ChangeSetSimulation {
  /** Human-readable describing what apply() would do. */
  description: string;
  /** Concrete fields that would change. */
  diffs: Array<{
    target: string;
    field: string;
    from: string | null;
    to: string | null;
  }>;
  /** Whether revert() is supported for this ChangeSet. */
  reversible: boolean;
  /** Estimated cost (dollars) if any external API is called. */
  estimated_cost_usd?: number;
}

export interface ChangeSetResult {
  ok: boolean;
  message?: string;
  /** Side effects applied; surfaced to the audit log. */
  effects?: Array<{ target: string; description: string }>;
}
