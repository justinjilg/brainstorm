/**
 * File-based agent loader — loads .agent.md files from disk.
 *
 * Inspired by Copilot's .github/agents/*.agent.md pattern.
 * Scans .brainstorm/agents/ and .claude/agents/ directories.
 *
 * File format:
 * ---
 * name: security-reviewer
 * description: Reviews code for security vulnerabilities
 * model: quality | capable | cheap
 * tools: ["file_read", "grep", "glob"]
 * max_steps: 8
 * role: reviewer
 * ---
 * <system prompt content>
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, basename } from "node:path";
import { homedir } from "node:os";
import type { AgentProfile, AgentRole } from "@brainst0rm/shared";

export interface FileAgent {
  id: string;
  filePath: string;
  profile: AgentProfile;
}

/**
 * Load all .agent.md files from standard directories.
 */
export function loadAgentFiles(projectPath: string): FileAgent[] {
  const agents: FileAgent[] = [];

  const searchDirs = [
    join(projectPath, ".brainstorm", "agents"),
    join(projectPath, ".claude", "agents"),
    join(homedir(), ".brainstorm", "agents"),
    join(homedir(), ".claude", "agents"),
  ];

  const seen = new Set<string>();

  for (const dir of searchDirs) {
    if (!existsSync(dir)) continue;

    for (const file of readdirSync(dir)) {
      if (!file.endsWith(".agent.md")) continue;

      const filePath = join(dir, file);
      const id = basename(file, ".agent.md");

      // Project-level agents take precedence over global
      if (seen.has(id)) continue;
      seen.add(id);

      try {
        const agent = parseAgentFile(filePath, id);
        if (agent) agents.push(agent);
      } catch {
        // Skip unparseable files
      }
    }
  }

  return agents;
}

/**
 * Parse a single .agent.md file into an AgentProfile.
 */
export function parseAgentFile(
  filePath: string,
  id?: string,
): FileAgent | null {
  const content = readFileSync(filePath, "utf-8");
  const agentId = id ?? basename(filePath, ".agent.md");
  const now = Math.floor(Date.now() / 1000);

  // Parse YAML frontmatter
  const fmMatch = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!fmMatch) {
    // No frontmatter — treat entire content as system prompt
    return {
      id: agentId,
      filePath,
      profile: {
        id: agentId,
        displayName: agentId,
        role: "custom",
        description: "",
        modelId: "",
        systemPrompt: content.trim(),
        allowedTools: "all",
        budget: { exhaustionAction: "stop" },
        confidenceThreshold: 0.7,
        maxSteps: 10,
        fallbackChain: [],
        guardrails: {},
        lifecycle: "active",
        createdAt: now,
        updatedAt: now,
      },
    };
  }

  const frontmatter = fmMatch[1];
  const body = fmMatch[2].trim();

  // Escape keys before building a RegExp. Callers here pass literals, but
  // interpolating any string into RegExp without escaping is a foot-gun
  // (ReDoS if a caller ever passes user input).
  const escapeRegex = (s: string): string =>
    s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  // Parse YAML fields
  const get = (key: string): string | undefined => {
    const match = frontmatter.match(
      new RegExp(`^${escapeRegex(key)}:\\s*(.+)$`, "m"),
    );
    return match?.[1]?.trim().replace(/^["']|["']$/g, "");
  };

  const getArray = (key: string): string[] => {
    const match = frontmatter.match(
      new RegExp(`^${escapeRegex(key)}:\\s*\\[([^\\]]+)\\]`, "m"),
    );
    if (!match) return [];
    return match[1].split(",").map((s) => s.trim().replace(/^["']|["']$/g, ""));
  };

  const name = get("name") ?? agentId;
  const description = get("description") ?? "";
  const model = get("model") ?? "";
  const role = (get("role") ?? "custom") as AgentRole;
  const tools = getArray("tools");
  const maxSteps = parseInt(get("max_steps") ?? "10", 10);
  const budget = parseFloat(get("budget") ?? "0");
  const confidence = parseFloat(get("confidence") ?? "0.7");

  // Map model hint to model ID pattern
  const modelId =
    model === "quality"
      ? "quality-first"
      : model === "cheap"
        ? "cost-first"
        : model === "capable"
          ? ""
          : model; // direct model ID

  const profile: AgentProfile = {
    id: agentId,
    displayName: name,
    role,
    description,
    modelId,
    systemPrompt: body || undefined,
    allowedTools: tools.length > 0 ? tools : "all",
    budget: {
      perWorkflow: budget > 0 ? budget : undefined,
      exhaustionAction: "stop",
    },
    confidenceThreshold: confidence,
    maxSteps,
    fallbackChain: [],
    guardrails: {},
    lifecycle: "active",
    createdAt: now,
    updatedAt: now,
  };

  return { id: agentId, filePath, profile };
}

/**
 * Find a specific agent by name across all directories.
 */
export function findAgentFile(
  projectPath: string,
  name: string,
): FileAgent | null {
  const agents = loadAgentFiles(projectPath);
  return agents.find((a) => a.id === name) ?? null;
}
