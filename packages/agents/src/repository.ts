import { randomUUID } from 'node:crypto';
import type { AgentProfile, AgentRole, AgentLifecycle } from '@brainstorm/shared';

export class AgentRepository {
  constructor(private db: any) {}

  create(input: Omit<AgentProfile, 'createdAt' | 'updatedAt'>): AgentProfile {
    const now = Math.floor(Date.now() / 1000);
    this.db.prepare(`
      INSERT INTO agent_profiles (id, display_name, role, description, model_id, system_prompt, allowed_tools, output_format, budget_per_workflow, budget_daily, exhaustion_action, downgrade_model_id, confidence_threshold, max_steps, fallback_chain, guardrails, lifecycle)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      input.id,
      input.displayName,
      input.role,
      input.description,
      input.modelId,
      input.systemPrompt ?? null,
      JSON.stringify(input.allowedTools),
      input.outputFormat ?? null,
      input.budget.perWorkflow ?? null,
      input.budget.daily ?? null,
      input.budget.exhaustionAction,
      input.budget.downgradeModelId ?? null,
      input.confidenceThreshold,
      input.maxSteps,
      JSON.stringify(input.fallbackChain),
      JSON.stringify(input.guardrails),
      input.lifecycle,
    );
    return { ...input, createdAt: now, updatedAt: now };
  }

  get(id: string): AgentProfile | null {
    const row = this.db.prepare('SELECT * FROM agent_profiles WHERE id = ?').get(id) as any;
    if (!row) return null;
    return this.rowToProfile(row);
  }

  list(): AgentProfile[] {
    const rows = this.db.prepare('SELECT * FROM agent_profiles WHERE lifecycle = ? ORDER BY created_at DESC').all('active') as any[];
    return rows.map((r) => this.rowToProfile(r));
  }

  listByRole(role: AgentRole): AgentProfile[] {
    const rows = this.db.prepare('SELECT * FROM agent_profiles WHERE role = ? AND lifecycle = ? ORDER BY created_at DESC').all(role, 'active') as any[];
    return rows.map((r) => this.rowToProfile(r));
  }

  update(id: string, patch: Partial<Pick<AgentProfile, 'displayName' | 'description' | 'modelId' | 'systemPrompt' | 'allowedTools' | 'outputFormat' | 'budget' | 'confidenceThreshold' | 'maxSteps' | 'fallbackChain' | 'guardrails' | 'lifecycle'>>): AgentProfile | null {
    const existing = this.get(id);
    if (!existing) return null;

    const updated = { ...existing, ...patch, updatedAt: Math.floor(Date.now() / 1000) };
    if (patch.budget) updated.budget = { ...existing.budget, ...patch.budget };
    if (patch.guardrails) updated.guardrails = { ...existing.guardrails, ...patch.guardrails };

    this.db.prepare(`
      UPDATE agent_profiles SET display_name=?, description=?, model_id=?, system_prompt=?, allowed_tools=?, output_format=?, budget_per_workflow=?, budget_daily=?, exhaustion_action=?, downgrade_model_id=?, confidence_threshold=?, max_steps=?, fallback_chain=?, guardrails=?, lifecycle=?, updated_at=unixepoch()
      WHERE id=?
    `).run(
      updated.displayName, updated.description, updated.modelId, updated.systemPrompt ?? null,
      JSON.stringify(updated.allowedTools), updated.outputFormat ?? null,
      updated.budget.perWorkflow ?? null, updated.budget.daily ?? null,
      updated.budget.exhaustionAction, updated.budget.downgradeModelId ?? null,
      updated.confidenceThreshold, updated.maxSteps,
      JSON.stringify(updated.fallbackChain), JSON.stringify(updated.guardrails),
      updated.lifecycle, id,
    );
    return updated;
  }

  delete(id: string): boolean {
    const result = this.db.prepare('DELETE FROM agent_profiles WHERE id = ?').run(id);
    return result.changes > 0;
  }

  private rowToProfile(row: any): AgentProfile {
    return {
      id: row.id,
      displayName: row.display_name,
      role: row.role as AgentRole,
      description: row.description,
      modelId: row.model_id,
      systemPrompt: row.system_prompt ?? undefined,
      allowedTools: safeJsonParse(row.allowed_tools, []),
      outputFormat: row.output_format ?? undefined,
      budget: {
        perWorkflow: row.budget_per_workflow ?? undefined,
        daily: row.budget_daily ?? undefined,
        exhaustionAction: row.exhaustion_action,
        downgradeModelId: row.downgrade_model_id ?? undefined,
      },
      confidenceThreshold: row.confidence_threshold,
      maxSteps: row.max_steps,
      fallbackChain: safeJsonParse(row.fallback_chain, []),
      guardrails: safeJsonParse(row.guardrails, {}),
      lifecycle: row.lifecycle as AgentLifecycle,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
}

/** Safely parse JSON, returning fallback on error instead of crashing. */
function safeJsonParse<T>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}
