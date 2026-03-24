import { streamText, stepCountIs } from 'ai';
import type { BrainstormConfig } from '@brainstorm/config';
import type { ProviderRegistry } from '@brainstorm/providers';
import { BrainstormRouter, CostTracker } from '@brainstorm/router';
import type { ToolRegistry } from '@brainstorm/tools';
import { serializeRoutingMetadata } from '@brainstorm/shared';

// ── Subagent Types ──────────────────────────────────────────────────

export type SubagentType = 'explore' | 'plan' | 'code' | 'review' | 'general';

interface SubagentTypeConfig {
  /** Tools this subagent type is allowed to use */
  allowedTools: string[] | 'all';
  /** System prompt prefix for behavioral instructions */
  systemPrompt: string;
  /** Default max steps (keep focused subagents short) */
  defaultMaxSteps: number;
  /** Model complexity hint: 'cheap' routes to cost-first, 'capable' to quality-first */
  modelHint: 'cheap' | 'capable';
}

const SUBAGENT_TYPES: Record<SubagentType, SubagentTypeConfig> = {
  explore: {
    allowedTools: ['file_read', 'glob', 'grep', 'list_dir', 'git_status', 'git_diff', 'git_log'],
    systemPrompt:
      'You are an exploration subagent. Your job is to find information in the codebase quickly and return what you found. You have read-only tools — you cannot modify files. Be thorough but concise.',
    defaultMaxSteps: 5,
    modelHint: 'cheap',
  },
  plan: {
    allowedTools: ['file_read', 'glob', 'grep', 'list_dir', 'git_status', 'git_diff', 'git_log', 'task_create', 'task_update', 'task_list'],
    systemPrompt:
      'You are a planning subagent. Analyze the codebase and design an implementation approach. Create tasks to track the plan. You have read-only file tools plus task management. Return a structured plan.',
    defaultMaxSteps: 8,
    modelHint: 'capable',
  },
  code: {
    allowedTools: 'all',
    systemPrompt:
      'You are a coding subagent. Implement the requested changes, verify they compile, and return a summary of what you changed. Follow existing patterns in the codebase.',
    defaultMaxSteps: 10,
    modelHint: 'capable',
  },
  review: {
    allowedTools: ['file_read', 'glob', 'grep', 'list_dir', 'git_status', 'git_diff', 'git_log', 'git_commit'],
    systemPrompt:
      'You are a code review subagent. Review the changes for bugs, style issues, and correctness. Be specific — cite file paths and line numbers. Focus on real issues, not nitpicks.',
    defaultMaxSteps: 5,
    modelHint: 'capable',
  },
  general: {
    allowedTools: 'all',
    systemPrompt:
      'You are a focused subagent. Complete the given task concisely and return the result. Do not ask questions — make your best judgment.',
    defaultMaxSteps: 5,
    modelHint: 'cheap',
  },
};

/**
 * Get the configuration for a subagent type.
 */
export function getSubagentTypeConfig(type: SubagentType): SubagentTypeConfig {
  return SUBAGENT_TYPES[type];
}

/**
 * All valid subagent type names.
 */
export const SUBAGENT_TYPE_NAMES: SubagentType[] = ['explore', 'plan', 'code', 'review', 'general'];

// ── Subagent Execution ──────────────────────────────────────────────

export interface SubagentOptions {
  config: BrainstormConfig;
  registry: ProviderRegistry;
  router: BrainstormRouter;
  costTracker: CostTracker;
  tools: ToolRegistry;
  projectPath: string;
  /** Subagent type — determines tool access, system prompt, and model hint. */
  type?: SubagentType;
  /** System prompt override (overrides type's default). */
  systemPrompt?: string;
  /** Max steps override (overrides type's default). */
  maxSteps?: number;
}

export interface SubagentResult {
  text: string;
  cost: number;
  modelUsed: string;
  toolCalls: string[];
  type: SubagentType;
}

/**
 * Spawn an isolated subagent for a focused task.
 *
 * Subagents get their own context — they don't see the parent conversation.
 * This prevents context bloat while enabling parallel work.
 *
 * The subagent type determines:
 * - Which tools are available (explore = read-only, code = all)
 * - System prompt behavior (review = bug-focused, plan = structured output)
 * - Model selection hint (explore → cheap, code → capable)
 */
export async function spawnSubagent(
  task: string,
  options: SubagentOptions,
): Promise<SubagentResult> {
  const { router, costTracker, tools, config, registry, projectPath } = options;
  const type = options.type ?? 'general';
  const typeConfig = SUBAGENT_TYPES[type];

  const taskProfile = router.classify(task);

  // Apply model hint: override routing strategy for this subagent
  const decision = router.route(taskProfile, {
    preferCheap: typeConfig.modelHint === 'cheap',
  });

  const modelId = registry.getProvider(decision.model.id);
  const systemPrompt = options.systemPrompt ?? typeConfig.systemPrompt;
  const maxSteps = options.maxSteps ?? typeConfig.defaultMaxSteps;

  // Filter tools based on subagent type
  const filteredTools = typeConfig.allowedTools === 'all'
    ? tools.toAISDKTools()
    : tools.toAISDKToolsFiltered(typeConfig.allowedTools);

  const costBefore = costTracker.getSessionCost();
  const toolCallNames: string[] = [];
  let fullText = '';

  const metadataHeader = serializeRoutingMetadata(taskProfile, decision);

  const result = streamText({
    model: modelId,
    system: systemPrompt,
    messages: [{ role: 'user' as const, content: task }],
    tools: filteredTools,
    ...(metadataHeader ? { headers: { 'x-br-metadata': metadataHeader } } : {}),
    stopWhen: stepCountIs(maxSteps),
    onStepFinish: async ({ usage }: any) => {
      if (usage) {
        costTracker.record({
          sessionId: 'subagent',
          modelId: decision.model.id,
          provider: decision.model.provider,
          inputTokens: usage.inputTokens ?? 0,
          outputTokens: usage.outputTokens ?? 0,
          taskType: taskProfile.type,
          projectPath,
          pricing: decision.model.pricing,
        });
      }
    },
  });

  for await (const part of result.fullStream) {
    if (part.type === 'text-delta') {
      fullText += (part as any).delta ?? (part as any).text ?? '';
    } else if (part.type === 'tool-call') {
      toolCallNames.push(part.toolName);
    }
  }

  return {
    text: fullText,
    cost: costTracker.getSessionCost() - costBefore,
    modelUsed: decision.model.name,
    toolCalls: toolCallNames,
    type,
  };
}

/**
 * Spawn multiple subagents in parallel.
 */
export async function spawnParallel(
  specs: Array<{ task: string; type?: SubagentType }>,
  options: SubagentOptions,
): Promise<SubagentResult[]> {
  return Promise.all(
    specs.map((spec) =>
      spawnSubagent(spec.task, { ...options, type: spec.type }),
    ),
  );
}
