/**
 * Storm File Format (.storm) — portable, serializable agent state.
 *
 * A .storm file captures an agent's full identity:
 * - Profile (role, model, system prompt, allowed tools)
 * - Memory (system + archive entries)
 * - Skills (names of active skills)
 * - Routing preferences (strategy, capability scores)
 * - History summary (session count, total cost, top tools)
 *
 * Usage:
 *   brainstorm agent export my-agent > agent.storm
 *   brainstorm agent import agent.storm
 */

import { readFileSync, writeFileSync } from "node:fs";
import { resolve, extname } from "node:path";
import type { AgentProfile } from "@brainst0rm/shared";
import {
  MemoryManager,
  type MemoryEntry,
  type MemoryTier,
} from "../memory/manager.js";

// ── Storm File Schema ─────────────────────────────────────────────

export interface StormFile {
  format: "storm-agent-v1";
  exportedAt: string;
  /** Lineage hash — tracks evolution across exports. */
  lineageHash: string;

  agent: {
    id: string;
    displayName: string;
    role: string;
    description: string;
    modelId: string;
    systemPrompt?: string;
    allowedTools: string[] | "all";
    confidenceThreshold: number;
    maxSteps: number;
    fallbackChain: string[];
  };

  memory: {
    system: StormMemoryEntry[];
    archive: StormMemoryEntry[];
  };

  skills: string[];

  routing: {
    strategy: string;
    modelPreferences?: Record<string, string>;
  };

  history: {
    sessionCount: number;
    totalCost: number;
    topTools: string[];
    exportCount: number;
  };
}

export interface StormMemoryEntry {
  name: string;
  type: string;
  description: string;
  content: string;
}

// ── Export ─────────────────────────────────────────────────────────

export function exportStormFile(opts: {
  agent: AgentProfile;
  memoryManager: MemoryManager;
  skills: string[];
  strategy: string;
  sessionCount: number;
  totalCost: number;
  topTools: string[];
  previousLineageHash?: string;
  exportCount?: number;
}): StormFile {
  const systemEntries = opts.memoryManager.listByTier("system");
  const archiveEntries = opts.memoryManager.listByTier("archive");

  const toStormEntry = (m: MemoryEntry): StormMemoryEntry => ({
    name: m.name,
    type: m.type,
    description: m.description,
    content: m.content,
  });

  // Lineage hash: hash of previous hash + current state
  const { createHash } = require("node:crypto");
  const stateString = JSON.stringify({
    agent: opts.agent.id,
    memoryCount: systemEntries.length + archiveEntries.length,
    skillCount: opts.skills.length,
    exportCount: (opts.exportCount ?? 0) + 1,
  });
  const lineageHash = createHash("sha256")
    .update((opts.previousLineageHash ?? "genesis") + stateString)
    .digest("hex")
    .slice(0, 16);

  return {
    format: "storm-agent-v1",
    exportedAt: new Date().toISOString(),
    lineageHash,

    agent: {
      id: opts.agent.id,
      displayName: opts.agent.displayName,
      role: opts.agent.role,
      description: opts.agent.description,
      modelId: opts.agent.modelId,
      systemPrompt: opts.agent.systemPrompt,
      allowedTools: opts.agent.allowedTools,
      confidenceThreshold: opts.agent.confidenceThreshold,
      maxSteps: opts.agent.maxSteps,
      fallbackChain: opts.agent.fallbackChain,
    },

    memory: {
      system: systemEntries.map(toStormEntry),
      archive: archiveEntries.map(toStormEntry),
    },

    skills: opts.skills,

    routing: {
      strategy: opts.strategy,
    },

    history: {
      sessionCount: opts.sessionCount,
      totalCost: opts.totalCost,
      topTools: opts.topTools,
      exportCount: (opts.exportCount ?? 0) + 1,
    },
  };
}

// ── Import ────────────────────────────────────────────────────────

export interface ImportResult {
  agent: StormFile["agent"];
  memoriesImported: { system: number; archive: number };
  skillsReferenced: string[];
}

export function importStormFile(
  stormFile: StormFile,
  memoryManager: MemoryManager,
): ImportResult {
  // Validate format
  if (stormFile.format !== "storm-agent-v1") {
    throw new Error(
      `Unknown storm file format: ${stormFile.format}. Expected storm-agent-v1.`,
    );
  }

  // Import memory entries
  let systemCount = 0;
  let archiveCount = 0;

  for (const entry of stormFile.memory.system) {
    memoryManager.save({
      name: entry.name,
      type: entry.type as MemoryEntry["type"],
      description: entry.description,
      content: entry.content,
      tier: "system" as MemoryTier,
      source: "import" as const,
      author: `storm-import:${stormFile.agent.id}`,
    });
    systemCount++;
  }

  for (const entry of stormFile.memory.archive) {
    memoryManager.save({
      name: entry.name,
      type: entry.type as MemoryEntry["type"],
      description: entry.description,
      content: entry.content,
      tier: "archive" as MemoryTier,
      source: "import" as const,
      author: `storm-import:${stormFile.agent.id}`,
    });
    archiveCount++;
  }

  memoryManager.flushIndex();

  return {
    agent: stormFile.agent,
    memoriesImported: { system: systemCount, archive: archiveCount },
    skillsReferenced: stormFile.skills,
  };
}

// ── File I/O ──────────────────────────────────────────────────────

export function readStormFile(filePath: string): StormFile {
  const resolved = resolve(filePath);
  const ext = extname(resolved);
  if (ext && ext !== ".storm" && ext !== ".json") {
    throw new Error(
      `Invalid storm file extension: ${ext}. Expected .storm or .json`,
    );
  }

  const content = readFileSync(resolved, "utf-8");
  const parsed = JSON.parse(content);

  // Validate format field to prevent importing arbitrary JSON
  if (parsed.format !== "storm-agent-v1") {
    throw new Error(
      `Invalid storm file format: ${parsed.format ?? "missing"}. Expected storm-agent-v1.`,
    );
  }

  return parsed;
}

export function writeStormFile(filePath: string, storm: StormFile): void {
  writeFileSync(filePath, JSON.stringify(storm, null, 2) + "\n", "utf-8");
}
