import {
  loadStormFile,
  loadHierarchicalStormFiles,
  type StormFrontmatter,
} from "@brainst0rm/config";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { INSIGHT_PROMPT_SECTION } from "./insights.js";
import { getOutputStylePrompt, type OutputStyle } from "./output-styles.js";
import { loadSkills } from "../skills/loader.js";
import { formatCommitContext } from "../search/lineage.js";
import { formatStyleContext } from "../learning/style-learner.js";
import { generateRepoMap } from "./repo-map.js";

const DEFAULT_SYSTEM_PROMPT = `You are Brainstorm, an AI coding assistant powered by BrainstormRouter — an intelligent model routing gateway. You help users with software engineering tasks: writing code, debugging, refactoring, reviewing, and explaining code.

You have real tools — use them. When the user asks you to look at files, run commands, or search for information, USE YOUR TOOLS. Do not print shell commands as code blocks — actually call the shell tool. Do not say you cannot access something — try it first with a tool call.

# Core Behaviors

1. Read before you write. Always use tools to examine files before modifying them. Never guess at file contents.
2. Lead with action. Start doing the work, not explaining what you plan to do.
3. Make decisions. Don't ask "should I use X or Y?" — pick the best approach and explain why briefly.
4. Push back on bad ideas. If the user's approach has issues, say so respectfully and offer an alternative.
5. Verify your work. After making changes, run the build command or test command if available. Check the diff.
6. Be honest about limitations. If you can't verify something, say "I can't confirm this without running tests."
7. Follow existing patterns. Match the codebase's style, naming, structure, and error handling. Edit existing files rather than creating new ones when possible.
8. Use tools surgically. Prefer one targeted search over many exploratory ones. Read specific files, not entire directories.
9. Track progress. For multi-step work, use task_create to create tasks and task_update to mark them completed. This shows the user a visual progress list.
10. Respect the blast radius. Don't touch files you don't need to. Ask before destructive operations.

# Communication Style

- Start responses with what you're doing, not why.
- Keep explanations to 1-2 sentences when possible.
- Don't repeat what the user said back to them.
- No filler phrases: avoid "Great question!", "I'd be happy to help!", "Sure!", "Absolutely!", "Of course!".
- No trailing summaries: don't end with "In summary..." or "To recap...".
- When you can't do something, say what you'll do instead.

# Tool Usage

- Use glob to find files by name pattern, grep to search file contents, file_read to examine specific files.
- Always read a file before editing it.
- Prefer editing existing files over creating new ones.
- When searching, start specific and broaden only if needed.

# Auto-Verification

After using file_write or file_edit to modify code files, you MUST verify the changes compile before moving on:
1. If a build command is available (see Verification Commands below), run it immediately after your edit.
2. If the build fails, read the error, fix the issue, and rebuild — do NOT ask the user to fix build errors you introduced.
3. If no build command is configured, at minimum check for obvious syntax errors by reading the modified file.
4. Only proceed to the next task after verification passes.

This is not optional — unverified edits create broken states the user has to clean up.

# Self-Correction

When a tool call fails, don't report the failure to the user immediately. Try an alternative approach:
- If file_read fails, the file may not exist at that path — use glob to find the right path.
- If shell fails, read the error message and adjust the command.
- If grep returns nothing, try broader search terms or search in different directories.
- If a build fails after your edit, read the error, fix the issue, and rebuild.
Only report failure to the user after 2 unsuccessful alternative approaches.

# Safety

- Never modify files outside the project directory without asking.
- Never commit secrets, credentials, or .env files.
- Ask before destructive operations: deleting files, dropping tables, force-pushing.
- When uncertain about the impact of a change, explain the risk and ask.

${INSIGHT_PROMPT_SECTION}`;

/**
 * A segment of the system prompt. Segments marked `cacheable` are stable across
 * turns and can be cached by providers that support prompt caching (e.g., Anthropic).
 * The AI SDK v6 passes `providerOptions.anthropic.cacheControl` for cache hints.
 */
export interface SystemPromptSegment {
  text: string;
  /** If true, this segment rarely changes and should be cached across turns. */
  cacheable: boolean;
}

export interface SystemPromptResult {
  /** Flat prompt string (backward compatibility for non-segmented consumers). */
  prompt: string;
  /** Segmented prompt for providers that support prompt caching. */
  segments: SystemPromptSegment[];
  frontmatter: StormFrontmatter | null;
}

/** Convert segments to AI SDK v6 system prompt array with Anthropic cache hints. */
export function segmentsToSystemArray(
  segments: SystemPromptSegment[],
): Array<{
  role: "system";
  content: string;
  providerOptions?: Record<string, any>;
}> {
  return segments.map((seg) => ({
    role: "system" as const,
    content: seg.text,
    ...(seg.cacheable
      ? {
          providerOptions: {
            anthropic: { cacheControl: { type: "ephemeral" } },
          },
        }
      : {}),
  }));
}

/** Convert segments to flat string (for trajectory recording, non-cached paths). */
export function segmentsToString(segments: SystemPromptSegment[]): string {
  return segments.map((s) => s.text).join("\n");
}

export function buildSystemPrompt(
  projectPath: string,
  outputStyle?: OutputStyle,
  basePromptOverride?: string,
): SystemPromptResult {
  // ── Cacheable zone: stable within a session ──────────────────────
  // These sections don't change between turns. Anthropic caches this prefix.
  const stableParts = [basePromptOverride ?? DEFAULT_SYSTEM_PROMPT];

  // Output style is set once per session (changed via /style command which rebuilds prompt)
  if (outputStyle) {
    stableParts.push("\n" + getOutputStylePrompt(outputStyle));
  }

  let frontmatter: StormFrontmatter | null = null;

  // Project context from STORM.md / BRAINSTORM.md (hierarchical: global → root → ... → cwd)
  const storm = loadHierarchicalStormFiles(projectPath);
  if (storm.sources.length > 0) {
    frontmatter = storm.frontmatter;
    stableParts.push(
      `\n## Project Context (from ${storm.sources.join(", ")})\n\n${storm.body}`,
    );

    const verifyCommands = extractVerificationCommands(
      storm.frontmatter,
      storm.body,
    );
    if (verifyCommands) {
      stableParts.push(
        `\n## Verification Commands\n\nAfter every file_write or file_edit on code files, run the appropriate command:\n${verifyCommands}\n\nRun the build command after edits. Run the test command after completing a logical unit of work.`,
      );
    }

    const protectedAreas = extractSection(storm.body, "Don't touch");
    if (protectedAreas) {
      stableParts.push(
        `\n## Protected Areas\n\nThese files are off-limits. Do NOT modify them without explicit user approval:\n${protectedAreas}\nIf a task requires changes to a protected file, explain WHY and ask before proceeding.`,
      );
    }

    const conventions = extractSection(storm.body, "Conventions");
    if (conventions) {
      stableParts.push(
        `\n## Code Patterns (MANDATORY)\n\nAlways follow these patterns when writing code in this project. Any code blocks below are reference examples — match this style exactly:\n${conventions}`,
      );
    }

    const architecture = extractSection(storm.body, "Architecture");
    if (architecture) {
      stableParts.push(
        `\n## Architecture Constraints\n\nRespect these architectural decisions when making changes:\n${architecture}`,
      );
    }

    const stack = extractSection(storm.body, "Stack");
    if (stack) {
      stableParts.push(`\n## Stack\n\n${stack}`);
    }

    const dependencies = extractSection(storm.body, "Dependencies");
    if (dependencies) {
      stableParts.push(
        `\n## Dependency Rules\n\nFollow these dependency guidelines:\n${dependencies}`,
      );
    }
  }

  // Structural context (high-signal, stable across session)
  const repoMapSection = buildRepoMapSection(projectPath);
  if (repoMapSection) {
    stableParts.push(repoMapSection);
  }

  const skillsSection = buildSkillsSection(projectPath);
  if (skillsSection) {
    stableParts.push(skillsSection);
  }

  const styleContext = formatStyleContext(projectPath);
  if (styleContext) {
    stableParts.push(
      `\n## Project Style Guide (auto-detected)\n\n${styleContext}`,
    );
  }

  // ── Dynamic zone: changes per turn or session ────────────────────
  // These sections may change between turns. Not cached.
  const dynamicParts: string[] = [];

  const memoryContext = loadMemoryContext(projectPath);
  if (memoryContext) {
    dynamicParts.push(
      `\n## Memory (from previous sessions)\n\n${memoryContext}`,
    );
  }

  const gitContext = getGitContext(projectPath);
  if (gitContext) {
    dynamicParts.push(`\n## Git Context\n\n${gitContext}`);
  }

  const commitContext = formatCommitContext(projectPath);
  if (commitContext) {
    dynamicParts.push(`\n## Recent Commits\n\n${commitContext}`);
  }

  const now = new Date();
  const days = [
    "Sunday",
    "Monday",
    "Tuesday",
    "Wednesday",
    "Thursday",
    "Friday",
    "Saturday",
  ];
  dynamicParts.push(
    `\n## Current Date\n\nToday is ${now.toISOString().split("T")[0]} (${days[now.getDay()]}). Time: ${now.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", timeZoneName: "short" })}.`,
  );

  const segments: SystemPromptSegment[] = [
    { text: stableParts.join("\n"), cacheable: true },
    { text: dynamicParts.join("\n"), cacheable: false },
  ];

  return {
    prompt: segmentsToString(segments),
    segments,
    frontmatter,
  };
}

// Cache: skills rarely change within a session
let _skillsCache: { path: string; result: string | null; ts: number } | null =
  null;
const SKILLS_TTL_MS = 30_000;

/**
 * Build an "Available Skills" section from loaded skill definitions.
 * Skills are user-defined .md files that can be invoked as /commands.
 * Cached for 30s to avoid repeated directory scans.
 */
function buildSkillsSection(projectPath: string): string | null {
  if (
    _skillsCache &&
    _skillsCache.path === projectPath &&
    Date.now() - _skillsCache.ts < SKILLS_TTL_MS
  ) {
    return _skillsCache.result;
  }

  try {
    const skills = loadSkills(projectPath);
    if (skills.length === 0) {
      _skillsCache = { path: projectPath, result: null, ts: Date.now() };
      return null;
    }

    const lines = skills.map((s) => {
      const source = s.source === "claude-compat" ? "claude" : s.source;
      return `- **/${s.name}** (${source}) — ${s.description}`;
    });

    const result = `\n## Available Skills\n\nYou can invoke these skills when the user requests them with /<name>:\n${lines.join("\n")}`;
    _skillsCache = { path: projectPath, result, ts: Date.now() };
    return result;
  } catch {
    return null;
  }
}

/**
 * Build a "Project Structure" section from the repository map.
 * Uses the enhanced repo map with function/class signatures, export lists,
 * and import relationship summaries — ranked by connectivity (PageRank-lite).
 */
function buildRepoMapSection(projectPath: string): string | null {
  try {
    const context = generateRepoMap(projectPath);
    if (!context) return null;

    return `\n## Project Structure\n\n${context}`;
  } catch {
    return null;
  }
}

/**
 * Extract verification commands from STORM.md frontmatter and body.
 */
function extractVerificationCommands(
  fm: StormFrontmatter | null,
  body: string,
): string | null {
  const commands: string[] = [];
  if (fm?.build_command) commands.push(`- Build: \`${fm.build_command}\``);
  if (fm?.test_command) commands.push(`- Test: \`${fm.test_command}\``);
  if (fm?.dev_command) commands.push(`- Dev server: \`${fm.dev_command}\``);
  return commands.length > 0 ? commands.join("\n") : null;
}

/**
 * Extract a markdown section by heading name from the body.
 * Returns the content between the heading and the next heading (or EOF).
 */
function extractSection(body: string, heading: string): string | null {
  const pattern = new RegExp(
    `^##\\s+${heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*$`,
    "mi",
  );
  const match = body.match(pattern);
  if (!match || match.index === undefined) return null;

  const start = match.index + match[0].length;
  const nextHeading = body.indexOf("\n## ", start);
  const section =
    nextHeading >= 0 ? body.slice(start, nextHeading) : body.slice(start);

  const trimmed = section.trim();
  // Skip sections that only contain placeholder comments
  if (!trimmed || (trimmed.startsWith("<!--") && trimmed.endsWith("-->")))
    return null;
  return trimmed;
}

function getGitContext(projectPath: string): string | null {
  // Check if it's a git repo
  if (!existsSync(join(projectPath, ".git"))) return null;

  try {
    const parts: string[] = [];

    // Current branch
    const branch = execFileSync("git", ["branch", "--show-current"], {
      cwd: projectPath,
      timeout: 3000,
    })
      .toString()
      .trim();
    if (branch) parts.push(`Branch: ${branch}`);

    // Short status
    const status = execFileSync("git", ["status", "--short"], {
      cwd: projectPath,
      timeout: 3000,
    })
      .toString()
      .trim();
    if (status) {
      const lines = status.split("\n");
      parts.push(
        `Working tree: ${lines.length} changed file${lines.length === 1 ? "" : "s"}`,
      );
      // Show first 10 files
      parts.push(lines.slice(0, 10).join("\n"));
      if (lines.length > 10) parts.push(`... and ${lines.length - 10} more`);
    } else {
      parts.push("Working tree: clean");
    }

    return parts.join("\n");
  } catch {
    return null;
  }
}

/**
 * Load memory context from the project's memory index.
 * Reads the MEMORY.md file directly to avoid MemoryManager dependency chain.
 */
function loadMemoryContext(projectPath: string): string | null {
  try {
    const projectHash = createHash("sha256")
      .update(projectPath)
      .digest("hex")
      .slice(0, 12);
    const indexPath = join(
      homedir(),
      ".brainstorm",
      "projects",
      projectHash,
      "memory",
      "MEMORY.md",
    );
    if (!existsSync(indexPath)) return null;
    const content = readFileSync(indexPath, "utf-8").trim();
    if (!content) return null;
    return content.split("\n").slice(0, 200).join("\n");
  } catch {
    return null;
  }
}

/**
 * Parse @file references from user input and inject file contents.
 *
 * Patterns: @path/to/file.ts, @./relative/path.js, @src/App.tsx
 *
 * Returns cleaned message (@ prefix stripped) and file content messages.
 */
export function parseAtMentions(
  input: string,
  projectPath: string,
): {
  cleanedInput: string;
  fileContexts: Array<{ role: "user"; content: string }>;
} {
  const atPattern = /@(\.?[\w./-]+\.\w{1,10})/g;
  const fileContexts: Array<{ role: "user"; content: string }> = [];
  const seen = new Set<string>();

  let match;
  while ((match = atPattern.exec(input)) !== null) {
    const ref = match[1];
    const filePath = resolve(projectPath, ref);

    if (seen.has(filePath)) continue;
    seen.add(filePath);

    if (existsSync(filePath)) {
      try {
        const content = readFileSync(filePath, "utf-8");
        const lines = content.split("\n");
        const truncated =
          lines.length > 500
            ? lines.slice(0, 500).join("\n") +
              `\n... (${lines.length - 500} more lines)`
            : content;
        fileContexts.push({
          role: "user",
          content: `[File: ${ref}]\n\`\`\`\n${truncated}\n\`\`\``,
        });
      } catch {
        /* skip unreadable files */
      }
    }
  }

  const cleanedInput = input.replace(atPattern, "$1").trim();
  return { cleanedInput, fileContexts };
}

// ── Tool Self-Awareness ─────────────────────────────────────────────

const TOOL_CATEGORIES: Record<string, string[]> = {
  Filesystem: [
    "file_read",
    "file_write",
    "file_edit",
    "multi_edit",
    "batch_edit",
    "list_dir",
    "glob",
    "grep",
  ],
  Shell: ["shell", "process_spawn", "process_kill"],
  Git: [
    "git_status",
    "git_diff",
    "git_log",
    "git_commit",
    "git_branch",
    "git_stash",
  ],
  GitHub: ["gh_pr", "gh_issue"],
  Web: ["web_fetch", "web_search"],
  Tasks: ["task_create", "task_update", "task_list"],
  Subagent: ["subagent"],
  BrainstormRouter: [
    "br_status",
    "br_budget",
    "br_leaderboard",
    "br_insights",
    "br_models",
    "br_memory_search",
    "br_memory_store",
    "br_health",
  ],
};

/**
 * Build a natural-language tool listing for injection into the system prompt.
 * Helps models understand available tools without relying solely on AI SDK schemas.
 */
export function buildToolAwarenessSection(
  tools: Array<{ name: string; description: string; permission: string }>,
): string {
  if (tools.length === 0) return "";

  const toolMap = new Map(tools.map((t) => [t.name, t]));
  const used = new Set<string>();
  const sections: string[] = [];

  for (const [category, names] of Object.entries(TOOL_CATEGORIES)) {
    const categoryTools = names
      .filter((n) => toolMap.has(n))
      .map((n) => {
        used.add(n);
        return toolMap.get(n)!;
      });
    if (categoryTools.length === 0) continue;
    sections.push(
      `### ${category}\n${categoryTools
        .map(
          (t) =>
            `- **${t.name}** (${t.permission}) — ${t.description.slice(0, 120)}`,
        )
        .join("\n")}`,
    );
  }

  // Catch uncategorized tools
  const other = tools.filter((t) => !used.has(t.name));
  if (other.length > 0) {
    sections.push(
      `### Other\n${other
        .map(
          (t) =>
            `- **${t.name}** (${t.permission}) — ${t.description.slice(0, 120)}`,
        )
        .join("\n")}`,
    );
  }

  const home = homedir();
  const selfAwareness = [
    "\n### Environment",
    `- Home directory: \`${home}\``,
    `- Current working directory: \`${process.cwd()}\``,
    "- You CAN read files outside the project (e.g., ~/Desktop, ~/Documents). Use absolute paths.",
    "- You should only WRITE files within the project directory unless the user explicitly asks otherwise.",
    "",
    "### Self-Configuration",
    "- Global config: `~/.brainstorm/config.toml` (TOML format)",
    "- Project config: `./brainstorm.toml` (overrides global)",
    "- Project context: `./BRAINSTORM.md` or `./STORM.md` (Markdown with YAML frontmatter)",
    "- Memory files: `~/.brainstorm/projects/<hash>/memory/` (Markdown with YAML frontmatter)",
    "- Database: `~/.brainstorm/brainstorm.db` (SQLite)",
    "- Eval scores: `~/.brainstorm/eval/capability-scores.json`",
    "- To change models or routing, edit `~/.brainstorm/config.toml` or use `/model` and `/strategy` slash commands.",
  ].join("\n");

  // Add BrainstormRouter intelligence section if BR MCP tools are connected
  const hasBRTools = tools.some((t) => t.name.startsWith("br_"));
  const brSection = hasBRTools
    ? [
        "",
        "### BrainstormRouter Intelligence",
        "You are connected to BrainstormRouter — an intelligent AI gateway. You have native tools to query it:",
        "",
        "- **br_status** — Full self-check: identity, budget, health, errors, suggestions. Start here.",
        "- **br_budget** — Check budget: daily/monthly spend, limits, forecast. Call before expensive operations.",
        "- **br_leaderboard** — Real model rankings from production data. See which models perform best.",
        "- **br_insights** — Cost optimization: waste detection, cheaper alternatives, savings estimates.",
        "- **br_models** — List all available models with pricing.",
        "- **br_memory_search** — Search persistent memory across sessions.",
        "- **br_memory_store** — Save important facts that persist across sessions.",
        "- **br_health** — Quick connectivity test.",
        "",
        "Use these when the situation calls for it — not routinely.",
      ].join("\n")
    : "";

  return `\n## Available Tools\n\nYou have access to ${tools.length} tools:\n\n${sections.join("\n\n")}\n${selfAwareness}${brSection}`;
}
