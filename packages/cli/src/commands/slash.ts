/**
 * Slash command registry and dispatcher.
 *
 * Commands are pure functions that receive a mutable session context and
 * return a string result to display to the user. The ChatApp detects the
 * `/` prefix and routes here instead of sending to the agent loop.
 */

export interface SlashContext {
  /** Switch the active model (name or provider:model format) */
  setModel?: (model: string) => void;
  /** Get the current model name */
  getModel?: () => string | undefined;
  /** Switch routing strategy */
  setStrategy?: (strategy: string) => void;
  /** Get the current routing strategy */
  getStrategy?: () => string;
  /** Switch permission mode */
  setMode?: (mode: string) => void;
  /** Get the current permission mode */
  getMode?: () => string;
  /** Get session cost so far */
  getSessionCost?: () => number;
  /** Get session token counts */
  getTokenCount?: () => { input: number; output: number };
  /** Get remaining budget */
  getBudget?: () => { remaining: number; limit: number } | null;
  /** Clear conversation history */
  clearHistory?: () => void;
  /** Trigger context compaction */
  compact?: () => Promise<void>;
  /** Exit the application */
  exit?: () => void;
  /** Set output style */
  setOutputStyle?: (style: string) => void;
  /** Get current output style */
  getOutputStyle?: () => string;
  /** Run memory consolidation (dream) */
  dream?: () => Promise<string>;
  /** Vault operations (list, add, get) */
  vault?: (action: string, args: string) => Promise<string>;
  /** Rebuild system prompt with optional base prompt override */
  rebuildSystemPrompt?: (basePromptOverride?: string) => void;
  /** Get/set active role */
  getActiveRole?: () => string | undefined;
  setActiveRole?: (role: string | undefined) => void;
  /** BrainstormRouter gateway client for /recommend, /stats, /compare */
  gateway?: any;
}

interface SlashCommand {
  name: string;
  aliases: string[];
  description: string;
  usage: string;
  execute: (
    args: string,
    ctx: SlashContext,
    invokedAs?: string,
  ) => string | Promise<string>;
}

const commands: SlashCommand[] = [
  {
    name: "help",
    aliases: ["h", "?"],
    description: "Show available slash commands",
    usage: "/help",
    execute: () => {
      const lines = ["Available commands:\n"];
      for (const cmd of commands) {
        const aliases =
          cmd.aliases.length > 0
            ? ` (${cmd.aliases.map((a) => "/" + a).join(", ")})`
            : "";
        lines.push(`  ${cmd.usage.padEnd(30)} ${cmd.description}${aliases}`);
      }
      return lines.join("\n");
    },
  },
  {
    name: "model",
    aliases: ["m"],
    description: "Switch or show the active model",
    usage: "/model [name]",
    execute: (args, ctx) => {
      if (!args) {
        const current = ctx.getModel?.() ?? "auto (router-selected)";
        return `Current model: ${current}`;
      }
      ctx.setModel?.(args);
      return `Model switched to: ${args}`;
    },
  },
  {
    name: "strategy",
    aliases: ["fast"],
    description: "Switch routing strategy",
    usage:
      "/strategy [cost-first|quality-first|combined|capability|rule-based]",
    execute: (args, ctx, invokedAs) => {
      const valid = [
        "cost-first",
        "quality-first",
        "combined",
        "capability",
        "rule-based",
      ];
      // /fast with no args → toggle (backward compat)
      if (!args && invokedAs === "fast") {
        const current = ctx.getStrategy?.() ?? "combined";
        const next = current === "cost-first" ? "quality-first" : "cost-first";
        ctx.setStrategy?.(next);
        return `Routing strategy: ${next}`;
      }
      if (!args) {
        return `Current strategy: ${ctx.getStrategy?.() ?? "combined"}. Options: ${valid.join(", ")}`;
      }
      if (!valid.includes(args)) {
        return `Unknown strategy: ${args}. Options: ${valid.join(", ")}`;
      }
      ctx.setStrategy?.(args);
      return `Routing strategy: ${args}`;
    },
  },
  {
    name: "mode",
    aliases: [],
    description: "Switch permission mode",
    usage: "/mode [auto|confirm|plan]",
    execute: (args, ctx) => {
      const valid = ["auto", "confirm", "plan"];
      if (!args) {
        return `Current mode: ${ctx.getMode?.() ?? "confirm"}. Options: ${valid.join(", ")}`;
      }
      if (!valid.includes(args)) {
        return `Invalid mode: ${args}. Options: ${valid.join(", ")}`;
      }
      ctx.setMode?.(args);
      return `Permission mode: ${args}`;
    },
  },
  {
    name: "cost",
    aliases: ["$"],
    description: "Show session cost so far",
    usage: "/cost",
    execute: (_args, ctx) => {
      const cost = ctx.getSessionCost?.() ?? 0;
      const tokens = ctx.getTokenCount?.() ?? { input: 0, output: 0 };
      return `Session cost: $${cost.toFixed(4)}\nTokens: ${tokens.input.toLocaleString()} in / ${tokens.output.toLocaleString()} out`;
    },
  },
  {
    name: "budget",
    aliases: [],
    description: "Show remaining budget",
    usage: "/budget",
    execute: (_args, ctx) => {
      const budget = ctx.getBudget?.();
      if (!budget) return "No budget limit set.";
      const pct = ((budget.remaining / budget.limit) * 100).toFixed(1);
      return `Budget: $${budget.remaining.toFixed(4)} remaining of $${budget.limit.toFixed(4)} (${pct}%)`;
    },
  },
  {
    name: "clear",
    aliases: [],
    description: "Clear conversation history",
    usage: "/clear",
    execute: (_args, ctx) => {
      ctx.clearHistory?.();
      return "Conversation cleared.";
    },
  },
  {
    name: "compact",
    aliases: [],
    description: "Trigger context compaction now",
    usage: "/compact",
    execute: async (_args, ctx) => {
      if (!ctx.compact) return "Compaction not available.";
      await ctx.compact();
      return "Context compacted.";
    },
  },
  {
    name: "style",
    aliases: [],
    description: "Switch output style",
    usage: "/style [concise|detailed|learning]",
    execute: (args, ctx) => {
      const valid = ["concise", "detailed", "learning"];
      if (!args) {
        return `Current style: ${ctx.getOutputStyle?.() ?? "concise"}. Options: ${valid.join(", ")}`;
      }
      if (!valid.includes(args)) {
        return `Invalid style: ${args}. Options: ${valid.join(", ")}`;
      }
      ctx.setOutputStyle?.(args);
      return `Output style: ${args}`;
    },
  },
  {
    name: "quit",
    aliases: ["exit", "q"],
    description: "Exit Brainstorm",
    usage: "/quit",
    execute: (_args, ctx) => {
      ctx.exit?.();
      return "Goodbye.";
    },
  },
  {
    name: "vault",
    aliases: ["keys"],
    description: "Manage API keys in the encrypted vault",
    usage: "/vault [list|add <name>|get <name>|remove <name>|status]",
    execute: async (args, ctx) => {
      if (!ctx.vault) return "Vault not available in this mode.";
      const parts = args.split(/\s+/);
      const action = parts[0] || "list";
      const rest = parts.slice(1).join(" ");
      return ctx.vault(action, rest);
    },
  },
  {
    name: "dream",
    aliases: ["consolidate"],
    description:
      "Consolidate memory files — merge duplicates, fix dates, prune stale refs",
    usage: "/dream",
    execute: async (_args, ctx) => {
      if (!ctx.dream) return "Dream not available in this mode.";
      return ctx.dream();
    },
  },
];

// ── Role Commands ─────────────────────────────────────────────────────
import {
  ROLES,
  formatModelMenu,
  getModelForRole,
  formatRoleConfirmation,
  type RoleId,
} from "./roles.js";

function createRoleCommand(roleId: RoleId): SlashCommand {
  const role = ROLES[roleId];
  return {
    name: roleId,
    aliases: [],
    description: role.description,
    usage: `/${roleId} [model-number]`,
    execute: (args, ctx) => {
      const modelIdx = args ? parseInt(args, 10) : 0;
      if (
        args &&
        (isNaN(modelIdx) || modelIdx < 1 || modelIdx > role.modelChoices.length)
      ) {
        return formatModelMenu(roleId);
      }
      if (!args) {
        return formatModelMenu(roleId);
      }

      // Apply role atomically: model, style, mode, strategy, system prompt
      const modelId = getModelForRole(roleId, modelIdx);
      ctx.setModel?.(modelId);
      ctx.setOutputStyle?.(role.outputStyle);
      ctx.setMode?.(role.permissionMode);
      ctx.setStrategy?.(role.routingStrategy);
      ctx.rebuildSystemPrompt?.(role.systemPrompt);
      ctx.setActiveRole?.(roleId);
      return formatRoleConfirmation(roleId, modelId);
    },
  };
}

for (const roleId of Object.keys(ROLES) as RoleId[]) {
  commands.push(createRoleCommand(roleId));
}

commands.push({
  name: "role",
  aliases: [],
  description: "Show current role or list available roles",
  usage: "/role",
  execute: (_args, ctx) => {
    const current = ctx.getActiveRole?.();
    if (current && ROLES[current as RoleId]) {
      const role = ROLES[current as RoleId];
      const model = ctx.getModel?.() ?? "auto";
      const lines = [
        `${role.icon} ${role.displayName} (active)`,
        `  Model:      ${model}`,
        `  Tools:      ${role.permissionMode === "plan" ? "read-only" : "all"}`,
        `  Style:      ${role.outputStyle}`,
        `  Strategy:   ${role.routingStrategy}`,
        `  Permission: ${role.permissionMode}`,
        ``,
        `Models: ${role.modelChoices.map((m, i) => `${i + 1}.${m.label}`).join(", ")}`,
        `Switch: /${current} N │ /default to reset`,
      ];
      return lines.join("\n");
    }
    const lines = Object.values(ROLES).map(
      (r) =>
        `  /${r.id.padEnd(18)} ${r.icon} ${r.displayName} — ${r.description}`,
    );
    return `Available roles:\n${lines.join("\n")}\n\nUsage: /<role> [model-number]`;
  },
});

commands.push({
  name: "default",
  aliases: ["reset"],
  description: "Reset to default session state (no role)",
  usage: "/default",
  execute: (_args, ctx) => {
    ctx.setActiveRole?.(undefined);
    ctx.rebuildSystemPrompt?.();
    ctx.setMode?.("confirm");
    ctx.setOutputStyle?.("concise");
    ctx.setStrategy?.("combined");
    return "Session reset to defaults.";
  },
});

// ── Utility Commands ──────────────────────────────────────────────────

commands.push({
  name: "history",
  aliases: ["hist"],
  description: "Show recent input history",
  usage: "/history",
  execute: (_args, ctx) => {
    // History is managed in ChatApp's InputHistory — show what's accessible
    return "Input history:\n  Use ↑/↓ arrow keys to navigate previous inputs.\n  History persists across sessions in ~/.brainstorm/input-history.json";
  },
});

// ── BR-Powered Commands ───────────────────────────────────────────────

commands.push({
  name: "recommend",
  aliases: ["rec"],
  description: "Get model recommendation from BrainstormRouter",
  usage: "/recommend [task-type]",
  execute: async (args, ctx) => {
    if (!ctx.gateway) return "No BrainstormRouter API key configured.";
    try {
      const { IntelligenceAPIClient } = await import("@brainstorm/gateway");
      const key =
        process.env._BR_RESOLVED_KEY ?? process.env.BRAINSTORM_API_KEY;
      if (!key) return "No BR API key available.";
      const intel = new IntelligenceAPIClient(key);
      const taskType = args || "code-generation";
      const recs = await intel.getRecommendations(taskType, "typescript");
      if (!recs || recs.length === 0)
        return `No recommendations for task type: ${taskType}`;
      const lines = recs.slice(0, 3).map((r: any, i: number) => {
        return `  ${i + 1}. ${r.recommendedModel ?? r.model} (${Math.round((r.confidence ?? r.score ?? 0) * 100)}% confidence)\n     ${r.reasoning ?? ""}`;
      });
      return `Model recommendations for "${taskType}":\n${lines.join("\n")}\n\nUse: /model <id> to switch`;
    } catch (err: any) {
      return `Recommendation failed: ${err.message}`;
    }
  },
});

commands.push({
  name: "stats",
  aliases: [],
  description: "Show session analytics and BR usage summary",
  usage: "/stats",
  execute: async (_args, ctx) => {
    const cost = ctx.getSessionCost?.() ?? 0;
    const tokens = ctx.getTokenCount?.() ?? { input: 0, output: 0 };
    const model = ctx.getModel?.() ?? "auto";
    const role = ctx.getActiveRole?.();
    const strategy = ctx.getStrategy?.() ?? "combined";

    const lines = [
      "Session Stats",
      `  Cost:     $${cost.toFixed(4)}`,
      `  Tokens:   ${tokens.input.toLocaleString()} in / ${tokens.output.toLocaleString()} out`,
      `  Model:    ${model}`,
      `  Strategy: ${strategy}`,
    ];
    if (role) lines.push(`  Role:     ${role}`);

    // Try to get BR usage summary
    if (ctx.gateway) {
      try {
        const summary = await ctx.gateway.getUsageSummary("daily");
        if (summary) {
          lines.push("");
          lines.push("BrainstormRouter (today)");
          lines.push(`  Requests: ${summary.total_requests ?? 0}`);
          lines.push(
            `  Cost:     $${(summary.total_cost_usd ?? 0).toFixed(4)}`,
          );
          if (summary.by_model?.length > 0) {
            lines.push("  By model:");
            for (const m of summary.by_model.slice(0, 5)) {
              lines.push(
                `    ${m.model}: $${m.cost_usd?.toFixed(4) ?? "0"} (${m.request_count ?? 0} reqs)`,
              );
            }
          }
        }
      } catch {
        // BR data unavailable — skip silently
      }
    }

    return lines.join("\n");
  },
});

commands.push({
  name: "compare",
  aliases: [],
  description: "Compare two models side by side",
  usage: "/compare <model1> <model2>",
  execute: (_args, ctx) => {
    const parts = _args.split(/\s+/);
    if (parts.length < 2)
      return "Usage: /compare model1 model2\nExample: /compare anthropic/claude-sonnet-4-6 deepseek/deepseek-chat";

    // This is a local comparison using registry data — no BR call needed
    return `Model comparison for: ${parts[0]} vs ${parts[1]}\n  (Switch to Models mode [Esc → 3] for detailed comparison with gauges)`;
  },
});

// Build lookup map: command name and aliases → handler
const commandMap = new Map<string, SlashCommand>();
for (const cmd of commands) {
  commandMap.set(cmd.name, cmd);
  for (const alias of cmd.aliases) {
    commandMap.set(alias, cmd);
  }
}

/**
 * Check if a string is a slash command.
 */
export function isSlashCommand(input: string): boolean {
  const trimmed = input.trim();
  if (!trimmed.startsWith("/")) return false;
  const name = trimmed.slice(1).split(/\s+/)[0].toLowerCase();
  return commandMap.has(name);
}

/**
 * Execute a slash command. Returns the display result.
 * Throws if the command is not recognized.
 */
export async function executeSlashCommand(
  input: string,
  ctx: SlashContext,
): Promise<string> {
  const trimmed = input.trim();
  const parts = trimmed.slice(1).split(/\s+/);
  const name = parts[0].toLowerCase();
  const args = parts.slice(1).join(" ");

  const cmd = commandMap.get(name);
  if (!cmd) {
    return `Unknown command: /${name}. Type /help for available commands.`;
  }

  // Pass the invoked name so commands can detect alias invocation (e.g., /fast vs /strategy)
  return cmd.execute(args, ctx, name);
}

/**
 * Get all registered slash commands (for autocomplete, etc.)
 */
export function getSlashCommands(): Array<{
  name: string;
  description: string;
  usage: string;
}> {
  return commands.map(({ name, description, usage }) => ({
    name,
    description,
    usage,
  }));
}
