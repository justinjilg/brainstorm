import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { join, basename, dirname } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

export interface SkillDefinition {
  name: string;
  description: string;
  content: string;
  source: "project" | "global" | "claude-compat";
  /** Optional: restrict which tools this skill can use. */
  tools?: string[];
  /** Optional: routing preference when this skill is active. */
  modelPreference?: "cheap" | "quality" | "fast" | "auto";
  /** Optional: max agentic steps for this skill. */
  maxSteps?: number;
  /** Optional: system prompt override (separate from content which is the user prompt). */
  systemPrompt?: string;
}

/**
 * Load skills from .brainstorm/skills/ directories.
 * Also loads Claude Code skills (.claude/commands/) for native compatibility.
 *
 * Skills are .md files with optional YAML frontmatter:
 * ---
 * description: "What this skill does"
 * ---
 * # Skill content (injected as prompt)
 */
export function loadSkills(projectPath: string): SkillDefinition[] {
  const skills: SkillDefinition[] = [];

  // 1. Project-level skills: .brainstorm/skills/ (highest priority)
  const projectSkillsDir = join(projectPath, ".brainstorm", "skills");
  skills.push(...loadSkillsFromDir(projectSkillsDir, "project"));

  // 2. Global skills: ~/.brainstorm/skills/
  const globalSkillsDir = join(homedir(), ".brainstorm", "skills");
  skills.push(...loadSkillsFromDir(globalSkillsDir, "global"));

  // 3. Claude Code compatibility: .claude/commands/
  const claudeCommandsDir = join(projectPath, ".claude", "commands");
  skills.push(...loadSkillsFromDir(claudeCommandsDir, "claude-compat"));

  // 4. Built-in skills: bundled with brainstorm (lowest priority)
  // Find @brainst0rm/core's package.json → dist/skills/builtin/
  try {
    const corePkgPath = createRequire(import.meta.url).resolve(
      "@brainst0rm/core/package.json",
    );
    const builtinSkillsDir = join(
      dirname(corePkgPath),
      "dist",
      "skills",
      "builtin",
    );
    skills.push(...loadSkillsFromDir(builtinSkillsDir, "builtin" as any));
  } catch {
    // Fallback: relative to import.meta.url
    try {
      const builtinSkillsDir = join(
        dirname(fileURLToPath(import.meta.url)),
        "skills",
        "builtin",
      );
      skills.push(...loadSkillsFromDir(builtinSkillsDir, "builtin" as any));
    } catch {
      // No builtin skills available — not fatal
    }
  }

  // Deduplicate: first occurrence wins (project overrides global overrides builtin)
  const seen = new Set<string>();
  return skills.filter((s) => {
    if (seen.has(s.name)) return false;
    seen.add(s.name);
    return true;
  });
}

function loadSkillsFromDir(
  dir: string,
  source: SkillDefinition["source"],
): SkillDefinition[] {
  if (!existsSync(dir)) return [];

  const skills: SkillDefinition[] = [];
  const entries = readdirSync(dir);

  for (const entry of entries) {
    try {
      const entryPath = join(dir, entry);
      const stat = statSync(entryPath);

      let content: string;
      let name: string;
      let skillDir: string | undefined;

      if (stat.isDirectory()) {
        // Directory format: skill-name/SKILL.md
        const skillMd = join(entryPath, "SKILL.md");
        if (!existsSync(skillMd)) continue;
        content = readFileSync(skillMd, "utf-8");
        name = entry;
        skillDir = entryPath;
      } else if (entry.endsWith(".md")) {
        // Flat format: skill-name.md
        content = readFileSync(entryPath, "utf-8");
        name = basename(entry, ".md");
      } else {
        continue;
      }

      const {
        description,
        body,
        tools,
        modelPreference,
        maxSteps,
        systemPrompt,
      } = parseFrontmatter(content);

      // Inject temporal template variables + skill directory path
      let processedBody = injectTemporalVars(body);
      if (skillDir) {
        processedBody = processedBody.replace(/<SKILL_DIR>/g, skillDir);
      }

      skills.push({
        name,
        description: description || `Skill: ${name}`,
        content: processedBody,
        source,
        ...(tools ? { tools } : {}),
        ...(modelPreference ? { modelPreference: modelPreference as any } : {}),
        ...(maxSteps ? { maxSteps } : {}),
        ...(systemPrompt ? { systemPrompt } : {}),
      });
    } catch {
      /* skip unreadable entries */
    }
  }

  return skills;
}

interface ParsedFrontmatter {
  description: string;
  body: string;
  tools?: string[];
  modelPreference?: string;
  maxSteps?: number;
  systemPrompt?: string;
}

/**
 * Parse YAML frontmatter from a markdown file.
 * Supports: description, tools, model_preference, max_steps, system_prompt.
 */
function parseFrontmatter(content: string): ParsedFrontmatter {
  const fmMatch = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!fmMatch) return { description: "", body: content };

  const frontmatter = fmMatch[1];
  const body = fmMatch[2];

  // Extract fields from frontmatter (simple key: value parsing)
  const descMatch = frontmatter.match(/description:\s*"?([^"\n]+)"?/);
  const description = descMatch?.[1]?.trim() ?? "";

  // tools: list (YAML array on separate lines or inline)
  const toolsMatch = frontmatter.match(/tools:\s*\n((?:\s+-\s+\S+\n?)+)/);
  const tools = toolsMatch
    ? toolsMatch[1]
        .split("\n")
        .map((l) => l.replace(/^\s+-\s+/, "").trim())
        .filter(Boolean)
    : undefined;

  // model_preference: cheap | quality | fast | auto
  const modelMatch = frontmatter.match(/model_preference:\s*(\S+)/);
  const modelPreference = modelMatch?.[1]?.trim();

  // max_steps: number
  const stepsMatch = frontmatter.match(/max_steps:\s*(\d+)/);
  const maxSteps = stepsMatch ? parseInt(stepsMatch[1], 10) : undefined;

  // system_prompt: multiline via |
  const sysMatch = frontmatter.match(
    /system_prompt:\s*\|\s*\n((?:\s{2,}.+\n?)+)/,
  );
  const systemPrompt = sysMatch
    ? sysMatch[1]
        .split("\n")
        .map((l) => l.replace(/^\s{2,}/, ""))
        .join("\n")
        .trim()
    : undefined;

  return { description, body, tools, modelPreference, maxSteps, systemPrompt };
}

/**
 * Find a skill by name (for /command invocation).
 */
/**
 * Inject temporal template variables into skill content.
 * Supports: {{current_date}}, {{current_time}}, {{current_year}}, {{day_of_week}}
 */
function injectTemporalVars(content: string): string {
  if (!content.includes("{{")) return content;
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
  return content
    .replace(/\{\{current_date\}\}/g, now.toISOString().split("T")[0])
    .replace(
      /\{\{current_time\}\}/g,
      now.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" }),
    )
    .replace(/\{\{current_year\}\}/g, String(now.getFullYear()))
    .replace(/\{\{day_of_week\}\}/g, days[now.getDay()]);
}

export function findSkill(
  skills: SkillDefinition[],
  name: string,
): SkillDefinition | undefined {
  return skills.find((s) => s.name === name);
}
