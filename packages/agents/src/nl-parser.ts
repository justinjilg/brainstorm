import type { AgentRole } from "@brainst0rm/shared";

/** Parsed agent creation intent from natural language. */
export interface AgentCreationIntent {
  id: string;
  role: AgentRole;
  modelId: string;
  budget?: number;
  budgetDaily?: number;
  description?: string;
  guardrailsPii?: boolean;
  expiresInDays?: number;
}

// Model name shortcuts → full model IDs
const MODEL_ALIASES: Record<string, string> = {
  opus: "anthropic/claude-opus-4-6",
  sonnet: "anthropic/claude-sonnet-4-5-20250620",
  haiku: "anthropic/claude-haiku-4-5-20251001",
  gpt: "openai/gpt-4.1",
  "gpt-5": "openai/gpt-5.4",
  "gpt-5.4": "openai/gpt-5.4",
  "gpt-4.1": "openai/gpt-4.1",
  "gpt-4.1-mini": "openai/gpt-4.1-mini",
  gemini: "google/gemini-2.5-flash",
  flash: "google/gemini-2.5-flash",
  deepseek: "deepseek/deepseek-chat",
  o3: "openai/o3-mini",
  local: "auto:local",
  cheap: "auto:price",
  best: "auto:quality",
};

// Role detection patterns
const ROLE_PATTERNS: Array<{ pattern: RegExp; role: AgentRole }> = [
  { pattern: /\b(architect|planner|designer)\b/i, role: "architect" },
  { pattern: /\b(coder|developer|programmer|implementer)\b/i, role: "coder" },
  { pattern: /\b(reviewer|auditor|checker)\b/i, role: "reviewer" },
  { pattern: /\b(debugger|fixer|troubleshooter)\b/i, role: "debugger" },
  { pattern: /\b(analyst|explainer|advisor)\b/i, role: "analyst" },
  { pattern: /\b(marketer|writer|copywriter|content)\b/i, role: "custom" },
];

/**
 * Parse natural language into an AgentCreationIntent.
 * Works offline — no LLM call needed for common patterns.
 *
 * Examples:
 * - "architect using opus with $30 budget"
 * - "coder using gpt-5.4 with $20 budget"
 * - "marketer with $10 budget and PII guardrails"
 * - "reviewer using sonnet with $50 daily budget"
 */
export interface ParseResult {
  intent: AgentCreationIntent | null;
  suggestion?: string;
}

export function parseAgentNL(input: string): ParseResult {
  const lower = input.toLowerCase().trim();

  // Extract role (first word or pattern match)
  let role: AgentRole = "custom";
  let id = "agent";
  for (const { pattern, role: r } of ROLE_PATTERNS) {
    const match = lower.match(pattern);
    if (match) {
      role = r;
      id = match[1].toLowerCase();
      break;
    }
  }

  // Extract model
  let modelId = "auto:quality"; // default to best available
  const modelMatch = lower.match(
    /\b(?:using|with model|model)\s+([a-z0-9._-]+)/,
  );
  if (modelMatch) {
    const alias = modelMatch[1];
    modelId = MODEL_ALIASES[alias] ?? alias;
  }

  // Extract budget (per-workflow)
  let budget: number | undefined;
  const budgetMatch = lower.match(
    /\$(\d+(?:\.\d+)?)\s*(?:budget|per.?workflow)?/,
  );
  if (budgetMatch) {
    budget = parseFloat(budgetMatch[1]);
  }

  // Extract daily budget
  let budgetDaily: number | undefined;
  const dailyMatch = lower.match(/\$(\d+(?:\.\d+)?)\s*(?:daily|per.?day)/);
  if (dailyMatch) {
    budgetDaily = parseFloat(dailyMatch[1]);
  }

  // Extract PII guardrails
  const guardrailsPii = /\bpii\b/i.test(lower);

  // Extract TTL (expires in N days)
  let expiresInDays: number | undefined;
  const ttlMatch = lower.match(/(\d+)\s*day\s*(?:key|ttl|expir)/);
  if (ttlMatch) {
    expiresInDays = parseInt(ttlMatch[1]);
  }

  // Extract description (anything after "that" or "it should" or "to")
  let description: string | undefined;
  const descMatch = input.match(
    /(?:that|it should|should|to)\s+(.+?)(?:\s+(?:with|using|and \$)|\s*$)/i,
  );
  if (descMatch) {
    description = descMatch[1].trim();
  }

  // Require at least a role or model to consider this a valid parse
  if (role === "custom" && modelId === "auto:quality" && !budget) {
    const availableRoles = ROLE_PATTERNS.map((p) => p.role).filter(
      (r) => r !== "custom",
    );
    const availableModels = Object.keys(MODEL_ALIASES).slice(0, 6);
    return {
      intent: null,
      suggestion: `Try: "<role> using <model> with $<budget> budget"\n  Roles: ${availableRoles.join(", ")}\n  Models: ${availableModels.join(", ")}`,
    };
  }

  return {
    intent: {
      id,
      role,
      modelId,
      budget,
      budgetDaily,
      description,
      guardrailsPii,
      expiresInDays,
    },
  };
}

/** Resolve a model alias to its full ID. */
export function resolveModelAlias(alias: string): string {
  return MODEL_ALIASES[alias.toLowerCase()] ?? alias;
}
