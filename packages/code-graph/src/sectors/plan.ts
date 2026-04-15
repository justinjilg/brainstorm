/**
 * Sector Plans — persistent objectives for sector agents.
 *
 * Plans survive across sessions (stored in the code-graph SQLite DB).
 * Each sector agent has a plan with objectives that it works through
 * over multiple daemon ticks.
 */

import type Database from "better-sqlite3";
import type { CodeGraph } from "../graph.js";
import { createLogger } from "@brainst0rm/shared";

const log = createLogger("sector-plan");

export interface PlanObjective {
  id: string;
  description: string;
  priority: number;
  status: "pending" | "in-progress" | "completed" | "blocked";
  dependsOn: string[];
  createdAt: number;
  completedAt?: number;
  notes?: string;
}

export interface SectorPlan {
  sectorId: string;
  objectives: PlanObjective[];
  status: "active" | "paused" | "completed";
  lastTickAt: number;
  tickCount: number;
  totalCost: number;
  createdAt: number;
  updatedAt: number;
}

/**
 * Initialize the sector_plans table in the code graph DB.
 */
export function initSectorPlansSchema(db: Database.Database): void {
  db.prepare(
    `
    CREATE TABLE IF NOT EXISTS sector_plans (
      sector_id TEXT PRIMARY KEY,
      plan_json TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `,
  ).run();
}

/**
 * Load a sector's plan from the database.
 */
export function loadSectorPlan(
  db: Database.Database,
  sectorId: string,
): SectorPlan | null {
  initSectorPlansSchema(db);
  const row = db
    .prepare("SELECT plan_json FROM sector_plans WHERE sector_id = ?")
    .get(sectorId) as { plan_json: string } | undefined;

  if (!row) return null;

  try {
    return JSON.parse(row.plan_json) as SectorPlan;
  } catch {
    log.warn({ sectorId }, "Corrupt sector plan — returning null");
    return null;
  }
}

/**
 * Save a sector's plan to the database.
 */
export function saveSectorPlan(db: Database.Database, plan: SectorPlan): void {
  initSectorPlansSchema(db);
  const now = Math.floor(Date.now() / 1000);
  plan.updatedAt = now;

  db.prepare(
    `
    INSERT OR REPLACE INTO sector_plans (sector_id, plan_json, updated_at)
    VALUES (?, ?, ?)
  `,
  ).run(plan.sectorId, JSON.stringify(plan), now);
}

/**
 * Load all active sector plans.
 */
export function loadAllSectorPlans(db: Database.Database): SectorPlan[] {
  initSectorPlansSchema(db);
  const rows = db
    .prepare("SELECT plan_json FROM sector_plans ORDER BY updated_at DESC")
    .all() as Array<{ plan_json: string }>;

  return rows
    .map((r) => {
      try {
        return JSON.parse(r.plan_json) as SectorPlan;
      } catch {
        return null;
      }
    })
    .filter((p): p is SectorPlan => p !== null);
}

/**
 * Create an initial plan for a sector based on its profile.
 */
export function createInitialPlan(
  sectorId: string,
  sectorName: string,
  files: string[],
  complexityScore: number,
): SectorPlan {
  const now = Math.floor(Date.now() / 1000);
  const objectives: PlanObjective[] = [];

  // Auto-generate initial objectives based on sector characteristics
  objectives.push({
    id: `${sectorId}-audit`,
    description: `Audit all ${files.length} files in ${sectorName} for code quality, dead code, and missing error handling`,
    priority: 1,
    status: "pending",
    dependsOn: [],
    createdAt: now,
  });

  if (complexityScore >= 5) {
    objectives.push({
      id: `${sectorId}-simplify`,
      description: `Identify simplification opportunities in high-complexity functions (complexity: ${complexityScore.toFixed(1)}/10)`,
      priority: 2,
      status: "pending",
      dependsOn: [`${sectorId}-audit`],
      createdAt: now,
    });
  }

  objectives.push({
    id: `${sectorId}-tests`,
    description: `Review test coverage for ${sectorName} and identify critical gaps`,
    priority: 3,
    status: "pending",
    dependsOn: [`${sectorId}-audit`],
    createdAt: now,
  });

  objectives.push({
    id: `${sectorId}-docs`,
    description: `Ensure key functions in ${sectorName} have accurate documentation`,
    priority: 4,
    status: "pending",
    dependsOn: [`${sectorId}-audit`],
    createdAt: now,
  });

  return {
    sectorId,
    objectives,
    status: "active",
    lastTickAt: 0,
    tickCount: 0,
    totalCost: 0,
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * Get the next actionable objective from a plan.
 * Returns the highest-priority pending objective whose dependencies are met.
 */
export function getNextObjective(plan: SectorPlan): PlanObjective | null {
  const completedIds = new Set(
    plan.objectives.filter((o) => o.status === "completed").map((o) => o.id),
  );

  const actionable = plan.objectives
    .filter(
      (o) =>
        o.status === "pending" &&
        o.dependsOn.every((dep) => completedIds.has(dep)),
    )
    .sort((a, b) => a.priority - b.priority);

  return actionable[0] ?? null;
}

/**
 * Mark an objective as completed.
 */
export function completeObjective(
  plan: SectorPlan,
  objectiveId: string,
  notes?: string,
): void {
  const obj = plan.objectives.find((o) => o.id === objectiveId);
  if (obj) {
    obj.status = "completed";
    obj.completedAt = Math.floor(Date.now() / 1000);
    if (notes) obj.notes = notes;
  }
}
