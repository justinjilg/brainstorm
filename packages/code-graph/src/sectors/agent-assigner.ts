/**
 * Sector Agent Assigner — maps communities to agent assignments.
 *
 * Each sector gets a SectorAgent with:
 * - Model matching via BR Complexity/QualityTier
 * - Sector-specific system prompt with territory context
 * - Budget allocation based on tier
 * - Generated .agent.md file for AgentManager compatibility
 */

import { writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { CodeGraph } from "../graph.js";
import type { SectorProfile, SectorTier } from "../community/sector-profile.js";
import { profileForTier, type SectorTaskProfile } from "./model-matcher.js";
import { buildSectorPrompt, generateSectorAgentMd } from "./prompt-builder.js";
import { createLogger } from "@brainst0rm/shared";

const log = createLogger("sector-assign");

export interface SectorAgent {
  sectorId: string;
  sectorName: string;
  tier: SectorTier;
  /** Agent ID (matches the .agent.md filename). */
  agentId: string;
  /** Task profile for BR router — determines model selection. */
  taskProfile: SectorTaskProfile;
  /** Sector-specific system prompt addendum. */
  systemPromptAddendum: string;
  /** Files this agent owns. */
  files: string[];
  /** Node count in this sector. */
  nodeCount: number;
}

/**
 * Assign agents to all detected sectors.
 *
 * For each community with enough nodes, creates a SectorAgent and
 * optionally writes a .agent.md file to the project's .brainstorm/agents/ directory.
 */
export function assignAgentsToSectors(
  sectors: SectorProfile[],
  graph: CodeGraph,
  opts?: {
    /** Write .agent.md files to disk. Default true. */
    writeAgentFiles?: boolean;
    /** Project path for .agent.md output. */
    projectPath?: string;
    /** Minimum nodes for a sector to get an agent. Default 3. */
    minNodes?: number;
  },
): SectorAgent[] {
  const writeFiles = opts?.writeAgentFiles ?? true;
  const minNodes = opts?.minNodes ?? 3;
  const agents: SectorAgent[] = [];

  // Filter out sectors too small to warrant their own agent
  const eligibleSectors = sectors.filter((s) => s.nodeCount >= minNodes);

  for (const sector of eligibleSectors) {
    const agentId = `sector-${sector.id}`;
    const taskProfile = profileForTier(sector.tier);
    const systemPromptAddendum = buildSectorPrompt(sector, graph);

    const agent: SectorAgent = {
      sectorId: sector.id,
      sectorName: sector.name,
      tier: sector.tier,
      agentId,
      taskProfile,
      systemPromptAddendum,
      files: sector.files,
      nodeCount: sector.nodeCount,
    };

    agents.push(agent);

    // Write .agent.md for AgentManager compatibility
    if (writeFiles && opts?.projectPath) {
      const agentDir = join(opts.projectPath, ".brainstorm", "agents");
      mkdirSync(agentDir, { recursive: true });
      const agentFilePath = join(agentDir, `${agentId}.agent.md`);
      const content = generateSectorAgentMd(sector, graph);
      writeFileSync(agentFilePath, content, "utf-8");
    }
  }

  log.info(
    {
      totalSectors: sectors.length,
      eligibleSectors: eligibleSectors.length,
      agents: agents.length,
      tiers: {
        critical: agents.filter((a) => a.tier === "critical").length,
        complex: agents.filter((a) => a.tier === "complex").length,
        standard: agents.filter((a) => a.tier === "standard").length,
        simple: agents.filter((a) => a.tier === "simple").length,
      },
    },
    "Sector agents assigned",
  );

  return agents;
}

/**
 * Get the sector agent responsible for a given file.
 */
export function getAgentForFile(
  filePath: string,
  agents: SectorAgent[],
): SectorAgent | null {
  for (const agent of agents) {
    if (agent.files.some((f) => filePath.endsWith(f) || f.endsWith(filePath))) {
      return agent;
    }
  }
  return null;
}

/**
 * Get all sector agents sorted by priority (critical first).
 */
export function getAgentsByPriority(agents: SectorAgent[]): SectorAgent[] {
  const tierOrder: Record<SectorTier, number> = {
    critical: 0,
    complex: 1,
    standard: 2,
    simple: 3,
  };
  return [...agents].sort((a, b) => tierOrder[a.tier] - tierOrder[b.tier]);
}
