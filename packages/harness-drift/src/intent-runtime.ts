import { createHash, randomUUID } from "node:crypto";
import type {
  ChangeSet,
  ChangeSetResult,
  ChangeSetSimulation,
  Drift,
  DriftDetector,
  DriftSeverity,
} from "./types.js";

/**
 * Generic intent ↔ runtime drift detector — compares a value declared in
 * the harness ("intent") against an observed value from a runtime system
 * (Stripe, BrainstormMSP, Carta, etc.).
 *
 * Concrete subclasses provide:
 *   - intent loader: reads the intent value from the harness file
 *   - runtime loader: queries the runtime system
 *   - field path: the dotted field name in the source artifact
 *
 * Per Decision #9 revised: this detector emits `field_class = "intent"`
 * (file authoritative). The user-facing panel surfaces a "Runtime needs
 * update" action; the user does NOT see "apply to file" as an option for
 * intent-class drifts (that's the muscle-memory failure mode Round 1
 * Attack #4 attacked).
 */
export interface IntentRuntimeFieldSpec<T = string> {
  detector_name: string;
  relative_path: string;
  field_path: string;
  /** Severity to apply when drift is detected. */
  severity: DriftSeverity;
  /** Resolve the intent value from the artifact. May read the file or use
   *  pre-parsed content provided by the caller. */
  loadIntent(): Promise<T | null> | T | null;
  /** Query the runtime system for the observed value. */
  loadObserved(): Promise<T | null> | T | null;
  /** Stringify a value for storage + display. Defaults to JSON.stringify. */
  serialize?(value: T | null): string | null;
  /** Equality check; defaults to deep equality via JSON. */
  equal?(a: T | null, b: T | null): boolean;
}

export class IntentRuntimeDriftDetector<T = string> implements DriftDetector {
  readonly name: string;
  readonly field_class = "intent" as const;

  constructor(private readonly spec: IntentRuntimeFieldSpec<T>) {
    this.name = spec.detector_name;
  }

  async detect(): Promise<Drift[]> {
    const intent = await Promise.resolve(this.spec.loadIntent());
    const observed = await Promise.resolve(this.spec.loadObserved());

    const equal = this.spec.equal ?? defaultEqual;
    if (equal(intent, observed)) return [];

    const serialize = this.spec.serialize ?? defaultSerialize;

    return [
      {
        id: stableDriftId(
          this.spec.detector_name,
          this.spec.relative_path,
          this.spec.field_path,
        ),
        field_class: "intent",
        relative_path: this.spec.relative_path,
        field_path: this.spec.field_path,
        intent_value: serialize(intent),
        observed_value: serialize(observed),
        detector_name: this.name,
        detected_at: Date.now(),
        severity: this.spec.severity,
      },
    ];
  }
}

/**
 * ChangeSet that applies an intent-class drift by writing the intent
 * value to the runtime system. The actual write call is provided as a
 * callback because every runtime has its own API (Stripe SDK, MSP REST,
 * Carta GraphQL, etc.).
 */
export interface ApplyIntentToRuntimeOptions<T = string> {
  drift: Drift;
  actor_ref: string;
  intent_value: T | null;
  apply: (value: T | null) => Promise<void> | void;
  /** Optional inverse — if the runtime supports rollback. */
  revert?: (priorValue: T | null) => Promise<void> | void;
  prior_observed_value?: T | null;
}

export class ApplyIntentToRuntimeChangeSet<T = string> implements ChangeSet {
  readonly id = randomUUID();
  readonly kind = "apply-intent-to-runtime" as const;
  readonly state: "proposed" | "applied" | "reverted" | "expired" = "proposed";
  readonly drift: Drift;
  readonly actor_ref: string;
  readonly created_at = Date.now();
  readonly payload: Record<string, unknown>;

  constructor(private readonly opts: ApplyIntentToRuntimeOptions<T>) {
    this.drift = opts.drift;
    this.actor_ref = opts.actor_ref;
    this.payload = {
      relative_path: opts.drift.relative_path,
      field_path: opts.drift.field_path,
      intent_value: opts.drift.intent_value,
      observed_value: opts.drift.observed_value,
    };
  }

  simulate(): ChangeSetSimulation {
    return {
      description: `Apply ${this.drift.field_path}=${this.drift.intent_value} to runtime (was ${this.drift.observed_value})`,
      diffs: [
        {
          target: this.drift.relative_path,
          field: this.drift.field_path,
          from: this.drift.observed_value,
          to: this.drift.intent_value,
        },
      ],
      reversible: !!this.opts.revert,
    };
  }

  async apply(): Promise<ChangeSetResult> {
    try {
      await Promise.resolve(this.opts.apply(this.opts.intent_value));
      return {
        ok: true,
        effects: [
          {
            target: this.drift.relative_path,
            description: `runtime updated to match intent`,
          },
        ],
      };
    } catch (e) {
      return {
        ok: false,
        message: e instanceof Error ? e.message : String(e),
      };
    }
  }

  async revert(): Promise<ChangeSetResult> {
    if (!this.opts.revert) {
      return {
        ok: false,
        message: "Runtime does not support revert for this field.",
      };
    }
    try {
      await Promise.resolve(
        this.opts.revert(this.opts.prior_observed_value ?? null),
      );
      return {
        ok: true,
        effects: [
          {
            target: this.drift.relative_path,
            description: "runtime reverted to prior observed value",
          },
        ],
      };
    } catch (e) {
      return {
        ok: false,
        message: e instanceof Error ? e.message : String(e),
      };
    }
  }
}

function defaultSerialize<T>(value: T | null): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") return value;
  return JSON.stringify(value);
}

function defaultEqual<T>(a: T | null, b: T | null): boolean {
  if (a === null && b === null) return true;
  if (a === null || b === null) return false;
  if (a === b) return true;
  return JSON.stringify(a) === JSON.stringify(b);
}

function stableDriftId(...parts: string[]): string {
  return (
    "drift_" +
    createHash("sha256").update(parts.join("|")).digest("hex").slice(0, 16)
  );
}
