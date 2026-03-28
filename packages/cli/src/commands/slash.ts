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
  /** Trigger context compaction, optionally with focus instruction */
  compact?: (focusInstruction?: string) => Promise<void>;
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
  /** Get the context window size of the current model */
  getContextWindow?: () => number;
  /** Remove last user message + assistant response */
  undoLastTurn?: () => number;
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
    usage: "/help [command]",
    execute: (args) => {
      if (args) {
        // Detailed help for specific command
        const cmd = commandMap.get(args.toLowerCase());
        if (!cmd)
          return `Unknown command: /${args}. Type /help for all commands.`;
        const aliases =
          cmd.aliases.length > 0
            ? `\nAliases: ${cmd.aliases.map((a) => "/" + a).join(", ")}`
            : "";
        return `${cmd.usage}\n${cmd.description}${aliases}`;
      }

      // Group commands by category
      const lines = [
        "Commands:",
        "",
        "Chat",
        "  /help [cmd]        Show help (detail for specific command)",
        "  /model [name]      Switch model",
        "  /strategy [name]   Switch routing strategy",
        "  /mode [mode]       Switch permission (auto/confirm/plan)",
        "  /style [style]     Switch output style",
        "  /compact [focus]   Compact context with optional focus",
        "  /context           Show token breakdown",
        "  /cost              Show session cost",
        "  /clear             Clear conversation",
        "",
        "Roles",
        "  /architect [N]     Deep thinking, read-only",
        "  /sr-developer [N]  Quality implementation",
        "  /jr-developer [N]  Fast, cheap coding",
        "  /qa [N]            Testing and review",
        "  /role              Show current role",
        "  /default           Reset to defaults",
        "",
        "Build",
        "  /build [desc]      Multi-model workflow wizard",
        "  /build-go          Execute pending pipeline",
        "  /build-customize   See model options per step",
        "",
        "Intelligence",
        "  /recommend [type]  Get model recommendation from BR",
        "  /stats             Session analytics + BR usage",
        "",
        "System",
        "  /vault [action]    Manage API keys",
        "  /dream             Consolidate memory files",
        "",
        "Modes: Esc toggles Dashboard │ Shift+Tab cycles permission",
      ];
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
    description: "Compact context, optionally with focus instruction",
    usage: "/compact [focus instruction]",
    execute: async (args, ctx) => {
      if (!ctx.compact) return "Compaction not available.";
      await ctx.compact(args || undefined);
      return args ? `Context compacted (focus: ${args})` : "Context compacted.";
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

commands.push({
  name: "context",
  aliases: ["ctx"],
  description: "Show context window token breakdown",
  usage: "/context",
  execute: (_args, ctx) => {
    const tokens = ctx.getTokenCount?.() ?? { input: 0, output: 0 };
    const total = tokens.input + tokens.output;
    const limit = ctx.getContextWindow?.() ?? 128000;
    const percent = Math.round((total / limit) * 100);
    const barWidth = 20;
    const filled = Math.round((percent / 100) * barWidth);
    const bar = "█".repeat(filled) + "░".repeat(barWidth - filled);

    const lines = [
      "Context Window Usage",
      "",
      `  [${bar}] ${percent}%`,
      "",
      `  Input tokens:   ${tokens.input.toLocaleString()}`,
      `  Output tokens:  ${tokens.output.toLocaleString()}`,
      `  Total:          ${total.toLocaleString()} / ${limit.toLocaleString()}`,
      `  Remaining:      ${(limit - total).toLocaleString()}`,
      "",
      percent >= 80
        ? "  ⚠ Context is high. Run /compact to free space."
        : percent >= 60
          ? "  Consider running /compact soon."
          : "  Context usage is healthy.",
    ];
    return lines.join("\n");
  },
});

commands.push({
  name: "undo",
  aliases: [],
  description: "Remove the last user message and assistant response",
  usage: "/undo",
  execute: (_args, ctx) => {
    const removed = ctx.undoLastTurn?.() ?? 0;
    if (removed === 0) return "Nothing to undo.";
    return `Removed ${removed} message${removed > 1 ? "s" : ""}.`;
  },
});

commands.push({
  name: "insights",
  aliases: [],
  description: "Session intelligence — what Brainstorm learned",
  usage: "/insights",
  execute: async (_args, ctx) => {
    const cost = ctx.getSessionCost?.() ?? 0;
    const tokens = ctx.getTokenCount?.() ?? { input: 0, output: 0 };
    const model = ctx.getModel?.() ?? "auto";
    const strategy = ctx.getStrategy?.() ?? "combined";
    const role = ctx.getActiveRole?.();

    const lines = [
      "Session Insights",
      "",
      `  Model: ${model}`,
      `  Strategy: ${strategy}`,
      `  Cost: $${cost.toFixed(4)}`,
      `  Tokens: ${tokens.input.toLocaleString()} in / ${tokens.output.toLocaleString()} out`,
    ];

    if (role) lines.push(`  Role: ${role}`);

    // Cost efficiency
    const totalTokens = tokens.input + tokens.output;
    if (totalTokens > 0) {
      const costPer1k = (cost / totalTokens) * 1000;
      lines.push("");
      lines.push(`  Cost efficiency: $${costPer1k.toFixed(4)} per 1K tokens`);
    }

    // Try BR insights
    if (ctx.gateway) {
      try {
        const waste = await ctx.gateway.getWasteInsights();
        if (waste?.suggestions?.length > 0) {
          lines.push("");
          lines.push("  Optimization suggestions:");
          for (const s of waste.suggestions.slice(0, 3)) {
            lines.push(
              `    → ${s.description} (save ~$${s.savings_usd?.toFixed(2) ?? "?"})`,
            );
          }
        }
      } catch {
        /* BR unavailable */
      }
    }

    return lines.join("\n");
  },
});

// ── Build Wizard ─────────────────────────────────────────────────────

import {
  createWizardState,
  processDescription,
  getModelChoicesForStep,
  updateAssignment,
  formatPipeline,
  buildWorkflowOverrides,
  type WizardState,
} from "./build-wizard.js";

commands.push({
  name: "build",
  aliases: ["b"],
  description: "Multi-model workflow wizard — assemble a dev team",
  usage: "/build [description]",
  execute: async (args, ctx) => {
    if (!args) {
      return [
        "Build Wizard",
        "",
        "/build add OAuth login",
        "/build fix the auth bug",
        "/build review the routing code",
      ].join("\n");
    }

    // Process description and build the pipeline
    let state = createWizardState();
    state = processDescription(state, args);

    if (!state.workflow) {
      return `Could not detect workflow type for: "${args}". Try a clearer description.`;
    }

    // Show the pipeline and return it as the wizard output
    const pipeline = formatPipeline(state);
    const lines = [
      pipeline,
      "",
      "/build-go to run",
      "/build-set 1 2 to change step 1",
      "/build-customize for all options",
    ];

    // Store wizard state in a module-level cache for /build-go
    _pendingWizard = state;

    return lines.join("\n");
  },
});

// Module-level cache for pending wizard state
let _pendingWizard: WizardState | null = null;

commands.push({
  name: "build-go",
  aliases: ["bg"],
  description: "Execute the pending build workflow",
  usage: "/build-go",
  execute: async (_args, ctx) => {
    if (!_pendingWizard || !_pendingWizard.workflow) {
      return "No pending build. Use /build <description> first.";
    }

    const state = _pendingWizard;
    _pendingWizard = null;

    const { stepModelOverrides } = buildWorkflowOverrides(state);

    // Format the execution plan
    const lines = [`Executing: ${state.detectedPreset}`, ""];
    for (const a of state.assignments) {
      lines.push(
        `  ${ROLE_ICONS_SLASH[a.stepRole] ?? "⚙"} ${a.stepRole}: ${a.modelLabel}`,
      );
    }
    lines.push("");
    lines.push(`Estimated cost: ~$${state.totalCost.toFixed(4)}`);
    lines.push("");
    lines.push("Workflow started — results will appear in chat.");

    return lines.join("\n");
  },
});

const ROLE_ICONS_SLASH: Record<string, string> = {
  architect: "🏗",
  coder: "👨‍💻",
  reviewer: "🔍",
  debugger: "🔧",
  analyst: "📊",
};

commands.push({
  name: "build-customize",
  aliases: ["bc"],
  description: "Show model options for each pipeline step",
  usage: "/build-customize",
  execute: (_args, ctx) => {
    if (!_pendingWizard || !_pendingWizard.workflow) {
      return "No pending build. Use /build <description> first.";
    }

    const lines = ["Model options per step:", ""];
    for (let i = 0; i < _pendingWizard.assignments.length; i++) {
      const a = _pendingWizard.assignments[i];
      const choices = getModelChoicesForStep(a.stepRole);
      lines.push(`${i + 1}. ${a.stepRole} [${a.modelLabel}]`);
      choices.forEach((m, j) => {
        const cur = m.modelId === a.modelId ? " ←" : "";
        lines.push(`   ${j + 1}. ${m.label} ${m.cost}${cur}`);
      });
      lines.push(`   /build-set ${i + 1} N`);
      lines.push("");
    }
    return lines.join("\n");
  },
});

commands.push({
  name: "build-set",
  aliases: ["bs"],
  description: "Set model for a pipeline step",
  usage: "/build-set <step> <model-number>",
  execute: (_args, ctx) => {
    if (!_pendingWizard || !_pendingWizard.workflow) {
      return "No pending build. Use /build <description> first.";
    }

    const parts = _args.split(/\s+/);
    const stepIdx = parseInt(parts[0], 10) - 1;
    const modelIdx = parseInt(parts[1], 10) - 1;

    if (
      isNaN(stepIdx) ||
      stepIdx < 0 ||
      stepIdx >= _pendingWizard.assignments.length
    ) {
      return `Invalid step. Use 1-${_pendingWizard.assignments.length}.`;
    }

    const a = _pendingWizard.assignments[stepIdx];
    const choices = getModelChoicesForStep(a.stepRole);

    if (isNaN(modelIdx) || modelIdx < 0 || modelIdx >= choices.length) {
      return `Invalid model. Use 1-${choices.length}.`;
    }

    _pendingWizard = updateAssignment(
      _pendingWizard,
      stepIdx,
      choices[modelIdx],
    );
    const updated = _pendingWizard.assignments[stepIdx];

    return `${a.stepRole} → ${updated.modelLabel}\n\n${formatPipeline(_pendingWizard)}\n\n/build-go to run`;
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
