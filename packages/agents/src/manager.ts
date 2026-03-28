import type { AgentProfile, AgentRole } from "@brainstorm/shared";
import type { BrainstormConfig, AgentConfig } from "@brainstorm/config";
import { AgentRepository } from "./repository.js";
import { loadAgentFiles, type FileAgent } from "./file-loader.js";

export class AgentManager {
  private repo: AgentRepository;
  private configAgents: Map<string, AgentProfile> = new Map();
  private fileAgents: Map<string, AgentProfile> = new Map();

  constructor(db: any, config: BrainstormConfig, projectPath?: string) {
    this.repo = new AgentRepository(db);
    // Load agents from TOML config
    for (const ac of config.agents) {
      this.configAgents.set(ac.id, this.configToProfile(ac));
    }
    // Load agents from .agent.md files (highest priority)
    if (projectPath) {
      this.loadFromFiles(projectPath);
    }
  }

  /** Reload file-based agents (call after project switch). */
  loadFromFiles(projectPath: string): void {
    this.fileAgents.clear();
    for (const fa of loadAgentFiles(projectPath)) {
      this.fileAgents.set(fa.id, fa.profile);
    }
  }

  /**
   * Get agent by ID.
   * Priority: .agent.md files > TOML config > SQLite database
   */
  get(id: string): AgentProfile | null {
    return (
      this.fileAgents.get(id) ?? this.configAgents.get(id) ?? this.repo.get(id)
    );
  }

  /**
   * List all active agents (merged: files > TOML > SQLite).
   */
  list(): AgentProfile[] {
    const merged = new Map<string, AgentProfile>();
    // DB first (lowest priority)
    for (const a of this.repo.list()) merged.set(a.id, a);
    // TOML overwrites DB
    for (const [id, a] of this.configAgents) merged.set(id, a);
    // Files overwrite everything
    for (const [id, a] of this.fileAgents) merged.set(id, a);
    return Array.from(merged.values());
  }

  /** Find first active agent matching a role. */
  resolveByRole(role: AgentRole): AgentProfile | null {
    // Check files first
    for (const a of this.fileAgents.values()) {
      if (a.role === role && a.lifecycle === "active") return a;
    }
    // Then TOML
    for (const a of this.configAgents.values()) {
      if (a.role === role && a.lifecycle === "active") return a;
    }
    // Then SQLite
    const dbMatches = this.repo.listByRole(role);
    return dbMatches[0] ?? null;
  }

  /** Get file-based agents only (for display purposes). */
  listFileAgents(): AgentProfile[] {
    return Array.from(this.fileAgents.values());
  }

  /** Create an agent in SQLite. */
  create(input: Omit<AgentProfile, "createdAt" | "updatedAt">): AgentProfile {
    return this.repo.create(input);
  }

  /** Update an agent in SQLite. Cannot update file/TOML agents here. */
  update(
    id: string,
    patch: Parameters<AgentRepository["update"]>[1],
  ): AgentProfile | null {
    if (this.fileAgents.has(id)) {
      throw new Error(
        `Agent '${id}' is defined in .agent.md file. Edit the file directly.`,
      );
    }
    if (this.configAgents.has(id)) {
      throw new Error(
        `Agent '${id}' is defined in TOML config. Edit brainstorm.toml to update it.`,
      );
    }
    return this.repo.update(id, patch);
  }

  /** Delete an agent from SQLite. Cannot delete file/TOML agents. */
  delete(id: string): boolean {
    if (this.fileAgents.has(id)) {
      throw new Error(
        `Agent '${id}' is defined in .agent.md file. Delete the file to remove it.`,
      );
    }
    if (this.configAgents.has(id)) {
      throw new Error(
        `Agent '${id}' is defined in TOML config. Remove it from brainstorm.toml.`,
      );
    }
    return this.repo.delete(id);
  }

  private configToProfile(ac: AgentConfig): AgentProfile {
    const now = Math.floor(Date.now() / 1000);
    return {
      id: ac.id,
      displayName: ac.displayName ?? ac.id,
      role: ac.role,
      description: ac.description,
      modelId: ac.model,
      systemPrompt: ac.systemPrompt,
      allowedTools: ac.allowedTools,
      outputFormat: ac.outputFormat,
      budget: {
        perWorkflow: ac.budget.perWorkflow,
        daily: ac.budget.daily,
        exhaustionAction: ac.budget.exhaustionAction,
        downgradeModelId: ac.budget.downgradeModel,
      },
      confidenceThreshold: ac.confidenceThreshold,
      maxSteps: ac.maxSteps,
      fallbackChain: ac.fallbackChain,
      guardrails: {
        pii: ac.guardrails.pii,
        topicRestriction: ac.guardrails.topicRestriction,
      },
      lifecycle: "active",
      createdAt: now,
      updatedAt: now,
    };
  }
}
