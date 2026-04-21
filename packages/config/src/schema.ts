import { z } from "zod";

// ── Provider Config ──────────────────────────────────────────────────

const gatewayProviderSchema = z.object({
  enabled: z.boolean().default(true),
  apiKeyEnv: z.string().default("AI_GATEWAY_API_KEY"),
  baseUrl: z.string().default("https://ai-gateway.vercel.sh/v1"),
});

const localProviderSchema = z.object({
  enabled: z.boolean().default(true),
  baseUrl: z.string(),
  autoDiscover: z.boolean().default(true),
});

const providersSchema = z.object({
  gateway: gatewayProviderSchema.default({}),
  ollama: localProviderSchema.default({ baseUrl: "http://localhost:11434" }),
  lmstudio: localProviderSchema.default({ baseUrl: "http://localhost:1234" }),
  llamacpp: localProviderSchema.default({
    baseUrl: "http://localhost:8080",
    enabled: false,
  }),
});

// ── Compaction Config ────────────────────────────────────────────────

const compactionSchema = z.object({
  enabled: z.boolean().default(true),
  threshold: z.number().min(0.1).max(1.0).default(0.8),
  keepRecent: z.number().min(1).default(5),
  summarizeModel: z.string().optional(),
});

// ── Shell Config ─────────────────────────────────────────────────────

const shellSchema = z.object({
  defaultTimeout: z.number().default(120_000),
  maxOutputBytes: z.number().default(50_000),
  // none: no restrictions, restricted: block dangerous commands, container: Docker sandbox
  sandbox: z.enum(["none", "restricted", "container"]).default("restricted"),
  containerImage: z.string().default("node:22-slim"),
  containerTimeout: z.number().default(120_000),
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
  strategy: z.enum(["cost-first", "quality-first"]).optional(),
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
  defaultStrategy: z
    .enum([
      "cost-first",
      "quality-first",
      "rule-based",
      "combined",
      "capability",
      "learned",
    ])
    .default("combined"),
  confirmTools: z.boolean().default(true),
  defaultPermissionMode: z.enum(["auto", "confirm", "plan"]).default("confirm"),
  theme: z.enum(["dark", "light"]).default("dark"),
  maxSteps: z.number().default(10),
  outputStyle: z.enum(["concise", "detailed", "learning"]).default("concise"),
  costSafetyMargin: z.number().min(1).max(3).default(1.3),
  loopDetector: z
    .object({
      readThreshold: z.number().default(4),
      repeatThreshold: z.number().default(3),
    })
    .default({}),
  /** Subagent filesystem isolation: none, git-stash, docker */
  subagentIsolation: z.enum(["none", "git-stash", "docker"]).default("none"),
});

// ── Full Config ──────────────────────────────────────────────────────

// ── Agent Config ─────────────────────────────────────────────────

const agentBudgetSchema = z.object({
  perWorkflow: z.number().optional(),
  daily: z.number().optional(),
  exhaustionAction: z.enum(["downgrade", "stop"]).default("downgrade"),
  downgradeModel: z.string().optional(),
});

const agentGuardrailsSchema = z.object({
  pii: z.boolean().optional(),
  topicRestriction: z.string().optional(),
});

const agentConfigSchema = z.object({
  id: z.string(),
  displayName: z.string().optional(),
  role: z
    .enum([
      "architect",
      "coder",
      "reviewer",
      "debugger",
      "analyst",
      "orchestrator",
      "product-manager",
      "security-reviewer",
      "code-reviewer",
      "style-reviewer",
      "qa",
      "compliance",
      "devops",
      "custom",
    ])
    .default("custom"),
  description: z.string().default(""),
  model: z.string(),
  systemPrompt: z.string().optional(),
  allowedTools: z.union([z.literal("all"), z.array(z.string())]).default("all"),
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
  agentRole: z.enum([
    "architect",
    "coder",
    "reviewer",
    "debugger",
    "analyst",
    "orchestrator",
    "custom",
  ]),
  agentId: z.string().optional(),
  description: z.string().default(""),
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
  description: z.string().default(""),
  communicationMode: z
    .enum(["handoff", "shared", "parallel"])
    .default("handoff"),
  maxIterations: z.number().default(3),
  steps: z.array(workflowStepConfigSchema).default([]),
});

// ── MCP Config ──────────────────────────────────────────────────────

const mcpAuthSchema = z.object({
  type: z.literal("oauth"),
  clientId: z.string(),
  clientSecret: z.string(),
  tokenUrl: z.string(),
  scopes: z.array(z.string()).optional(),
});

const mcpServerSchema = z.object({
  name: z.string(),
  transport: z.enum(["sse", "http", "stdio"]),
  url: z.string().optional(),
  command: z.string().optional(),
  args: z.array(z.string()).optional(),
  env: z.record(z.string()).optional(),
  enabled: z.boolean().default(true),
  toolFilter: z.array(z.string()).optional(),
  auth: mcpAuthSchema.optional(),
});

const mcpSchema = z.object({
  servers: z.array(mcpServerSchema).default([]),
});

// ── Permissions Config ──────────────────────────────────────────────

const permissionsSchema = z.object({
  allowlist: z.array(z.string()).default([]),
  denylist: z.array(z.string()).default([]),
  /** Role preset: viewer (read-only), developer (confirm destructive), admin (auto-approve all). */
  role: z.enum(["viewer", "developer", "admin"]).optional(),
});

// ── Daemon Config ───────────────────────────────────────────────────

const daemonSchema = z.object({
  enabled: z.boolean().default(false),
  /** Base tick interval in milliseconds. Model can override via SleepTool. */
  tickIntervalMs: z.number().min(5_000).max(600_000).default(30_000),
  /** Maximum ticks before auto-stop (cost safety). */
  maxTicksPerSession: z.number().min(1).max(10_000).default(1000),
  /** Default sleep duration when model doesn't specify (ms). */
  sleepDefaultMs: z.number().min(1_000).max(3_600_000).default(60_000),
  /** Directory for append-only daily logs. */
  dailyLogDir: z.string().default("~/.brainstorm/logs"),
  /** Prompt cache expiry hint — warn model about cache invalidation (ms). */
  promptCacheExpiryMs: z.number().default(300_000),
  /** Compaction threshold override for daemon (more aggressive than interactive). */
  compactionThreshold: z.number().min(0.1).max(1.0).default(0.6),
});

// ── God Mode Config ─────────────────────────────────────────────────

const godmodeConnectorSchema = z.object({
  enabled: z.boolean().default(true),
  baseUrl: z.string(),
  apiKeyName: z.string(),
  /** Human-readable product name (e.g., "BrainstormMSP"). Derived from ID if omitted. */
  displayName: z.string().optional(),
});

const godmodeSchema = z.object({
  enabled: z.boolean().default(true),
  /** Risk score threshold for auto-approval (0-100). Below this, no user confirmation needed. */
  autoApproveRiskThreshold: z.number().min(0).max(100).default(20),
  /** Per-connector configuration. Key is connector name ("msp", "email", "vm", etc.). */
  connectors: z.record(godmodeConnectorSchema).default({}),
  /**
   * Code Mode: register connector tools with `deferred` set so their schemas
   * stay out of the prompt until discovered via `tool_search`. Reduces tool
   * catalog token cost when many connectors are healthy. Off by default to
   * preserve the eager-loading behavior current sessions assume.
   */
  deferToolSchemas: z.boolean().default(false),
});

// ── Serve Config ────────────────────────────────────────────────────

const serveSchema = z.object({
  port: z.number().default(8000),
  host: z.string().default("127.0.0.1"),
  cors: z.boolean().default(false),
  /** Supabase project URL for JWT verification. */
  supabaseUrl: z.string().optional(),
  /** Supabase anon key for JWT verification. */
  supabaseAnonKey: z.string().optional(),
});

// ── Full Config ─────────────────────────────────────────────────────

export const brainstormConfigSchema = z.object({
  general: generalSchema.default({}),
  compaction: compactionSchema.default({}),
  shell: shellSchema.default({}),
  budget: budgetSchema.default({}),
  providers: providersSchema.default({}),
  permissions: permissionsSchema.default({}),
  routing: z
    .object({
      rules: z.array(routingRuleSchema).default([]),
      /** Fallback models for empty response retry. */
      fallbackModels: z
        .array(z.string())
        .default([
          "anthropic/claude-sonnet-4.6",
          "openai/gpt-5.4",
          "anthropic/claude-haiku-4.5",
        ]),
    })
    .default({}),
  memory: z
    .object({
      /** Maximum memory storage in bytes (default 25KB). */
      maxBytes: z.number().default(25 * 1024),
      /** Git remote URL for memory sync (e.g., a GitHub repo). Optional. */
      gitRemote: z.string().optional(),
      /** Git branch for memory sync (default: "main"). */
      gitBranch: z.string().default("main"),
    })
    .default({}),
  models: z.array(modelOverrideSchema).default([]),
  agent: z
    .object({
      /**
       * How long the agent loop waits for any stream event (text-delta,
       * tool-call, reasoning, finish) before declaring the stream dead
       * and aborting via the stall watchdog. Default 60s matches the
       * historical hardcoded value. Extended-thinking models that emit
       * long stretches of silent reasoning may need higher values; raw
       * chat models usually don't.
       */
      streamTimeoutMs: z.number().int().positive().default(60_000),
    })
    .default({}),
  agents: z.array(agentConfigSchema).default([]),
  workflows: z.array(workflowConfigSchema).default([]),
  mcp: mcpSchema.default({}),
  daemon: daemonSchema.default({}),
  godmode: godmodeSchema.default({}),
  serve: serveSchema.default({}),
});

export type BrainstormConfig = z.infer<typeof brainstormConfigSchema>;
export type BudgetConfig = z.infer<typeof budgetSchema>;
export type ProviderConfig = z.infer<typeof providersSchema>;
export type RoutingRule = z.infer<typeof routingRuleSchema>;
export type GeneralConfig = z.infer<typeof generalSchema>;
export type AgentConfig = z.infer<typeof agentConfigSchema>;
export type WorkflowConfig = z.infer<typeof workflowConfigSchema>;
export type WorkflowStepConfig = z.infer<typeof workflowStepConfigSchema>;
export type MCPServerConfigSchema = z.infer<typeof mcpServerSchema>;
export type CompactionConfig = z.infer<typeof compactionSchema>;
export type GodModeConfig = z.infer<typeof godmodeSchema>;
export type GodModeConnectorConfig = z.infer<typeof godmodeConnectorSchema>;
export type ServeConfig = z.infer<typeof serveSchema>;
export type ShellConfig = z.infer<typeof shellSchema>;
export type PermissionsConfig = z.infer<typeof permissionsSchema>;
export type DaemonConfig = z.infer<typeof daemonSchema>;
