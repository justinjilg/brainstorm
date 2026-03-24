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
}

interface SlashCommand {
  name: string;
  aliases: string[];
  description: string;
  usage: string;
  execute: (args: string, ctx: SlashContext, invokedAs?: string) => string | Promise<string>;
}

const commands: SlashCommand[] = [
  {
    name: 'help',
    aliases: ['h', '?'],
    description: 'Show available slash commands',
    usage: '/help',
    execute: () => {
      const lines = ['Available commands:\n'];
      for (const cmd of commands) {
        const aliases = cmd.aliases.length > 0 ? ` (${cmd.aliases.map((a) => '/' + a).join(', ')})` : '';
        lines.push(`  ${cmd.usage.padEnd(30)} ${cmd.description}${aliases}`);
      }
      return lines.join('\n');
    },
  },
  {
    name: 'model',
    aliases: ['m'],
    description: 'Switch or show the active model',
    usage: '/model [name]',
    execute: (args, ctx) => {
      if (!args) {
        const current = ctx.getModel?.() ?? 'auto (router-selected)';
        return `Current model: ${current}`;
      }
      ctx.setModel?.(args);
      return `Model switched to: ${args}`;
    },
  },
  {
    name: 'strategy',
    aliases: ['fast'],
    description: 'Switch routing strategy',
    usage: '/strategy [cost-first|quality-first|combined|capability|rule-based]',
    execute: (args, ctx, invokedAs) => {
      const valid = ['cost-first', 'quality-first', 'combined', 'capability', 'rule-based'];
      // /fast with no args → toggle (backward compat)
      if (!args && invokedAs === 'fast') {
        const current = ctx.getStrategy?.() ?? 'combined';
        const next = current === 'cost-first' ? 'quality-first' : 'cost-first';
        ctx.setStrategy?.(next);
        return `Routing strategy: ${next}`;
      }
      if (!args) {
        return `Current strategy: ${ctx.getStrategy?.() ?? 'combined'}. Options: ${valid.join(', ')}`;
      }
      if (!valid.includes(args)) {
        return `Unknown strategy: ${args}. Options: ${valid.join(', ')}`;
      }
      ctx.setStrategy?.(args);
      return `Routing strategy: ${args}`;
    },
  },
  {
    name: 'mode',
    aliases: [],
    description: 'Switch permission mode',
    usage: '/mode [auto|confirm|plan]',
    execute: (args, ctx) => {
      const valid = ['auto', 'confirm', 'plan'];
      if (!args) {
        return `Current mode: ${ctx.getMode?.() ?? 'confirm'}. Options: ${valid.join(', ')}`;
      }
      if (!valid.includes(args)) {
        return `Invalid mode: ${args}. Options: ${valid.join(', ')}`;
      }
      ctx.setMode?.(args);
      return `Permission mode: ${args}`;
    },
  },
  {
    name: 'cost',
    aliases: ['$'],
    description: 'Show session cost so far',
    usage: '/cost',
    execute: (_args, ctx) => {
      const cost = ctx.getSessionCost?.() ?? 0;
      const tokens = ctx.getTokenCount?.() ?? { input: 0, output: 0 };
      return `Session cost: $${cost.toFixed(4)}\nTokens: ${tokens.input.toLocaleString()} in / ${tokens.output.toLocaleString()} out`;
    },
  },
  {
    name: 'budget',
    aliases: [],
    description: 'Show remaining budget',
    usage: '/budget',
    execute: (_args, ctx) => {
      const budget = ctx.getBudget?.();
      if (!budget) return 'No budget limit set.';
      const pct = ((budget.remaining / budget.limit) * 100).toFixed(1);
      return `Budget: $${budget.remaining.toFixed(4)} remaining of $${budget.limit.toFixed(4)} (${pct}%)`;
    },
  },
  {
    name: 'clear',
    aliases: [],
    description: 'Clear conversation history',
    usage: '/clear',
    execute: (_args, ctx) => {
      ctx.clearHistory?.();
      return 'Conversation cleared.';
    },
  },
  {
    name: 'compact',
    aliases: [],
    description: 'Trigger context compaction now',
    usage: '/compact',
    execute: async (_args, ctx) => {
      if (!ctx.compact) return 'Compaction not available.';
      await ctx.compact();
      return 'Context compacted.';
    },
  },
  {
    name: 'style',
    aliases: [],
    description: 'Switch output style',
    usage: '/style [concise|detailed|learning]',
    execute: (args, ctx) => {
      const valid = ['concise', 'detailed', 'learning'];
      if (!args) {
        return `Current style: ${ctx.getOutputStyle?.() ?? 'concise'}. Options: ${valid.join(', ')}`;
      }
      if (!valid.includes(args)) {
        return `Invalid style: ${args}. Options: ${valid.join(', ')}`;
      }
      ctx.setOutputStyle?.(args);
      return `Output style: ${args}`;
    },
  },
  {
    name: 'quit',
    aliases: ['exit', 'q'],
    description: 'Exit Brainstorm',
    usage: '/quit',
    execute: (_args, ctx) => {
      ctx.exit?.();
      return 'Goodbye.';
    },
  },
  {
    name: 'dream',
    aliases: ['consolidate'],
    description: 'Consolidate memory files — merge duplicates, fix dates, prune stale refs',
    usage: '/dream',
    execute: async (_args, ctx) => {
      if (!ctx.dream) return 'Dream not available in this mode.';
      return ctx.dream();
    },
  },
];

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
  if (!trimmed.startsWith('/')) return false;
  const name = trimmed.slice(1).split(/\s+/)[0].toLowerCase();
  return commandMap.has(name);
}

/**
 * Execute a slash command. Returns the display result.
 * Throws if the command is not recognized.
 */
export async function executeSlashCommand(input: string, ctx: SlashContext): Promise<string> {
  const trimmed = input.trim();
  const parts = trimmed.slice(1).split(/\s+/);
  const name = parts[0].toLowerCase();
  const args = parts.slice(1).join(' ');

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
export function getSlashCommands(): Array<{ name: string; description: string; usage: string }> {
  return commands.map(({ name, description, usage }) => ({ name, description, usage }));
}
