import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, basename } from "node:path";
import { homedir } from "node:os";

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

  // 1. Project-level skills: .brainstorm/skills/
  const projectSkillsDir = join(projectPath, ".brainstorm", "skills");
  skills.push(...loadSkillsFromDir(projectSkillsDir, "project"));

  // 2. Global skills: ~/.brainstorm/skills/
  const globalSkillsDir = join(homedir(), ".brainstorm", "skills");
  skills.push(...loadSkillsFromDir(globalSkillsDir, "global"));

  // 3. Claude Code compatibility: .claude/commands/
  const claudeCommandsDir = join(projectPath, ".claude", "commands");
  skills.push(...loadSkillsFromDir(claudeCommandsDir, "claude-compat"));

  return skills;
}

function loadSkillsFromDir(
  dir: string,
  source: SkillDefinition["source"],
): SkillDefinition[] {
  if (!existsSync(dir)) return [];

  const skills: SkillDefinition[] = [];
  const files = readdirSync(dir).filter((f) => f.endsWith(".md"));

  for (const file of files) {
    try {
      const content = readFileSync(join(dir, file), "utf-8");
      const name = basename(file, ".md");
      const {
        description,
        body,
        tools,
        modelPreference,
        maxSteps,
        systemPrompt,
      } = parseFrontmatter(content);

      // Inject temporal template variables
      const processedBody = injectTemporalVars(body);

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
      /* skip unreadable files */
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
