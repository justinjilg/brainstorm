/**
 * Sector Daemon — round-robin tick runner across sector agents.
 *
 * Each tick picks the sector with the oldest lastTickAt, builds a
 * sector-scoped message with plan context, and returns it for
 * the DaemonController to run through the agent loop.
 *
 * This does NOT run the agent loop itself — it produces tick messages
 * that the existing DaemonController consumes. The daemon's runTick
 * callback handles actual agent execution.
 */

import type { SectorAgent } from "./agent-assigner.js";
import type { CodeGraph } from "../graph.js";
import {
  loadSectorPlan,
  saveSectorPlan,
  createInitialPlan,
  getNextObjective,
  type SectorPlan,
} from "./plan.js";
import { createLogger } from "@brainst0rm/shared";

const log = createLogger("sector-daemon");

export interface SectorTickContext {
  /** The sector being ticked. */
  agent: SectorAgent;
  /** The sector's current plan. */
  plan: SectorPlan;
  /** The next objective to work on (null if all done). */
  objective: { id: string; description: string } | null;
  /** The tick message to inject into the agent loop. */
  tickMessage: string;
  /** Model routing hint from sector tier. */
  preferredQualityTier: number;
  /** Budget for this tick. */
  budgetLimit: number;
}

/**
 * Select the next sector to tick (round-robin by oldest lastTickAt).
 * Returns null if no sectors have active plans.
 */
export function selectNextSector(
  agents: SectorAgent[],
  graph: CodeGraph,
): SectorTickContext | null {
  if (agents.length === 0) return null;

  const db = graph.getDb();

  // Load or create plans for all agents
  const agentPlans: Array<{ agent: SectorAgent; plan: SectorPlan }> = [];

  for (const agent of agents) {
    let plan = loadSectorPlan(db, agent.sectorId);
    if (!plan) {
      plan = createInitialPlan(
        agent.sectorId,
        agent.sectorName,
        agent.files,
        agent.taskProfile.qualityTier,
      );
      saveSectorPlan(db, plan);
    }

    if (plan.status === "active") {
      agentPlans.push({ agent, plan });
    }
  }

  if (agentPlans.length === 0) return null;

  // Pick the sector with the oldest lastTickAt
  agentPlans.sort((a, b) => a.plan.lastTickAt - b.plan.lastTickAt);
  const { agent, plan } = agentPlans[0];

  // Get next objective
  const objective = getNextObjective(plan);

  // Build tick message
  const tickMessage = buildSectorTickMessage(agent, plan, objective);

  return {
    agent,
    plan,
    objective: objective
      ? { id: objective.id, description: objective.description }
      : null,
    tickMessage,
    preferredQualityTier: agent.taskProfile.qualityTier,
    budgetLimit: agent.taskProfile.budgetPerTick,
  };
}

/**
 * Record that a sector tick completed.
 * Updates the plan's lastTickAt, tickCount, and cost.
 */
export function recordSectorTick(
  graph: CodeGraph,
  sectorId: string,
  cost: number,
  objectiveCompleted?: string,
  notes?: string,
): void {
  const db = graph.getDb();
  const plan = loadSectorPlan(db, sectorId);
  if (!plan) return;

  plan.lastTickAt = Math.floor(Date.now() / 1000);
  plan.tickCount++;
  plan.totalCost += cost;

  if (objectiveCompleted) {
    const obj = plan.objectives.find((o) => o.id === objectiveCompleted);
    if (obj) {
      obj.status = "completed";
      obj.completedAt = plan.lastTickAt;
      if (notes) obj.notes = notes;
    }

    // Check if all objectives are done
    const allDone = plan.objectives.every((o) => o.status === "completed");
    if (allDone) {
      plan.status = "completed";
      log.info({ sectorId }, "All sector objectives completed");
    }
  }

  saveSectorPlan(db, plan);
}

/**
 * Get a summary of all sector plans for dashboard display.
 */
export function getSectorPlanSummary(
  agents: SectorAgent[],
  graph: CodeGraph,
): Array<{
  sectorName: string;
  tier: string;
  status: string;
  progress: string;
  lastTickAt: number;
  totalCost: number;
}> {
  const db = graph.getDb();
  return agents.map((agent) => {
    const plan = loadSectorPlan(db, agent.sectorId);
    if (!plan) {
      return {
        sectorName: agent.sectorName,
        tier: agent.tier,
        status: "no plan",
        progress: "0/0",
        lastTickAt: 0,
        totalCost: 0,
      };
    }

    const completed = plan.objectives.filter(
      (o) => o.status === "completed",
    ).length;
    const total = plan.objectives.length;

    return {
      sectorName: agent.sectorName,
      tier: agent.tier,
      status: plan.status,
      progress: `${completed}/${total}`,
      lastTickAt: plan.lastTickAt,
      totalCost: plan.totalCost,
    };
  });
}

// ── Private ─────────────────────────────────────────────────────

function buildSectorTickMessage(
  agent: SectorAgent,
  plan: SectorPlan,
  objective: ReturnType<typeof getNextObjective>,
): string {
  const lines = [
    `# Sector Tick: ${agent.sectorName}`,
    "",
    `**Tier:** ${agent.tier} | **Tick:** ${plan.tickCount + 1} | **Cost so far:** $${plan.totalCost.toFixed(4)}`,
    "",
  ];

  if (objective) {
    lines.push(
      `## Current Objective`,
      "",
      `**[${objective.id}]** ${objective.description}`,
      "",
      `Work on this objective. When complete, report what you accomplished.`,
      `Use code intelligence tools (code_impact, code_callers, code_search) to understand the codebase before making changes.`,
    );
  } else {
    lines.push(
      "## All Objectives Complete",
      "",
      "All current objectives are done. Review your sector for new issues or improvements to propose.",
    );
  }

  // Plan status summary
  const completed = plan.objectives.filter(
    (o) => o.status === "completed",
  ).length;
  const pending = plan.objectives.filter((o) => o.status === "pending").length;
  const blocked = plan.objectives.filter((o) => o.status === "blocked").length;

  lines.push(
    "",
    `## Plan Status: ${completed}/${plan.objectives.length} complete` +
      (blocked > 0 ? ` (${blocked} blocked)` : ""),
  );

  // Agent context
  lines.push("", agent.systemPromptAddendum);

  return lines.join("\n");
}
