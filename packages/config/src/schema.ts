import { z } from 'zod';

// ── Provider Config ──────────────────────────────────────────────────

const gatewayProviderSchema = z.object({
  enabled: z.boolean().default(true),
  apiKeyEnv: z.string().default('AI_GATEWAY_API_KEY'),
  baseUrl: z.string().default('https://ai-gateway.vercel.sh/v1'),
});

const localProviderSchema = z.object({
  enabled: z.boolean().default(true),
  baseUrl: z.string(),
  autoDiscover: z.boolean().default(true),
});

const providersSchema = z.object({
  gateway: gatewayProviderSchema.default({}),
  ollama: localProviderSchema.default({ baseUrl: 'http://localhost:11434' }),
  lmstudio: localProviderSchema.default({ baseUrl: 'http://localhost:1234' }),
  llamacpp: localProviderSchema.default({ baseUrl: 'http://localhost:8080', enabled: false }),
});

// ── Budget Config ────────────────────────────────────────────────────

const budgetSchema = z.object({
  daily: z.number().optional(),
  monthly: z.number().optional(),
  perSession: z.number().optional(),
  perProject: z.number().optional(),
  hardLimit: z.boolean().default(false),
});

// ── Routing Rules ────────────────────────────────────────────────────

const routingRuleMatchSchema = z.object({
  task: z.string().optional(),
  complexity: z.string().optional(),
  filePattern: z.string().optional(),
  language: z.string().optional(),
});

const routingRuleSchema = z.object({
  match: routingRuleMatchSchema,
  model: z.string().optional(),
  preferProvider: z.string().optional(),
  strategy: z.enum(['cost-first', 'quality-first']).optional(),
});

// ── Model Override ───────────────────────────────────────────────────

const modelOverrideSchema = z.object({
  id: z.string(),
  qualityTier: z.number().min(1).max(5).optional(),
  speedTier: z.number().min(1).max(5).optional(),
  bestFor: z.array(z.string()).optional(),
});

// ── General Config ───────────────────────────────────────────────────

const generalSchema = z.object({
  defaultStrategy: z.enum(['cost-first', 'quality-first', 'rule-based', 'combined']).default('combined'),
  confirmTools: z.boolean().default(true),
  defaultPermissionMode: z.enum(['auto', 'confirm', 'plan']).default('confirm'),
  theme: z.enum(['dark', 'light']).default('dark'),
  maxSteps: z.number().default(10),
});

// ── Full Config ──────────────────────────────────────────────────────

// ── Agent Config ─────────────────────────────────────────────────

const agentBudgetSchema = z.object({
  perWorkflow: z.number().optional(),
  daily: z.number().optional(),
  exhaustionAction: z.enum(['downgrade', 'stop']).default('downgrade'),
  downgradeModel: z.string().optional(),
});

const agentGuardrailsSchema = z.object({
  pii: z.boolean().optional(),
  topicRestriction: z.string().optional(),
});

const agentConfigSchema = z.object({
  id: z.string(),
  displayName: z.string().optional(),
  role: z.enum(['architect', 'coder', 'reviewer', 'debugger', 'analyst', 'custom']).default('custom'),
  description: z.string().default(''),
  model: z.string(),
  systemPrompt: z.string().optional(),
  allowedTools: z.union([z.literal('all'), z.array(z.string())]).default('all'),
  outputFormat: z.string().optional(),
  confidenceThreshold: z.number().min(0).max(1).default(0.7),
  maxSteps: z.number().default(10),
  fallbackChain: z.array(z.string()).default([]),
  budget: agentBudgetSchema.default({}),
  guardrails: agentGuardrailsSchema.default({}),
});

// ── Workflow Config ──────────────────────────────────────────────

const workflowStepConfigSchema = z.object({
  id: z.string(),
  agentRole: z.enum(['architect', 'coder', 'reviewer', 'debugger', 'analyst', 'custom']),
  agentId: z.string().optional(),
  description: z.string().default(''),
  inputArtifacts: z.array(z.string()).default([]),
  outputArtifact: z.string(),
  outputSchema: z.string().optional(),
  isReviewStep: z.boolean().default(false),
  loopBackTo: z.string().optional(),
  skipCondition: z.string().optional(),
});

const workflowConfigSchema = z.object({
  id: z.string(),
  name: z.string().optional(),
  description: z.string().default(''),
  communicationMode: z.enum(['handoff', 'shared']).default('handoff'),
  maxIterations: z.number().default(3),
  steps: z.array(workflowStepConfigSchema).default([]),
});

export const brainstormConfigSchema = z.object({
  general: generalSchema.default({}),
  budget: budgetSchema.default({}),
  providers: providersSchema.default({}),
  routing: z.object({
    rules: z.array(routingRuleSchema).default([]),
  }).default({}),
  models: z.array(modelOverrideSchema).default([]),
  agents: z.array(agentConfigSchema).default([]),
  workflows: z.array(workflowConfigSchema).default([]),
});

export type BrainstormConfig = z.infer<typeof brainstormConfigSchema>;
export type BudgetConfig = z.infer<typeof budgetSchema>;
export type ProviderConfig = z.infer<typeof providersSchema>;
export type RoutingRule = z.infer<typeof routingRuleSchema>;
export type GeneralConfig = z.infer<typeof generalSchema>;
export type AgentConfig = z.infer<typeof agentConfigSchema>;
export type WorkflowConfig = z.infer<typeof workflowConfigSchema>;
export type WorkflowStepConfig = z.infer<typeof workflowStepConfigSchema>;
