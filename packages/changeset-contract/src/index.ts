/**
 * @brainst0rm/changeset-contract
 *
 * Cross-package + cross-product type definitions for Brainstorm's
 * mutation-gating safety layer (ChangeSets). Federation-aware.
 *
 * Imported by:
 *  - @brainst0rm/godmode — the runtime engine that creates, simulates, and
 *    executes ChangeSets
 *  - apps/desktop — the renderer that displays the operator-facing preview
 *  - Product services (when they publish ChangeSet lifecycle events to
 *    the EventBridge federation bus)
 *
 * Authored as PR 5 of the Business Harness Opus project.
 * See `.claude/notes/business-harness-opus-plan-2026-05-20.md` for context.
 */

export type {
  Change,
  ChangeSet,
  ChangeSetLifecycleEvent,
  ChangeSetStatus,
  CostEstimate,
  CreateChangeSetInput,
  DataClass,
  Reversibility,
  BlastRadius,
  SimulationResult,
} from "./types.js";

export {
  BlastRadiusSchema,
  ChangeSchema,
  ChangeSetLifecycleEventSchema,
  ChangeSetSchema,
  ChangeSetStatusSchema,
  CostEstimateSchema,
  CreateChangeSetInputSchema,
  DataClassSchema,
  ReversibilitySchema,
  SimulationResultSchema,
} from "./schemas.js";
