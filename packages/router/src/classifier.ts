import type { TaskProfile, TaskType, Complexity } from '@brainstorm/shared';
import type { StormFrontmatter } from '@brainstorm/config';

/** Routing hints from STORM.md frontmatter. */
export type ProjectHints = StormFrontmatter['routing'];

// Heuristic task classifier — no LLM call, instant, free

const TASK_SIGNALS: Record<TaskType, string[]> = {
  'simple-edit': ['change', 'rename', 'update', 'replace', 'swap', 'modify', 'set', 'add line', 'remove line'],
  'code-generation': ['create', 'build', 'implement', 'write', 'generate', 'scaffold', 'new file', 'add feature'],
  'refactoring': ['refactor', 'restructure', 'reorganize', 'extract', 'inline', 'move', 'split', 'merge', 'clean up'],
  'debugging': ['fix', 'bug', 'error', 'broken', 'failing', 'crash', 'issue', 'wrong', 'doesn\'t work', 'not working'],
  'explanation': ['explain', 'what does', 'how does', 'why', 'describe', 'tell me about', 'understand', 'walk me through'],
  'conversation': ['hello', 'hi', 'thanks', 'help', 'can you', 'should i', 'what should', 'opinion', 'think about'],
  'analysis': ['review', 'analyze', 'evaluate', 'audit', 'check', 'assess', 'compare', 'pros and cons'],
  'search': ['find', 'search', 'where is', 'locate', 'look for', 'grep', 'which file'],
  'multi-file-edit': ['across', 'all files', 'everywhere', 'project-wide', 'codebase', 'multiple files'],
};

const COMPLEXITY_SIGNALS: Record<Complexity, { keywords: string[]; minLength: number }> = {
  trivial: { keywords: ['simple', 'quick', 'just', 'only'], minLength: 0 },
  simple: { keywords: ['basic', 'small', 'minor'], minLength: 20 },
  moderate: { keywords: [], minLength: 100 },
  complex: { keywords: ['complex', 'complicated', 'tricky', 'difficult', 'large'], minLength: 300 },
  expert: { keywords: ['architecture', 'design system', 'migration', 'security audit', 'performance'], minLength: 500 },
};

export function classifyTask(
  message: string,
  context?: { fileCount?: number; hasErrors?: boolean; conversationLength?: number },
  projectHints?: ProjectHints,
): TaskProfile {
  const lower = message.toLowerCase();
  const type = detectTaskType(lower, projectHints);
  const complexity = detectComplexity(lower, message.length, context, projectHints);

  return {
    type,
    complexity,
    estimatedTokens: estimateTokens(type, complexity, message.length),
    requiresToolUse: requiresTools(type),
    requiresReasoning: requiresReasoning(type, complexity),
    language: detectLanguage(lower),
    domain: detectDomain(lower),
  };
}

function detectTaskType(lower: string, hints?: ProjectHints): TaskType {
  let bestType: TaskType = 'conversation';
  let bestScore = 0;

  for (const [type, signals] of Object.entries(TASK_SIGNALS)) {
    let score = 0;
    for (const signal of signals) {
      if (lower.includes(signal)) score++;
    }
    // Project hints boost: if STORM.md declares primary_tasks, give those a small edge
    if (hints?.primary_tasks?.includes(type)) {
      score += 0.5;
    }
    if (score > bestScore) {
      bestScore = score;
      bestType = type as TaskType;
    }
  }

  return bestType;
}

function detectComplexity(
  lower: string,
  length: number,
  context?: { fileCount?: number; hasErrors?: boolean; conversationLength?: number },
  hints?: ProjectHints,
): Complexity {
  // Check keyword signals first
  for (const [level, config] of Object.entries(COMPLEXITY_SIGNALS).reverse()) {
    for (const keyword of config.keywords) {
      if (lower.includes(keyword)) return level as Complexity;
    }
  }

  // Fall back to length + context heuristics
  const fileCount = context?.fileCount ?? 0;
  if (fileCount > 5 || length > 500) return 'complex';
  if (fileCount > 2 || length > 200) return 'moderate';
  if (length > 50) return 'simple';

  // When signals are ambiguous, use project's typical complexity as prior
  if (hints?.typical_complexity) return hints.typical_complexity;

  return 'trivial';
}

function estimateTokens(type: TaskType, complexity: Complexity, inputLength: number): { input: number; output: number } {
  const baseInput = Math.max(inputLength * 1.3, 500); // rough char-to-token + system prompt overhead
  const outputMultipliers: Record<Complexity, number> = {
    trivial: 0.5, simple: 1, moderate: 2, complex: 4, expert: 8,
  };
  const typeOutputBase: Record<TaskType, number> = {
    'simple-edit': 200,
    'code-generation': 1000,
    'refactoring': 800,
    'debugging': 600,
    'explanation': 500,
    'conversation': 200,
    'analysis': 800,
    'search': 150,
    'multi-file-edit': 2000,
  };

  return {
    input: Math.round(baseInput),
    output: Math.round(typeOutputBase[type] * outputMultipliers[complexity]),
  };
}

function requiresTools(type: TaskType): boolean {
  return ['simple-edit', 'code-generation', 'refactoring', 'debugging', 'search', 'multi-file-edit'].includes(type);
}

function requiresReasoning(type: TaskType, complexity: Complexity): boolean {
  if (['complex', 'expert'].includes(complexity)) return true;
  return ['debugging', 'analysis', 'refactoring', 'multi-file-edit'].includes(type);
}

function detectLanguage(lower: string): string | undefined {
  const langs: Record<string, string[]> = {
    typescript: ['typescript', '.ts', '.tsx', 'tsx'],
    javascript: ['javascript', '.js', '.jsx', 'jsx'],
    python: ['python', '.py', 'pip', 'django', 'flask'],
    rust: ['rust', '.rs', 'cargo'],
    go: ['golang', '.go', 'go mod'],
  };
  for (const [lang, signals] of Object.entries(langs)) {
    if (signals.some((s) => lower.includes(s))) return lang;
  }
  return undefined;
}

function detectDomain(lower: string): string | undefined {
  if (['frontend', 'react', 'css', 'html', 'ui', 'component'].some((s) => lower.includes(s))) return 'frontend';
  if (['backend', 'api', 'server', 'database', 'endpoint'].some((s) => lower.includes(s))) return 'backend';
  if (['devops', 'docker', 'ci', 'deploy', 'kubernetes'].some((s) => lower.includes(s))) return 'devops';
  return undefined;
}
