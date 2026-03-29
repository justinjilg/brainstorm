import { createHash } from "node:crypto";
import type { TaskProfile, TaskType, Complexity } from "@brainst0rm/shared";
import type { StormFrontmatter } from "@brainst0rm/config";

/** Routing hints from STORM.md frontmatter. */
export type ProjectHints = StormFrontmatter["routing"];

// ── Classification Memoization ────────────────────────────────────
const _classifyCache = new Map<string, TaskProfile>();
const MAX_CLASSIFY_CACHE = 20;

function hashMessage(msg: string): string {
  return createHash("sha256").update(msg).digest("hex").slice(0, 16);
}

// Heuristic task classifier — no LLM call, instant, free

const TASK_SIGNALS: Record<TaskType, string[]> = {
  "simple-edit": [
    "change",
    "rename",
    "update",
    "replace",
    "swap",
    "modify",
    "set",
    "add line",
    "remove line",
  ],
  "code-generation": [
    "create",
    "build",
    "implement",
    "write",
    "generate",
    "scaffold",
    "new file",
    "add feature",
  ],
  refactoring: [
    "refactor",
    "restructure",
    "reorganize",
    "extract",
    "inline",
    "move",
    "split",
    "merge",
    "clean up",
  ],
  debugging: [
    "fix",
    "bug",
    "error",
    "broken",
    "failing",
    "crash",
    "issue",
    "wrong",
    "doesn't work",
    "not working",
  ],
  explanation: [
    "explain",
    "what does",
    "how does",
    "why",
    "describe",
    "tell me about",
    "understand",
    "walk me through",
  ],
  conversation: [
    "hello",
    "hi",
    "thanks",
    "help",
    "can you",
    "should i",
    "what should",
    "opinion",
    "think about",
  ],
  analysis: [
    "review",
    "analyze",
    "evaluate",
    "audit",
    "check",
    "assess",
    "compare",
    "pros and cons",
  ],
  search: [
    "find",
    "search",
    "where is",
    "locate",
    "look for",
    "grep",
    "which file",
    "read the file",
    "read file",
    "show me the file",
    "cat ",
    "open the file",
  ],
  "multi-file-edit": [
    "across",
    "all files",
    "everywhere",
    "project-wide",
    "codebase",
    "multiple files",
  ],
  ingest: [
    "ingest",
    "understand this codebase",
    "analyze the project",
    "set up ai",
    "set up infrastructure",
    "onboard",
    "legacy",
    "what is this project",
    "map the codebase",
    "learn this codebase",
  ],
  audit: [
    "audit",
    "review everything",
    "full review",
    "security review",
    "code review the entire",
    "tech debt",
    "find all issues",
    "quality check",
    "health check",
  ],
  migration: [
    "migrate",
    "upgrade",
    "convert",
    "port",
    "modernize",
    "deprecated",
    "move from",
    "switch to",
    "replace all uses of",
    "update all",
  ],
  documentation: [
    "document",
    "write docs",
    "generate documentation",
    "readme",
    "api docs",
    "architecture doc",
    "explain the system",
    "onboarding guide",
    "write a guide",
  ],
};

const COMPLEXITY_SIGNALS: Record<
  Complexity,
  { keywords: string[]; minLength: number }
> = {
  trivial: { keywords: ["simple", "quick", "just", "only"], minLength: 0 },
  simple: { keywords: ["basic", "small", "minor"], minLength: 20 },
  moderate: { keywords: [], minLength: 100 },
  complex: {
    keywords: ["complex", "complicated", "tricky", "difficult", "large"],
    minLength: 300,
  },
  expert: {
    keywords: [
      "architecture",
      "design system",
      "migration",
      "security audit",
      "performance",
    ],
    minLength: 500,
  },
};

/** Keywords that indicate tool use regardless of task type classification. */
const TOOL_USE_SIGNALS = [
  "read the file",
  "read file",
  "open the file",
  "show me the code",
  "look at",
  "check the file",
  "list the files",
  "run the",
  "execute",
  "write to file",
  "create a file",
  "edit the file",
  "modify the file",
];

export function classifyTask(
  message: string,
  context?: {
    fileCount?: number;
    hasErrors?: boolean;
    conversationLength?: number;
  },
  projectHints?: ProjectHints,
): TaskProfile {
  // Check memoization cache
  const cacheKey = hashMessage(message);
  const cached = _classifyCache.get(cacheKey);
  if (cached) return cached;

  const lower = message.toLowerCase();
  const type = detectTaskType(lower, projectHints);
  const complexity = detectComplexity(
    lower,
    message.length,
    context,
    projectHints,
  );

  // Tool use: either the task type implies it, or explicit tool-use keywords are present
  const toolUseFromType = requiresTools(type);
  const toolUseFromKeywords = TOOL_USE_SIGNALS.some((signal) =>
    lower.includes(signal),
  );

  const profile: TaskProfile = {
    type,
    complexity,
    estimatedTokens: estimateTokens(type, complexity, message.length),
    requiresToolUse: toolUseFromType || toolUseFromKeywords,
    requiresReasoning: requiresReasoning(type, complexity),
    language: detectLanguage(lower),
    domain: detectDomain(lower),
  };

  // Cache result (evict oldest if full)
  if (_classifyCache.size >= MAX_CLASSIFY_CACHE) {
    const firstKey = _classifyCache.keys().next().value;
    if (firstKey) _classifyCache.delete(firstKey);
  }
  _classifyCache.set(cacheKey, profile);

  return profile;
}

function detectTaskType(lower: string, hints?: ProjectHints): TaskType {
  let bestType: TaskType = "conversation";
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
  context?: {
    fileCount?: number;
    hasErrors?: boolean;
    conversationLength?: number;
  },
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
  if (fileCount > 5 || length > 500) return "complex";
  if (fileCount > 2 || length > 200) return "moderate";
  if (length > 50) return "simple";

  // When signals are ambiguous, use project's typical complexity as prior
  if (hints?.typical_complexity) return hints.typical_complexity;

  return "trivial";
}

function estimateTokens(
  type: TaskType,
  complexity: Complexity,
  inputLength: number,
): { input: number; output: number } {
  const baseInput = Math.max(inputLength * 1.3, 500); // rough char-to-token + system prompt overhead
  const outputMultipliers: Record<Complexity, number> = {
    trivial: 0.5,
    simple: 1,
    moderate: 2,
    complex: 4,
    expert: 8,
  };
  const typeOutputBase: Record<TaskType, number> = {
    "simple-edit": 200,
    "code-generation": 1000,
    refactoring: 800,
    debugging: 600,
    explanation: 500,
    conversation: 200,
    analysis: 800,
    search: 150,
    "multi-file-edit": 2000,
    ingest: 5000,
    audit: 3000,
    migration: 2000,
    documentation: 2000,
  };

  return {
    input: Math.round(baseInput),
    output: Math.round(typeOutputBase[type] * outputMultipliers[complexity]),
  };
}

function requiresTools(type: TaskType): boolean {
  return [
    "simple-edit",
    "code-generation",
    "refactoring",
    "debugging",
    "search",
    "multi-file-edit",
    "ingest",
    "audit",
    "migration",
    "documentation",
  ].includes(type);
}

function requiresReasoning(type: TaskType, complexity: Complexity): boolean {
  if (["complex", "expert"].includes(complexity)) return true;
  return [
    "debugging",
    "analysis",
    "refactoring",
    "multi-file-edit",
    "ingest",
    "audit",
    "migration",
  ].includes(type);
}

function detectLanguage(lower: string): string | undefined {
  const langs: Record<string, string[]> = {
    typescript: ["typescript", ".ts", ".tsx", "tsx"],
    javascript: ["javascript", ".js", ".jsx", "jsx"],
    python: ["python", ".py", "pip", "django", "flask"],
    rust: ["rust", ".rs", "cargo"],
    go: ["golang", ".go", "go mod"],
  };
  for (const [lang, signals] of Object.entries(langs)) {
    if (signals.some((s) => lower.includes(s))) return lang;
  }
  return undefined;
}

function detectDomain(lower: string): string | undefined {
  if (
    ["frontend", "react", "css", "html", "ui", "component"].some((s) =>
      lower.includes(s),
    )
  )
    return "frontend";
  if (
    ["backend", "api", "server", "database", "endpoint"].some((s) =>
      lower.includes(s),
    )
  )
    return "backend";
  if (
    ["devops", "docker", "ci", "deploy", "kubernetes"].some((s) =>
      lower.includes(s),
    )
  )
    return "devops";
  return undefined;
}
