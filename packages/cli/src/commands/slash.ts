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
  /** Push an inline interactive prompt (SelectPrompt). Returns user's selection. */
  prompt?: (
    question: string,
    options: Array<{
      label: string;
      value: string;
      description?: string;
      recommended?: boolean;
    }>,
  ) => Promise<string>;
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
        "  /plan              Toggle plan mode (describe before execute)",
        "  /efficiency        Token usage and routing savings",
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
  {
    name: "project",
    aliases: ["proj"],
    description: "Manage projects — switch, list, show dashboard",
    usage: "/project [name|list|register|show <name>]",
    execute: async (args, ctx) => {
      const { ProjectManager } = await import("@brainst0rm/projects");
      const { getDb } = await import("@brainst0rm/db");
      const db = getDb();
      const pm = new ProjectManager(db);

      const parts = args.trim().split(/\s+/);
      const action = parts[0] || "";

      if (!action || action === "list") {
        const projects = pm.projects.list();
        if (projects.length === 0) {
          return "No projects registered. Run: /project register or storm projects import ~/Projects";
        }
        const active = pm.getActive();
        const lines = projects.map((p) => {
          const marker = active && active.id === p.id ? " ← active" : "";
          return `  ${p.name.padEnd(25)} ${p.path}${marker}`;
        });
        return `Projects:\n${lines.join("\n")}`;
      }

      if (action === "register") {
        const path = parts[1] || process.cwd();
        try {
          const project = pm.register(path);
          return `✓ Registered "${project.name}" → ${project.path}`;
        } catch (err) {
          return `✗ ${err instanceof Error ? err.message : String(err)}`;
        }
      }

      if (action === "show") {
        const name = parts[1];
        if (!name) return "Usage: /project show <name>";
        const project = pm.projects.getByName(name);
        if (!project) return `Project "${name}" not found.`;
        const dash = pm.dashboard(project.id);
        if (!dash) return "Failed to load dashboard.";
        const lines = [
          `── ${project.name} ──`,
          `Path: ${project.path}`,
          project.description ? `Description: ${project.description}` : "",
          `Sessions: ${dash.sessionCount}`,
          `Cost today: $${dash.costToday.toFixed(4)}`,
          `Cost month: $${dash.costThisMonth.toFixed(4)}`,
        ].filter(Boolean);
        if (project.budgetDaily)
          lines.push(
            `Budget daily: $${project.budgetDaily.toFixed(2)} (${dash.budgetDailyUsed.toFixed(0)}% used)`,
          );
        if (project.budgetMonthly)
          lines.push(
            `Budget month: $${project.budgetMonthly.toFixed(2)} (${dash.budgetMonthlyUsed.toFixed(0)}% used)`,
          );
        return lines.join("\n");
      }

      // Default: treat arg as project name to switch to
      try {
        const project = pm.switch(action);
        ctx.rebuildSystemPrompt?.();
        return `✓ Switched to "${project.name}" (${project.path})`;
      } catch (err) {
        return `✗ ${err instanceof Error ? err.message : String(err)}`;
      }
    },
  },
  {
    name: "schedule",
    aliases: ["sched", "cron"],
    description: "Manage scheduled tasks for the active project",
    usage: "/schedule [list|add|history]",
    execute: async (args) => {
      const parts = args.trim().split(/\s+/);
      const action = parts[0] || "list";

      if (action === "list" || !action) {
        // Lazy-load scheduler
        const { getDb } = await import("@brainst0rm/db");
        const db = getDb();
        const tasks = db
          .prepare(
            "SELECT * FROM scheduled_tasks WHERE status = 'active' ORDER BY name",
          )
          .all() as any[];

        if (tasks.length === 0) {
          return 'No scheduled tasks. Use: storm schedule add "<prompt>" --project <name> --cron "0 9 * * *"';
        }

        const lines = tasks.map((t: any) => {
          const cron = t.cron_expression || "one-shot";
          const mutations = t.allow_mutations ? "read+write" : "read-only";
          return `  ${t.name.padEnd(25)} ${cron.padEnd(15)} ${mutations.padEnd(12)} $${(t.budget_limit ?? 0).toFixed(2)}`;
        });
        return `Scheduled Tasks:\n${lines.join("\n")}`;
      }

      if (action === "history") {
        const { getDb } = await import("@brainst0rm/db");
        const db = getDb();
        const runs = db
          .prepare(
            "SELECT r.*, t.name as task_name FROM scheduled_task_runs r JOIN scheduled_tasks t ON r.task_id = t.id ORDER BY r.created_at DESC LIMIT 10",
          )
          .all() as any[];

        if (runs.length === 0) return "No task run history yet.";

        const lines = runs.map((r: any) => {
          const status =
            r.status === "completed"
              ? "✓"
              : r.status === "failed"
                ? "✗"
                : r.status;
          const cost = `$${r.cost.toFixed(4)}`;
          const date = new Date(r.created_at * 1000).toLocaleDateString();
          return `  ${status} ${(r.task_name ?? "").padEnd(20)} ${cost.padEnd(10)} ${date}`;
        });
        return `Recent Runs:\n${lines.join("\n")}`;
      }

      return `Unknown action "${action}". Usage: /schedule [list|history]`;
    },
  },
  {
    name: "orchestrate",
    aliases: ["orch"],
    description: "Coordinate work across multiple projects",
    usage: '/orchestrate "<description>" [project1,project2,...]',
    execute: async (args) => {
      const { OrchestrationEngine } = await import("@brainst0rm/orchestrator");
      const { ProjectManager } = await import("@brainst0rm/projects");
      const { getDb } = await import("@brainst0rm/db");
      const db = getDb();
      const engine = new OrchestrationEngine(db);
      const pm = new ProjectManager(db);

      if (!args.trim()) {
        // Show recent runs
        const runs = engine.listRecent(5);
        if (runs.length === 0) {
          return 'No orchestrations yet. Usage: /orchestrate "do something" project1,project2';
        }
        const lines = runs.map((r) => {
          const icon =
            r.status === "completed" ? "✓" : r.status === "failed" ? "✗" : "●";
          return `  ${icon} ${r.name.slice(0, 50)} — ${r.status} ($${r.totalCost.toFixed(4)})`;
        });
        return `Recent orchestrations:\n${lines.join("\n")}`;
      }

      // Parse: "description" project1,project2
      const match =
        args.match(/^"([^"]+)"\s+(.+)$/) ?? args.match(/^(.+?)\s+([\w,-]+)$/);
      if (!match) {
        return 'Usage: /orchestrate "description" project1,project2';
      }

      const description = match[1];
      const projectNames = match[2].split(",").map((s: string) => s.trim());

      const lines: string[] = [
        `Orchestrating: "${description}"`,
        `Projects: ${projectNames.join(", ")}`,
        "",
      ];

      for await (const event of engine.run({ description, projectNames })) {
        if (event.type === "task-started") {
          lines.push(`● ${event.project.name} — starting...`);
        } else if (event.type === "task-completed") {
          lines.push(`✓ ${event.project.name} — $${event.cost.toFixed(4)}`);
        } else if (event.type === "task-failed") {
          lines.push(`✗ ${event.project.name} — ${event.error}`);
        } else if (event.type === "orchestration-completed") {
          lines.push("", `Complete: $${event.run.totalCost.toFixed(4)} total`);
        }
      }

      return lines.join("\n");
    },
  },
  {
    name: "intelligence",
    aliases: ["intel"],
    description: "Show what BrainstormRouter has learned",
    usage: "/intelligence [--json]",
    execute: async (args, _ctx) => {
      const { createGatewayClient, createIntelligenceClient } =
        await import("@brainst0rm/gateway");
      const gw = createGatewayClient();
      if (!gw) return "No BRAINSTORM_API_KEY set.";

      const intel = createIntelligenceClient();
      const asJson = args.includes("--json");

      const [leaderboard, usage, waste, forecast] = await Promise.all([
        gw.getLeaderboard().catch(() => []),
        gw.getUsageSummary("weekly").catch(() => null),
        gw.getWasteInsights().catch(() => null),
        gw.getForecast().catch(() => null),
      ]);

      if (asJson) {
        return JSON.stringify({ leaderboard, usage, waste, forecast }, null, 2);
      }

      const lines: string[] = [];
      lines.push("BrainstormRouter Intelligence Report");
      lines.push("══════════════════════════════════════");

      const ud = (usage as any)?.data?.[0];
      const reqs = ud?.requestCount ?? 0;
      lines.push(
        `\nRequests: ${reqs.toLocaleString()} | Cost: $${(ud?.totalCostUsd ?? 0).toFixed(2)}`,
      );

      const real = leaderboard.filter(
        (m: any) => m.id && !m.id.startsWith("cache/"),
      );
      if (real.length > 0) {
        lines.push("\nTop Models:");
        for (const m of real.slice(0, 5) as any[]) {
          const name = m.model_id ?? m.id ?? "?";
          const reward =
            m.reward_score != null
              ? (m.reward_score * 100).toFixed(0) + "%"
              : "n/a";
          lines.push(
            `  ${name} — reward:${reward} (${m.sample_count ?? 0} samples)`,
          );
        }
      }

      const fc = (forecast as any)?.forecast;
      if (fc) {
        const trend =
          fc.trend === "increasing"
            ? "↑"
            : fc.trend === "decreasing"
              ? "↓"
              : "→";
        lines.push(
          `\nForecast: $${(fc.avgDailySpendUsd ?? 0).toFixed(2)}/day ${trend}`,
        );
      }

      const w = waste as any;
      if (w?.estimatedWasteUsd > 0) {
        lines.push(`\nRecoverable waste: $${w.estimatedWasteUsd.toFixed(4)}`);
      }

      return lines.join("\n");
    },
  },
  {
    name: "plan",
    aliases: [],
    description: "Toggle plan mode — agent describes changes before executing",
    usage: "/plan",
    execute: async (_args, ctx) => {
      const current = ctx.getMode?.() ?? "auto";
      if (current === "plan") {
        ctx.setMode?.("auto");
        return "Plan mode OFF — agent will execute directly.";
      }
      ctx.setMode?.("plan");
      return "Plan mode ON — agent will describe changes before executing. Approve to proceed.";
    },
  },
  {
    name: "efficiency",
    aliases: ["eff"],
    description: "Show token efficiency and cost savings from routing",
    usage: "/efficiency",
    execute: async (_args, ctx) => {
      const tokens = ctx.getTokenCount?.() ?? { input: 0, output: 0 };
      const cost = ctx.getSessionCost?.() ?? 0;
      const totalTokens = tokens.input + tokens.output;

      // Estimate what single-model costs would be
      const opusCostPer1M = 75; // output price
      const sonnetCostPer1M = 15;
      const haikuCostPer1M = 4;

      const opusCost = (totalTokens / 1_000_000) * opusCostPer1M;
      const sonnetCost = (totalTokens / 1_000_000) * sonnetCostPer1M;
      const haikuCost = (totalTokens / 1_000_000) * haikuCostPer1M;

      const savings =
        opusCost > 0 ? Math.round((1 - cost / opusCost) * 100) : 0;

      const lines = [
        "Token Efficiency Report",
        "══════════════════════════════════════",
        "",
        `Tokens used: ${totalTokens.toLocaleString()} (${tokens.input.toLocaleString()} in / ${tokens.output.toLocaleString()} out)`,
        `Actual cost:  $${cost.toFixed(4)} (with routing)`,
        "",
        "If you used a single model for everything:",
        `  Opus only:   $${opusCost.toFixed(4)}`,
        `  Sonnet only: $${sonnetCost.toFixed(4)}`,
        `  Haiku only:  $${haikuCost.toFixed(4)}`,
        "",
        `Savings vs Opus: ${savings}%`,
      ];
      return lines.join("\n");
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
    execute: async (args, ctx) => {
      let modelId: string;

      if (args) {
        // Direct: /architect 2
        modelId = getModelForRole(roleId, parseInt(args, 10));
      } else if (ctx.prompt) {
        // Interactive: show inline SelectPrompt
        const selected = await ctx.prompt(
          `${role.icon} ${role.displayName} — pick model`,
          role.modelChoices.map((m) => ({
            label: m.label,
            value: m.modelId,
            description: `${m.cost} per 1M tokens`,
            recommended: m.default,
          })),
        );
        modelId = selected;
      } else {
        // Fallback: show text menu
        return formatModelMenu(roleId);
      }

      // Apply role atomically
      ctx.setModel?.(modelId);
      ctx.setOutputStyle?.(role.outputStyle);
      ctx.setMode?.(role.permissionMode);
      ctx.setStrategy?.(role.routingStrategy);
      // Use persona-composed prompt (model-tuned expert playbook)
      const { getRolePrompt } = await import("./roles.js");
      ctx.rebuildSystemPrompt?.(getRolePrompt(roleId, modelId));
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
        `  Tools:      ${role.allowedTools ? `only: ${role.allowedTools.join(", ")}` : role.blockedTools ? `all except: ${role.blockedTools.join(", ")}` : "all"}`,
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
  name: "changelog",
  aliases: ["whatsnew"],
  description: "Show recent features and changes",
  usage: "/changelog",
  execute: () => {
    return [
      "What's New in Brainstorm",
      "",
      "v11 — Claude Code Parity",
      "  /context      Token breakdown with visual gauge",
      "  /insights     Session intelligence + BR waste tips",
      "  /undo         Remove last turn",
      "  /build        Multi-model workflow wizard",
      "  Shift+Tab     Cycle permission modes",
      "  SelectPrompt  Model asks you to pick from options",
      "  Autocomplete  Type / to see command suggestions",
      "  Multi-line    End line with \\ to continue",
      "  Error badges  [NETWORK] [BUDGET] [AUTH] with hints",
      "  ?             Shortcut overlay (in non-chat modes)",
      "",
      "v10 — DeerFlow Gaps",
      "  Artifacts     Workflow outputs persist to disk",
      "  Temporal      System prompt includes current date",
      "  Style         Detects comment style, JSDoc, line length",
      "  Test parsing  vitest/jest/pytest structured results",
      "",
      "v9 — Build Wizard",
      "  /build desc   Auto-detect workflow + assign models",
      "",
      "v7 — Dashboard",
      "  4 modes: Chat [1] Dashboard [2] Models [3] Config [4]",
      "  BR leaderboard, waste detection, guardian audit",
      "",
      "v6 — Roles",
      "  /architect /sr-developer /jr-developer /qa",
    ].join("\n");
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
      return "Usage: /build <what you want to build>\nExample: /build add OAuth login";
    }

    // Process description and build the pipeline
    let state = createWizardState();
    state = processDescription(state, args);

    if (!state.workflow) {
      return `Could not detect workflow type for: "${args}"`;
    }

    // If prompt() is available, use interactive inline selection
    if (ctx.prompt) {
      // Step 1: Confirm workflow type
      const action = await ctx.prompt(
        `Detected: ${state.detectedPreset} (${state.assignments.length} steps)`,
        [
          {
            label: "Go with defaults",
            value: "defaults",
            description: formatPipeline(state),
            recommended: true,
          },
          { label: "Customize models", value: "customize" },
          { label: "Cancel", value: "cancel" },
        ],
      );

      if (action === "cancel") return "Build cancelled.";

      if (action === "customize") {
        // Step 2: For each pipeline step, let user pick model
        for (let i = 0; i < state.assignments.length; i++) {
          const a = state.assignments[i];
          const choices = getModelChoicesForStep(a.stepRole);
          const selected = await ctx.prompt(
            `Step ${i + 1}: ${a.stepRole}`,
            choices.map((m) => ({
              label: m.label,
              value: m.modelId,
              description: `${m.cost} per 1M tokens`,
              recommended: m.modelId === a.modelId,
            })),
          );
          const choice = choices.find((m) => m.modelId === selected);
          if (choice) state = updateAssignment(state, i, choice);
        }
      }

      // Show final pipeline
      return `${formatPipeline(state)}\n\nReady to execute. Use /build-go to start.`;
    }

    // Fallback: text-based menu (no prompt() available)
    _pendingWizard = state;
    return `${formatPipeline(state)}\n\n/build-go to run │ /build-customize for options`;
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

// ── Plan & Efficiency Commands ────────────────────────────────────────

commands.push({
  name: "plan",
  aliases: [],
  description: "Toggle plan mode — agent describes changes before executing",
  usage: "/plan",
  execute: (_args, ctx) => {
    const current = ctx.getMode?.() ?? "confirm";
    if (current === "plan") {
      ctx.setMode?.("confirm");
      return "Plan mode OFF — agent will execute changes directly (with confirmation).";
    }
    ctx.setMode?.("plan");
    return "Plan mode ON — agent will describe changes before executing. Approve to proceed.";
  },
});

commands.push({
  name: "efficiency",
  aliases: ["eff"],
  description: "Show token efficiency and routing savings",
  usage: "/efficiency",
  execute: (_args, ctx) => {
    const tokens = ctx.getTokenCount?.() ?? { input: 0, output: 0 };
    const cost = ctx.getSessionCost?.() ?? 0;
    const totalTokens = tokens.input + tokens.output;

    // Opus 4.6 pricing: $15/1M input, $75/1M output
    const opusInputCost = (tokens.input / 1_000_000) * 15;
    const opusOutputCost = (tokens.output / 1_000_000) * 75;
    const opusCost = opusInputCost + opusOutputCost;

    const savings = opusCost > 0 ? ((opusCost - cost) / opusCost) * 100 : 0;

    const lines = [
      "Token Efficiency Report",
      "",
      `  Input tokens:   ${tokens.input.toLocaleString()}`,
      `  Output tokens:  ${tokens.output.toLocaleString()}`,
      `  Total tokens:   ${totalTokens.toLocaleString()}`,
      "",
      `  Session cost:   $${cost.toFixed(4)}`,
    ];

    if (totalTokens > 0) {
      lines.push(
        `  Cost per 1K:    $${((cost / totalTokens) * 1000).toFixed(4)}`,
      );
    }

    lines.push("");
    lines.push(`  If you used Opus for everything: $${opusCost.toFixed(4)}`);
    lines.push(`  With routing:                    $${cost.toFixed(4)}`);
    lines.push(
      `  Savings:                         ${savings > 0 ? savings.toFixed(1) : "0"}%`,
    );

    if (savings > 50) {
      lines.push("");
      lines.push("  Routing is saving you significant cost.");
    } else if (savings > 0) {
      lines.push("");
      lines.push(
        "  Tip: Use /strategy cost-first for cheaper tasks to increase savings.",
      );
    }

    return lines.join("\n");
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
      const { IntelligenceAPIClient } = await import("@brainst0rm/gateway");
      const key =
        process.env._BR_RESOLVED_KEY ?? process.env.BRAINSTORM_API_KEY;
      if (!key) return "No BR API key available.";
      const intel = new IntelligenceAPIClient(
        "https://api.brainstormrouter.com",
        key,
      );
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

// ── Architect-Edit: dual-model pattern ────────────────────────────────
// Opus plans the change, Sonnet applies it. Two routing decisions per task.

commands.push({
  name: "architect-edit",
  aliases: ["ae", "dual"],
  description:
    "Dual-model mode: reasoning model plans, fast model applies (Aider-style)",
  usage: "/architect-edit [task description]",
  execute: async (args, ctx) => {
    if (!args.trim()) {
      return "Usage: /architect-edit <task description>\n\nA reasoning model (Opus/GPT-5.4) will plan the change, then a fast model (Sonnet/GPT-4.1) will apply it.";
    }

    // Phase 1: Switch to architect role for planning
    const { ROLES, getRolePrompt } = await import("./roles.js");
    const architect = ROLES.architect;
    const planModel =
      architect.modelChoices[0]?.modelId ?? "anthropic/claude-opus-4.6";

    ctx.setModel?.(planModel);
    ctx.setMode?.("plan");
    ctx.rebuildSystemPrompt?.(
      getRolePrompt("architect", planModel) +
        "\n\n## Architect-Edit Mode\n\n" +
        "You are in Phase 1 (PLAN). Your job is to analyze the codebase and produce a detailed, " +
        "actionable implementation plan. Do NOT make any changes — only read files and produce the plan. " +
        "Include specific file paths, function names, and code snippets. " +
        "After you present the plan, the user will approve it and a fast coding model will execute it.\n\n" +
        `Task: ${args.trim()}`,
    );

    return [
      `🏗️ Architect-Edit mode activated`,
      ``,
      `  Phase 1 (PLAN): ${planModel}`,
      `  Phase 2 (EDIT): will auto-switch to fast model after approval`,
      ``,
      `Describe your changes and the architect will plan them.`,
      `After approving the plan, type /ae-apply to switch to the coding model.`,
    ].join("\n");
  },
});

commands.push({
  name: "ae-apply",
  aliases: ["apply"],
  description: "Switch from architect plan phase to coding apply phase",
  usage: "/ae-apply",
  execute: async (_args, ctx) => {
    // Phase 2: Switch to fast coding model
    const { ROLES } = await import("./roles.js");
    const dev = ROLES["sr-developer"];
    const codeModel =
      dev.modelChoices[0]?.modelId ?? "anthropic/claude-sonnet-4.6";

    ctx.setModel?.(codeModel);
    ctx.setMode?.("auto");
    ctx.rebuildSystemPrompt?.();

    return [
      `⚡ Switched to coding model: ${codeModel}`,
      ``,
      `The plan from the architect is in your conversation history.`,
      `Now implement it. Auto-verify after each edit.`,
    ].join("\n");
  },
});

// ── Recipe commands ──────────────────────────────────────────────────

commands.push({
  name: "recipe",
  aliases: ["recipes"],
  description: "List, run, or init shareable YAML workflow recipes",
  usage: "/recipe [list|run <name>|init]",
  execute: async (args, ctx) => {
    const { listRecipes, loadRecipe, initRecipeDir } =
      await import("@brainst0rm/workflow");
    const cwd = process.cwd();
    const parts = args.trim().split(/\s+/);
    const subcommand = parts[0]?.toLowerCase() ?? "list";

    if (subcommand === "init") {
      const dir = initRecipeDir(cwd);
      return `Recipe directory initialized: ${dir}\nAn example recipe was created. Edit it or add new .yaml files.`;
    }

    if (subcommand === "run") {
      const name = parts[1];
      if (!name) return "Usage: /recipe run <name>";
      const recipe = loadRecipe(cwd, name);
      if (!recipe)
        return `Recipe '${name}' not found. Run /recipe list to see available recipes.`;
      return [
        `Recipe loaded: ${recipe.name}`,
        `  ${recipe.description}`,
        `  Steps: ${recipe.steps.map((s: any) => s.id).join(" → ")}`,
        `  Max iterations: ${recipe.maxIterations}`,
        ``,
        `To execute, describe the task and the workflow engine will use this recipe.`,
      ].join("\n");
    }

    // Default: list
    const recipes = listRecipes(cwd);
    if (recipes.length === 0) {
      return "No recipes found. Run /recipe init to create the recipe directory with an example.";
    }
    const lines = recipes.map(
      (r: any) =>
        `  ${r.id.padEnd(20)} ${r.name} (${r.source}) — ${r.description}`,
    );
    return `Available recipes:\n${lines.join("\n")}\n\nUsage: /recipe run <name>`;
  },
});

// ── Voice command ─────────────────────────────────────────────────

commands.push({
  name: "voice",
  aliases: ["mic"],
  description: "Record voice input and transcribe via Whisper (requires sox)",
  usage: "/voice",
  execute: async () => {
    const { AudioRecorder } = await import("../voice/recorder.js");

    if (!AudioRecorder.isAvailable()) {
      return "Voice input requires `sox`. Install: brew install sox (macOS) or apt install sox (Linux).";
    }

    const recorder = new AudioRecorder();
    const outputPath = recorder.start();
    return [
      "🎙️ Recording... Press Enter to stop.",
      "",
      `  Audio file: ${outputPath}`,
      `  Transcription will be sent via BrainstormRouter Whisper API.`,
      "",
      "  Note: Full voice loop (record → transcribe → send) is coming in a future update.",
      "  For now, the audio file is saved for manual transcription.",
    ].join("\n");
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
