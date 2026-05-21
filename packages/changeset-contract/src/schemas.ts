/**
 * ChangeSet Contract v2 — Zod schemas for runtime validation.
 *
 * Mirror the TypeScript types in `./types.ts`. Use these for:
 *  - Validating ChangeSets received over IPC or HTTP at trust boundaries
 *  - Validating federation events before PutEvents
 *  - Schema-based form generation in the renderer
 *  - Test fixtures
 */

import { z } from "zod";

export const ChangeSetStatusSchema = z.enum([
  "draft",
  "approved",
  "executed",
  "failed",
  "rolled_back",
  "rejected",
  "expired",
]);

export const ReversibilitySchema = z.enum([
  "instant",
  "manual",
  "irreversible",
]);

export const DataClassSchema = z.enum([
  "pii",
  "financial",
  "config",
  "content",
  "credentials",
  "audit-log",
]);

export const ChangeSchema = z.object({
  system: z.string().min(1),
  entity: z.string().min(1),
  operation: z.enum(["create", "update", "delete", "execute"]),
  before: z.unknown().optional(),
  after: z.unknown().optional(),
});

export const BlastRadiusSchema = z.object({
  // Code-structural — REQUIRED for backward compat with godmode
  affectedSymbols: z.array(
    z.object({
      name: z.string(),
      file: z.string(),
      depth: z.number().int().nonnegative(),
    }),
  ),
  affectedCommunities: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      tier: z.string(),
    }),
  ),
  riskMultiplier: z.number().positive(),
  totalAffected: z.number().int().nonnegative(),

  // Operational — OPTIONAL v2 additions
  entitiesAffected: z.number().int().nonnegative().optional(),
  productsTouched: z.array(z.string()).optional(),
  tenantsTouched: z.array(z.string()).optional(),
  dataClasses: z.array(DataClassSchema).optional(),
  reversibility: ReversibilitySchema.optional(),
});

export const CostEstimateSchema = z.object({
  usd: z.number().nonnegative(),
  breakdown: z.record(z.string(), z.number().nonnegative()),
});

export const SimulationResultSchema = z.object({
  success: z.boolean(),
  statePreview: z.unknown(),
  cascades: z.array(z.string()),
  constraints: z.array(z.string()),
  estimatedDuration: z.string(),
  blastRadius: BlastRadiusSchema.optional(),
  costEstimate: CostEstimateSchema.optional(),
});

export const ChangeSetSchema = z.object({
  id: z.string().min(1),
  tenantId: z.string().min(1, "tenantId is required on every ChangeSet"),
  connector: z.string().min(1),
  action: z.string().min(1),
  description: z.string(),
  status: ChangeSetStatusSchema,
  riskScore: z.number().min(0).max(100),
  riskFactors: z.array(z.string()),
  changes: z.array(ChangeSchema),
  simulation: SimulationResultSchema,
  rollbackData: z.unknown().optional(),
  createdAt: z.number().int().nonnegative(),
  expiresAt: z.number().int().nonnegative(),
  executedAt: z.number().int().nonnegative().optional(),
  terminalAt: z.number().int().nonnegative().optional(),
  approvedBy: z.enum(["user", "auto"]).optional(),
  correlationId: z.string().optional(),
  traceId: z.string().optional(),
});

export const CreateChangeSetInputSchema = z.object({
  tenantId: z.string().min(1, "tenantId is required to create a ChangeSet"),
  connector: z.string().min(1),
  action: z.string().min(1),
  description: z.string(),
  changes: z.array(ChangeSchema),
  simulation: SimulationResultSchema,
  correlationId: z.string().optional(),
  traceId: z.string().optional(),
});

export const ChangeSetLifecycleEventSchema = z.object({
  tenantId: z.string().min(1),
  ts: z.number().int().nonnegative(),
  changesetId: z.string().min(1),
  payload: z.object({
    product: z.string().min(1),
    tool: z.string().min(1),
    state: ChangeSetStatusSchema,
    blastRadius: BlastRadiusSchema.optional(),
    approver: z.string().optional(),
    executionResult: z.unknown().optional(),
    error: z.string().optional(),
  }),
  correlationId: z.string().optional(),
  traceId: z.string().optional(),
});
