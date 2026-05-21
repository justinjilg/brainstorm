/**
 * ChangeSet Contract v2 — types.
 *
 * The wire/cross-package type definitions for Brainstorm's mutation-gating
 * safety layer. Every mutation across the harness (MSP, BR, VM, GTM, Ops,
 * brainstorm desktop itself) flows through a ChangeSet that conforms to
 * these types. The runtime engine (in @brainst0rm/godmode) implements
 * the lifecycle; the renderer (in apps/desktop) renders the preview;
 * product services publish ChangeSet lifecycle events to the federation
 * bus per these shapes.
 *
 * Changes from v1 (which lived in @brainst0rm/godmode/src/types.ts):
 *   - `tenant_id` is now a REQUIRED field on every ChangeSet (was implicit)
 *   - `dataClasses` added to BlastRadius for sensitivity tagging
 *   - `costEstimate` standardized as { usd, breakdown }
 *   - `reversibility` typed as enum (instant | manual | irreversible)
 *   - `correlation_id` for cross-product workflows
 */

/** Lifecycle states a ChangeSet may transition through. */
export type ChangeSetStatus =
  | "draft"
  | "approved"
  | "executed"
  | "failed"
  | "rolled_back"
  | "rejected"
  | "expired";

/** Reversibility class — used for risk presentation in the renderer. */
export type Reversibility = "instant" | "manual" | "irreversible";

/** Data sensitivity classes touched by a change. */
export type DataClass =
  | "pii"
  | "financial"
  | "config"
  | "content"
  | "credentials"
  | "audit-log";

/**
 * The atomic unit of mutation within a ChangeSet — one row, one file,
 * one resource, one entity transition.
 */
export interface Change {
  /** Which product/system owns the entity being mutated. */
  system: string;
  /** Stable identifier for the entity. Examples:
   *  "device:john-laptop", "user:todd@example.com", "vm:i-0abc123". */
  entity: string;
  /** Type of mutation. */
  operation: "create" | "update" | "delete" | "execute";
  /** Current state, if knowable. */
  before?: unknown;
  /** Projected state after the change. */
  after?: unknown;
}

/**
 * Result of simulating a ChangeSet — what *would* happen if executed.
 * Renderer uses this to populate the operator's preview UI.
 */
export interface SimulationResult {
  success: boolean;
  /** Human-readable preview of the post-execution state. */
  statePreview: unknown;
  /** Downstream effects that would propagate from this change. */
  cascades: string[];
  /** Things that would block execution (e.g. "VM is in use", "tenant over quota"). */
  constraints: string[];
  /** Rough wall-clock estimate, in operator-readable form. */
  estimatedDuration: string;
  /** Detailed impact analysis. */
  blastRadius?: BlastRadius;
  /** Projected cost. */
  costEstimate?: CostEstimate;
}

/**
 * Detailed impact analysis. Computed by either:
 *  - The brainstorm code-graph (for code-structural blast: symbols + communities)
 *  - The `harness-session-blast-radius` subagent or product's God Mode tool
 *    (for operational blast: entities + tenants + data classes)
 *
 * Both dimensions can be present on the same BlastRadius. The renderer
 * surfaces whichever fields are populated.
 *
 * Code-structural fields are REQUIRED for backward compatibility with the
 * existing godmode blast-radius computation. Operational fields are
 * OPTIONAL but should be set on every cross-product ChangeSet going forward.
 */
export interface BlastRadius {
  // ── Code-structural (legacy godmode shape — REQUIRED) ────────────
  /** Functions/methods directly or transitively affected. */
  affectedSymbols: Array<{ name: string; file: string; depth: number }>;
  /** Community sectors affected by this change. */
  affectedCommunities: Array<{ id: string; name: string; tier: string }>;
  /** Risk multiplier — higher if critical sectors are affected. */
  riskMultiplier: number;
  /** Total number of affected symbols. */
  totalAffected: number;

  // ── Operational (v2 additions — OPTIONAL, populate going forward) ─
  /** Number of distinct entities affected. */
  entitiesAffected?: number;
  /** Products whose state will change. */
  productsTouched?: string[];
  /** Tenants whose state will change (almost always one — multi-tenant ops are exceptional). */
  tenantsTouched?: string[];
  /** Sensitivity classes touched. */
  dataClasses?: DataClass[];
  /** How undoable this is. */
  reversibility?: Reversibility;
}

/**
 * Cost preview. Sum of upstream LLM, AWS, third-party API, and infra
 * costs that executing this ChangeSet would incur, in USD.
 */
export interface CostEstimate {
  /** Total estimated cost in USD. */
  usd: number;
  /** Line-item breakdown by SKU (e.g. { "llm-anthropic-opus-4-7-input": 0.0042, "aws-ec2-c5xlarge-hour": 0.17 }). */
  breakdown: Record<string, number>;
}

/**
 * The canonical ChangeSet shape. Every mutation across the harness
 * conforms to this. Federation-aware via `tenantId` and optional
 * `correlationId`/`traceId`.
 *
 * Field naming uses camelCase per TypeScript convention; EventBridge
 * Detail payloads use the same camelCase shape (no snake_case
 * conversion at the wire layer — see @brainst0rm/event-bus envelope).
 */
export interface ChangeSet {
  /** Stable identifier, set at creation. UUID or short hash. */
  id: string;
  /** Tenant scope. REQUIRED — every ChangeSet is bound to exactly one tenant. */
  tenantId: string;
  /** Which connector / product created this. */
  connector: string;
  /** Tool name that produced the ChangeSet. */
  action: string;
  /** Human-readable summary, operator-facing. */
  description: string;
  /** Current lifecycle state. */
  status: ChangeSetStatus;
  /** 0–100, auto-calculated from changes + blast radius. */
  riskScore: number;
  /** Human-readable risk factors (e.g. "irreversible", "PII deletion", "production environment"). */
  riskFactors: string[];
  /** Atomic mutations this ChangeSet performs. */
  changes: Change[];
  /** Pre-execution simulation. */
  simulation: SimulationResult;
  /** Opaque payload the connector can use to undo. Engine doesn't interpret it. */
  rollbackData?: unknown;
  /** Unix ms at creation. */
  createdAt: number;
  /** Unix ms — drafts expire after this. */
  expiresAt: number;
  /** Unix ms — set on transition to executed. */
  executedAt?: number;
  /** Unix ms — set on transition to any terminal state (executed/failed/expired/rejected). */
  terminalAt?: number;
  /** Who/what approved the execution. */
  approvedBy?: "user" | "auto";
  /** OPTIONAL — for tracking cross-product workflows (Step Functions, multi-step ChangeSet sequences). */
  correlationId?: string;
  /** OPTIONAL — OTEL trace id, for distributed-trace correlation. */
  traceId?: string;
}

/**
 * Input shape for createChangeSet — the strict subset of fields a
 * connector must provide. The engine fills in id, status, timestamps,
 * riskScore, riskFactors.
 */
export interface CreateChangeSetInput {
  /** REQUIRED — tenant scope. */
  tenantId: string;
  /** Connector name. */
  connector: string;
  /** Tool/action name. */
  action: string;
  /** Operator-facing summary. */
  description: string;
  /** Atomic mutations. */
  changes: Change[];
  /** Pre-execution simulation. */
  simulation: SimulationResult;
  /** OPTIONAL — for workflow correlation. */
  correlationId?: string;
  /** OPTIONAL — OTEL trace id. */
  traceId?: string;
}

/**
 * EventBridge Detail envelope for ChangeSet lifecycle events.
 * Aligned with the schema in `terraform/modules/eventbridge-bus`
 * (`brainstorm.events.changeset.<state>`).
 *
 * Publishers wrap this with PutEvents:
 *   {
 *     Source: "brainstorm.<product>",
 *     DetailType: "changeset.<state>",
 *     Detail: JSON.stringify(<ChangeSetLifecycleEvent>),
 *     EventBusName: "brainstorm.events",
 *   }
 */
export interface ChangeSetLifecycleEvent {
  /** REQUIRED — propagated from the ChangeSet. */
  tenantId: string;
  /** Unix ms — when this state transition happened. */
  ts: number;
  /** REQUIRED — references the ChangeSet this event is about. */
  changesetId: string;
  /** The kind-specific payload. */
  payload: {
    /** Product that owns the resource being changed. */
    product: string;
    /** God-mode tool id that produced the ChangeSet. */
    tool: string;
    /** State the ChangeSet entered. */
    state: ChangeSetStatus;
    /** For "simulated" events. */
    blastRadius?: BlastRadius;
    /** For "approved" events. */
    approver?: string;
    /** For "executed" / "failed" events. */
    executionResult?: unknown;
    error?: string;
  };
  /** OPTIONAL — for cross-product workflows. */
  correlationId?: string;
  /** OPTIONAL — OTEL trace id. */
  traceId?: string;
}
