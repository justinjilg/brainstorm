/**
 * ChangeSet Engine — safety layer for God Mode.
 *
 * Every destructive God Mode action produces a ChangeSet before executing.
 * The ChangeSet contains a simulation of what will happen, a risk score,
 * and rollback data. The user approves before execution.
 *
 * Adapted from EventFlow's proven pattern:
 * Intent → Simulation → Diff → Control → Execution
 *
 * The engine also provides three tools that the LLM uses:
 * - gm_changeset_list: show pending changesets
 * - gm_changeset_approve: approve + execute
 * - gm_changeset_reject: reject a draft
 */

import { randomUUID } from "node:crypto";
import { defineTool, type BrainstormToolDef } from "@brainst0rm/tools";
import { z } from "zod";
import { logChangeSet } from "./audit.js";
import type {
  ChangeSet,
  ChangeSetStatus,
  Change,
  SimulationResult,
} from "./types.js";

/** Draft TTL: 5 minutes. */
const DRAFT_TTL_MS = 5 * 60 * 1000;

/** In-memory store of active changesets (keyed by ID). */
const changesets = new Map<string, ChangeSet>();

/** Callbacks registered by connectors to execute approved changesets. */
const executors = new Map<
  string,
  (
    changeset: ChangeSet,
  ) => Promise<{ success: boolean; message: string; rollbackData?: unknown }>
>();

// ── ChangeSet CRUD ───────────────────────────────────────────────

export interface CreateChangeSetInput {
  connector: string;
  action: string;
  description: string;
  changes: Change[];
  simulation: SimulationResult;
}

/**
 * Create a ChangeSet draft from a connector's simulation.
 * Returns the draft for the LLM to present to the user.
 */
export function createChangeSet(input: CreateChangeSetInput): ChangeSet {
  // Expire stale drafts first
  expireStale();

  const riskScore = calculateRiskScore(
    input.changes,
    input.simulation,
    input.connector,
  );
  const riskFactors = identifyRiskFactors(
    input.changes,
    input.simulation,
    input.connector,
  );

  const changeset: ChangeSet = {
    id: randomUUID().slice(0, 8),
    connector: input.connector,
    action: input.action,
    description: input.description,
    status: "draft",
    riskScore,
    riskFactors,
    changes: input.changes,
    simulation: input.simulation,
    createdAt: Date.now(),
    expiresAt: Date.now() + DRAFT_TTL_MS,
  };

  changesets.set(changeset.id, changeset);
  return changeset;
}

/**
 * Approve and execute a ChangeSet.
 * Returns the execution result.
 */
export async function approveChangeSet(
  id: string,
  approvedBy: "user" | "auto" = "user",
): Promise<{ success: boolean; message: string; changeset: ChangeSet }> {
  const cs = changesets.get(id);
  if (!cs)
    return {
      success: false,
      message: `ChangeSet ${id} not found`,
      changeset: null as any,
    };
  if (cs.status !== "draft")
    return {
      success: false,
      message: `ChangeSet ${id} is ${cs.status}, not draft`,
      changeset: cs,
    };
  if (Date.now() > cs.expiresAt) {
    cs.status = "expired";
    return {
      success: false,
      message: `ChangeSet ${id} expired`,
      changeset: cs,
    };
  }

  cs.status = "approved";
  cs.approvedBy = approvedBy;

  // Execute via the registered executor
  const executor = executors.get(cs.action);
  if (!executor) {
    return {
      success: false,
      message: `No executor registered for ${cs.action}`,
      changeset: cs,
    };
  }

  try {
    const result = await executor(cs);
    if (result.success) {
      cs.status = "executed";
      cs.executedAt = Date.now();
      cs.rollbackData = result.rollbackData;
    } else {
      // Execution returned failure — mark as failed, not executed
      cs.status = "draft"; // Keep retryable
    }
    // Always audit both success and failure
    logChangeSet(cs);
    return { success: result.success, message: result.message, changeset: cs };
  } catch (error) {
    cs.status = "draft"; // revert to draft on failure
    logChangeSet(cs); // Audit the failure
    const msg = error instanceof Error ? error.message : String(error);
    return {
      success: false,
      message: `Execution failed: ${msg}`,
      changeset: cs,
    };
  }
}

/**
 * Reject a ChangeSet draft.
 */
export function rejectChangeSet(id: string): {
  success: boolean;
  message: string;
} {
  const cs = changesets.get(id);
  if (!cs) return { success: false, message: `ChangeSet ${id} not found` };
  cs.status = "rejected";
  return { success: true, message: `ChangeSet ${id} rejected` };
}

/**
 * List all active changesets (non-expired, non-rejected).
 */
export function listChangeSets(): ChangeSet[] {
  expireStale();
  return Array.from(changesets.values()).filter(
    (cs) => cs.status !== "expired" && cs.status !== "rejected",
  );
}

/**
 * Register an executor for a specific tool/action.
 * Called by connectors during setup.
 */
export function registerExecutor(
  action: string,
  executor: (
    changeset: ChangeSet,
  ) => Promise<{ success: boolean; message: string; rollbackData?: unknown }>,
): void {
  executors.set(action, executor);
}

// ── Risk Scoring ─────────────────────────────────────────────────

function calculateRiskScore(
  changes: Change[],
  simulation: SimulationResult,
  connector: string,
): number {
  let score = 0;

  // Operation types
  for (const change of changes) {
    if (change.operation === "delete") score += 40;
    else if (change.operation === "update") score += 10;
    else if (change.operation === "create") score += 5;
    else if (change.operation === "execute") score += 15;
  }

  // Entity count
  if (changes.length > 5) score += 20;
  else if (changes.length > 1) score += 5;

  // Cascades
  if (simulation.cascades.length > 0) score += 15;

  // Infrastructure systems are higher risk
  if (connector === "vm" || connector === "ops") score += 20;

  // Constraints/blockers
  if (simulation.constraints.length > 0) score += 10;

  return Math.min(score, 100);
}

function identifyRiskFactors(
  changes: Change[],
  simulation: SimulationResult,
  connector: string,
): string[] {
  const factors: string[] = [];

  const deletes = changes.filter((c) => c.operation === "delete").length;
  if (deletes > 0) factors.push(`${deletes} delete operation(s)`);

  if (changes.length > 5) factors.push(`${changes.length} entities affected`);

  if (simulation.cascades.length > 0)
    factors.push(
      `${simulation.cascades.length} cascade effect(s): ${simulation.cascades.join(", ")}`,
    );

  if (connector === "vm" || connector === "ops")
    factors.push("Infrastructure-level changes");

  if (simulation.constraints.length > 0)
    factors.push(`${simulation.constraints.length} constraint(s) to check`);

  return factors;
}

// ── Expiry ───────────────────────────────────────────────────────

function expireStale(): void {
  const now = Date.now();
  for (const [id, cs] of changesets) {
    if (cs.status === "draft" && now > cs.expiresAt) {
      cs.status = "expired";
    }
  }
}

// ── ChangeSet Tools ──────────────────────────────────────────────

export function getChangeSetTools(): BrainstormToolDef[] {
  return [
    defineTool({
      name: "gm_changeset_list",
      description:
        "List all pending God Mode changesets. Shows draft and executed changesets with their risk scores and descriptions.",
      permission: "auto",
      readonly: true,
      inputSchema: z.object({}),
      async execute() {
        const active = listChangeSets();
        if (active.length === 0) return { message: "No active changesets" };
        return {
          changesets: active.map((cs) => ({
            id: cs.id,
            connector: cs.connector,
            action: cs.action,
            description: cs.description,
            status: cs.status,
            riskScore: cs.riskScore,
            riskFactors: cs.riskFactors,
            changes: cs.changes.length,
            createdAt: new Date(cs.createdAt).toISOString(),
            expiresAt: new Date(cs.expiresAt).toISOString(),
          })),
        };
      },
    }),

    defineTool({
      name: "gm_changeset_approve",
      description:
        "Approve and execute a God Mode changeset. This will apply the simulated changes to the target system. Only call after presenting the changeset simulation to the user and receiving approval.",
      permission: "confirm",
      inputSchema: z.object({
        changeset_id: z
          .string()
          .describe("The changeset ID to approve and execute"),
      }),
      async execute({ changeset_id }) {
        return approveChangeSet(changeset_id, "user");
      },
    }),

    defineTool({
      name: "gm_changeset_reject",
      description:
        "Reject a God Mode changeset. The simulated changes will not be applied.",
      permission: "auto",
      inputSchema: z.object({
        changeset_id: z.string().describe("The changeset ID to reject"),
      }),
      async execute({ changeset_id }) {
        return rejectChangeSet(changeset_id);
      },
    }),
  ];
}
