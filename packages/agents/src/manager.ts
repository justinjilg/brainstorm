import type { AgentProfile, AgentRole } from '@brainstorm/shared';
import type { BrainstormConfig, AgentConfig } from '@brainstorm/config';
import { AgentRepository } from './repository.js';

export class AgentManager {
  private repo: AgentRepository;
  private configAgents: Map<string, AgentProfile> = new Map();

  constructor(db: any, config: BrainstormConfig) {
    this.repo = new AgentRepository(db);
    // Load agents from TOML config
    for (const ac of config.agents) {
      this.configAgents.set(ac.id, this.configToProfile(ac));
    }
  }

  /** Get agent by ID. TOML config wins over SQLite on conflict. */
  get(id: string): AgentProfile | null {
    return this.configAgents.get(id) ?? this.repo.get(id);
  }

  /** List all active agents (merged: TOML + SQLite, TOML wins). */
  list(): AgentProfile[] {
    const dbAgents = this.repo.list();
    const merged = new Map<string, AgentProfile>();
    for (const a of dbAgents) merged.set(a.id, a);
    for (const [id, a] of this.configAgents) merged.set(id, a); // TOML overwrites
    return Array.from(merged.values());
  }

  /** Find first active agent matching a role. */
  resolveByRole(role: AgentRole): AgentProfile | null {
    // Check TOML first
    for (const a of this.configAgents.values()) {
      if (a.role === role && a.lifecycle === 'active') return a;
    }
    // Then SQLite
    const dbMatches = this.repo.listByRole(role);
    return dbMatches[0] ?? null;
  }

  /** Create an agent in SQLite. */
  create(input: Omit<AgentProfile, 'createdAt' | 'updatedAt'>): AgentProfile {
    return this.repo.create(input);
  }

  /** Update an agent in SQLite. Cannot update TOML agents here. */
  update(id: string, patch: Parameters<AgentRepository['update']>[1]): AgentProfile | null {
    if (this.configAgents.has(id)) {
      throw new Error(`Agent '${id}' is defined in TOML config. Edit brainstorm.toml to update it.`);
    }
    return this.repo.update(id, patch);
  }

  /** Delete an agent from SQLite. Cannot delete TOML agents. */
  delete(id: string): boolean {
    if (this.configAgents.has(id)) {
      throw new Error(`Agent '${id}' is defined in TOML config. Remove it from brainstorm.toml.`);
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
      lifecycle: 'active',
      createdAt: now,
      updatedAt: now,
    };
  }
}
